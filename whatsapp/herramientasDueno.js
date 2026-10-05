// ============================================================
//  herramientasDueno.js — Lo que el bot puede hacer SOLO para el dueño
//  (se activan únicamente cuando el mensaje viene del número del dueño)
//  Consultar clientes, quién tiene un número, cómo va una rifa, ventas,
//  pagos por aprobar, quién espera atención, cargar resultados, ver o
//  reenviar la imagen de un ticket y ver el reparto de números por vendedor.
// ============================================================
const pool = require('../config/db');
const chats = require('../services/waChats');
const reservas = require('../services/reservas');
const resultados = require('../services/resultados');
const envios = require('./envios');
const vendedoresSvc = require('../services/vendedores');

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
  {
    nombre: 'dueno_ticket',
    descripcion: 'Busca la imagen del ticket de una compra en línea ya aprobada (por número, por cliente o ambos). Si encuentra una sola compra, el SISTEMA le manda la imagen del ticket a quien pregunta. Con reenviar_al_cliente=true además se la vuelve a enviar al cliente por WhatsApp (úsalo solo si lo pide expresamente: "reenvíale el ticket"). Los boletos que venden los vendedores no tienen imagen aquí.',
    parametros: {
      type: 'object',
      properties: {
        numero: { type: 'string', description: 'Número del ticket' },
        cliente: { type: 'string', description: 'Nombre o teléfono del cliente (o parte)' },
        rifa_id: { type: 'string', description: 'Opcional, para distinguir entre rifas' },
        reenviar_al_cliente: { type: 'boolean', description: 'true = volver a enviarle el ticket al cliente' },
      },
      required: [],
    },
  },
  {
    nombre: 'dueno_vendedores',
    descripcion: 'Directorio de vendedores. Sin "vendedor": la lista de todos con cuántos números fijos tienen, en qué rifas participan y cuánto han vendido. Con "vendedor" (nombre, usuario o cédula): su ficha completa con sus números fijos por categoría y los números que tiene en cada rifa. Úsala para "qué vendedores tengo", "qué números fijos tiene X", "en qué rifas está X".',
    parametros: { type: 'object', properties: { vendedor: { type: 'string', description: 'Nombre, usuario o cédula (o parte), opcional' } }, required: [] },
  },
  {
    nombre: 'dueno_numeros_vendedores',
    descripcion: 'Cómo están repartidos los números de una rifa: qué números tiene cada vendedor (en rangos), cuántos son, cuántos lleva vendidos y cuántos quedan libres para la venta en línea. Con "vendedor" devuelve solo ese.',
    parametros: {
      type: 'object',
      properties: { rifa_id: { type: 'string' }, vendedor: { type: 'string', description: 'Nombre del vendedor (o parte), opcional' } },
      required: ['rifa_id'],
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

// ["001","002","003","010"] → "001-003, 010"
function enRangos(nums) {
  const orden = [...new Set(nums)].sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
  const out = [];
  let ini = null, prev = null;
  for (const n of orden) {
    if (prev != null && Number(n) === Number(prev) + 1) { prev = n; continue; }
    if (ini != null) out.push(ini === prev ? ini : `${ini}-${prev}`);
    ini = prev = n;
  }
  if (ini != null) out.push(ini === prev ? ini : `${ini}-${prev}`);
  return out.join(', ');
}

const ESTADOS_ENVIO = {
  en_cola: 'en cola para enviarse', esperando_cliente: 'esperando a que el cliente escriba (contacto nuevo)',
  enviando: 'enviándose', enviado: 'enviado al cliente', error: 'no se pudo enviar',
};

// ctx: { efectos, prueba } — efectos.fotos son imágenes que el sistema manda después del texto
async function ejecutar(nombre, args, ctx = {}) {
  switch (nombre) {
    case 'dueno_rifas': {
      const enVenta = await reservas.rifasEnVenta(pool, { todas: true });
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
      const enVenta = await reservas.rifasEnVenta(pool, { todas: true });
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
    case 'dueno_ticket': {
      const numero = String(args.numero || '').replace(/\D/g, '');
      const cliente = String(args.cliente || '').trim();
      if (!numero && cliente.length < 2) return { error: 'Dime el número del ticket o el nombre/teléfono del cliente.' };
      let rifa = null;
      if (args.rifa_id) {
        rifa = await reservas.infoRifa(pool, args.rifa_id);
        if (!rifa) return { error: 'No encontré esa rifa. Usa dueno_rifas.' };
      }
      await envios.tablaLista;
      const dig = cliente.replace(/\D/g, '');
      const r = await pool.query(`
        SELECT e.* FROM wa_envios e
         WHERE e.tipo = 'ticket'
           AND ($1 = '' OR EXISTS (SELECT 1 FROM unnest(e.numeros) n WHERE ltrim(n, '0') = ltrim($1, '0')))
           AND ($2::text IS NULL OR e.rifa = $2)
           AND ($3 = '' OR e.nombre ILIKE '%' || $3 || '%' OR ($4 <> '' AND e.jid LIKE '%' || $4 || '%'))
         ORDER BY e.id DESC LIMIT 6`,
        [numero, rifa?.nombre || null, cliente, dig.length >= 4 ? dig.replace(/^0/, '') : '']);
      if (!r.rows.length) {
        return { encontrado: false, nota: 'No hay ticket con esos datos. Solo se guarda la imagen de las compras en línea (página o WhatsApp) ya aprobadas; los boletos de los vendedores no tienen imagen en el sistema.' };
      }
      const lista = r.rows.map((e) => ({
        cliente: e.nombre, telefono: String(e.jid).split('@')[0], rifa: e.rifa, numeros: e.numeros,
        envio_al_cliente: ESTADOS_ENVIO[e.estado] || e.estado, ...(e.error ? { detalle: e.error } : {}),
        imagenes: e.imagenes.length, aprobado: haceCuanto(e.created_at),
      }));
      if (r.rows.length > 1) return { tickets: lista, nota: 'Hay varias compras que coinciden: pregúntale cuál (por cliente o por rifa) antes de mandar o reenviar nada.' };

      const e = r.rows[0];
      // La foto i corresponde al número i; si pidió un número, solo esa
      const sinCeros = (n) => String(n).replace(/^0+(?=\d)/, '');
      const fotos = e.imagenes
        .map((url, i) => ({ url, numero: e.numeros[i] }))
        .filter((f) => !numero || e.imagenes.length === 1 || sinCeros(f.numero) === sinCeros(numero));
      if (ctx.efectos && fotos.length) {
        ctx.efectos.fotos = [...(ctx.efectos.fotos || []), ...fotos.slice(0, 4).map((f) => ({ url: f.url, caption: `🎟️ ${e.nombre || 'Cliente'} · ${e.rifa}${f.numero ? ` · ${f.numero}` : ''}` }))];
      }
      let reenvio;
      if (args.reenviar_al_cliente) {
        if (['en_cola', 'enviando'].includes(e.estado)) reenvio = 'Ya estaba en cola para enviarse al cliente; sale en un momento.';
        else if (ctx.prueba) reenvio = 'Modo prueba: no se reenvió.';
        else { await envios.reintentar(e.id); reenvio = 'Listo: se puso en cola y le llega al cliente en un momento.'; }
      }
      return {
        ticket: lista[0],
        imagen: fotos.length ? `El SISTEMA te manda ${fotos.length > 1 ? `las ${Math.min(fotos.length, 4)} imágenes` : 'la imagen'} justo después de tu mensaje.` : 'Esta compra no tiene imagen de ticket guardada (se aprobó sin generar la imagen).',
        ...(reenvio ? { reenvio_al_cliente: reenvio } : {}),
      };
    }
    case 'dueno_vendedores': {
      const filtro = String(args.vendedor || '').trim();
      const lista = await vendedoresSvc.directorio({ texto: filtro });
      if (!lista.length) return { encontrado: false, nota: filtro ? 'No hay ningún vendedor con ese nombre, usuario o cédula.' : 'No hay vendedores registrados.' };
      const series = (s, tipo) => (tipo === 'simultanea'
        ? Object.fromEntries(Object.entries(s).map(([serie, ns]) => [`serie ${serie}`, enRangos(ns)]))
        : enRangos(Object.values(s).flat()));
      // Ficha completa si se buscó a alguien (hasta 3 coincidencias); si no, resumen de todos
      if (filtro && lista.length <= 3) {
        return {
          vendedores: lista.map((v) => ({
            nombre: v.nombre, usuario: v.usuario, cedula: v.cedula || 'sin cédula', estado: v.activo ? 'activo' : 'inactivo',
            ventas_registradas: v.total_ventas, total_vendido: pesos(v.total_ingresos),
            ultima_venta: v.ultima_venta ? haceCuanto(v.ultima_venta) : 'nunca',
            numeros_fijos: v.numeros_fijos.length
              ? v.numeros_fijos.map((c) => ({ categoria: c.categoria, tipo: c.tipo, cantidad: c.cantidad, numeros: series(c.series, c.tipo) }))
              : 'no tiene números fijos',
            rifas: v.rifas.length
              ? v.rifas.map((r) => ({
                  rifa_id: r.rifa_id, rifa: r.rifa, estado: r.activa ? 'en venta' : 'ya sorteada', sorteo: r.fecha_sorteo, categoria: r.categoria,
                  cantidad: r.cantidad, vendidos_registrados: r.vendidos, numeros: r.cantidad ? series(r.series, r.tipo) : 'sin números asignados',
                }))
              : 'no participa en rifas activas ni recientes',
          })),
        };
      }
      return {
        total: lista.length, activos: lista.filter((v) => v.activo).length,
        vendedores: lista.slice(0, 60).map((v) => ({
          nombre: v.nombre, estado: v.activo ? 'activo' : 'inactivo', numeros_fijos: v.total_numeros_fijos,
          categorias: v.numeros_fijos.map((c) => c.categoria),
          rifas: v.rifas.map((r) => `${r.rifa} (${r.cantidad} números${r.activa ? '' : ', ya sorteada'})`),
          ventas_registradas: v.total_ventas,
        })),
        nota: 'Para ver los números de uno, vuelve a llamar con su nombre en "vendedor".',
      };
    }
    case 'dueno_numeros_vendedores': {
      const rifa = await reservas.infoRifa(pool, args.rifa_id);
      if (!rifa) return { error: 'No encontré esa rifa. Usa dueno_rifas.' };
      const [nums, sel, vendidos, libres] = await Promise.all([
        pool.query(`
          SELECT x.vendedor_id, u.nombre, x.numero, x.serie FROM (
            SELECT vendedor_id, TRIM(numero::text) AS numero, COALESCE(TRIM(serie), 'A') AS serie FROM numeros_vendedor WHERE rifa_id = $1
            UNION ALL
            SELECT vendedor_id, TRIM(numero), COALESCE(TRIM(serie), 'A') FROM boleteria_numeros_extra WHERE rifa_id = $1
          ) x JOIN users u ON u.id = x.vendedor_id`, [rifa.id]),
        pool.query(`SELECT s.vendedor_id, u.nombre FROM rifa_vendedores_sel s JOIN users u ON u.id = s.vendedor_id WHERE s.rifa_id = $1`, [rifa.id]).catch(() => ({ rows: [] })),
        pool.query(`SELECT vendedor_id, COUNT(*)::int n FROM ventas WHERE rifa_id = $1 AND COALESCE(origen, 'vendedor') = 'vendedor' GROUP BY 1`, [rifa.id]),
        reservas.numerosLibres(pool, rifa, { cantidad: 1 }),
      ]);
      const simultanea = rifa.tipo === 'simultanea';
      const porVendedor = new Map();
      for (const v of sel.rows) porVendedor.set(v.vendedor_id, { vendedor: v.nombre, series: {} });
      for (const x of nums.rows) {
        const v = porVendedor.get(x.vendedor_id) || { vendedor: x.nombre, series: {} };
        (v.series[x.serie] = v.series[x.serie] || []).push(x.numero);
        porVendedor.set(x.vendedor_id, v);
      }
      const ventasDe = Object.fromEntries(vendidos.rows.map((x) => [x.vendedor_id, x.n]));
      const filtro = String(args.vendedor || '').trim().toLowerCase();
      let lista = [...porVendedor.entries()].map(([id, v]) => {
        const todos = Object.values(v.series).flat();
        return {
          vendedor: v.vendedor, cantidad: todos.length, vendidos_registrados: ventasDe[id] || 0,
          numeros: !todos.length ? 'sin números asignados'
            : simultanea ? Object.fromEntries(Object.entries(v.series).map(([serie, ns]) => [`serie ${serie}`, enRangos(ns)]))
            : enRangos(todos),
        };
      }).sort((a, b) => b.cantidad - a.cantidad);
      if (filtro) {
        lista = lista.filter((v) => v.vendedor.toLowerCase().includes(filtro));
        if (!lista.length) return { rifa: rifa.nombre, encontrado: false, nota: `Ningún vendedor con ese nombre tiene números en esta rifa.` };
      }
      return {
        rifa: rifa.nombre, vendedores: lista.slice(0, 40),
        ...(filtro ? {} : { total_con_vendedores: nums.rows.length, libres_para_venta_en_linea: libres.totalLibres }),
        nota: 'vendidos_registrados son las ventas que el vendedor anotó en el sistema. Para asignar, quitar o mover números hay que hacerlo en el panel (Rifas / Números Fijos).',
      };
    }
    default:
      return null;   // no es una herramienta del dueño
  }
}

module.exports = { DEFINICIONES, ejecutar };
