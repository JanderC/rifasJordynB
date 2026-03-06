const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { authMiddleware, soloDueno } = require('../middleware/auth');

// ── GET /api/reportes/dashboard ───────────────────────────
// Dashboard general para el dueño
router.get('/dashboard', authMiddleware, soloDueno, async (req, res) => {
  try {
    // Resumen de rifas
    const rifasResult = await pool.query(`
      SELECT v.*, r.created_at
      FROM vista_resumen_rifas v
      JOIN rifas r ON r.id = v.id
      ORDER BY r.created_at
    `);

    // Total de vendedores activos
    const vendedoresResult = await pool.query(
      'SELECT COUNT(*) AS total FROM users WHERE rol = $1 AND activo = TRUE',
      ['vendedor']
    );

    // Ventas de hoy
    const hoyResult = await pool.query(
      `SELECT COUNT(*) AS ventas_hoy, COALESCE(SUM(precio_venta), 0) AS ingresos_hoy
       FROM ventas
       WHERE DATE(created_at) = CURRENT_DATE`
    );

    // Top 5 vendedores del mes
    const topVendedoresResult = await pool.query(
      `SELECT u.nombre, COUNT(v.id) AS ventas, COALESCE(SUM(v.precio_venta), 0) AS ingresos
       FROM users u
       JOIN ventas v ON v.vendedor_id = u.id
       WHERE DATE_TRUNC('month', v.created_at) = DATE_TRUNC('month', CURRENT_DATE)
       GROUP BY u.id, u.nombre
       ORDER BY ventas DESC
       LIMIT 5`
    );

    // Últimas 10 ventas
    const ultimasVentasResult = await pool.query(
      `SELECT v.numero, v.nombre_comprador, v.precio_venta, v.created_at,
              r.nombre AS rifa_nombre, u.nombre AS vendedor_nombre
       FROM ventas v
       JOIN rifas r ON r.id = v.rifa_id
       JOIN users u ON u.id = v.vendedor_id
       ORDER BY v.created_at DESC
       LIMIT 10`
    );

    // Números más vendidos
    const numerosCalientesResult = await pool.query(
      `SELECT numero, COUNT(*) AS veces
       FROM ventas
       GROUP BY numero
       ORDER BY veces DESC, numero
       LIMIT 10`
    );

    res.json({
      rifas: rifasResult.rows,
      total_vendedores: parseInt(vendedoresResult.rows[0].total),
      hoy: {
        ventas: parseInt(hoyResult.rows[0].ventas_hoy),
        ingresos: parseFloat(hoyResult.rows[0].ingresos_hoy)
      },
      top_vendedores: topVendedoresResult.rows,
      ultimas_ventas: ultimasVentasResult.rows,
      numeros_calientes: numerosCalientesResult.rows
    });
  } catch (err) {
    console.error('Error en dashboard:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ── GET /api/reportes/vendedor-dashboard ──────────────────
// Dashboard del vendedor (sus propias estadísticas)
router.get('/vendedor-dashboard', authMiddleware, async (req, res) => {
  try {
    // Sus ventas totales
    const ventasResult = await pool.query(
      `SELECT COUNT(*) AS total_ventas, COALESCE(SUM(precio_venta), 0) AS total_ingresos
       FROM ventas WHERE vendedor_id = $1`,
      [req.user.id]
    );

    // Sus ventas de hoy
    const hoyResult = await pool.query(
      `SELECT COUNT(*) AS ventas_hoy
       FROM ventas
       WHERE vendedor_id = $1 AND DATE(created_at) = CURRENT_DATE`,
      [req.user.id]
    );

    // Sus números asignados pendientes
    const pendientesResult = await pool.query(
      `SELECT COUNT(*) AS pendientes
       FROM numeros_vendedor nv
       LEFT JOIN ventas v ON v.rifa_id = nv.rifa_id AND v.numero = nv.numero AND v.vendedor_id = nv.vendedor_id
       WHERE nv.vendedor_id = $1 AND v.id IS NULL`,
      [req.user.id]
    );

    // Estado de rifas activas
    const rifasResult = await pool.query('SELECT * FROM vista_resumen_rifas WHERE activa = TRUE');

    res.json({
      mis_ventas: {
        total: parseInt(ventasResult.rows[0].total_ventas),
        ingresos: parseFloat(ventasResult.rows[0].total_ingresos),
        hoy: parseInt(hoyResult.rows[0].ventas_hoy)
      },
      numeros_pendientes: parseInt(pendientesResult.rows[0].pendientes),
      rifas: rifasResult.rows
    });
  } catch (err) {
    console.error('Error en dashboard vendedor:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ── GET /api/reportes/porcentaje-ventas ───────────────────
// % de ventas por rifa (para la barra de progreso del frontend)
router.get('/porcentaje-ventas', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        r.id,
        r.nombre,
        r.premio,
        r.precio,
        r.fecha_sorteo,
        r.activa,
        -- Números únicos con al menos 1 venta
        COUNT(DISTINCT v.numero) AS numeros_vendidos,
        -- Números con exactamente 2 ventas (agotados)
        COUNT(DISTINCT CASE WHEN sub.cnt = 2 THEN v.numero END) AS numeros_agotados,
        -- Números disponibles
        1000 - COUNT(DISTINCT v.numero) AS numeros_disponibles,
        -- Porcentaje vendido (al menos 1 vez)
        ROUND((COUNT(DISTINCT v.numero)::numeric / 1000) * 100, 1) AS porcentaje_vendido,
        -- Porcentaje agotado (2 veces)
        ROUND((COUNT(DISTINCT CASE WHEN sub.cnt = 2 THEN v.numero END)::numeric / 1000) * 100, 1) AS porcentaje_agotado,
        -- Total ventas e ingresos
        COUNT(v.id) AS total_ventas,
        COALESCE(SUM(v.precio_venta), 0) AS ingresos_totales
      FROM rifas r
      LEFT JOIN ventas v ON v.rifa_id = r.id
      LEFT JOIN (
        SELECT rifa_id, numero, COUNT(*) AS cnt
        FROM ventas GROUP BY rifa_id, numero
      ) sub ON sub.rifa_id = r.id AND sub.numero = v.numero
      GROUP BY r.id, r.nombre, r.premio, r.precio, r.fecha_sorteo, r.activa, r.created_at
      ORDER BY r.created_at
    `);

    res.json(result.rows);
  } catch (err) {
    console.error('Error obteniendo porcentajes:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

module.exports = router;