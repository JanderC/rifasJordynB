// ============================================================
//  rifaOpciones.js — Opciones de cada rifa para la venta en línea
//   • publicada: si sale en la página del cliente (y la ofrece el bot)
//   • premios_extra: premios adicionales al premio mayor [{ nombre, detalle }]
//   • pago_diferido: el cliente puede APARTAR sin pagar y pagar después,
//     hasta `diferido_limite_horas` antes del sorteo. Si no paga, el número
//     se libera. El bot le va recordando por WhatsApp.
// ============================================================
const pool = require('../config/db');

const esquemaListo = (async () => {
  const sqls = [
    `ALTER TABLE rifas ADD COLUMN IF NOT EXISTS publicada BOOLEAN NOT NULL DEFAULT TRUE`,
    `ALTER TABLE rifas ADD COLUMN IF NOT EXISTS premios_extra JSONB NOT NULL DEFAULT '[]'::jsonb`,
    `ALTER TABLE rifas ADD COLUMN IF NOT EXISTS pago_diferido BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE rifas ADD COLUMN IF NOT EXISTS diferido_limite_horas SMALLINT NOT NULL DEFAULT 3`,
    `ALTER TABLE rifas ADD COLUMN IF NOT EXISTS diferido_max_numeros SMALLINT NOT NULL DEFAULT 10`,
    // Reserva apartada para pagar después (distinta del apartado corto del bot mientras llega el comprobante)
    `ALTER TABLE reservas_cliente ADD COLUMN IF NOT EXISTS pago_diferido BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE reservas_cliente ADD COLUMN IF NOT EXISTS recordatorios JSONB NOT NULL DEFAULT '[]'::jsonb`,
    `CREATE INDEX IF NOT EXISTS idx_reservas_diferidas ON reservas_cliente (rifa_id) WHERE estado = 'apartado' AND pago_diferido`,
  ];
  for (const sql of sqls) {
    try { await pool.query(sql); } catch (e) { console.error('[rifaOpciones] esquema:', e.message); }
  }
})();

// Columnas para los SELECT de rifas (alias de la tabla)
const COLUMNAS = (a = 'r') => `
  ${a}.publicada, COALESCE(${a}.premios_extra, '[]'::jsonb) AS premios_extra,
  ${a}.pago_diferido, ${a}.diferido_limite_horas, ${a}.diferido_max_numeros`;

function limpiarPremios(lista) {
  return (Array.isArray(lista) ? lista : [])
    .map((p) => ({ nombre: String(p?.nombre ?? '').trim().slice(0, 120), detalle: String(p?.detalle ?? '').trim().slice(0, 200) }))
    .filter((p) => p.nombre)
    .slice(0, 12);
}

// Guarda las opciones que vengan en el body (las que no vienen no se tocan)
async function guardar(db, rifaId, body = {}) {
  await esquemaListo;
  const sets = [];
  const vals = [];
  const poner = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
  if (typeof body.publicada === 'boolean') poner('publicada', body.publicada);
  if (body.premios_extra !== undefined) poner('premios_extra', JSON.stringify(limpiarPremios(body.premios_extra)));
  if (typeof body.pago_diferido === 'boolean') poner('pago_diferido', body.pago_diferido);
  if (body.diferido_limite_horas !== undefined) poner('diferido_limite_horas', Math.min(72, Math.max(0, Math.round(Number(body.diferido_limite_horas)) || 0)));
  if (body.diferido_max_numeros !== undefined) poner('diferido_max_numeros', Math.min(50, Math.max(1, Math.round(Number(body.diferido_max_numeros)) || 10)));
  if (!sets.length) return null;
  vals.push(rifaId);
  const r = await db.query(
    `UPDATE rifas SET ${sets.join(', ')} WHERE id = $${vals.length}
     RETURNING publicada, premios_extra, pago_diferido, diferido_limite_horas, diferido_max_numeros`, vals);
  return r.rows[0] || null;
}

// Momento del sorteo (hora de Venezuela). Sin hora cargada se asume 8:00 p. m.
function momentoSorteo(rifa) {
  if (!rifa?.fecha_sorteo) return null;
  const fecha = String(rifa.fecha_sorteo).slice(0, 10);
  const hora = rifa.hora_sorteo ? String(rifa.hora_sorteo).slice(0, 8).padEnd(8, ':00').slice(0, 8) : '20:00:00';
  const d = new Date(`${fecha}T${hora}-04:00`);
  return isNaN(d.getTime()) ? null : d;
}

// Hasta cuándo se puede pagar un número apartado (Date) o null si la rifa no lo permite
function limiteDePago(rifa) {
  if (!rifa?.pago_diferido) return null;
  const sorteo = momentoSorteo(rifa);
  if (!sorteo) return null;
  return new Date(sorteo.getTime() - (Number(rifa.diferido_limite_horas) || 0) * 3600000);
}

// ¿Se puede apartar sin pagar ahora mismo? (queda al menos media hora para pagar)
function puedeApartarse(rifa) {
  const limite = limiteDePago(rifa);
  return !!limite && limite.getTime() - Date.now() > 30 * 60000;
}

// "sábado 4 de octubre a las 7:10 p. m."
function fmtLimite(d) {
  if (!d) return '';
  const dia = d.toLocaleDateString('es-VE', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Caracas' });
  const hora = d.toLocaleTimeString('es-VE', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/Caracas' });
  return `${dia} a las ${hora}`;
}

module.exports = { esquemaListo, COLUMNAS, guardar, limpiarPremios, momentoSorteo, limiteDePago, puedeApartarse, fmtLimite };
