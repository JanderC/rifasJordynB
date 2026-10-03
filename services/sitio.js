// ============================================================
//  sitio.js — Ajustes de la página del cliente (guardados en la BD)
//  El dueño los edita en Configuración: enlace del grupo de WhatsApp
//  (burbuja flotante) y el top de compradores.
// ============================================================
const pool = require('../config/db');
const { nombreCorto } = require('./resultados');

const DEFECTO = {
  grupo_whatsapp: 'https://chat.whatsapp.com/Ek5kcDvEPVn8ObjyzqWdEl',
  grupo_activo: true,            // mostrar la burbuja del grupo
  top_compradores_activo: true,  // mostrar el top de compradores
};
const TOP_CANTIDAD = 5;

const tablaLista = (async () => {
  try {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS config_sitio (
         id          INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
         config      JSONB NOT NULL DEFAULT '{}'::jsonb,
         updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )`);
  } catch (e) { console.error('[sitio] esquema:', e.message); }
})();

async function obtenerConfig() {
  await tablaLista;
  const r = await pool.query(`SELECT config FROM config_sitio WHERE id = 1`);
  return { ...DEFECTO, ...(r.rows[0]?.config || {}) };
}

// Solo enlaces de invitación de WhatsApp (grupo, canal o chat); sin parámetros de rastreo
function limpiarEnlace(url) {
  const t = String(url || '').trim();
  if (!t) return '';
  let u;
  try { u = new URL(t); } catch { return null; }
  if (u.protocol !== 'https:' || !['chat.whatsapp.com', 'whatsapp.com', 'www.whatsapp.com', 'wa.me'].includes(u.hostname)) return null;
  return `${u.origin}${u.pathname}`.replace(/\/$/, '');
}

async function guardarConfig(cambios) {
  const actual = await obtenerConfig();
  const nueva = { ...actual };
  if ('grupo_whatsapp' in cambios) {
    const enlace = limpiarEnlace(cambios.grupo_whatsapp);
    if (enlace === null) throw new Error('El enlace debe ser de WhatsApp (https://chat.whatsapp.com/...)');
    nueva.grupo_whatsapp = enlace;
  }
  for (const k of ['grupo_activo', 'top_compradores_activo']) {
    if (k in cambios) nueva[k] = cambios[k] === true;
  }
  await pool.query(
    `INSERT INTO config_sitio (id, config, updated_at) VALUES (1, $1, NOW())
     ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config, updated_at = NOW()`, [JSON.stringify(nueva)]);
  topCache = null;
  return nueva;
}

// Los que más números han comprado en las rifas que están en venta.
// Cuenta las compras con el pago aprobado (página, WhatsApp y venta directa);
// los boletos que venden los vendedores no registran al comprador.
// Una persona = su teléfono (o su nombre si no dejó teléfono).
let topCache = null;   // { at, lista }
async function topCompradores() {
  if (topCache && Date.now() - topCache.at < 60000) return topCache.lista;
  const r = await pool.query(`
    SELECT (ARRAY_AGG(rc.nombre_cliente ORDER BY rc.created_at DESC))[1] AS nombre, COUNT(*)::int AS numeros
      FROM reservas_cliente rc JOIN rifas r ON r.id = rc.rifa_id
     WHERE rc.estado = 'aprobado' AND r.activa
     GROUP BY COALESCE(NULLIF(regexp_replace(COALESCE(rc.telefono, ''), '\\D', '', 'g'), ''), LOWER(TRIM(rc.nombre_cliente)))
     ORDER BY COUNT(*) DESC, MIN(rc.created_at) ASC
     LIMIT $1`, [TOP_CANTIDAD]);
  // En público solo nombre e inicial del apellido ("Ana P.")
  const lista = r.rows.map((x, i) => ({ puesto: i + 1, nombre: nombreCorto(x.nombre) || 'Cliente', numeros: x.numeros }));
  topCache = { at: Date.now(), lista };
  return lista;
}

// Lo que recibe la página del cliente
async function datosPublicos() {
  const cfg = await obtenerConfig();
  return {
    grupo_whatsapp: cfg.grupo_activo && cfg.grupo_whatsapp ? cfg.grupo_whatsapp : null,
    top_compradores: cfg.top_compradores_activo ? await topCompradores() : [],
  };
}

module.exports = { obtenerConfig, guardarConfig, topCompradores, datosPublicos };
