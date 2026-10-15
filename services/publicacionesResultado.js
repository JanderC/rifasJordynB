// ============================================================
//  publicacionesResultado.js — La publicación de cada resultado
//  (módulo Resultados del panel): imagen + mensaje oficial.
//  La usan el envío al grupo y el bot cuando un cliente pregunta
//  por un resultado (le manda esa misma publicación).
// ============================================================
const pool = require('../config/db');

// ── Mensaje para el grupo ─────────────────────────────────────
// El mismo armado que muestra el panel (pages/Resultados.js → mensajeResultado).
const DIAS  = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
function fechaLarga(f) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(f || ''));
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return `${DIAS[d.getDay()]} ${+m[3]} de ${MESES[+m[2] - 1]} de ${m[1]}`;
}
function hora12(h) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(h || ''));
  if (!m) return '';
  const hh = +m[1];
  return `${((hh + 11) % 12) + 1}:${m[2]} ${hh < 12 ? 'am' : 'pm'}`;
}
function mensajeResultado({ titulo, rifa, fecha, loteria, numero, premio, vendido_por: vendidoPor, descripcion }) {
  const l = [`🎉 *${String(titulo || 'Resultado').toUpperCase()}* 🎉`, ''];
  if (rifa) l.push(`🎟️ Sorteo: *${rifa}*`);
  if (fecha) l.push(`📅 ${fecha}`);
  if (loteria) l.push(`🎰 Lotería: ${loteria}`);
  if (numero) l.push('', `🔢 Número ganador: *${numero}*`);
  if (premio) l.push(`🏆 Premio: ${premio}`);
  if (vendidoPor) l.push(`🤝 Vendido por: *${vendidoPor}*`);
  if (descripcion) l.push('', descripcion);
  l.push('', '¡Felicidades al ganador y gracias a todos por participar! 🍀');
  return l.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
// Texto final: el que escribió/ajustó el dueño o, si no hay, el armado con los datos
async function textoParaGrupo(r) {
  if (r.mensaje && r.mensaje.trim()) return r.mensaje.trim();
  const rifa = r.rifa_id ? (await pool.query(`SELECT nombre, premio, loteria_ref, hora_sorteo::text AS hora FROM rifas WHERE id = $1`, [r.rifa_id])).rows[0] : null;
  return mensajeResultado({
    titulo: r.titulo, rifa: rifa?.nombre, fecha: fechaLarga(r.fecha),
    loteria: rifa?.loteria_ref ? `${rifa.loteria_ref}${hora12(rifa.hora) ? ` · ${hora12(rifa.hora)}` : ''}` : null,
    numero: r.numero, premio: rifa?.premio, vendido_por: r.vendido_por, descripcion: r.descripcion,
  });
}

// Publicaciones visibles recientes, la más nueva primero
async function recientes(dias = 30) {
  const r = await pool.query(
    `SELECT id, titulo, descripcion, rifa_id, TO_CHAR(fecha, 'YYYY-MM-DD') AS fecha, imagen_url, numero, vendido_por, mensaje, created_at
       FROM resultados_publicados
      WHERE visible AND COALESCE(fecha, created_at::date) >= (NOW() AT TIME ZONE 'America/Caracas')::date - $1::int
      ORDER BY fecha DESC NULLS LAST, created_at DESC
      LIMIT 20`, [dias]).catch(() => ({ rows: [] }));   // la tabla puede no existir todavía
  return r.rows;
}

async function porId(id) {
  const r = await pool.query(
    `SELECT id, titulo, descripcion, rifa_id, TO_CHAR(fecha, 'YYYY-MM-DD') AS fecha, imagen_url, numero, vendido_por, mensaje
       FROM resultados_publicados WHERE id = $1 AND visible`, [id]).catch(() => ({ rows: [] }));
  return r.rows[0] || null;
}

module.exports = { mensajeResultado, textoParaGrupo, recientes, porId, fechaLarga };
