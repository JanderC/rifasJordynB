// ============================================================
//   RIFAS JORDYN — Rutas de Números
//   ✅ ACTUALIZADO: endpoint POST /vender-bulk para múltiples números
//   ✅ FIX PUNTO 3A: estado-global ahora soporta N rifas activas
//      (antes hardcodeaba LIMIT 1 / OFFSET 1, rompiendo con 3+)
//      La validación de agotado ya era correcta por rifa_id,
//      pero la vista global ahora refleja todos los pares rifa×número.
// ============================================================
const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { authMiddleware, soloDueno } = require('../middleware/auth');

const validarNumero = (num) => /^[0-9]{3}$/.test(num);

/* ──────────────────────────────────────────────────────────
   GET /api/numeros/estado-global
   ─────────────────────────────────────────────────────────
   FIX PUNTO 3A — Rifas Simultáneas
   ─────────────────────────────────────────────────────────
   PROBLEMA ORIGINAL:
     La query hardcodeaba dos subqueries con:
       WHERE v.rifa_id = (SELECT id FROM rifas WHERE activa=TRUE ORDER BY created_at LIMIT 1)
       WHERE v.rifa_id = (SELECT id FROM rifas WHERE activa=TRUE ORDER BY created_at OFFSET 1 LIMIT 1)
     Esto asumía EXACTAMENTE 2 rifas activas. Con 3+ rifas:
       - La rifa 3 quedaba invisible en el estado global.
       - Un número vendido en rifa 3 se mostraba como "libre" en el grid.
       - El estado_global resultante era incorrecto (solo calculaba rifa1 y rifa2).

   SOLUCIÓN:
     Reescribir la query para que funcione con cualquier número de rifas activas.
     El estado_global por número ahora es:
       - 'libre':           0 ventas en TODAS las rifas activas
       - 'parcial_vendido': ≥1 número tiene 1 venta (pero ninguno agotado)
       - 'parcial_agotado': ≥1 número agotado (2 ventas) pero no todos
       - 'agotado_total':   TODOS los números están agotados en TODAS sus rifas

     NOTA IMPORTANTE sobre la lógica de negocio:
     El número "001" puede venderse hasta 2 veces EN CADA rifa activa de forma independiente.
     Eso es correcto — rifas diferentes son productos diferentes.
     El estado_global es solo para el DISPLAY del grid admin (colores/labels),
     NO para controlar si se puede vender (eso lo hace POST /vender por rifa_id).
────────────────────────────────────────────────────────── */
router.get('/estado-global', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(`
      WITH rifas_activas AS (
        -- Obtener todas las rifas activas (sin límite hardcodeado)
        SELECT id AS rifa_id, nombre
        FROM rifas
        WHERE activa = TRUE
        ORDER BY created_at
      ),
      numeros_serie AS (
        -- Generar el rango 000–999
        SELECT LPAD(gs::text, 3, '0') AS numero
        FROM generate_series(0, 999) gs
      ),
      ventas_por_rifa_numero AS (
        -- Contar ventas de cada número en cada rifa activa
        SELECT
          v.numero,
          v.rifa_id,
          COUNT(*) AS veces
        FROM ventas v
        WHERE v.rifa_id IN (SELECT rifa_id FROM rifas_activas)
        GROUP BY v.numero, v.rifa_id
      ),
      estado_por_numero AS (
        -- Para cada número, calcular estado global considerando TODAS las rifas activas
        SELECT
          n.numero,
          COUNT(ra.rifa_id)                                        AS total_rifas,
          COALESCE(SUM(vpn.veces), 0)                              AS total_ventas_globales,
          COUNT(CASE WHEN COALESCE(vpn.veces, 0) >= 2 THEN 1 END) AS rifas_agotadas,
          COUNT(CASE WHEN COALESCE(vpn.veces, 0) = 1  THEN 1 END) AS rifas_con_1_venta,
          COUNT(CASE WHEN COALESCE(vpn.veces, 0) = 0  THEN 1 END) AS rifas_libres,
          -- Datos de las primeras dos rifas para compatibilidad con el frontend existente
          MAX(CASE WHEN ra_ord.rn = 1 THEN COALESCE(vpn.veces, 0) END) AS rifa1_vendido,
          MAX(CASE WHEN ra_ord.rn = 2 THEN COALESCE(vpn.veces, 0) END) AS rifa2_vendido
        FROM numeros_serie n
        CROSS JOIN rifas_activas ra
        LEFT JOIN ventas_por_rifa_numero vpn
          ON vpn.numero = n.numero AND vpn.rifa_id = ra.rifa_id
        LEFT JOIN (
          SELECT rifa_id, ROW_NUMBER() OVER (ORDER BY created_at) AS rn
          FROM rifas_activas
        ) ra_ord ON ra_ord.rifa_id = ra.rifa_id
        GROUP BY n.numero
      )
      SELECT
        numero,
        total_rifas,
        total_ventas_globales,
        rifas_agotadas,
        rifas_con_1_venta,
        rifas_libres,
        -- Compatibilidad con el frontend que espera rifa1_vendido / rifa2_vendido
        COALESCE(rifa1_vendido, 0)::int AS rifa1_vendido,
        CASE
          WHEN COALESCE(rifa1_vendido, 0) = 0 THEN 'disponible'
          WHEN COALESCE(rifa1_vendido, 0) = 1 THEN 'vendido_1'
          ELSE 'agotado'
        END AS rifa1_estado,
        COALESCE(rifa2_vendido, 0)::int AS rifa2_vendido,
        CASE
          WHEN COALESCE(rifa2_vendido, 0) = 0 THEN 'disponible'
          WHEN COALESCE(rifa2_vendido, 0) = 1 THEN 'vendido_1'
          ELSE 'agotado'
        END AS rifa2_estado,
        -- Estado global calculado sobre TODAS las rifas activas
        CASE
          WHEN total_ventas_globales = 0
            THEN 'libre'
          WHEN rifas_agotadas = total_rifas
            THEN 'agotado_total'
          WHEN rifas_agotadas > 0
            THEN 'parcial_agotado'
          ELSE 'parcial_vendido'
        END AS estado_global
      FROM estado_por_numero
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
          compradores: ventas.rows,
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

// ── POST /api/numeros/vender ───────────────────────────────
// Vender un único número
// FIX PUNTO 3A: La validación ya era correcta — usa rifa_id en el WHERE,
// por lo tanto el mismo número puede venderse en rifas distintas.
// Solo se bloquea si ESA rifa_id ya tiene 2 ventas de ESE número.
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

    // Contar ventas de ESTE número en ESTA rifa (correcto: scoped por rifa_id)
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
        veces_vendido: veces,
      });
    }

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

    // NUEVO: desestructura cedula y correo del body para ventas directas desde el admin
    const { cedula: cedulaVenta, correo: correoVenta } = req.body;

    const venta = await client.query(
      `INSERT INTO ventas
         (rifa_id, numero, vendedor_id, nombre_comprador,
          cedula, correo, telefono, precio_venta, observacion)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        rifa_id, numero, req.user.id,
        nombre_comprador.trim(),
        cedulaVenta?.trim() || null,
        correoVenta?.trim() || null,
        telefono || null,
        rifaResult.rows[0].precio,
        observacion || null,
      ]
    );

    const nuevasVeces = veces + 1;
    const estado = nuevasVeces >= 2 ? 'agotado' : 'vendido_1';

    await client.query('COMMIT');

    res.status(201).json({
      message: `✅ Número ${numero} vendido exitosamente`,
      venta: venta.rows[0],
      estado_actual: estado,
      veces_vendido: nuevasVeces,
      alerta: nuevasVeces === 2 ? `⚠️ El número ${numero} ahora está AGOTADO en esta rifa` : null,
    });

  } catch (err) {
    await client.query('ROLLBACK');
    if (err.message?.includes('NUMERO_AGOTADO')) {
      return res.status(409).json({ error: 'NUMERO_AGOTADO', message: `⛔ El número ${numero} está agotado` });
    }
    console.error('Error registrando venta:', err);
    res.status(500).json({ error: 'Error del servidor al registrar la venta' });
  } finally {
    client.release();
  }
});

/* ── POST /api/numeros/vender-bulk ───────────────────────────
   Registrar venta de MÚLTIPLES números en una transacción
   FIX PUNTO 3A: igual que /vender, la validación ya era scoped
   por rifa_id — se mantiene. Solo se mejora el mensaje de error.
─────────────────────────────────────────────────────────── */
router.post('/vender-bulk', authMiddleware, async (req, res) => {
  const { rifa_id, numeros, nombre_comprador, cedula, correo, telefono, observacion } = req.body;

  if (!rifa_id || !nombre_comprador) {
    return res.status(400).json({ error: 'rifa_id y nombre_comprador son requeridos' });
  }

  if (!Array.isArray(numeros) || numeros.length === 0) {
    return res.status(400).json({ error: 'numeros[] debe ser un array no vacío' });
  }

  if (numeros.length > 100) {
    return res.status(400).json({ error: 'Máximo 100 números por operación' });
  }

  const invalidos = numeros.filter(n => !validarNumero(n));
  if (invalidos.length > 0) {
    return res.status(400).json({ error: `Números inválidos: ${invalidos.join(', ')}` });
  }

  const numerosUnicos = [...new Set(numeros)];
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const rifaResult = await client.query('SELECT precio, nombre FROM rifas WHERE id = $1', [rifa_id]);
    if (!rifaResult.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Rifa no encontrada' });
    }
    const precioBoleto = rifaResult.rows[0].precio;

    // Si el vendedor tiene asignaciones, verificar de antemano
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

    // Obtener estado actual de todos los números EN ESTA RIFA en una sola consulta
    // (scoped por rifa_id — correcto para rifas simultáneas)
    const estadoActual = await client.query(
      `SELECT numero, COUNT(*) AS veces
       FROM ventas
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
        fallidos.push({ numero, razon: 'no_asignado' });
        continue;
      }

      const veces = vecesMap[numero] || 0;
      if (veces >= 2) {
        fallidos.push({ numero, razon: 'agotado' });
        continue;
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
            cedula?.trim() || null,
            correo?.trim() || null,
            telefono || null,
            precioBoleto,
            observacion || `Venta múltiple`,
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
      return res.status(409).json({
        error: 'Ningún número pudo venderse',
        fallidos,
      });
    }

    await client.query('COMMIT');

    res.status(201).json({
      message: `✅ ${vendidos.length} número(s) vendidos exitosamente`,
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
        message: `Los siguientes números ya pertenecen a otro vendedor: ${detalle}`,
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
      limit: parseInt(limit),
    });
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

    if (!result.rows[0]) {
      return res.status(404).json({ error: 'Venta no encontrada' });
    }

    res.json({
      message: `Venta anulada. Número ${result.rows[0].numero} vuelve a estar disponible.`,
    });
  } catch (err) {
    console.error('Error anulando venta:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

module.exports = router;