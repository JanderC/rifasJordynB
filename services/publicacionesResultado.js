// ============================================================
//  publicacionesResultado.js — La publicación de cada resultado
//  (módulo Resultados del panel): imagen + mensaje oficial.
//
//  El texto sale de DOS PLANTILLAS que el dueño edita en el panel
//  (se guardan en la configuración del bot, mensajes_resultado):
//    • grupo   → lo que se publica en el grupo de WhatsApp
//    • privado → lo que el bot le manda a quien pregunta por el resultado
//  Llevan variables como {numero} o {sorteo}. Una línea cuya variable
//  quede vacía (por ejemplo, sin lotería cargada) no se envía.
// ============================================================
const pool = require('../config/db');
const { obtenerConfig, DEFECTO } = require('../whatsapp/botConfig');

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

// Variables disponibles en las plantillas (las mismas que muestra el panel)
const VARIABLES = ['titulo', 'sorteo', 'fecha', 'hora', 'loteria', 'numero', 'premio', 'vendido_por', 'descripcion'];

// Reemplaza las variables. {variable} tal cual; {VARIABLE} en mayúsculas.
// Si una línea usa una variable vacía, esa línea se quita entera.
function renderPlantilla(plantilla, vars) {
  const valor = (k) => String(vars[k.toLowerCase()] ?? '').trim();
  const lineas = [];
  for (const linea of String(plantilla || '').split('\n')) {
    const usadas = [...linea.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).filter((k) => VARIABLES.includes(k.toLowerCase()));
    if (usadas.some((k) => !valor(k))) continue;
    lineas.push(linea.replace(/\{(\w+)\}/g, (todo, k) => {
      if (!VARIABLES.includes(k.toLowerCase())) return todo;
      const v = valor(k);
      return k === k.toUpperCase() && k !== k.toLowerCase() ? v.toUpperCase() : v;
    }));
  }
  return lineas.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Datos de una publicación para las plantillas
async function variablesDe(r) {
  const rifa = r.rifa_id ? (await pool.query(`SELECT nombre, premio, loteria_ref, hora_sorteo::text AS hora FROM rifas WHERE id = $1`, [r.rifa_id])).rows[0] : null;
  return {
    titulo: r.titulo || 'Resultado', sorteo: rifa?.nombre || '', fecha: fechaLarga(r.fecha) || '', hora: hora12(rifa?.hora),
    loteria: rifa?.loteria_ref || '', numero: r.numero || '', premio: rifa?.premio || '',
    vendido_por: r.vendido_por || '', descripcion: r.descripcion || '',
  };
}

async function plantillas() {
  const cfg = await obtenerConfig();
  const p = cfg.mensajes_resultado || {};
  const d = DEFECTO.mensajes_resultado;
  return { grupo: String(p.grupo || '').trim() ? p.grupo : d.grupo, privado: String(p.privado || '').trim() ? p.privado : d.privado };
}

// Grupo: el texto ajustado a mano para esa publicación o, si no hay, la plantilla del grupo
async function textoParaGrupo(r) {
  if (r.mensaje && r.mensaje.trim()) return r.mensaje.trim();
  return renderPlantilla((await plantillas()).grupo, await variablesDe(r));
}

// Privado (el bot a quien pregunta): siempre la plantilla privada
async function textoPrivado(r) {
  return renderPlantilla((await plantillas()).privado, await variablesDe(r));
}

// Publicaciones recientes, la más nueva primero. "Mostrar en la página" solo decide si salen
// en la página del cliente: al bot le sirven igual para responder.
async function recientes(dias = 30) {
  const r = await pool.query(
    `SELECT id, titulo, descripcion, rifa_id, TO_CHAR(fecha, 'YYYY-MM-DD') AS fecha, imagen_url, numero, vendido_por, mensaje, created_at
       FROM resultados_publicados
      WHERE COALESCE(fecha, created_at::date) >= (NOW() AT TIME ZONE 'America/Caracas')::date - $1::int
      ORDER BY fecha DESC NULLS LAST, created_at DESC
      LIMIT 20`, [dias]).catch(() => ({ rows: [] }));   // la tabla puede no existir todavía
  return r.rows;
}

async function porId(id) {
  const r = await pool.query(
    `SELECT id, titulo, descripcion, rifa_id, TO_CHAR(fecha, 'YYYY-MM-DD') AS fecha, imagen_url, numero, vendido_por, mensaje
       FROM resultados_publicados WHERE id = $1`, [id]).catch(() => ({ rows: [] }));
  return r.rows[0] || null;
}

module.exports = { VARIABLES, renderPlantilla, variablesDe, plantillas, textoParaGrupo, textoPrivado, recientes, porId, fechaLarga };
