const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { authMiddleware, soloDueno } = require('../middleware/auth');

// ── Función helper para validar formato de número ─────────
const validarNumero = (num) => /^[0-9]{3}$/.test(num);

// ── GET /api/numeros/estado-global ────────────────────────
// Vista unificada de los 1000 números con estado en AMBAS rifas
router.get('/estado-global', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        n.numero,
        -- Estado Rifa 1
        COALESCE(r1.veces, 0) AS rifa1_vendido,
        CASE
          WHEN COALESCE(r1.veces, 0) = 0 THEN 'disponible'
          WHEN COALESCE(r1.veces, 0) = 1 THEN 'vendido_1'
          ELSE 'agotado'
        END AS rifa1_estado,
        -- Estado Rifa 2
        COALESCE(r2.veces, 0) AS rifa2_vendido,
        CASE
          WHEN COALESCE(r2.veces, 0) = 0 THEN 'disponible'
          WHEN COALESCE(r2.veces, 0) = 1 THEN 'vendido_1'
          ELSE 'agotado'
        END AS rifa2_estado,
        -- Estado global combinado
        CASE
          WHEN COALESCE(r1.veces, 0) = 0 AND COALESCE(r2.veces, 0) = 0 THEN 'libre'
          WHEN COALESCE(r1.veces, 0) >= 2 AND COALESCE(r2.veces, 0) >= 2 THEN 'agotado_total'
          WHEN COALESCE(r1.veces, 0) >= 2 OR COALESCE(r2.veces, 0) >= 2 THEN 'parcial_agotado'
          ELSE 'parcial_vendido'
        END AS estado_global
      FROM (
        SELECT LPAD(gs::text, 3, '0') AS numero
        FROM generate_series(0, 999) gs
      ) n
      LEFT JOIN (
        SELECT v.numero, COUNT(*) AS veces
        FROM ventas v
        WHERE v.rifa_id = (
          SELECT id FROM rifas WHERE activa = TRUE ORDER BY created_at LIMIT 1
        )
        GROUP BY v.numero
      ) r1 ON r1.numero = n.numero
      LEFT JOIN (
        SELECT v.numero, COUNT(*) AS veces
        FROM ventas v
        WHERE v.rifa_id = (
          SELECT id FROM rifas WHERE activa = TRUE ORDER BY created_at OFFSET 1 LIMIT 1
        )
        GROUP BY v.numero
      ) r2 ON r2.numero = n.numero
      ORDER BY n.numero
    `);

    res.json(result.rows);
  } catch (err) {
    console.error('Error estado global:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ── GET /api/numeros/verificar/:numero ────────────────────
// Verificar disponibilidad de un número en todas las rifas activas
router.get('/verificar/:numero', authMiddleware, async (req, res) => {
  const { numero } = req.params;

  if (!validarNumero(numero)) {
    return res.status(400).json({ error: 'Número inválido. Debe ser entre 000 y 999' });
  }

  try {
    const rifas = await pool.query('SELECT * FROM rifas WHERE activa = TRUE ORDER BY created_at');

    const disponibilidad = await Promise.all(
      rifas.rows.map(async (rifa) => {
        const ventas = await pool.query(
          `SELECT v.id, v.nombre_comprador, v.telefono, v.created_at,
                  u.nombre AS nombre_vendedor
           FROM ventas v
           JOIN users u ON u.id = v.vendedor_id
           WHERE v.rifa_id = $1 AND v.numero = $2
           ORDER BY v.created_at`,
          [rifa.id, numero]
        );

        const veces_vendido = ventas.rows.length;

        // Si la rifa tiene números asignados a vendedores, verificar si este número
        // está bloqueado para el vendedor actual
        let bloqueadoPorOtro = false;
        let vendedorPropietario = null;

        if (req.user.rol === 'vendedor') {
          const asignacion = await pool.query(
            `SELECT nv.vendedor_id, u.nombre AS vendedor_nombre
             FROM numeros_vendedor nv
             JOIN users u ON u.id = nv.vendedor_id
             WHERE nv.rifa_id = $1 AND nv.numero = $2`,
            [rifa.id, numero]
          );
          if (asignacion.rows.length > 0) {
            const propietario = asignacion.rows[0];
            if (propietario.vendedor_id !== req.user.id) {
              bloqueadoPorOtro = true;
              vendedorPropietario = propietario.vendedor_nombre;
            }
          }
        }

        const disponible = veces_vendido < 2 && !bloqueadoPorOtro;

        return {
          rifa_id: rifa.id,
          rifa_nombre: rifa.nombre,
          premio: rifa.premio,
          precio: rifa.precio,
          fecha_sorteo: rifa.fecha_sorteo,
          loteria_ref: rifa.loteria_ref,
          veces_vendido,
          estado: bloqueadoPorOtro
            ? 'asignado_otro'
            : veces_vendido === 0 ? 'disponible'
            : veces_vendido === 1 ? 'vendido_1'
            : 'agotado',
          disponible,
          bloqueado_por: vendedorPropietario,
          compradores: ventas.rows
        };
      })
    );

    res.json({ numero, rifas: disponibilidad });
  } catch (err) {
    console.error('Error verificando número:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ── GET /api/numeros/rifa/:rifa_id ────────────────────────
// Estado de todos los números de una rifa específica
router.get('/rifa/:rifa_id', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT numero, veces_vendido, estado, compras
       FROM vista_numeros_estado
       WHERE rifa_id = $1`,
      [req.params.rifa_id]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('Error obteniendo números de rifa:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ── POST /api/numeros/vender ───────────────────────────────
// Registrar una venta
router.post('/vender', authMiddleware, async (req, res) => {
  const { rifa_id, numero, nombre_comprador, telefono, observacion } = req.body;

  if (!rifa_id || !numero || !nombre_comprador) {
    return res.status(400).json({ error: 'rifa_id, numero y nombre_comprador son requeridos' });
  }

  if (!validarNumero(numero)) {
    return res.status(400).json({ error: 'Número inválido. Debe ser entre 000 y 999' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Verificar cuántas veces se ha vendido este número (con lock)
    const checkResult = await client.query(
      `SELECT COUNT(*) AS veces FROM ventas WHERE rifa_id = $1 AND numero = $2`,
      [rifa_id, numero]
    );

    const veces = parseInt(checkResult.rows[0].veces);

    if (veces >= 2) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'NUMERO_AGOTADO',
        message: `⛔ El número ${numero} ya fue vendido 2 veces y está AGOTADO en esta rifa`,
        veces_vendido: veces
      });
    }

    // Si el vendedor NO es dueño, verificar que el número le pertenezca
    // (si hay números asignados en esta rifa, el vendedor solo puede vender los suyos)
    if (req.user.rol === 'vendedor') {
      const hayAsignados = await client.query(
        `SELECT COUNT(*) AS total FROM numeros_vendedor WHERE rifa_id = $1`,
        [rifa_id]
      );
      const rifaTieneAsignaciones = parseInt(hayAsignados.rows[0].total) > 0;

      if (rifaTieneAsignaciones) {
        const essuyo = await client.query(
          `SELECT 1 FROM numeros_vendedor
           WHERE vendedor_id = $1 AND rifa_id = $2 AND numero = $3`,
          [req.user.id, rifa_id, numero]
        );
        if (!essuyo.rows[0]) {
          await client.query('ROLLBACK');
          return res.status(403).json({
            error: 'NUMERO_NO_ASIGNADO',
            message: `⛔ El número ${numero} no está asignado a tu cartera. Solo puedes vender tus números asignados.`
          });
        }
      }
    }

    // Obtener precio de la rifa
    const rifaResult = await client.query('SELECT precio FROM rifas WHERE id = $1', [rifa_id]);
    if (!rifaResult.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Rifa no encontrada' });
    }

    // Registrar la venta
    const venta = await client.query(
      `INSERT INTO ventas (rifa_id, numero, vendedor_id, nombre_comprador, telefono, precio_venta, observacion)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [rifa_id, numero, req.user.id, nombre_comprador.trim(), telefono || null, rifaResult.rows[0].precio, observacion || null]
    );

    const nuevasVeces = veces + 1;
    const estado = nuevasVeces >= 2 ? 'agotado' : 'vendido_1';

    await client.query('COMMIT');

    res.status(201).json({
      message: `✅ Número ${numero} vendido exitosamente`,
      venta: venta.rows[0],
      estado_actual: estado,
      veces_vendido: nuevasVeces,
      alerta: nuevasVeces === 2 ? `⚠️ El número ${numero} ahora está AGOTADO (vendido 2 veces)` : null
    });

  } catch (err) {
    await client.query('ROLLBACK');

    if (err.message && err.message.includes('NUMERO_AGOTADO')) {
      return res.status(409).json({
        error: 'NUMERO_AGOTADO',
        message: `⛔ El número ${numero} está agotado`
      });
    }

    console.error('Error registrando venta:', err);
    res.status(500).json({ error: 'Error del servidor al registrar la venta' });
  } finally {
    client.release();
  }
});

// ── GET /api/numeros/vendedor/mis-numeros ─────────────────
// Números asignados al vendedor actual
router.get('/vendedor/mis-numeros', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT nv.numero, nv.rifa_id, r.nombre AS rifa_nombre,
              COUNT(v.id) AS veces_vendido,
              CASE
                WHEN COUNT(v.id) = 0 THEN 'disponible'
                WHEN COUNT(v.id) = 1 THEN 'vendido_1'
                ELSE 'agotado'
              END AS estado
       FROM numeros_vendedor nv
       JOIN rifas r ON r.id = nv.rifa_id
       LEFT JOIN ventas v ON v.rifa_id = nv.rifa_id AND v.numero = nv.numero
       WHERE nv.vendedor_id = $1
       GROUP BY nv.numero, nv.rifa_id, r.nombre
       ORDER BY nv.rifa_id, nv.numero`,
      [req.user.id]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('Error obteniendo mis números:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ── POST /api/numeros/asignar (solo dueño) ────────────────
// Asignar números fijos a un vendedor
router.post('/asignar', authMiddleware, soloDueno, async (req, res) => {
  const { vendedor_id, rifa_id, numeros } = req.body;

  if (!vendedor_id || !rifa_id || !Array.isArray(numeros) || numeros.length === 0) {
    return res.status(400).json({ error: 'vendedor_id, rifa_id y numeros[] son requeridos' });
  }

  const numerosInvalidos = numeros.filter(n => !validarNumero(n));
  if (numerosInvalidos.length > 0) {
    return res.status(400).json({ error: `Números inválidos: ${numerosInvalidos.join(', ')}` });
  }

  try {
    // Verificar que ninguno de los números esté ya asignado a OTRO vendedor en esta rifa
    const conflictos = await pool.query(
      `SELECT nv.numero, u.nombre AS vendedor_actual
       FROM numeros_vendedor nv
       JOIN users u ON u.id = nv.vendedor_id
       WHERE nv.rifa_id = $1
         AND nv.numero = ANY($2)
         AND nv.vendedor_id != $3`,
      [rifa_id, numeros, vendedor_id]
    );

    if (conflictos.rows.length > 0) {
      const detalle = conflictos.rows
        .map(r => `${r.numero} (asignado a ${r.vendedor_actual})`)
        .join(', ');
      return res.status(409).json({
        error: 'NUMEROS_YA_ASIGNADOS',
        message: `Los siguientes números ya pertenecen a otro vendedor: ${detalle}`
      });
    }

    const values = numeros.map((n, i) => `($1, $2, $${i + 3})`).join(', ');
    const params = [vendedor_id, rifa_id, ...numeros];

    await pool.query(
      `INSERT INTO numeros_vendedor (vendedor_id, rifa_id, numero)
       VALUES ${values}
       ON CONFLICT (vendedor_id, rifa_id, numero) DO NOTHING`,
      params
    );

    res.json({ message: `${numeros.length} número(s) asignados al vendedor` });
  } catch (err) {
    console.error('Error asignando números:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ── DELETE /api/numeros/asignar (solo dueño) ──────────────
// Remover números asignados a un vendedor
router.delete('/asignar', authMiddleware, soloDueno, async (req, res) => {
  const { vendedor_id, rifa_id, numeros } = req.body;

  if (!vendedor_id || !rifa_id || !Array.isArray(numeros)) {
    return res.status(400).json({ error: 'vendedor_id, rifa_id y numeros[] son requeridos' });
  }

  try {
    await pool.query(
      `DELETE FROM numeros_vendedor
       WHERE vendedor_id = $1 AND rifa_id = $2 AND numero = ANY($3)`,
      [vendedor_id, rifa_id, numeros]
    );

    res.json({ message: 'Números removidos del vendedor' });
  } catch (err) {
    console.error('Error removiendo números:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ── GET /api/numeros/ventas/historial ─────────────────────
// Historial de ventas (dueño ve todo, vendedor solo las suyas)
router.get('/ventas/historial', authMiddleware, async (req, res) => {
  const { rifa_id, page = 1, limit = 50 } = req.query;
  const offset = (page - 1) * limit;

  try {
    let whereClause = req.user.rol === 'vendedor' ? 'WHERE v.vendedor_id = $1' : 'WHERE 1=1';
    let params = req.user.rol === 'vendedor' ? [req.user.id] : [];

    if (rifa_id) {
      params.push(rifa_id);
      whereClause += ` AND v.rifa_id = $${params.length}`;
    }

    params.push(limit, offset);

    const result = await pool.query(
      `SELECT v.*, r.nombre AS rifa_nombre, u.nombre AS vendedor_nombre
       FROM ventas v
       JOIN rifas r ON r.id = v.rifa_id
       JOIN users u ON u.id = v.vendedor_id
       ${whereClause}
       ORDER BY v.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json({
      ventas: result.rows,
      page: parseInt(page),
      limit: parseInt(limit)
    });
  } catch (err) {
    console.error('Error obteniendo historial:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ── DELETE /api/numeros/venta/:id (solo dueño) ────────────
// Anular una venta
router.delete('/venta/:id', authMiddleware, soloDueno, async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM ventas WHERE id = $1 RETURNING numero, rifa_id',
      [req.params.id]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ error: 'Venta no encontrada' });
    }

    res.json({
      message: `Venta anulada. Número ${result.rows[0].numero} vuelve a estar disponible.`
    });
  } catch (err) {
    console.error('Error anulando venta:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

module.exports = router;