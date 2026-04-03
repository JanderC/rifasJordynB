// ============================================================
//   RIFAS JORDYN — Rutas de Vendedores
//   ✅ ACTUALIZADO: números globales en numeros_vendedor_global
//      GET /  → incluye numeros_asignados (array de números)
//      GET /:id → numeros_asignados desde tabla global
//      POST /numeros/asignar y DELETE usan tabla global
//      GET /:id/numeros-aleatorios usa tabla global
// ============================================================
const express = require('express');
const router  = express.Router();
const bcrypt  = require('bcryptjs');
const pool    = require('../config/db');
const { authMiddleware, soloDueno } = require('../middleware/auth');

// ── GET /api/vendedores ────────────────────────────────────
router.get('/', authMiddleware, soloDueno, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        u.id,
        u.nombre,
        u.usuario,
        u.cedula,
        u.rol,
        u.activo,
        u.created_at,
        COUNT(DISTINCT v.id)::int             AS total_ventas,
        COALESCE(SUM(v.precio_venta), 0)      AS total_ingresos,
        COUNT(DISTINCT ng.numero)::int        AS numeros_count,
        COALESCE(
          JSON_AGG(ng.numero ORDER BY ng.numero)
          FILTER (WHERE ng.numero IS NOT NULL),
          '[]'
        ) AS numeros_asignados
      FROM users u
      LEFT JOIN ventas v             ON v.vendedor_id = u.id
      LEFT JOIN numeros_vendedor_global ng ON ng.vendedor_id = u.id
      WHERE u.rol = 'vendedor'
      GROUP BY u.id, u.nombre, u.usuario, u.cedula, u.rol, u.activo, u.created_at
      ORDER BY u.nombre
    `);

    res.json(result.rows);
  } catch (err) {
    console.error('Error obteniendo vendedores:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ── GET /api/vendedores/:id ────────────────────────────────
router.get('/:id', authMiddleware, soloDueno, async (req, res) => {
  try {
    const userResult = await pool.query(
      'SELECT id, nombre, usuario, cedula, rol, activo, created_at FROM users WHERE id = $1',
      [req.params.id]
    );

    if (!userResult.rows[0]) {
      return res.status(404).json({ error: 'Vendedor no encontrado' });
    }

    // Números globales del vendedor
    const numerosResult = await pool.query(
      `SELECT numero FROM numeros_vendedor_global
       WHERE vendedor_id = $1
       ORDER BY numero`,
      [req.params.id]
    );

    // Rifas donde participa este vendedor (con cuántos números)
    const rifasResult = await pool.query(
      `SELECT
         nv.rifa_id,
         r.nombre   AS rifa_nombre,
         r.activa,
         COUNT(nv.numero)::int AS numeros_en_rifa,
         COUNT(v.id)::int      AS ventas_en_rifa
       FROM numeros_vendedor nv
       JOIN rifas r ON r.id = nv.rifa_id
       LEFT JOIN ventas v ON v.rifa_id = nv.rifa_id
         AND v.numero = nv.numero
         AND v.vendedor_id = nv.vendedor_id
       WHERE nv.vendedor_id = $1
       GROUP BY nv.rifa_id, r.nombre, r.activa
       ORDER BY r.activa DESC, nv.rifa_id DESC`,
      [req.params.id]
    );

    // Ventas recientes
    const ventasResult = await pool.query(
      `SELECT v.*, r.nombre AS rifa_nombre
       FROM ventas v
       JOIN rifas r ON r.id = v.rifa_id
       WHERE v.vendedor_id = $1
       ORDER BY v.created_at DESC LIMIT 20`,
      [req.params.id]
    );

    res.json({
      vendedor:         userResult.rows[0],
      numeros_asignados: numerosResult.rows.map(r => r.numero),
      rifas_participando: rifasResult.rows,
      ventas_recientes: ventasResult.rows,
    });
  } catch (err) {
    console.error('Error obteniendo vendedor:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ── PUT /api/vendedores/:id ────────────────────────────────
router.put('/:id', authMiddleware, soloDueno, async (req, res) => {
  const { nombre, password, activo, cedula } = req.body;

  try {
    let updateFields = [];
    let params       = [];
    let i            = 1;

    if (nombre)                     { updateFields.push(`nombre = $${i++}`);  params.push(nombre); }
    if (typeof activo === 'boolean') { updateFields.push(`activo = $${i++}`);  params.push(activo); }
    if (cedula !== undefined)        { updateFields.push(`cedula = $${i++}`);  params.push(cedula || null); }
    if (password) {
      if (password.length < 6)
        return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
      const hash = await bcrypt.hash(password, 10);
      updateFields.push(`password = $${i++}`);
      params.push(hash);
    }

    if (updateFields.length === 0)
      return res.status(400).json({ error: 'No hay campos para actualizar' });

    params.push(req.params.id);
    const result = await pool.query(
      `UPDATE users SET ${updateFields.join(', ')} WHERE id = $${i} RETURNING id, nombre, usuario, cedula, rol, activo`,
      params
    );

    if (!result.rows[0])
      return res.status(404).json({ error: 'Vendedor no encontrado' });

    res.json({ message: 'Vendedor actualizado', vendedor: result.rows[0] });
  } catch (err) {
    console.error('Error actualizando vendedor:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ── DELETE /api/vendedores/:id ─────────────────────────────
router.delete('/:id', authMiddleware, soloDueno, async (req, res) => {
  try {
    const ventas = await pool.query(
      'SELECT COUNT(*) FROM ventas WHERE vendedor_id = $1',
      [req.params.id]
    );
    if (parseInt(ventas.rows[0].count) > 0) {
      return res.status(400).json({
        error: 'No se puede eliminar un vendedor con ventas registradas. Desactívalo en su lugar.'
      });
    }

    // Limpiar números globales y asignaciones por rifa
    await pool.query('DELETE FROM numeros_vendedor_global WHERE vendedor_id = $1', [req.params.id]);
    await pool.query('DELETE FROM numeros_vendedor        WHERE vendedor_id = $1', [req.params.id]);
    await pool.query('DELETE FROM users                   WHERE id = $1',          [req.params.id]);

    res.json({ message: 'Vendedor eliminado exitosamente' });
  } catch (err) {
    console.error('Error eliminando vendedor:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ── GET /api/vendedores/:id/numeros-aleatorios ────────────
// Genera números aleatorios disponibles en el pool global
// (excluye los que ya tienen otros vendedores y los del mismo)
router.get('/:id/numeros-aleatorios', authMiddleware, soloDueno, async (req, res) => {
  const { cantidad = 10, excluir = '' } = req.query;

  // excluir puede venir como "001,002,003" desde el frontend
  const excluirArr = excluir ? excluir.split(',').map(n => n.trim()).filter(Boolean) : [];

  try {
    // Números ya asignados a cualquier vendedor en la tabla global
    const result = await pool.query(
      `SELECT LPAD(gs::text, 3, '0') AS numero
       FROM generate_series(0, 999) gs
       WHERE LPAD(gs::text, 3, '0') NOT IN (
         SELECT numero FROM numeros_vendedor_global
       )
       ${excluirArr.length > 0 ? `AND LPAD(gs::text, 3, '0') != ALL($2)` : ''}
       ORDER BY RANDOM()
       LIMIT $1`,
      excluirArr.length > 0
        ? [parseInt(cantidad), excluirArr]
        : [parseInt(cantidad)]
    );

    res.json({
      numeros_sugeridos: result.rows.map(r => r.numero),
      cantidad:          result.rows.length,
    });
  } catch (err) {
    console.error('Error generando números aleatorios:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

module.exports = router;