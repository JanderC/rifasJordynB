const express = require('express');
const router  = express.Router();
const pool    = require('../config/db');
const { authMiddleware, soloDueno } = require('../middleware/auth');

// ── Clave usada en config_sistema ─────────────────────────
const CONFIG_KEY = 'ticket_design_global';

// ── GET /api/ticket-design ────────────────────────────────
// Pública — la consumen GestionRifas y el componente Ticket
router.get('/', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT valor, updated_at
       FROM config_sistema
       WHERE clave = $1`,
      [CONFIG_KEY]
    );
    if (!r.rows[0]) {
      // Sin config → devuelve null (el frontend usa DEFAULT_DESIGN)
      return res.json({ design: null, updated_at: null });
    }
    res.json({
      design:     r.rows[0].valor,        // jsonb → ya viene como objeto JS
      updated_at: r.rows[0].updated_at,
    });
  } catch (err) {
    console.error('Error obteniendo ticket design:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ── PUT /api/ticket-design ────────────────────────────────
// Solo dueño puede guardar
router.put('/', authMiddleware, soloDueno, async (req, res) => {
  const { design } = req.body;

  if (!design || typeof design !== 'object') {
    return res.status(400).json({ error: 'design debe ser un objeto JSON' });
  }

  try {
    const r = await pool.query(
      `INSERT INTO config_sistema (clave, valor, descripcion, updated_by, updated_at)
       VALUES ($1, $2::jsonb, 'Diseño global del ticket de boleto', $3, NOW())
       ON CONFLICT (clave) DO UPDATE
         SET valor      = EXCLUDED.valor,
             updated_by = EXCLUDED.updated_by,
             updated_at = NOW()
       RETURNING updated_at`,
      [CONFIG_KEY, JSON.stringify(design), req.user.id]
    );
    res.json({ ok: true, updated_at: r.rows[0].updated_at });
  } catch (err) {
    console.error('Error guardando ticket design:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

module.exports = router;