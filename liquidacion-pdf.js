const LIQ_DEDUCCIONES = [
  ["anticipo_prestaciones", "Anticipo de prestaciones sociales"],
  ["anticipo_intereses", "Anticipo de intereses de prestaciones"],
  ["anticipo_utilidades", "Anticipo de utilidades"],
  ["prestamo", "Préstamo"],
  ["inces", "INCES"],
  ["faov", "FAOV"]
];

const LIQ_DATOS_DOCUMENTO = [
  ["fecha_documento", "Fecha del documento", "date"],
  ["fecha_pago", "Fecha de pago", "date"],
  ["elaborado_por", "Elaborado por"],
  ["cargo_elaborado", "Cargo de quien elabora"],
  ["aprobado_por", "Aprobado por"],
  ["cargo_aprobado", "Cargo de quien aprueba"],
  ["medio_pago", "Medio de pago"],
  ["referencia_pago", "Referencia del pago"],
  ["banco_pago", "Banco"]
];

function modoIndemnizacionLiquidacion(cfg) {
  if (cfg.modo_indemnizacion) return cfg.modo_indemnizacion;
  return cfg.motivo === "despido_injust" && cfg.indemniz_auto === false ? "manual" : "segun_motivo";
}

function antiguedadLiquidacion(desde, hasta) {
  if (!rrhhFechaValida(desde) || !rrhhFechaValida(hasta) || hasta < desde) return null;
  const inicio = new Date(desde);
  const fin = new Date(hasta);
  const dias = (fin - inicio) / 86400000;
  let mesesTot = (fin.getUTCFullYear() - inicio.getUTCFullYear()) * 12
    + fin.getUTCMonth() - inicio.getUTCMonth();
  if (fin.getUTCDate() < inicio.getUTCDate()) mesesTot--;
  const aniversario = new Date(inicio);
  aniversario.setUTCMonth(inicio.getUTCMonth() + mesesTot, 1);
  const ultimoDia = new Date(aniversario);
  ultimoDia.setUTCMonth(ultimoDia.getUTCMonth() + 1, 0);
  aniversario.setUTCDate(Math.min(inicio.getUTCDate(), ultimoDia.getUTCDate()));
  return {
    dias,
    mesesTot,
    aniosEnt: Math.floor(mesesTot / 12),
    mesesResto: mesesTot % 12,
    diasResto: (fin - aniversario) / 86400000,
    mesEgreso: fin.getUTCMonth() + 1
  };
}

function detalleLiquidacion(c, r) {
  const centavos = valor => Math.round((Number(valor) || 0) * 100);
  const fila = (concepto, monto, dias = null, base = null) => ({
    concepto, centavos: centavos(monto), dias, base
  });
  const asignaciones = [
    fila("Prestaciones sociales", r.prestaciones, r.prestacionesManual ? null : r.diasPrestaciones,
      r.prestacionesManual ? null : r.salIntDia),
    fila("Indemnización", r.indemniz),
    fila("Intereses sobre prestaciones sociales", r.intereses),
    fila("Intereses de mora", c.intereses_mora),
    fila("Vacaciones fraccionadas", r.vacFrac, r.diasVacFrac, r.salDia),
    fila("Bono vacacional fraccionado", r.bonoFrac, r.diasBonoFrac, r.salDia),
    fila("Utilidades fraccionadas", r.utilFrac, r.diasUtilFrac, r.baseUtil)
  ];
  if (r.vacVenc) asignaciones.push(fila("Vacaciones vencidas", r.vacVenc, Number(c.vac_vencidas_dias), r.salDia));
  if (r.bonoVenc) asignaciones.push(fila("Bono vacacional vencido", r.bonoVenc, Number(c.bono_vencido_dias), r.salDia));
  if (r.utilPend) asignaciones.push(fila("Utilidades pendientes", r.utilPend, Number(c.util_pend_dias), r.baseUtil));
  if (r.otros || c.otros_desc) asignaciones.push(fila(c.otros_desc || "Otras asignaciones", r.otros));
  const deducciones = LIQ_DEDUCCIONES.map(([id, nombre]) => fila(nombre, c[id]));
  if (Number(c.deducciones) || c.deduc_desc) deducciones.push(fila(c.deduc_desc || "Otras deducciones", c.deducciones));
  const sumar = filas => filas.reduce((s, x) => s + x.centavos, 0);
  const asignados = sumar(asignaciones);
  const deducidos = sumar(deducciones);
  return { asignaciones, deducciones, subtotal: asignados / 100, deduc: deducidos / 100, total: (asignados - deducidos) / 100 };
}

function pdfLiquidacionFormateada(doc, empresa, empleado, cfg, r, motivo) {
  const papel = doc.internal.pageSize;
  const margen = 11;
  const ancho = papel.getWidth() - 2 * margen;
  const limite = papel.getHeight() - 16;
  const azul = [37, 107, 138];
  const tinta = [26, 43, 54];
  const linea = [161, 174, 182];
  const suave = [232, 241, 246];
  const blanco = [255, 255, 255];
  const cifras = new Intl.NumberFormat("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const num = v => v == null ? "-" : cifras.format(v);
  const fecha = iso => rrhhFechaValida(iso) ? iso.split("-").reverse().join("/") : "-";
  const fechaDocumento = cfg.fecha_documento || cfg.fecha_egreso;
  const texto = s => String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  let y = margen;

  function fuente(tamano, negrita = false, color = tinta) {
    doc.setFont("helvetica", negrita ? "bold" : "normal");
    doc.setFontSize(tamano);
    doc.setTextColor(...color);
  }

  function nuevaPagina() {
    doc.addPage();
    y = margen;
    fuente(11, true, azul);
    doc.text("LIQUIDACIÓN DE TRABAJO", margen, y + 4);
    fuente(8, false);
    doc.text(doc.splitTextToSize(texto(empleado.nombre), ancho - 4), margen, y + 9);
    y += 16;
  }

  function asegurar(alto) {
    if (y + alto > limite) nuevaPagina();
  }

  function altoFila(celdas, anchos, tamano, negrita) {
    fuente(tamano, negrita);
    const lineas = celdas.map((dato, i) => doc.splitTextToSize(texto(dato || dato === 0 ? dato : "-") || "-", anchos[i] - 4));
    return { lineas, alto: Math.max(5.1, ...lineas.map(l => l.length * tamano * 0.38 + 2)) };
  }

  function fila(celdas, anchos, { fondo, negrita = false, tamano = 8.3, numericos = [], color = tinta } = {}) {
    const { lineas, alto } = altoFila(celdas, anchos, tamano, negrita);
    let x = margen;
    fuente(tamano, negrita, color);
    doc.setDrawColor(...linea);
    doc.setLineWidth(0.19);
    lineas.forEach((ls, i) => {
      const w = anchos[i];
      if (fondo) doc.setFillColor(...fondo);
      doc.rect(x, y, w, alto, fondo ? "FD" : "S");
      const derecha = numericos.includes(i);
      doc.text(ls, derecha ? x + w - 2 : x + 2, y + 1.55 + tamano * 0.26,
        { align: derecha ? "right" : "left", lineHeightFactor: 1.08 });
      x += w;
    });
    y += alto;
  }

  function banda(titulo, oscuro = false) {
    fila([titulo], [ancho], { negrita: true, tamano: 8.8, fondo: oscuro ? azul : suave, color: oscuro ? blanco : tinta });
  }

  function tabla(titulo, encabezados, filas, columnas, total) {
    const numericos = columnas.map((_, i) => i).slice(1);
    const opts = { numericos };
    const cab = () => {
      banda(titulo);
      if (encabezados) fila(encabezados, columnas, { ...opts, negrita: true, tamano: 7.7, fondo: [246, 249, 251] });
    };
    asegurar(12 + (filas.length ? altoFila(filas[0], columnas, 8.3, false).alto : 0));
    cab();
    for (const datos of filas) {
      const { alto } = altoFila(datos, columnas, 8.3, false);
      if (y + alto > limite) { nuevaPagina(); cab(); }
      fila(datos, columnas, encabezados ? opts : {});
    }
    if (total) {
      if (y + 6 > limite) { nuevaPagina(); cab(); }
      fila(total, columnas, { ...opts, negrita: true, fondo: suave });
    }
    y += 1.6;
  }

  function parrafo(s) {
    fuente(8, false);
    const ls = doc.splitTextToSize(texto(s), ancho - 4);
    for (const l of ls) {
      asegurar(4);
      doc.text(l, margen + 2, y + 3.1);
      y += 3.2;
    }
  }

  fuente(13, true);
  const tituloEmpresa = doc.splitTextToSize(texto(empresa.nombre), ancho);
  doc.text(tituloEmpresa, margen, y + 4.6);
  y += tituloEmpresa.length * 5.4 + 1;
  if (empresa.rif || empresa.direccion) {
    parrafo([empresa.rif && "RIF " + empresa.rif, empresa.direccion].filter(Boolean).join("  ·  "));
    y += 1.4;
  }
  banda("LIQUIDACIÓN DE TRABAJO", true);
  fila(["Fecha del documento: " + fecha(fechaDocumento)], [ancho], { tamano: 8 });
  y += 1.6;

  tabla("DATOS DEL TRABAJADOR", null, [
    ["Trabajador", empleado.nombre],
    ["Cargo / área", [empleado.cargo, empleado.area].filter(Boolean).join(" · ")],
    ["Cédula de identidad", empleado.cedula],
    ["Causa / concepto", motivo]
  ], [47, ancho - 47]);

  const cuatro = [ancho - 96, 28, 28, 40];
  tabla("SALARIOS EN BOLÍVARES", ["Concepto", "Mensual (Bs)", "Días", "Diario (Bs)"], [
    ["Último salario", num(r.salMes), "30", num(r.salDia)],
    ["Salario integral", num(r.salIntDia * 30), "30", num(r.salIntDia)]
  ], cuatro);

  const fechaColumnas = [ancho - 96, 32, 32, 32];
  const partes = iso => iso.split("-").map(Number).map(String);
  tabla("TIEMPO DE ANTIGÜEDAD", ["Concepto", "Año", "Mes", "Día"], [
    ["Fecha de ingreso", ...partes(cfg.fecha_ingreso)],
    ["Fecha de egreso", ...partes(cfg.fecha_egreso)],
    ["Antigüedad", String(r.aniosEnt), String(r.mesesResto), String(r.diasResto)]
  ], fechaColumnas);

  const columnas = [ancho - 81, 20, 28, 33];
  const cabConceptos = ["Concepto", "Días", "Base (Bs)", "Monto (Bs)"];
  const valores = filas => filas.map(x => [x.concepto, num(x.dias), num(x.base), num(x.centavos / 100)]);
  tabla("ASIGNACIONES", cabConceptos, valores(r.asignaciones), columnas, ["TOTAL ASIGNACIONES", "", "", num(r.subtotal)]);
  tabla("DEDUCCIONES", cabConceptos, valores(r.deducciones), columnas, ["TOTAL DEDUCCIONES", "", "", num(r.deduc)]);

  const entero = Math.abs(Math.round(r.total * 100));
  const unidades = Math.floor(entero / 100);
  const letras = ((r.total < 0 ? "menos " : "") + numeroALetras(unidades).replace(/uno$/, "un") +
    (unidades === 1 ? " bolívar" : " bolívares") + " con " + String(entero % 100).padStart(2, "0") + "/100").toUpperCase();
  const escrito = ["SON: " + letras];
  asegurar(8 + altoFila(escrito, [ancho], 8.0, true).alto);
  fila(["NETO A COBRAR", num(r.total) + " Bs"], [ancho - 48, 48],
    { fondo: azul, color: blanco, numericos: [1], negrita: true, tamano: 9.6 });
  fila(escrito, [ancho], { negrita: true, tamano: 8 });
  y += 1.6;

  asegurar(14);
  banda("CÁLCULO DE PRESTACIONES");
  const metodo = r.prestacionesManual ? "Monto manual" : r.usarRetro ? "Retroactivo" : "Garantía";
  parrafo("Garantía: Bs " + num(r.prestGarantia) + "   |   Retroactivo: Bs " + num(r.prestRetro) + "   |   Aplicado: " + metodo + ".");
  if (cfg.notas) parrafo("Observaciones: " + cfg.notas);
  y += 1.6;

  asegurar(31);
  const firmas = [ancho / 3, ancho / 3, ancho / 3];
  fila(["Elaborado por", "Aprobado por", "Sello"], firmas, { fondo: suave, negrita: true, tamano: 7.8 });
  fila([[cfg.elaborado_por, cfg.cargo_elaborado].filter(Boolean).join(" · "), [cfg.aprobado_por, cfg.cargo_aprobado].filter(Boolean).join(" · "), " "], firmas, { tamano: 7.6 });
  fila(["Firma: __________________", "Firma: __________________", " "], firmas, { tamano: 7.6 });
  y += 1.6;

  asegurar(25);
  banda("RECIBÍ CONFORME", true);
  const datosPago = [
    "Fecha: " + (cfg.fecha_pago ? fecha(cfg.fecha_pago) : "____________"),
    "Medio: " + (cfg.medio_pago || "____________"),
    "Referencia: " + (cfg.referencia_pago || "____________"),
    cfg.banco_pago && "Banco: " + cfg.banco_pago
  ].filter(Boolean);
  parrafo("Dejo constancia de haber recibido el monto indicado en esta liquidación.");
  parrafo(datosPago.join("  |  "));
  asegurar(10);
  fila(["Firma del trabajador: __________________________", "Huella: _______________"], [ancho * 0.72, ancho * 0.28], { tamano: 8.1 });

  const paginas = doc.getNumberOfPages();
  for (let i = 1; i <= paginas; i++) {
    doc.setPage(i);
    fuente(7, false, [83, 98, 108]);
    const pie = papel.getHeight() - 8;
    doc.text("Liquidación de trabajo · " + fecha(fechaDocumento), margen, pie);
    doc.text(i + " / " + paginas, papel.getWidth() - margen, pie, { align: "right" });
  }
  return doc;
}
