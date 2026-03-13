const express = require('express');
const router  = express.Router();
const pool    = require('../config/db');
const { authMiddleware, soloDueno } = require('../middleware/auth');

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
    res.json({ message: 'Tasa actualizada', tasa: result.rows[0] });
  } catch (err) {
    console.error('Error actualizando tasa:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

module.exports = router;