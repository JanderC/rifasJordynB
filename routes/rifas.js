const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { authMiddleware, soloDueno } = require('../middleware/auth');

// ── GET /api/rifas ─────────────────────────────────────────
// Obtener todas las rifas con su resumen de ventas
router.get('/', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM vista_resumen_rifas ORDER BY created_at`
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error obteniendo rifas:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ── GET /api/rifas/:id ─────────────────────────────────────
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM vista_resumen_rifas WHERE id = $1`,
      [req.params.id]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ error: 'Rifa no encontrada' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error obteniendo rifa:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ── POST /api/rifas (solo dueño) ───────────────────────────
router.post('/', authMiddleware, soloDueno, async (req, res) => {
  const { nombre, descripcion, premio, precio, fecha_sorteo, loteria_ref } = req.body;

  if (!nombre || !premio || !precio) {
    return res.status(400).json({ error: 'Nombre, premio y precio son requeridos' });
  }

  try {
    // Verificar que no haya más de 2 rifas activas
    const countResult = await pool.query('SELECT COUNT(*) FROM rifas WHERE activa = TRUE');
    if (parseInt(countResult.rows[0].count) >= 2) {
      return res.status(400).json({ error: 'Solo se permiten 2 rifas activas simultáneamente' });
    }

    const result = await pool.query(
      `INSERT INTO rifas (nombre, descripcion, premio, precio, fecha_sorteo, loteria_ref, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [nombre, descripcion, premio, precio, fecha_sorteo || null, loteria_ref, req.user.id]
    );

    res.status(201).json({ message: 'Rifa creada exitosamente', rifa: result.rows[0] });
  } catch (err) {
    console.error('Error creando rifa:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ── PUT /api/rifas/:id (solo dueño) ───────────────────────
router.put('/:id', authMiddleware, soloDueno, async (req, res) => {
  const { nombre, descripcion, premio, precio, fecha_sorteo, loteria_ref, activa } = req.body;

  try {
    const result = await pool.query(
      `UPDATE rifas SET
        nombre = COALESCE($1, nombre),
        descripcion = COALESCE($2, descripcion),
        premio = COALESCE($3, premio),
        precio = COALESCE($4, precio),
        fecha_sorteo = COALESCE($5, fecha_sorteo),
        loteria_ref = COALESCE($6, loteria_ref),
        activa = COALESCE($7, activa)
       WHERE id = $8
       RETURNING *`,
      [nombre, descripcion, premio, precio, fecha_sorteo, loteria_ref, activa, req.params.id]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ error: 'Rifa no encontrada' });
    }

    res.json({ message: 'Rifa actualizada', rifa: result.rows[0] });
  } catch (err) {
    console.error('Error actualizando rifa:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ── DELETE /api/rifas/:id (solo dueño) ────────────────────
router.delete('/:id', authMiddleware, soloDueno, async (req, res) => {
  try {
    const ventas = await pool.query('SELECT COUNT(*) FROM ventas WHERE rifa_id = $1', [req.params.id]);
    if (parseInt(ventas.rows[0].count) > 0) {
      return res.status(400).json({
        error: 'No se puede eliminar una rifa con ventas registradas. Desactívala en su lugar.'
      });
    }

    await pool.query('DELETE FROM rifas WHERE id = $1', [req.params.id]);
    res.json({ message: 'Rifa eliminada exitosamente' });
  } catch (err) {
    console.error('Error eliminando rifa:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

module.exports = router;