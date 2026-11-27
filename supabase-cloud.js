const nubeRRHH = (() => {
  const config = window.HLT_SUPABASE || {};
  const url = String(config.url || "").trim();
  const publishableKey = String(config.publishableKey || "").trim();
  let cliente;
  let versiones = new Map();
  let operaciones = 0;
  let cambios = 0;
  let sesion = 0;
  let consulta;
  const campos = "coleccion,id,contenido,revision,actualizado";
  const claveSesion = "hlt_rrhh_supabase_session";

  function exigir(resultado) {
    if (resultado.error) {
      if (resultado.error.code === "23505") throw Error("Ya existe un registro con esos datos.");
      if (resultado.error.code === "42501") throw Error("Tu cuenta no tiene acceso para realizar esta acción.");
      throw resultado.error;
    }
    return resultado.data;
  }

  function crearCliente() {
    const urlValida = /^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(url);
    if (!urlValida || !/^sb_publishable_[A-Za-z0-9_-]+$/.test(publishableKey)) {
      throw Error("Completa la URL y la clave publicable del proyecto en supabase-config.js.");
    }
    if (!window.supabase?.createClient) throw Error("Falta la biblioteca de conexión con Supabase.");
    return window.supabase.createClient(url, publishableKey, {
      auth: { storage: sessionStorage, storageKey: claveSesion, persistSession: true, detectSessionInUrl: false }
    });
  }

  function limpiar() {
    sesion++;
    cambios++;
    versiones = new Map();
    store = Object.fromEntries(TABLES.map(tabla => [tabla, []]));
  }

  async function configurar() {
    cliente = crearCliente();
    cliente.auth.onAuthStateChange(evento => {
      if (evento === "SIGNED_OUT" && currentUser) {
        currentUser = null;
        limpiar();
        closeModal();
        closeModal2();
        mostrarLogin();
      }
    });
    const { data, error } = await cliente.auth.getSession();
    if (error) throw error;
    if (!data.session) return null;
    const { data: verificado, error: fallo } = await cliente.auth.getUser();
    if (fallo) {
      if ([400, 401, 403].includes(fallo.status)) {
        await cliente.auth.signOut({ scope: "local" });
        return null;
      }
      throw fallo;
    }
    return cargarCuenta(verificado.user);
  }

  async function entrar(email, password) {
    const { data, error } = await cliente.auth.signInWithPassword({ email, password });
    if (error) throw Error("No se pudo iniciar sesión. Revisa el correo y la contraseña.");
    return cargarCuenta(data.user);
  }

  async function cargarCuenta(usuario) {
    const miembro = exigir(await cliente.from("rrhh_miembros")
      .select("usuario_id,nombre,rol")
      .eq("usuario_id", usuario.id)
      .maybeSingle());
    if (!miembro) {
      await cliente.auth.signOut({ scope: "local" });
      throw Error("Esta cuenta todavía no tiene acceso a Recursos Humanos.");
    }
    await refrescar();
    return {
      id: miembro.usuario_id,
      nombre: miembro.nombre,
      es_gerencia: miembro.rol === "gerencia",
      es_rrhh: miembro.rol === "rrhh",
      permisos: []
    };
  }

  async function salir() {
    try {
      const { error } = await cliente.auth.signOut({ scope: "local" });
      if (error) throw error;
    } finally {
      sessionStorage.removeItem(claveSesion);
      limpiar();
    }
  }

  const llave = (tabla, id) => tabla + "/" + id;

  async function descargar() {
    const inicio = cambios;
    const cuenta = sesion;
    const colecciones = Object.fromEntries(TABLES.map(tabla => [tabla, []]));
    const nuevasVersiones = new Map();
    let desde = 0;
    const limite = 500;
    while (true) {
      const filas = exigir(await cliente.from("rrhh_registros").select(campos)
        .order("coleccion").order("id").range(desde, desde + limite - 1));
      for (const fila of filas) {
        if (!Object.hasOwn(colecciones, fila.coleccion) || fila.coleccion === "usuarios") continue;
        colecciones[fila.coleccion].push(fila.contenido);
        nuevasVersiones.set(llave(fila.coleccion, fila.id), fila);
      }
      if (filas.length < limite) break;
      desde += limite;
    }
    if (cuenta !== sesion || inicio !== cambios || operaciones) return false;
    store = colecciones;
    versiones = nuevasVersiones;
    cargarConfigCompartida();
    return true;
  }

  async function refrescar() {
    if (!consulta) {
      consulta = descargar().finally(() => { consulta = null; });
    }
    return consulta;
  }

  async function conOperacion(trabajo) {
    const cuenta = sesion;
    operaciones++;
    cambios++;
    try {
      const resultado = await trabajo();
      if (cuenta !== sesion) throw Error("La sesión cambió. Vuelve a iniciar sesión.");
      return resultado;
    } finally {
      operaciones--;
      cambios++;
    }
  }

  async function guardar(tabla, anterior, nuevo) {
    const id = nuevo?.id || anterior.id;
    const fila = await conOperacion(async () => {
      if (tabla === "usuarios") throw Error("Las cuentas se administran desde Supabase Auth.");
      if (!anterior) {
        return exigir(await cliente.from("rrhh_registros")
          .insert({coleccion: tabla, id, contenido: nuevo}).select(campos).single());
      }
      const version = versiones.get(llave(tabla, id));
      if (!version) throw Error("Actualiza los datos y vuelve a intentar.");
      const registros = cliente.from("rrhh_registros");
      const peticion = nuevo ? registros.update({contenido: nuevo}) : registros.delete();
      const resultado = exigir(await peticion.eq("coleccion", tabla).eq("id", id)
        .eq("revision", version.revision).eq("actualizado", version.actualizado)
        .select(campos).maybeSingle());
      if (!resultado) throw Error("Otro usuario cambió este registro. Actualiza los datos antes de editarlo.");
      return resultado;
    });
    if (nuevo) versiones.set(llave(tabla, id), fila);
    else versiones.delete(llave(tabla, id));
  }

  async function restaurar(datos) {
    await conOperacion(async () => {
      exigir(await cliente.rpc("rrhh_restaurar", { registros: datos }));
    });
    await refrescar();
  }

  return { activa: Boolean(url || publishableKey), configurar, entrar, salir, refrescar, guardar, restaurar };
})();
