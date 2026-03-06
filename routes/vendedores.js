const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const pool = require('../config/db');
const { authMiddleware, soloDueno } = require('../middleware/auth');

// ── GET /api/vendedores ────────────────────────────────────
// Listar todos los vendedores con sus estadísticas
router.get('/', authMiddleware, soloDueno, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        u.id,
        u.nombre,
        u.usuario,
        u.rol,
        u.activo,
        u.created_at,
        COUNT(DISTINCT v.id) AS total_ventas,
        COALESCE(SUM(v.precio_venta), 0) AS total_ingresos,
        COUNT(DISTINCT nv.numero || '-' || nv.rifa_id::text) AS numeros_asignados
      FROM users u
      LEFT JOIN ventas v ON v.vendedor_id = u.id
      LEFT JOIN numeros_vendedor nv ON nv.vendedor_id = u.id
      WHERE u.rol = 'vendedor'
      GROUP BY u.id, u.nombre, u.usuario, u.rol, u.activo, u.created_at
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
      'SELECT id, nombre, usuario, rol, activo, created_at FROM users WHERE id = $1',
      [req.params.id]
    );

    if (!userResult.rows[0]) {
      return res.status(404).json({ error: 'Vendedor no encontrado' });
    }

    // Números asignados por rifa
    const numerosResult = await pool.query(
      `SELECT nv.numero, nv.rifa_id, r.nombre AS rifa_nombre,
              COUNT(v.id) AS veces_vendido
       FROM numeros_vendedor nv
       JOIN rifas r ON r.id = nv.rifa_id
       LEFT JOIN ventas v ON v.rifa_id = nv.rifa_id AND v.numero = nv.numero AND v.vendedor_id = nv.vendedor_id
       WHERE nv.vendedor_id = $1
       GROUP BY nv.numero, nv.rifa_id, r.nombre
       ORDER BY nv.rifa_id, nv.numero`,
      [req.params.id]
    );

    // Ventas recientes
    const ventasResult = await pool.query(
      `SELECT v.*, r.nombre AS rifa_nombre
       FROM ventas v JOIN rifas r ON r.id = v.rifa_id
       WHERE v.vendedor_id = $1
       ORDER BY v.created_at DESC LIMIT 20`,
      [req.params.id]
    );

    res.json({
      vendedor: userResult.rows[0],
      numeros_asignados: numerosResult.rows,
      ventas_recientes: ventasResult.rows
    });
  } catch (err) {
    console.error('Error obteniendo vendedor:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ── PUT /api/vendedores/:id (solo dueño) ──────────────────
router.put('/:id', authMiddleware, soloDueno, async (req, res) => {
  const { nombre, password, activo } = req.body;

  try {
    let updateFields = [];
    let params = [];
    let i = 1;

    if (nombre) { updateFields.push(`nombre = $${i++}`); params.push(nombre); }
    if (typeof activo === 'boolean') { updateFields.push(`activo = $${i++}`); params.push(activo); }
    if (password) {
      if (password.length < 6) {
        return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
      }
      const hash = await bcrypt.hash(password, 10);
      updateFields.push(`password = $${i++}`);
      params.push(hash);
    }

    if (updateFields.length === 0) {
      return res.status(400).json({ error: 'No hay campos para actualizar' });
    }

    params.push(req.params.id);
    const result = await pool.query(
      `UPDATE users SET ${updateFields.join(', ')} WHERE id = $${i} RETURNING id, nombre, usuario, rol, activo`,
      params
    );

    if (!result.rows[0]) {
      return res.status(404).json({ error: 'Vendedor no encontrado' });
    }

    res.json({ message: 'Vendedor actualizado', vendedor: result.rows[0] });
  } catch (err) {
    console.error('Error actualizando vendedor:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ── DELETE /api/vendedores/:id (solo dueño) ───────────────
router.delete('/:id', authMiddleware, soloDueno, async (req, res) => {
  try {
    const ventas = await pool.query('SELECT COUNT(*) FROM ventas WHERE vendedor_id = $1', [req.params.id]);
    if (parseInt(ventas.rows[0].count) > 0) {
      return res.status(400).json({
        error: 'No se puede eliminar un vendedor con ventas registradas. Desactívalo en su lugar.'
      });
    }

    await pool.query('DELETE FROM numeros_vendedor WHERE vendedor_id = $1', [req.params.id]);
    await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);

    res.json({ message: 'Vendedor eliminado exitosamente' });
  } catch (err) {
    console.error('Error eliminando vendedor:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ── GET /api/vendedores/:id/numeros-aleatorios ────────────
// Generar números aleatorios disponibles para asignar
router.get('/:id/numeros-aleatorios', authMiddleware, soloDueno, async (req, res) => {
  const { rifa_id, cantidad = 10 } = req.query;

  if (!rifa_id) {
    return res.status(400).json({ error: 'rifa_id es requerido' });
  }

  try {
    // Números que ya están agotados (vendidos 2 veces) o ya asignados a este vendedor
    const result = await pool.query(
      `SELECT LPAD(gs::text, 3, '0') AS numero
       FROM generate_series(0, 999) gs
       WHERE LPAD(gs::text, 3, '0') NOT IN (
         -- Agotados
         SELECT numero FROM ventas WHERE rifa_id = $1 GROUP BY numero HAVING COUNT(*) >= 2
       )
       AND LPAD(gs::text, 3, '0') NOT IN (
         -- Ya asignados al vendedor
         SELECT numero FROM numeros_vendedor WHERE vendedor_id = $2 AND rifa_id = $1
       )
       ORDER BY RANDOM()
       LIMIT $3`,
      [rifa_id, req.params.id, parseInt(cantidad)]
    );

    res.json({
      numeros_sugeridos: result.rows.map(r => r.numero),
      cantidad: result.rows.length
    });
  } catch (err) {
    console.error('Error generando números aleatorios:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

module.exports = router;