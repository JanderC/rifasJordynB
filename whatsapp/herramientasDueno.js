// ============================================================
//  herramientasDueno.js — Lo que el bot puede hacer SOLO para el dueño
//  (se activan únicamente cuando el mensaje viene del número del dueño)
//  Consultar clientes, quién tiene un número, cómo va una rifa, ventas,
//  pagos por aprobar, quién espera atención y cargar resultados.
// ============================================================
const pool = require('../config/db');
const chats = require('../services/waChats');
const reservas = require('../services/reservas');
const resultados = require('../services/resultados');

const DEFINICIONES = [
  {
    nombre: 'dueno_rifas',
    descripcion: 'Lista las rifas (en venta y las sorteadas recientemente) con su id, fecha y estado. Úsala para saber el rifa_id antes de otras consultas.',
    parametros: { type: 'object', properties: {}, required: [] },
  },
  {
    nombre: 'dueno_buscar_cliente',
    descripcion: 'Busca un cliente por nombre, teléfono o cédula y devuelve sus compras, reservas y su chat de WhatsApp.',
    parametros: { type: 'object', properties: { texto: { type: 'string', description: 'Nombre, teléfono o cédula (o parte)' } }, required: ['texto'] },
  },
  {
    nombre: 'dueno_quien_tiene_numero',
    descripcion: 'Dice quién tiene un número en una rifa: el cliente que lo compró en línea, el vendedor que lo tiene asignado, si está en una reserva o si está libre.',
    parametros: { type: 'object', properties: { rifa_id: { type: 'string' }, numero: { type: 'string' } }, required: ['rifa_id', 'numero'] },
  },
  {
    nombre: 'dueno_resumen_rifa',
    descripcion: 'Cómo va una rifa: números con vendedores, vendidos por WhatsApp y por la página (cantidad y monto), pagos por aprobar, apartados y libres. Sin rifa_id resume todas las que están en venta.',
    parametros: { type: 'object', properties: { rifa_id: { type: 'string' } }, required: [] },
  },
  {
    nombre: 'dueno_ventas_en_linea',
    descripcion: 'Ventas hechas por WhatsApp y por la página en los últimos días (por defecto hoy).',
    parametros: { type: 'object', properties: { dias: { type: 'integer', description: '1 = hoy, 7 = última semana' } }, required: [] },
  },
  {
    nombre: 'dueno_pagos_por_aprobar',
    descripcion: 'Reservas con comprobante que están esperando que el dueño apruebe el pago.',
    parametros: { type: 'object', properties: {}, required: [] },
  },
  {
    nombre: 'dueno_clientes_esperando',
    descripcion: 'Clientes de WhatsApp que están esperando que los atienda una persona, con el motivo.',
    parametros: { type: 'object', properties: {}, required: [] },
  },
  {
    nombre: 'dueno_registrar_resultado',
    descripcion: 'Guarda el número ganador de un sorteo. El sistema busca quién tenía ese número. Para rifas con varios premios, llama una vez por premio.',
    parametros: {
      type: 'object',
      properties: {
        rifa_id: { type: 'string' },
        numero: { type: 'string', description: 'Número que salió' },
        premio: { type: 'string', description: 'Ej. "Premio mayor", "2do premio", "A". Por defecto "Premio mayor"' },
        serie: { type: 'string', description: 'A o B, solo en rifas simultáneas si aplica' },
        ganador: { type: 'string', description: 'Nombre del ganador a anunciar, si el dueño lo dice' },
      },
      required: ['rifa_id', 'numero'],
    },
  },
];

const haceCuanto = (f) => {
  const min = Math.round((Date.now() - new Date(f).getTime()) / 60000);
  if (min < 60) return `hace ${Math.max(1, min)} min`;
  const h = Math.round(min / 60);
  return h < 24 ? `hace ${h} h` : `hace ${Math.round(h / 24)} d`;
};
const pesos = (n) => `${Math.round(Number(n) || 0).toLocaleString('es-CO')} pesos`;

async function resumenDe(rifa) {
  const [asig, onl, pend, libres] = await Promise.all([
    pool.query(`SELECT (SELECT COUNT(*) FROM numeros_vendedor WHERE rifa_id=$1)::int + (SELECT COUNT(*) FROM boleteria_numeros_extra WHERE rifa_id=$1)::int AS n,
                       (SELECT COUNT(*) FROM rifa_vendedores_sel WHERE rifa_id=$1)::int AS vendedores`, [rifa.id]),
    pool.query(`SELECT COALESCE(origen, 'vendedor') AS origen, COUNT(*)::int n, COALESCE(SUM(precio_venta), 0) AS monto
                  FROM ventas WHERE rifa_id=$1 GROUP BY 1`, [rifa.id]),
    pool.query(`SELECT estado, COUNT(*)::int n FROM reservas_cliente
                 WHERE rifa_id=$1 AND (estado='pendiente' OR (estado='apartado' AND apartado_hasta > NOW())) GROUP BY 1`, [rifa.id]),
    reservas.numerosLibres(pool, rifa, { cantidad: 1 }),
  ]);
  const por = Object.fromEntries(onl.rows.map((x) => [x.origen, x]));
  const est = Object.fromEntries(pend.rows.map((x) => [x.estado, x.n]));
  return {
    rifa: rifa.nombre, sorteo: [rifa.fecha_sorteo, rifa.hora_sorteo?.slice(0, 5)].filter(Boolean).join(' '),
    precio: pesos(rifa.precio),
    vendedores: asig.rows[0].vendedores, numeros_con_vendedores: asig.rows[0].n,
    vendidos_por_whatsapp: { numeros: por.whatsapp?.n || 0, monto: pesos(por.whatsapp?.monto) },
    vendidos_por_la_pagina: { numeros: por.web?.n || 0, monto: pesos(por.web?.monto) },
    pagos_por_aprobar: est.pendiente || 0, apartados_esperando_pago: est.apartado || 0,
    numeros_libres: libres.totalLibres,
  };
}

async function ejecutar(nombre, args) {
  switch (nombre) {
    case 'dueno_rifas': {
      const enVenta = await reservas.rifasEnVenta();
      const sorteadas = await resultados.sorteosRecientes(21);
      const ids = new Set(enVenta.map((r) => r.id));
      return {
        en_venta: enVenta.map((r) => ({ rifa_id: r.id, nombre: r.nombre, sorteo: [r.fecha_sorteo, r.hora_sorteo?.slice(0, 5)].filter(Boolean).join(' '), precio: pesos(r.precio) })),
        sorteadas_recientes: sorteadas.filter((r) => r.ya_sorteo || !ids.has(r.id)).map((r) => ({
          rifa_id: r.id, nombre: r.nombre, sorteo: r.fecha_sorteo, ya_sorteo: r.ya_sorteo,
          resultados: r.resultados.length ? r.resultados.map((x) => `${x.premio}: ${x.numero}${x.ganador ? ` (${x.ganador})` : ''}`) : 'sin cargar',
        })),
      };
    }
    case 'dueno_buscar_cliente': {
      const texto = String(args.texto || '').trim();
      if (texto.length < 2) return { error: 'Dime un nombre, teléfono o cédula para buscar.' };
      const like = `%${texto}%`;
      const dig = texto.replace(/\D/g, '');
      const likeDig = dig.length >= 4 ? `%${dig.replace(/^0/, '')}%` : null;
      const r = await pool.query(`
        SELECT rc.nombre_cliente AS nombre, rc.telefono, rc.cedula, TRIM(rc.numero) AS numero, rc.estado,
               COALESCE(rc.origen, 'web') AS canal, rc.created_at, r.nombre AS rifa
          FROM reservas_cliente rc JOIN rifas r ON r.id = rc.rifa_id
         WHERE rc.nombre_cliente ILIKE $1 OR ($2::text IS NOT NULL AND (regexp_replace(COALESCE(rc.telefono,''), '\\D', '', 'g') LIKE $2 OR regexp_replace(COALESCE(rc.cedula,''), '\\D', '', 'g') LIKE $2))
         ORDER BY rc.created_at DESC LIMIT 40`, [like, likeDig]);
      const ch = await pool.query(`
        SELECT jid, COALESCE(nombre_guardado, nombre) AS nombre, telefono, ultimo_mensaje, ultimo_at, bot_activo, necesita_humano
          FROM wa_chats
         WHERE COALESCE(nombre_guardado, '') ILIKE $1 OR COALESCE(nombre, '') ILIKE $1 OR ($2::text IS NOT NULL AND COALESCE(telefono, '') LIKE $2)
         ORDER BY ultimo_at DESC NULLS LAST LIMIT 5`, [like, likeDig]);
      const clientes = {};
      for (const x of r.rows) {
        const k = `${String(x.nombre).trim().toLowerCase()}|${String(x.telefono || '').replace(/\D/g, '')}`;
        clientes[k] = clientes[k] || { nombre: x.nombre, telefono: x.telefono, cedula: x.cedula, compras: [] };
        clientes[k].compras.push({ rifa: x.rifa, numero: x.numero, estado: x.estado, canal: x.canal, cuando: haceCuanto(x.created_at) });
      }
      const lista = Object.values(clientes).slice(0, 6);
      if (!lista.length && !ch.rows.length) return { encontrado: false, nota: 'No encontré a nadie con ese dato en compras en línea ni en los chats. Los clientes de los vendedores no quedan registrados en el sistema.' };
      return {
        clientes: lista,
        chats_de_whatsapp: ch.rows.map((c) => ({ nombre: c.nombre, telefono: c.telefono, ultimo_mensaje: c.ultimo_mensaje, cuando: c.ultimo_at ? haceCuanto(c.ultimo_at) : null, lo_atiende: c.bot_activo ? 'el bot' : 'una persona', necesita_atencion: c.necesita_humano })),
      };
    }
    case 'dueno_quien_tiene_numero': {
      const rifa = await reservas.infoRifa(pool, args.rifa_id);
      if (!rifa) return { error: 'No encontré esa rifa. Usa dueno_rifas.' };
      const num = reservas.normalizarNumero(args.numero, rifa.cifras);
      if (!num) return { error: `Ese número no existe en esta rifa (va de ${'0'.repeat(rifa.cifras)} a ${'9'.repeat(rifa.cifras)}).` };
      const t = await resultados.quienTiene(rifa.id, num);
      const libre = !t.compradores_en_linea.length && !t.vendedores.length && !t.reservas_en_curso.length;
      return { rifa: rifa.nombre, ...t, ...(libre ? { libre: true } : {}) };
    }
    case 'dueno_resumen_rifa': {
      if (args.rifa_id) {
        const rifa = await reservas.infoRifa(pool, args.rifa_id);
        if (!rifa) return { error: 'No encontré esa rifa. Usa dueno_rifas.' };
        return resumenDe(rifa);
      }
      const enVenta = await reservas.rifasEnVenta();
      const out = [];
      for (const r of enVenta) out.push(await resumenDe(r));
      return { rifas: out };
    }
    case 'dueno_ventas_en_linea': {
      const dias = Math.min(60, Math.max(1, Number(args.dias) || 1));
      const r = await pool.query(`
        SELECT TRIM(v.numero) AS numero, v.nombre_comprador AS nombre, v.telefono, v.origen AS canal, v.precio_venta, v.created_at, r.nombre AS rifa
          FROM ventas v JOIN rifas r ON r.id = v.rifa_id
         WHERE v.origen IN ('web', 'whatsapp')
           AND v.created_at >= (date_trunc('day', NOW() AT TIME ZONE 'America/Caracas') - ($1::int - 1) * INTERVAL '1 day') AT TIME ZONE 'America/Caracas'
         ORDER BY v.created_at DESC LIMIT 60`, [dias]);
      const total = r.rows.reduce((s, x) => s + Number(x.precio_venta || 0), 0);
      return {
        periodo: dias === 1 ? 'hoy' : `últimos ${dias} días`, numeros_vendidos: r.rows.length, total: pesos(total),
        ventas: r.rows.slice(0, 25).map((x) => ({ rifa: x.rifa, numero: x.numero, cliente: x.nombre, telefono: x.telefono, canal: x.canal, monto: pesos(x.precio_venta), cuando: haceCuanto(x.created_at) })),
      };
    }
    case 'dueno_pagos_por_aprobar': {
      const r = await pool.query(`
        SELECT rc.nombre_cliente AS nombre, rc.telefono, COALESCE(rc.origen, 'web') AS canal, rc.metodo_pago, r.nombre AS rifa,
               array_agg(TRIM(rc.numero) ORDER BY rc.numero) AS numeros, MIN(rc.created_at) AS desde,
               MAX(rc.comprobante_datos->>'monto_esperado') AS monto_esperado
          FROM reservas_cliente rc JOIN rifas r ON r.id = rc.rifa_id
         WHERE rc.estado = 'pendiente'
         GROUP BY rc.nombre_cliente, rc.telefono, rc.origen, rc.metodo_pago, r.nombre
         ORDER BY MIN(rc.created_at) ASC LIMIT 30`);
      return { pendientes: r.rows.length, lista: r.rows.map((x) => ({ cliente: x.nombre, telefono: x.telefono, rifa: x.rifa, numeros: x.numeros, canal: x.canal, metodo: x.metodo_pago, monto_esperado: x.monto_esperado, esperando: haceCuanto(x.desde) })), nota: 'Se aprueban en el panel, en Reservas (ahí se revisa el comprobante).' };
    }
    case 'dueno_clientes_esperando': {
      const lista = await chats.colaAtencion(args._telefonoDueno || null);
      return { esperando: lista.length, lista: lista.map((c) => ({ nombre: c.nombre_guardado || c.nombre || c.telefono, telefono: c.telefono, motivo: c.motivo_humano || 'le escribió a una persona y no tiene respuesta', ultimo_mensaje: c.ultimo_del_cliente, desde: haceCuanto(c.esperando_desde || c.ultimo_at) })) };
    }
    case 'dueno_registrar_resultado': {
      const r = await resultados.registrar({ rifaId: args.rifa_id, numero: args.numero, premio: args.premio || 'Premio mayor', serie: args.serie || null, ganador: args.ganador || null });
      return { ok: true, rifa: r.rifa, premio: r.premio, numero: r.numero, ganador_a_anunciar: r.ganador || 'no definido', quien_lo_tenia: r.detalle,
        nota: 'Guardado. Desde ya el bot se lo dice a los clientes que pregunten. Si el ganador a anunciar no es correcto, el dueño puede decir el nombre.' };
    }
    default:
      return null;   // no es una herramienta del dueño
  }
}

module.exports = { DEFINICIONES, ejecutar };
