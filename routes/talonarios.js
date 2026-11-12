// ============================================================
//  routes/talonarios.js — Talonarios de tickets de 3 números
//  Independiente del resto del sistema: no toca rifas, vendedores,
//  números ni caja. Cada talonario guarda su diseño y sus combinaciones
//  (cada ticket lleva 3 números del 000 al 999 que no se repiten en la serie),
//  para reimprimirlo igual desde cualquier equipo.
//   GET    /api/talonarios          lista
//   GET    /api/talonarios/:id      uno completo
//   POST   /api/talonarios          { nombre, datos }
//   PUT    /api/talonarios/:id      { nombre, datos }
//   DELETE /api/talonarios/:id
// ============================================================
const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { authMiddleware, soloDueno } = require('../middleware/auth');

const tablaLista = pool.query(`
  CREATE TABLE IF NOT EXISTS talonarios_triples (
    id          SERIAL PRIMARY KEY,
    nombre      VARCHAR(120) NOT NULL,
    datos       JSONB NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`).catch((e) => console.error('[talonarios] esquema:', e.message));

// Revisa que las combinaciones sean válidas: 3 números por ticket, 0–999, ninguno repetido
function limpiar(body) {
  const nombre = String(body?.nombre || '').trim().slice(0, 120);
  if (!nombre) throw new Error('Ponle un nombre al talonario');
  const d = body?.datos || {};
  const tickets = Array.isArray(d.tickets) ? d.tickets : [];
  if (!tickets.length || tickets.length > 333) throw new Error('El talonario debe tener entre 1 y 333 tickets');
  const vistos = new Set();
  for (const t of tickets) {
    if (!Array.isArray(t) || t.length !== 3) throw new Error('Cada ticket debe tener 3 números');
    for (const n of t) {
      if (!Number.isInteger(n) || n < 0 || n > 999) throw new Error('Los números van del 000 al 999');
      if (vistos.has(n)) throw new Error(`El ${String(n).padStart(3, '0')} está repetido`);
      vistos.add(n);
    }
  }
  const datos = { ...d, tickets };
  if (JSON.stringify(datos).length > 200000) throw new Error('El talonario es demasiado grande');
  return { nombre, datos };
}

router.use(authMiddleware, soloDueno);

router.get('/', async (req, res) => {
  try {
    await tablaLista;
    const r = await pool.query(`
      SELECT id, nombre, jsonb_array_length(datos->'tickets') AS tickets, datos->>'serie' AS serie, created_at, updated_at
        FROM talonarios_triples ORDER BY updated_at DESC`);
    res.json(r.rows);
  } catch (e) { console.error('talonarios:', e); res.status(500).json({ error: 'Error del servidor' }); }
});

router.get('/:id', async (req, res) => {
  try {
    await tablaLista;
    const r = await pool.query(`SELECT * FROM talonarios_triples WHERE id = $1`, [Number(req.params.id) || 0]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Talonario no encontrado' });
    res.json(r.rows[0]);
  } catch (e) { console.error('talonarios:', e); res.status(500).json({ error: 'Error del servidor' }); }
});

router.post('/', async (req, res) => {
  let x; try { x = limpiar(req.body); } catch (e) { return res.status(400).json({ error: e.message }); }
  try {
    await tablaLista;
    const r = await pool.query(`INSERT INTO talonarios_triples (nombre, datos) VALUES ($1, $2) RETURNING *`, [x.nombre, x.datos]);
    res.json(r.rows[0]);
  } catch (e) { console.error('talonarios:', e); res.status(500).json({ error: 'Error del servidor' }); }
});

router.put('/:id', async (req, res) => {
  let x; try { x = limpiar(req.body); } catch (e) { return res.status(400).json({ error: e.message }); }
  try {
    await tablaLista;
    const r = await pool.query(`UPDATE talonarios_triples SET nombre = $1, datos = $2, updated_at = NOW() WHERE id = $3 RETURNING *`,
      [x.nombre, x.datos, Number(req.params.id) || 0]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Talonario no encontrado' });
    res.json(r.rows[0]);
  } catch (e) { console.error('talonarios:', e); res.status(500).json({ error: 'Error del servidor' }); }
});

router.delete('/:id', async (req, res) => {
  try {
    await tablaLista;
    await pool.query(`DELETE FROM talonarios_triples WHERE id = $1`, [Number(req.params.id) || 0]);
    res.json({ ok: true });
  } catch (e) { console.error('talonarios:', e); res.status(500).json({ error: 'Error del servidor' }); }
});

module.exports = router;
