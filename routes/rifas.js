const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { authMiddleware, soloDueno } = require('../middleware/auth');

// ── GET /api/rifas ─────────────────────────────────────────
router.get('/', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        r.id, r.nombre, r.descripcion, r.premio, r.precio,
        r.fecha_sorteo, r.loteria_ref, r.activa,
        r.imagen_url,
        COALESCE(r.tipo,   'sencilla') AS tipo,
        COALESCE(r.estado, 'activa')   AS estado,
        COALESCE(COUNT(DISTINCT v.id), 0)::int  AS total_ventas,
        COALESCE(SUM(v.precio_venta),  0)        AS ingresos_totales,
        r.created_at
      FROM rifas r
      LEFT JOIN ventas v ON v.rifa_id = r.id
      GROUP BY r.id
      ORDER BY r.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('Error obteniendo rifas:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ── GET /api/rifas/:id ─────────────────────────────────────
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        r.id, r.nombre, r.descripcion, r.premio, r.precio,
        r.fecha_sorteo, r.loteria_ref, r.activa,
        r.imagen_url,
        COALESCE(r.tipo,   'sencilla') AS tipo,
        COALESCE(r.estado, 'activa')   AS estado,
        COALESCE(COUNT(DISTINCT v.id), 0)::int  AS total_ventas,
        COALESCE(SUM(v.precio_venta),  0)        AS ingresos_totales,
        r.created_at
      FROM rifas r
      LEFT JOIN ventas v ON v.rifa_id = r.id
      WHERE r.id = $1
      GROUP BY r.id
    `, [req.params.id]);

    if (!result.rows[0]) return res.status(404).json({ error: 'Rifa no encontrada' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error obteniendo rifa:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ── POST /api/rifas ────────────────────────────────────────
router.post('/', authMiddleware, soloDueno, async (req, res) => {
  const {
    nombre, descripcion, premio, precio,
    fecha_sorteo, loteria_ref,
    tipo = 'sencilla',
    imagen_url = null,
    estado = 'activa',
  } = req.body;

  if (!nombre || !premio || !precio) {
    return res.status(400).json({ error: 'Nombre, premio y precio son requeridos' });
  }

  try {
    const countResult = await pool.query(
      `SELECT COUNT(*) FROM rifas WHERE activa = TRUE AND COALESCE(estado,'activa') != 'archivada'`
    );
    if (parseInt(countResult.rows[0].count) >= 2) {
      return res.status(400).json({ error: 'Solo se permiten 2 rifas activas simultáneamente' });
    }

    const result = await pool.query(
      `INSERT INTO rifas
         (nombre, descripcion, premio, precio, fecha_sorteo, loteria_ref,
          tipo, imagen_url, estado, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [nombre, descripcion || null, premio, precio,
       fecha_sorteo || null, loteria_ref || null,
       tipo, imagen_url, estado, req.user.id]
    );

    res.status(201).json({ message: 'Rifa creada exitosamente', rifa: result.rows[0] });
  } catch (err) {
    console.error('Error creando rifa:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ── PUT /api/rifas/:id ─────────────────────────────────────
router.put('/:id', authMiddleware, soloDueno, async (req, res) => {
  const {
    nombre, descripcion, premio, precio,
    fecha_sorteo, loteria_ref,
    activa, tipo, imagen_url, estado,
  } = req.body;

  try {
    if (activa === true) {
      const countResult = await pool.query(
        `SELECT COUNT(*) FROM rifas
         WHERE activa = TRUE AND COALESCE(estado,'activa') != 'archivada' AND id != $1`,
        [req.params.id]
      );
      if (parseInt(countResult.rows[0].count) >= 2) {
        return res.status(400).json({ error: 'Solo se permiten 2 rifas activas simultáneamente' });
      }
    }

    // imagen_url: si el cliente envía explícitamente null la borramos;
    // si no la envía (undefined) mantenemos la que había.
    const imgValue = imagen_url !== undefined ? imagen_url : undefined;

    const result = await pool.query(
      `UPDATE rifas SET
        nombre       = COALESCE($1,  nombre),
        descripcion  = COALESCE($2,  descripcion),
        premio       = COALESCE($3,  premio),
        precio       = COALESCE($4,  precio),
        fecha_sorteo = COALESCE($5,  fecha_sorteo),
        loteria_ref  = COALESCE($6,  loteria_ref),
        activa       = COALESCE($7,  activa),
        tipo         = COALESCE($8,  tipo),
        imagen_url   = CASE WHEN $9::text IS NOT NULL THEN $9::text ELSE imagen_url END,
        estado       = COALESCE($10, estado)
       WHERE id = $11
       RETURNING *`,
      [
        nombre       ?? null,
        descripcion  ?? null,
        premio       ?? null,
        precio       ?? null,
        fecha_sorteo ?? null,
        loteria_ref  ?? null,
        activa       ?? null,
        tipo         ?? null,
        imgValue     ?? null,
        estado       ?? null,
        req.params.id,
      ]
    );

    if (!result.rows[0]) return res.status(404).json({ error: 'Rifa no encontrada' });
    res.json({ message: 'Rifa actualizada', rifa: result.rows[0] });
  } catch (err) {
    console.error('Error actualizando rifa:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ── DELETE /api/rifas/:id ──────────────────────────────────
router.delete('/:id', authMiddleware, soloDueno, async (req, res) => {
  try {
    const ventas = await pool.query('SELECT COUNT(*) FROM ventas WHERE rifa_id = $1', [req.params.id]);
    if (parseInt(ventas.rows[0].count) > 0) {
      return res.status(400).json({
        error: 'No se puede eliminar una rifa con ventas. Archívala en su lugar.'
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