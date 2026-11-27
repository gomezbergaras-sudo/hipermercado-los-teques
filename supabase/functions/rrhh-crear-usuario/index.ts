import { createClient } from "npm:@supabase/supabase-js@2.86.0";

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Cache-Control": "no-store"
};

function responder(status: number, body: Record<string, unknown>) {
  return Response.json(body, { status, headers });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "POST") return responder(405, { mensaje: "Método no permitido." });
  const bearer = req.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!bearer) return responder(401, { mensaje: "Inicia sesión para continuar." });

  const url = Deno.env.get("SUPABASE_URL");
  const secreta = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !secreta) return responder(503, { mensaje: "El servicio de altas no está disponible." });
  const admin = createClient(url, secreta, { auth: { persistSession: false, autoRefreshToken: false } });

  try {
    const identidad = await admin.auth.getUser(bearer);
    if (identidad.error || !identidad.data.user) return responder(401, { mensaje: "La sesión no está activa." });
    const operador = identidad.data.user.id;
    const perfil = await admin.from("rrhh_miembros")
      .select("rol,activo").eq("usuario_id", operador).maybeSingle();
    if (perfil.error) return responder(503, { mensaje: "No se pudieron comprobar los permisos." });
    if (perfil.data?.rol !== "gerencia" || !perfil.data.activo) {
      return responder(403, { mensaje: "Solo Gerencia puede crear cuentas de RRHH." });
    }

    let body;
    try { body = await req.json(); }
    catch { return responder(400, { mensaje: "Los datos de la cuenta son inválidos." }); }
    const usuario = typeof body?.usuario === "string" ? body.usuario.trim().toLowerCase() : "";
    const nombre = typeof body?.nombre === "string" ? body.nombre.trim() || usuario : usuario;
    const clave = typeof body?.clave === "string" ? body.clave : "";
    const aliasValido = /^[a-z0-9](?:[a-z0-9._-]{0,30}[a-z0-9])?$/.test(usuario) && !usuario.includes("..");
    if (!aliasValido) return responder(400, { mensaje: "Usa hasta 32 letras sin tilde, números, puntos, guiones o guiones bajos. Empieza y termina con letra o número." });
    if (nombre.length > 160 || clave.length < 6 || clave.length > 128 || !clave.trim()) {
      return responder(400, { mensaje: "Revisa el nombre y usa una clave de 6 a 128 caracteres." });
    }
    const alta = await admin.auth.admin.createUser({
      email: usuario + "@hlt-rrhh.example.com",
      password: clave,
      email_confirm: true,
      app_metadata: { hlt_rrhh_alta: { usuario, nombre, creado_por: operador } }
    });
    if (alta.error) {
      if (["email_exists", "user_already_exists"].includes(alta.error.code || "")) {
        return responder(409, { mensaje: "Ese nombre de usuario ya existe." });
      }
      if (alta.error.code === "weak_password") {
        return responder(400, { mensaje: "La clave no cumple las reglas de Supabase. Usa otra más segura." });
      }
      return responder(502, { mensaje: "No se pudo crear la cuenta de RRHH." });
    }
    return responder(201, { usuario, nombre, rol: "rrhh" });
  } catch {
    return responder(503, { mensaje: "El servicio de altas no está disponible." });
  }
});
