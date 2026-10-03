// ============================================================
//  resultados.js — Resultados de los sorteos y quién tenía el número
//  Los carga el dueño (por WhatsApp hablándole al bot, o en el panel).
//  El bot los usa para responder "¿qué cayó?" y "¿quién ganó?".
// ============================================================
const pool = require('../config/db');
const bus  = require('./waBus');

const tablaLista = (async () => {
  const sqls = [
    `CREATE TABLE IF NOT EXISTS rifa_resultados (
       id          BIGSERIAL PRIMARY KEY,
       rifa_id     UUID NOT NULL REFERENCES rifas(id) ON DELETE CASCADE,
       premio      TEXT NOT NULL DEFAULT 'Premio mayor',   -- 'Premio mayor', '2do premio', 'A', 'B'…
       numero      VARCHAR(4) NOT NULL,
       serie       VARCHAR(2),                             -- en rifas simultáneas (A/B), opcional
       ganador     TEXT,                                   -- nombre a anunciar (lo detecta el sistema o lo dice el dueño)
       detalle     TEXT,                                   -- p. ej. "lo tenía el vendedor Pedro" / "nadie lo compró"
       created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       UNIQUE (rifa_id, premio)
     )`,
  ];
  for (const sql of sqls) {
    try { await pool.query(sql); } catch (e) { console.error('[resultados] esquema:', e.message); }
  }
})();

// "Ana María Pérez Gómez" → "Ana P." (para anunciar sin exponer el nombre completo)
function nombreCorto(nombre) {
  const p = String(nombre || '').trim().split(/\s+/).filter(Boolean);
  if (!p.length) return null;
  return p.length === 1 ? p[0] : `${p[0]} ${p[p.length > 2 ? 2 : 1][0].toUpperCase()}.`;
}

// Quién tiene un número en una rifa: comprador en línea (página o WhatsApp), venta
// registrada en el panel, vendedor que lo tenía, reserva en curso o nadie
async function quienTiene(rifaId, numero) {
  const [ventas, fijos, extras, reservas] = await Promise.all([
    // El canal sale de `origen`; las ventas en línea viejas (sin origen) se reconocen por la observación
    pool.query(`SELECT v.nombre_comprador, v.telefono, v.cedula, v.created_at, v.reserva_id, u.nombre AS vendedor,
                       CASE WHEN v.origen IN ('web', 'whatsapp') THEN v.origen
                            WHEN v.observacion LIKE 'Compra online%' THEN 'web'
                            WHEN v.observacion LIKE 'Compra por WhatsApp%' THEN 'whatsapp'
                            ELSE 'vendedor' END AS origen
                  FROM ventas v LEFT JOIN users u ON u.id = v.vendedor_id
                 WHERE v.rifa_id = $1 AND TRIM(v.numero) = $2
                 ORDER BY v.created_at`, [rifaId, numero]),
    pool.query(`SELECT COALESCE(nv.serie, 'A') AS serie, u.nombre AS vendedor
                  FROM numeros_vendedor nv JOIN users u ON u.id = nv.vendedor_id
                 WHERE nv.rifa_id = $1 AND TRIM(nv.numero::text) = $2`, [rifaId, numero]),
    pool.query(`SELECT bx.serie, u.nombre AS vendedor
                  FROM boleteria_numeros_extra bx JOIN users u ON u.id = bx.vendedor_id
                 WHERE bx.rifa_id = $1 AND TRIM(bx.numero) = $2`, [rifaId, numero]),
    pool.query(`SELECT id, nombre_cliente, telefono, cedula, estado, COALESCE(origen, 'web') AS origen, updated_at
                  FROM reservas_cliente
                 WHERE rifa_id = $1 AND TRIM(numero) = $2
                   AND (estado IN ('pendiente', 'aprobado') OR (estado = 'apartado' AND apartado_hasta > NOW()))
                 ORDER BY updated_at`, [rifaId, numero]),
  ]);
  // Una reserva aprobada ES una venta en línea aunque no tenga su fila en ventas
  // (venta anulada en Historial, o no se pudo insertar): el número no está libre.
  const conVenta = new Set(ventas.rows.map((v) => v.reserva_id).filter(Boolean));
  const aprobadasSinVenta = reservas.rows.filter((r) => r.estado === 'aprobado' && !conVenta.has(r.id));
  return {
    numero,
    compradores_en_linea: [
      ...ventas.rows.filter((v) => v.origen !== 'vendedor').map((v) => ({ nombre: v.nombre_comprador, telefono: v.telefono, cedula: v.cedula, canal: v.origen, fecha: v.created_at })),
      ...aprobadasSinVenta.map((r) => ({ nombre: r.nombre_cliente, telefono: r.telefono, cedula: r.cedula, canal: r.origen === 'whatsapp' ? 'whatsapp' : 'web', fecha: r.updated_at, sin_venta_registrada: true })),
    ],
    // Ventas anotadas en el panel (por un vendedor o venta directa del dueño), con su comprador
    ventas_registradas: ventas.rows.filter((v) => v.origen === 'vendedor').map((v) => ({ nombre: v.nombre_comprador, telefono: v.telefono, cedula: v.cedula, vendedor: v.vendedor, fecha: v.created_at })),
    vendedores: [...fijos.rows, ...extras.rows].map((x) => ({ vendedor: x.vendedor, serie: String(x.serie || '').trim() || null })),
    reservas_en_curso: reservas.rows.filter((r) => r.estado !== 'aprobado').map((r) => ({ nombre: r.nombre_cliente, telefono: r.telefono, estado: r.estado })),
  };
}

// Normaliza el número a las cifras de la rifa y registra (o corrige) el resultado.
// Si no se indica el ganador, se deduce de quién tenía el número.
async function registrar({ rifaId, numero, premio = 'Premio mayor', serie = null, ganador = null }) {
  await tablaLista;
  const r = await pool.query(`SELECT id, nombre, COALESCE(cifras, 3) AS cifras FROM rifas WHERE id = $1`, [rifaId]);
  const rifa = r.rows[0];
  if (!rifa) throw new Error('Rifa no encontrada');
  const raw = String(numero ?? '').replace(/\D/g, '');
  if (!raw || raw.length > Number(rifa.cifras)) throw new Error(`El número debe tener hasta ${rifa.cifras} cifras`);
  const num = raw.padStart(Number(rifa.cifras), '0');

  const t = await quienTiene(rifaId, num);
  let detalle;
  const vendedores = serie ? t.vendedores.filter((v) => !v.serie || v.serie === serie.toUpperCase()) : t.vendedores;
  if (t.compradores_en_linea.length) {
    const c = t.compradores_en_linea[0];
    if (!ganador) ganador = nombreCorto(c.nombre);
    detalle = `Lo compró ${c.nombre} por ${c.canal === 'whatsapp' ? 'WhatsApp' : 'la página'}${c.telefono ? ` (${c.telefono})` : ''}`;
  } else if (vendedores.length) {
    detalle = `Lo tenía ${vendedores.length > 1 ? 'los vendedores' : 'el vendedor'} ${vendedores.map((v) => v.vendedor + (v.serie ? ` (serie ${v.serie})` : '')).join(' y ')}`;
  } else {
    detalle = 'Nadie tenía ese número';
  }

  const ins = await pool.query(`
    INSERT INTO rifa_resultados (rifa_id, premio, numero, serie, ganador, detalle)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (rifa_id, premio) DO UPDATE
      SET numero = EXCLUDED.numero, serie = EXCLUDED.serie, ganador = EXCLUDED.ganador, detalle = EXCLUDED.detalle, created_at = NOW()
    RETURNING *`, [rifaId, String(premio).trim() || 'Premio mayor', num, serie ? serie.toUpperCase() : null, ganador || null, detalle]);
  bus.emit('resultado:registrado', { rifaId });   // el bot lo anuncia en el grupo de WhatsApp
  return { ...ins.rows[0], rifa: rifa.nombre, tenencia: t };
}

async function eliminar(id) {
  await tablaLista;
  await pool.query(`DELETE FROM rifa_resultados WHERE id = $1`, [id]);
}

// Rifas ya sorteadas (o que se sortean hoy) con sus resultados, las más recientes primero
async function sorteosRecientes(dias = 21) {
  await tablaLista;
  const r = await pool.query(`
    SELECT r.id, r.nombre, r.premio, r.fecha_sorteo::text AS fecha_sorteo, r.hora_sorteo::text AS hora_sorteo,
           r.loteria_ref, COALESCE(r.cifras, 3) AS cifras, COALESCE(r.tipo, 'sencilla') AS tipo,
           (r.fecha_sorteo + COALESCE(r.hora_sorteo, '00:00'::time)) <= (NOW() AT TIME ZONE 'America/Caracas') AS ya_sorteo,
           COALESCE((SELECT json_agg(json_build_object('id', x.id, 'premio', x.premio, 'numero', x.numero, 'serie', x.serie,
                                                       'ganador', x.ganador, 'detalle', x.detalle) ORDER BY x.id)
                       FROM rifa_resultados x WHERE x.rifa_id = r.id), '[]'::json) AS resultados
      FROM rifas r
     WHERE r.fecha_sorteo IS NOT NULL
       AND r.fecha_sorteo <= (NOW() AT TIME ZONE 'America/Caracas')::date
       AND r.fecha_sorteo >= (NOW() AT TIME ZONE 'America/Caracas')::date - $1::int
     ORDER BY r.fecha_sorteo DESC, r.hora_sorteo DESC NULLS LAST`, [dias]);
  return r.rows;
}

module.exports = { tablaLista, registrar, eliminar, sorteosRecientes, quienTiene, nombreCorto };
