const express = require('express');
const router  = express.Router();
const pool    = require('../config/db');
const { authMiddleware, soloDueno } = require('../middleware/auth');

// ============================================================
//  Tasas de referencia (las mismas APIs de los otros proyectos)
//   • bcv      — dólar oficial del BCV, Bs por USD      (ve.dolarapi.com)
//   • paralelo — dólar paralelo, Bs por USD             (ve.dolarapi.com)
//   • oficial  — dólar oficial en Colombia, COP por USD (co.dolarapi.com)
//  Cada tasa del sistema puede quedar "manual" (como siempre) o seguir sola
//  una de estas fuentes: se revisa cada hora y se guarda si cambió.
// ============================================================
const FUENTES = {
  BSD_POR_USD: ['manual', 'bcv', 'paralelo'],
  COP_POR_USD: ['manual', 'oficial'],
};
const NOMBRE_FUENTE = { bcv: 'BCV (oficial)', paralelo: 'dólar paralelo', oficial: 'dólar oficial de Colombia' };

const esquemaListo = pool.query(`
  CREATE TABLE IF NOT EXISTS config_tasas_auto (
    clave        VARCHAR(40) PRIMARY KEY,
    fuente       VARCHAR(20) NOT NULL DEFAULT 'manual',
    revisado_at  TIMESTAMPTZ,
    error        TEXT
  )`).catch((e) => console.error('[tasas] esquema:', e.message));

async function traer(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(9000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

let cacheRef = null, cacheAt = 0;
// { bcv, paralelo, oficial } → cada una { valor, fecha } o null si la API no respondió
async function referencias({ fresca = false } = {}) {
  if (!fresca && cacheRef && Date.now() - cacheAt < 10 * 60000) return cacheRef;
  const [ve, co] = await Promise.allSettled([
    traer('https://ve.dolarapi.com/v1/dolares'),
    traer('https://co.dolarapi.com/v1/cotizaciones/usd'),
  ]);
  const out = { bcv: null, paralelo: null, oficial: null, consultado_at: new Date().toISOString() };
  if (ve.status === 'fulfilled' && Array.isArray(ve.value)) {
    for (const [clave, fuente] of [['bcv', 'oficial'], ['paralelo', 'paralelo']]) {
      const d = ve.value.find((x) => x.fuente === fuente);
      const valor = Number(d?.promedio) || Number(d?.venta) || 0;
      if (valor > 0) out[clave] = { valor: +valor.toFixed(2), fecha: d.fechaActualizacion || null };
    }
  }
  if (co.status === 'fulfilled' && co.value) {
    const c = Number(co.value.compra), v = Number(co.value.venta);
    const valor = c > 0 && v > 0 ? (c + v) / 2 : (v || c || 0);
    if (valor > 0) out.oficial = { valor: Math.round(valor), fecha: co.value.fechaActualizacion || null };
  }
  if (out.bcv || out.paralelo || out.oficial) { cacheRef = out; cacheAt = Date.now(); }
  return out;
}

// Guarda en la tasa del sistema el valor actual de la fuente. Devuelve { valor, cambio }
async function aplicar(clave, fuente, userId = null) {
  const ref = (await referencias({ fresca: true }))[fuente];
  if (!ref?.valor) throw new Error(`No se pudo consultar ${NOMBRE_FUENTE[fuente] || fuente} en este momento. Intenta de nuevo en unos minutos.`);
  const antes = (await pool.query(`SELECT valor FROM config_tasas WHERE clave = $1`, [clave])).rows[0];
  if (antes && Number(antes.valor) === ref.valor) return { valor: ref.valor, cambio: false };
  await pool.query(
    `INSERT INTO config_tasas (clave, valor, updated_by, updated_at) VALUES ($1, $2, $3, NOW())
     ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
    [clave, ref.valor, userId]);
  return { valor: ref.valor, cambio: true };
}

async function fuentesGuardadas() {
  await esquemaListo;
  const r = await pool.query(`SELECT clave, fuente, revisado_at, error FROM config_tasas_auto`);
  const out = {};
  for (const clave of Object.keys(FUENTES)) out[clave] = { fuente: 'manual', revisado_at: null, error: null };
  for (const x of r.rows) if (FUENTES[x.clave]?.includes(x.fuente)) out[x.clave] = { fuente: x.fuente, revisado_at: x.revisado_at, error: x.error };
  return out;
}

// Las tasas en automático siguen a su fuente
async function actualizarAutomaticas() {
  const f = await fuentesGuardadas();
  for (const [clave, { fuente }] of Object.entries(f)) {
    if (fuente === 'manual') continue;
    let error = null;
    try {
      const r = await aplicar(clave, fuente);
      if (r.cambio) console.log(`💱 [Tasas] ${clave} = ${r.valor} (${NOMBRE_FUENTE[fuente]})`);
    } catch (e) { error = e.message; console.error(`❌ [Tasas] ${clave}:`, e.message); }
    await pool.query(`UPDATE config_tasas_auto SET revisado_at = NOW(), error = $2 WHERE clave = $1`, [clave, error]).catch(() => {});
  }
}
setTimeout(() => actualizarAutomaticas().catch(() => {}), 45000).unref();
setInterval(() => actualizarAutomaticas().catch(() => {}), 60 * 60000).unref();

// ── GET /api/tasas ─────────────────────────────────────────
// Pública: el frontend de clientes la consume sin auth
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT clave, valor, descripcion, updated_at
       FROM config_tasas
       ORDER BY clave`
    );
    // Devuelve objeto { COP_POR_USD: 4200, ... } para fácil consumo
    const obj = {};
    result.rows.forEach(r => { obj[r.clave] = { valor: parseFloat(r.valor), descripcion: r.descripcion, updated_at: r.updated_at }; });
    res.json(obj);
  } catch (err) {
    console.error('Error obteniendo tasas:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ── GET /api/tasas/referencias ─────────────────────────────
// Tasas del día (BCV, paralelo, oficial de Colombia) y de dónde sale cada tasa del sistema
router.get('/referencias', authMiddleware, soloDueno, async (req, res) => {
  try {
    res.json({ referencias: await referencias({ fresca: req.query.fresca === '1' }), fuentes: await fuentesGuardadas(), opciones: FUENTES });
  } catch (err) {
    console.error('Error consultando tasas de referencia:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ── PUT /api/tasas/:clave/fuente ───────────────────────────
// Body: { fuente: 'manual' | 'bcv' | 'paralelo' | 'oficial' }
// Con una fuente automática la tasa se actualiza ya y luego sola cada hora.
router.put('/:clave/fuente', authMiddleware, soloDueno, async (req, res) => {
  const { clave } = req.params;
  const fuente = String(req.body?.fuente || '');
  if (!FUENTES[clave]?.includes(fuente)) return res.status(400).json({ error: 'Fuente no válida para esta tasa' });
  try {
    await esquemaListo;
    let aplicado = null;
    if (fuente !== 'manual') aplicado = await aplicar(clave, fuente, req.user.id);   // si la API no responde no se cambia nada
    await pool.query(
      `INSERT INTO config_tasas_auto (clave, fuente, revisado_at, error) VALUES ($1, $2, NOW(), NULL)
       ON CONFLICT (clave) DO UPDATE SET fuente = EXCLUDED.fuente, revisado_at = NOW(), error = NULL`, [clave, fuente]);
    res.json({ ok: true, fuente, valor: aplicado?.valor ?? null });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ── POST /api/tasas/:clave/sincronizar ─────────────────────
// Body: { fuente } — copia una sola vez el valor de la fuente (la tasa sigue en manual)
router.post('/:clave/sincronizar', authMiddleware, soloDueno, async (req, res) => {
  const { clave } = req.params;
  const fuente = String(req.body?.fuente || '');
  if (fuente === 'manual' || !FUENTES[clave]?.includes(fuente)) return res.status(400).json({ error: 'Fuente no válida para esta tasa' });
  try {
    const r = await aplicar(clave, fuente, req.user.id);
    res.json({ ok: true, ...r });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ── PUT /api/tasas/:clave ──────────────────────────────────
// Solo dueño puede actualizar
router.put('/:clave', authMiddleware, soloDueno, async (req, res) => {
  const { clave } = req.params;
  const { valor, descripcion } = req.body;

  if (valor === undefined || isNaN(parseFloat(valor))) {
    return res.status(400).json({ error: 'El valor es requerido y debe ser numérico' });
  }
  if (parseFloat(valor) <= 0) {
    return res.status(400).json({ error: 'El valor debe ser mayor a cero' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO config_tasas (clave, valor, descripcion, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (clave) DO UPDATE
         SET valor      = EXCLUDED.valor,
             descripcion= COALESCE(EXCLUDED.descripcion, config_tasas.descripcion),
             updated_by = EXCLUDED.updated_by,
             updated_at = NOW()
       RETURNING *`,
      [clave, parseFloat(valor), descripcion || null, req.user.id]
    );
    // Escribirla a mano la deja en manual: si no, la automática la pisaría en una hora
    await esquemaListo;
    await pool.query(`UPDATE config_tasas_auto SET fuente = 'manual', error = NULL WHERE clave = $1`, [clave]).catch(() => {});
    res.json({ message: 'Tasa actualizada', tasa: result.rows[0] });
  } catch (err) {
    console.error('Error actualizando tasa:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

module.exports = router;
