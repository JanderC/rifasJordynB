// ============================================================
//   RIFAS JORDYN — Rutas de Números
//   ✅ FIX: estado-global soporta N rifas activas
//   ✅ NUEVO: asignación global en numeros_vendedor_global
//      POST /asignar  → inserta en numeros_vendedor_global (sin rifa_id)
//      DELETE /asignar → borra de numeros_vendedor_global
//      La copia a numeros_vendedor (con rifa_id) la hace rifas.js
//      al crear/editar la rifa con vendedores_ids.
// ============================================================
const express = require('express');
const router  = express.Router();
const pool    = require('../config/db');
const { authMiddleware, soloDueno } = require('../middleware/auth');

const validarNumero = (num) => /^[0-9]{3}$/.test(num);

/* ──────────────────────────────────────────────────────────
   GET /api/numeros/estado-global
   Devuelve los 1000 números con su estado en todas las rifas
   activas. Los números reservados por vendedores (que no están
   en numeros_vendedor de esta rifa) no se bloquean aquí —
   la lógica de reserva es por rifa en numeros_vendedor.
────────────────────────────────────────────────────────── */
router.get('/estado-global', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(`
      WITH
      rifas_activas AS (
        SELECT id AS rifa_id,
               ROW_NUMBER() OVER (ORDER BY created_at) AS rn
        FROM rifas
        WHERE activa = TRUE
      ),
      ventas_agg AS (
        SELECT v.numero,
               v.rifa_id,
               COUNT(*)::int AS veces
        FROM ventas v
        INNER JOIN rifas_activas ra ON ra.rifa_id = v.rifa_id
        GROUP BY v.numero, v.rifa_id
      ),
      total_rifas_cte AS (
        SELECT COUNT(*)::int AS total FROM rifas_activas
      ),
      estado AS (
        SELECT
          n.numero,
          tr.total                                                       AS total_rifas,
          COALESCE(SUM(va.veces), 0)::int                               AS total_ventas_globales,
          COUNT(CASE WHEN COALESCE(va.veces, 0) >= 2 THEN 1 END)::int  AS rifas_agotadas,
          COUNT(CASE WHEN COALESCE(va.veces, 0) = 1  THEN 1 END)::int  AS rifas_con_1_venta,
          COALESCE(MAX(CASE WHEN ra.rn = 1 THEN va.veces END), 0)::int AS rifa1_vendido,
          COALESCE(MAX(CASE WHEN ra.rn = 2 THEN va.veces END), 0)::int AS rifa2_vendido
        FROM (
          SELECT LPAD(gs::text, 3, '0') AS numero
          FROM generate_series(0, 999) gs
        ) n
        CROSS JOIN rifas_activas ra
        CROSS JOIN total_rifas_cte tr
        LEFT JOIN ventas_agg va ON va.numero = n.numero AND va.rifa_id = ra.rifa_id
        GROUP BY n.numero, tr.total
      )
      SELECT
        numero,
        total_rifas,
        total_ventas_globales,
        rifas_agotadas,
        rifas_con_1_venta,
        rifa1_vendido,
        CASE
          WHEN rifa1_vendido = 0 THEN 'disponible'
          WHEN rifa1_vendido = 1 THEN 'vendido_1'
          ELSE 'agotado'
        END AS rifa1_estado,
        rifa2_vendido,
        CASE
          WHEN rifa2_vendido = 0 THEN 'disponible'
          WHEN rifa2_vendido = 1 THEN 'vendido_1'
          ELSE 'agotado'
        END AS rifa2_estado,
        CASE
          WHEN total_ventas_globales = 0    THEN 'libre'
          WHEN rifas_agotadas = total_rifas THEN 'agotado_total'
          WHEN rifas_agotadas > 0           THEN 'parcial_agotado'
          ELSE 'parcial_vendido'
        END AS estado_global
      FROM estado
      ORDER BY numero
    `);

    res.json(result.rows);
  } catch (err) {
    console.error('Error estado global:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ── GET /api/numeros/verificar/:numero ────────────────────
router.get('/verificar/:numero', authMiddleware, async (req, res) => {
  const { numero } = req.params;

  if (!validarNumero(numero))
    return res.status(400).json({ error: 'Número inválido. Debe ser entre 000 y 999' });

  try {
    const rifas = await pool.query('SELECT * FROM rifas WHERE activa = TRUE ORDER BY created_at');

    const disponibilidad = await Promise.all(
      rifas.rows.map(async (rifa) => {
        const ventas = await pool.query(
          `SELECT v.id, v.nombre_comprador, v.telefono, v.cedula, v.created_at,
                  u.nombre AS nombre_vendedor
           FROM ventas v
           JOIN users u ON u.id = v.vendedor_id
           WHERE v.rifa_id = $1 AND v.numero = $2
           ORDER BY v.created_at`,
          [rifa.id, numero]
        );

        const veces_vendido     = ventas.rows.length;
        let bloqueadoPorOtro    = false;
        let vendedorPropietario = null;

        if (req.user.rol === 'vendedor') {
          // Verificar si hay asignaciones para esta rifa
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
              bloqueadoPorOtro    = true;
              vendedorPropietario = propietario.vendedor_nombre;
            }
          }
        }

        const disponible = veces_vendido < 2 && !bloqueadoPorOtro;

        return {
          rifa_id:       rifa.id,
          rifa_nombre:   rifa.nombre,
          premio:        rifa.premio,
          precio:        rifa.precio,
          fecha_sorteo:  rifa.fecha_sorteo,
          loteria_ref:   rifa.loteria_ref,
          veces_vendido,
          estado: bloqueadoPorOtro
            ? 'asignado_otro'
            : veces_vendido === 0 ? 'disponible'
            : veces_vendido === 1 ? 'vendido_1'
            : 'agotado',
          disponible,
          bloqueado_por: vendedorPropietario,
          compradores:   ventas.rows,
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

// ── POST /api/numeros/vender ──────────────────────────────
router.post('/vender', authMiddleware, async (req, res) => {
  const { rifa_id, numero, nombre_comprador, cedula, correo, telefono, observacion } = req.body;

  if (!rifa_id || !numero || !nombre_comprador)
    return res.status(400).json({ error: 'rifa_id, numero y nombre_comprador son requeridos' });

  if (!validarNumero(numero))
    return res.status(400).json({ error: 'Número inválido. Debe ser entre 000 y 999' });

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const checkResult = await client.query(
      `SELECT COUNT(*) AS veces FROM ventas WHERE rifa_id = $1 AND numero = $2`,
      [rifa_id, numero]
    );
    const veces = parseInt(checkResult.rows[0].veces);

    if (veces >= 2) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error:   'NUMERO_AGOTADO',
        message: `⛔ El número ${numero} ya fue vendido 2 veces y está AGOTADO en esta rifa`,
        veces_vendido: veces,
      });
    }

    if (req.user.rol === 'vendedor') {
      // Verificar si hay asignaciones en esta rifa
      const hayAsignados = await client.query(
        `SELECT COUNT(*) AS total FROM numeros_vendedor WHERE rifa_id = $1`,
        [rifa_id]
      );
      if (parseInt(hayAsignados.rows[0].total) > 0) {
        const essuyo = await client.query(
          `SELECT 1 FROM numeros_vendedor WHERE vendedor_id = $1 AND rifa_id = $2 AND numero = $3`,
          [req.user.id, rifa_id, numero]
        );
        if (!essuyo.rows[0]) {
          await client.query('ROLLBACK');
          return res.status(403).json({
            error:   'NUMERO_NO_ASIGNADO',
            message: `⛔ El número ${numero} no está asignado a tu cartera.`,
          });
        }
      }
    }

    const rifaResult = await client.query('SELECT precio FROM rifas WHERE id = $1', [rifa_id]);
    if (!rifaResult.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Rifa no encontrada' });
    }

    const venta = await client.query(
      `INSERT INTO ventas
         (rifa_id, numero, vendedor_id, nombre_comprador,
          cedula, correo, telefono, precio_venta, observacion)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        rifa_id, numero, req.user.id,
        nombre_comprador.trim(),
        cedula?.trim()  || null,
        correo?.trim()  || null,
        telefono        || null,
        rifaResult.rows[0].precio,
        observacion     || null,
      ]
    );

    const nuevasVeces = veces + 1;
    const estado      = nuevasVeces >= 2 ? 'agotado' : 'vendido_1';

    await client.query('COMMIT');

    res.status(201).json({
      message:       `✅ Número ${numero} vendido exitosamente`,
      venta:         venta.rows[0],
      estado_actual: estado,
      veces_vendido: nuevasVeces,
      alerta:        nuevasVeces === 2 ? `⚠️ El número ${numero} ahora está AGOTADO en esta rifa` : null,
    });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error registrando venta:', err);
    res.status(500).json({ error: 'Error del servidor al registrar la venta' });
  } finally {
    client.release();
  }
});

/* ── POST /api/numeros/vender-bulk ───────────────────────── */
router.post('/vender-bulk', authMiddleware, async (req, res) => {
  const { rifa_id, numeros, nombre_comprador, cedula, correo, telefono, observacion } = req.body;

  if (!rifa_id || !nombre_comprador)
    return res.status(400).json({ error: 'rifa_id y nombre_comprador son requeridos' });

  if (!Array.isArray(numeros) || numeros.length === 0)
    return res.status(400).json({ error: 'numeros[] debe ser un array no vacío' });

  if (numeros.length > 100)
    return res.status(400).json({ error: 'Máximo 100 números por operación' });

  const invalidos = numeros.filter(n => !validarNumero(n));
  if (invalidos.length > 0)
    return res.status(400).json({ error: `Números inválidos: ${invalidos.join(', ')}` });

  const numerosUnicos = [...new Set(numeros)];
  const client        = await pool.connect();

  try {
    await client.query('BEGIN');

    const rifaResult = await client.query('SELECT precio, nombre FROM rifas WHERE id = $1', [rifa_id]);
    if (!rifaResult.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Rifa no encontrada' });
    }

    const precioBoleto = rifaResult.rows[0].precio;

    let numerosPermitidos = new Set(numerosUnicos);
    if (req.user.rol === 'vendedor') {
      const hayAsignados = await client.query(
        `SELECT COUNT(*) AS total FROM numeros_vendedor WHERE rifa_id = $1`,
        [rifa_id]
      );
      if (parseInt(hayAsignados.rows[0].total) > 0) {
        const asignados = await client.query(
          `SELECT numero FROM numeros_vendedor WHERE vendedor_id = $1 AND rifa_id = $2`,
          [req.user.id, rifa_id]
        );
        numerosPermitidos = new Set(asignados.rows.map(r => r.numero));
      }
    }

    const estadoActual = await client.query(
      `SELECT numero, COUNT(*) AS veces FROM ventas
       WHERE rifa_id = $1 AND numero = ANY($2)
       GROUP BY numero`,
      [rifa_id, numerosUnicos]
    );
    const vecesMap = {};
    estadoActual.rows.forEach(r => { vecesMap[r.numero] = parseInt(r.veces); });

    const vendidos = [];
    const fallidos = [];

    for (const numero of numerosUnicos) {
      if (!numerosPermitidos.has(numero) && req.user.rol === 'vendedor') {
        fallidos.push({ numero, razon: 'no_asignado' }); continue;
      }
      const veces = vecesMap[numero] || 0;
      if (veces >= 2) {
        fallidos.push({ numero, razon: 'agotado' }); continue;
      }
      try {
        const venta = await client.query(
          `INSERT INTO ventas
             (rifa_id, numero, vendedor_id, nombre_comprador,
              cedula, correo, telefono, precio_venta, observacion)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           RETURNING *`,
          [
            rifa_id, numero, req.user.id,
            nombre_comprador.trim(),
            cedula?.trim()  || null,
            correo?.trim()  || null,
            telefono        || null,
            precioBoleto,
            observacion     || `Venta múltiple`,
          ]
        );
        vendidos.push({ numero, estado: veces + 1 >= 2 ? 'agotado' : 'vendido_1', venta: venta.rows[0] });
        vecesMap[numero] = veces + 1;
      } catch (insertErr) {
        fallidos.push({ numero, razon: 'conflicto_bd' });
      }
    }

    if (vendidos.length === 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Ningún número pudo venderse', fallidos });
    }

    await client.query('COMMIT');
    res.status(201).json({
      message:       `✅ ${vendidos.length} número(s) vendidos exitosamente`,
      vendidos,
      fallidos,
      total_vendido: vendidos.length,
      total_fallido: fallidos.length,
    });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error en venta bulk:', err);
    res.status(500).json({ error: 'Error del servidor' });
  } finally {
    client.release();
  }
});

// ── GET /api/numeros/vendedor/mis-numeros ─────────────────
// Devuelve los números globales del vendedor logueado
// con su estado por rifa (para el módulo de números en admin)
router.get('/vendedor/mis-numeros', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         ng.numero,
         nv.rifa_id,
         r.nombre AS rifa_nombre,
         COUNT(v.id)::int AS veces_vendido,
         CASE
           WHEN COUNT(v.id) = 0 THEN 'disponible'
           WHEN COUNT(v.id) = 1 THEN 'vendido_1'
           ELSE 'agotado'
         END AS estado
       FROM numeros_vendedor_global ng
       LEFT JOIN numeros_vendedor nv
         ON nv.vendedor_id = ng.vendedor_id AND nv.numero = ng.numero
       LEFT JOIN rifas r ON r.id = nv.rifa_id
       LEFT JOIN ventas v
         ON v.rifa_id = nv.rifa_id AND v.numero = ng.numero
       WHERE ng.vendedor_id = $1
       GROUP BY ng.numero, nv.rifa_id, r.nombre
       ORDER BY ng.numero`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error obteniendo mis números:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ── POST /api/numeros/asignar (solo dueño) ────────────────
// Ahora asigna globalmente en numeros_vendedor_global (sin rifa_id)
// La copia a numeros_vendedor con rifa_id la hace rifas.js
router.post('/asignar', authMiddleware, soloDueno, async (req, res) => {
  const { vendedor_id, numeros } = req.body;

  if (!vendedor_id || !Array.isArray(numeros) || numeros.length === 0)
    return res.status(400).json({ error: 'vendedor_id y numeros[] son requeridos' });

  const numerosInvalidos = numeros.filter(n => !validarNumero(n));
  if (numerosInvalidos.length > 0)
    return res.status(400).json({ error: `Números inválidos: ${numerosInvalidos.join(', ')}` });

  try {
    // Verificar conflictos: números ya asignados a OTRO vendedor
    const conflictos = await pool.query(
      `SELECT ng.numero, u.nombre AS vendedor_actual
       FROM numeros_vendedor_global ng
       JOIN users u ON u.id = ng.vendedor_id
       WHERE ng.numero = ANY($1) AND ng.vendedor_id != $2`,
      [numeros, vendedor_id]
    );

    if (conflictos.rows.length > 0) {
      const detalle = conflictos.rows
        .map(r => `${r.numero} (asignado a ${r.vendedor_actual})`)
        .join(', ');
      return res.status(409).json({
        error:   'NUMEROS_YA_ASIGNADOS',
        message: `Los siguientes números ya pertenecen a otro vendedor: ${detalle}`,
      });
    }

    // Insertar en tabla global
    if (numeros.length > 0) {
      const values = numeros.map((_, i) => `($1, $${i + 2})`).join(', ');
      await pool.query(
        `INSERT INTO numeros_vendedor_global (vendedor_id, numero)
         VALUES ${values}
         ON CONFLICT (vendedor_id, numero) DO NOTHING`,
        [vendedor_id, ...numeros]
      );
    }

    res.json({ message: `${numeros.length} número(s) asignados globalmente al vendedor` });
  } catch (err) {
    console.error('Error asignando números:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ── DELETE /api/numeros/asignar (solo dueño) ──────────────
// Borra de la tabla global. También borra de numeros_vendedor
// (asignaciones por rifa) donde no haya ventas registradas.
router.delete('/asignar', authMiddleware, soloDueno, async (req, res) => {
  const { vendedor_id, numeros } = req.body;

  if (!vendedor_id || !Array.isArray(numeros))
    return res.status(400).json({ error: 'vendedor_id y numeros[] son requeridos' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Verificar que ninguno de los números a quitar tenga ventas activas
    const conVentas = await client.query(
      `SELECT DISTINCT nv.numero
       FROM numeros_vendedor nv
       JOIN ventas v ON v.rifa_id = nv.rifa_id AND v.numero = nv.numero AND v.vendedor_id = nv.vendedor_id
       WHERE nv.vendedor_id = $1 AND nv.numero = ANY($2)`,
      [vendedor_id, numeros]
    );

    if (conVentas.rows.length > 0) {
      await client.query('ROLLBACK');
      const nums = conVentas.rows.map(r => r.numero).join(', ');
      return res.status(409).json({
        error:   'NUMEROS_CON_VENTAS',
        message: `No se pueden quitar los números ${nums} porque tienen ventas registradas en una rifa activa.`,
      });
    }

    // Borrar de la tabla global
    await client.query(
      `DELETE FROM numeros_vendedor_global WHERE vendedor_id = $1 AND numero = ANY($2)`,
      [vendedor_id, numeros]
    );

    // Borrar de asignaciones por rifa (donde no hay ventas)
    await client.query(
      `DELETE FROM numeros_vendedor
       WHERE vendedor_id = $1 AND numero = ANY($2)
         AND numero NOT IN (
           SELECT numero FROM ventas
           WHERE vendedor_id = $1
         )`,
      [vendedor_id, numeros]
    );

    await client.query('COMMIT');
    res.json({ message: `${numeros.length} número(s) removidos del vendedor` });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error removiendo números:', err);
    res.status(500).json({ error: 'Error del servidor' });
  } finally {
    client.release();
  }
});

// ── GET /api/numeros/ventas/historial ─────────────────────
router.get('/ventas/historial', authMiddleware, async (req, res) => {
  const { rifa_id, page = 1, limit = 50 } = req.query;
  const offset = (page - 1) * limit;

  try {
    let whereClause = req.user.rol === 'vendedor' ? 'WHERE v.vendedor_id = $1' : 'WHERE 1=1';
    let params      = req.user.rol === 'vendedor' ? [req.user.id] : [];

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

    res.json({ ventas: result.rows, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    console.error('Error obteniendo historial:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ── DELETE /api/numeros/venta/:id (solo dueño) ────────────
router.delete('/venta/:id', authMiddleware, soloDueno, async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM ventas WHERE id = $1 RETURNING numero, rifa_id',
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Venta no encontrada' });
    res.json({ message: `Venta anulada. Número ${result.rows[0].numero} vuelve a estar disponible.` });
  } catch (err) {
    console.error('Error anulando venta:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

module.exports = router;