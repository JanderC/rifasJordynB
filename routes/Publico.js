// ============================================================
//   RIFAS JORDYN — Rutas Públicas (sin autenticación)
//   ✅ ACTUALIZADO: soporte reserva de MÚLTIPLES números
// ============================================================
const router = require('express').Router();
const pool   = require('../config/db');
const { authMiddleware, soloDueno } = require('../middleware/auth');

/* ──────────────────────────────────────────────────────────
   GET /api/publico/rifas
────────────────────────────────────────────────────────── */
router.get('/rifas', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT
        r.id,
        r.nombre,
        r.descripcion,
        r.premio,
        r.precio,
        r.fecha_sorteo,
        r.loteria_ref,
        r.activa,
        r.imagen_url,
        COALESCE(r.tipo,   'sencilla') AS tipo,
        COALESCE(r.estado, 'activa')   AS estado,
        COALESCE(COUNT(DISTINCT v.numero), 0)::int           AS numeros_vendidos,
        COALESCE(SUM(v.precio_venta), 0)                     AS recaudado,
        ROUND(
          COALESCE(COUNT(DISTINCT v.numero), 0)::numeric / 10, 2
        )                                                    AS porcentaje
      FROM rifas r
      LEFT JOIN ventas v ON v.rifa_id = r.id
      WHERE r.activa = TRUE
        AND COALESCE(r.estado, 'activa') != 'archivada'
      GROUP BY r.id
      ORDER BY r.created_at DESC
    `);
    res.json(r.rows);
  } catch (e) {
    console.error('Error obteniendo rifas públicas:', e);
    res.status(500).json({ error: e.message });
  }
});

/* ──────────────────────────────────────────────────────────
   GET /api/publico/rifas/:id/numeros-disponibles
────────────────────────────────────────────────────────── */
router.get('/rifas/:id/numeros-disponibles', async (req, res) => {
  try {
    const vendidos = await pool.query(
      `SELECT numero, COUNT(*) AS veces FROM ventas WHERE rifa_id=$1 GROUP BY numero`,
      [req.params.id]
    );
    const reservados = await pool.query(
      `SELECT numero FROM reservas_cliente
       WHERE rifa_id=$1 AND estado='pendiente'`,
      [req.params.id]
    );
    const asignadosVendedor = await pool.query(
      `SELECT numero FROM numeros_vendedor WHERE rifa_id=$1`,
      [req.params.id]
    );

    const mapa = {};
    vendidos.rows.forEach(r => {
      mapa[r.numero] = parseInt(r.veces) >= 2 ? 'agotado' : 'vendido_1';
    });
    // Marcar números con reserva pendiente (puede haber varias para el mismo número
    // si ya tiene una venta previa, no bloqueamos doble reserva—la lógica de venta lo hace)
    reservados.rows.forEach(r => {
      if (!mapa[r.numero]) mapa[r.numero] = 'reservado';
    });
    asignadosVendedor.rows.forEach(r => {
      if (!mapa[r.numero]) mapa[r.numero] = 'vendedor';
    });

    const numeros = [];
    for (let i = 0; i < 1000; i++) {
      const n = String(i).padStart(3, '0');
      const estado = mapa[n] || 'disponible';
      if (estado !== 'vendedor') {
        numeros.push({ numero: n, estado });
      }
    }
    res.json(numeros);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ──────────────────────────────────────────────────────────
   POST /api/publico/reservar
   ✅ NUEVO: acepta `numeros` (array) además del legacy `numero` (string)
   Body:
     {
       rifa_id, nombre_cliente, telefono, metodo_pago,
       comprobante_base64, comprobante_nombre,
       numeros: ['001','045','123']   ← array de strings '000'–'999'
       // o en modo legacy:
       numero: '001'
     }
   Respuesta:
     { ok, reservas: [...], mensaje }
────────────────────────────────────────────────────────── */
router.post('/reservar', async (req, res) => {
  const {
    rifa_id,
    nombre_cliente,
    telefono,
    metodo_pago,
    comprobante_base64,
    comprobante_nombre,
  } = req.body;

  // Soporte legacy (numero string) y nuevo (numeros array)
  let numeros = req.body.numeros;
  if (!numeros && req.body.numero) {
    numeros = [req.body.numero];
  }

  // ── Validaciones básicas ──────────────────────────────
  if (!rifa_id || !nombre_cliente)
    return res.status(400).json({ error: 'rifa_id y nombre_cliente son requeridos' });

  if (!numeros || !Array.isArray(numeros) || numeros.length === 0)
    return res.status(400).json({ error: 'Debes seleccionar al menos un número' });

  if (numeros.length > 50)
    return res.status(400).json({ error: 'Máximo 50 números por reserva' });

  const invalidos = numeros.filter(n => !/^\d{3}$/.test(n));
  if (invalidos.length > 0)
    return res.status(400).json({ error: `Números con formato inválido: ${invalidos.join(', ')}` });

  // Eliminar duplicados
  const numerosUnicos = [...new Set(numeros)];

  if (!comprobante_base64)
    return res.status(400).json({ error: 'El comprobante de pago es obligatorio para reservar' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const reservasCreadas = [];
    const conflictos = [];

    for (const numero of numerosUnicos) {
      // Verificar si está agotado (2 ventas)
      const vendidos = await client.query(
        `SELECT COUNT(*) FROM ventas WHERE rifa_id=$1 AND numero=$2`,
        [rifa_id, numero]
      );
      if (parseInt(vendidos.rows[0].count) >= 2) {
        conflictos.push({ numero, razon: 'agotado' });
        continue;
      }

      // Verificar si ya tiene reserva pendiente
      const reservaExiste = await client.query(
        `SELECT id FROM reservas_cliente WHERE rifa_id=$1 AND numero=$2 AND estado='pendiente'`,
        [rifa_id, numero]
      );
      if (reservaExiste.rows.length > 0) {
        conflictos.push({ numero, razon: 'reserva_pendiente' });
        continue;
      }

      // Crear la reserva
      const r = await client.query(`
        INSERT INTO reservas_cliente
          (rifa_id, numero, nombre_cliente, telefono, metodo_pago,
           comprobante_base64, comprobante_nombre)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        RETURNING id, numero, nombre_cliente, estado, created_at
      `, [
        rifa_id,
        numero,
        nombre_cliente.trim(),
        telefono || null,
        metodo_pago || null,
        comprobante_base64,
        comprobante_nombre || null,
      ]);
      reservasCreadas.push(r.rows[0]);
    }

    // Si todos los números tuvieron conflicto, rollback
    if (reservasCreadas.length === 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'Ningún número pudo reservarse',
        conflictos,
      });
    }

    await client.query('COMMIT');

    // Compatibilidad legacy: si solo se envió un número, devolver `reserva` también
    const respuesta = {
      ok: true,
      reservas: reservasCreadas,
      total_reservados: reservasCreadas.length,
      mensaje: reservasCreadas.length === 1
        ? '¡Reserva enviada! El administrador verificará tu pago pronto.'
        : `¡${reservasCreadas.length} números reservados! El administrador verificará tu pago pronto.`,
    };
    if (conflictos.length > 0) respuesta.conflictos = conflictos;
    if (reservasCreadas.length === 1) respuesta.reserva = reservasCreadas[0]; // legacy

    res.status(201).json(respuesta);
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

/* ──────────────────────────────────────────────────────────
   GET /api/publico/reserva/:id
────────────────────────────────────────────────────────── */
router.get('/reserva/:id', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT rc.id, rc.numero, rc.nombre_cliente, rc.estado, rc.nota_admin,
              rc.created_at, rc.updated_at,
              r.nombre AS rifa_nombre, r.premio, r.precio, r.fecha_sorteo
       FROM reservas_cliente rc
       JOIN rifas r ON r.id = rc.rifa_id
       WHERE rc.id=$1`,
      [req.params.id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Reserva no encontrada' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ──────────────────────────────────────────────────────────
   GET /api/publico/reservas-cliente
   Busca TODAS las reservas de un cliente por nombre + rifa
   Query params: nombre_cliente, rifa_id
────────────────────────────────────────────────────────── */
router.get('/reservas-cliente', async (req, res) => {
  const { nombre_cliente, rifa_id } = req.query;
  if (!nombre_cliente)
    return res.status(400).json({ error: 'nombre_cliente es requerido' });

  try {
    const params = [nombre_cliente.trim()];
    let extra = '';
    if (rifa_id) { params.push(rifa_id); extra = `AND rc.rifa_id = $${params.length}`; }

    const r = await pool.query(`
      SELECT rc.id, rc.numero, rc.nombre_cliente, rc.estado, rc.nota_admin,
             rc.created_at, rc.updated_at,
             r.nombre AS rifa_nombre, r.premio, r.precio, r.fecha_sorteo
      FROM reservas_cliente rc
      JOIN rifas r ON r.id = rc.rifa_id
      WHERE LOWER(rc.nombre_cliente) = LOWER($1) ${extra}
      ORDER BY rc.created_at DESC
    `, params);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ══════════════════════════════════════════════════════════
   ADMIN
══════════════════════════════════════════════════════════ */

/* ── GET /api/publico/admin/reservas ──────────────────── */
router.get('/admin/reservas', authMiddleware, soloDueno, async (req, res) => {
  const { estado } = req.query;
  try {
    const r = await pool.query(`
      SELECT
        rc.*,
        r.nombre  AS rifa_nombre,
        r.precio,
        r.premio,
        r.fecha_sorteo
      FROM reservas_cliente rc
      JOIN rifas r ON r.id = rc.rifa_id
      ${estado && estado !== 'todos' ? 'WHERE rc.estado=$1' : ''}
      ORDER BY rc.created_at DESC
    `, estado && estado !== 'todos' ? [estado] : []);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── PUT /api/publico/admin/reservas/:id ──────────────── */
router.put('/admin/reservas/:id', authMiddleware, soloDueno, async (req, res) => {
  const { estado, nota_admin } = req.body;
  if (!['aprobado', 'rechazado'].includes(estado))
    return res.status(400).json({ error: 'estado debe ser aprobado o rechazado' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const res_r = await client.query(
      `UPDATE reservas_cliente SET estado=$1, nota_admin=$2, updated_at=NOW()
       WHERE id=$3 RETURNING *`,
      [estado, nota_admin || null, req.params.id]
    );
    if (!res_r.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'No encontrada' });
    }

    const reserva = res_r.rows[0];

    if (estado === 'aprobado') {
      const dueno = await client.query(`SELECT id FROM users WHERE rol='dueno' LIMIT 1`);
      const vendedorId = dueno.rows[0]?.id;
      const rifa = await client.query(`SELECT precio FROM rifas WHERE id=$1`, [reserva.rifa_id]);

      await client.query(`
        INSERT INTO ventas
          (rifa_id, numero, vendedor_id, nombre_comprador, telefono, precio_venta, observacion)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
      `, [
        reserva.rifa_id,
        reserva.numero,
        vendedorId,
        reserva.nombre_cliente,
        reserva.telefono,
        rifa.rows[0]?.precio || 0,
        `Compra online - Reserva #${reserva.id.slice(0, 8)} - ${reserva.metodo_pago || ''}`,
      ]);
    }

    await client.query('COMMIT');
    res.json({ ok: true, reserva: res_r.rows[0] });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

/* ── PUT /api/publico/admin/reservas-bulk ─────────────────
   Aprobar / rechazar múltiples reservas a la vez
   Body: { ids: [...], estado, nota_admin }
────────────────────────────────────────────────────────── */
router.put('/admin/reservas-bulk', authMiddleware, soloDueno, async (req, res) => {
  const { ids, estado, nota_admin } = req.body;
  if (!Array.isArray(ids) || ids.length === 0)
    return res.status(400).json({ error: 'ids[] es requerido' });
  if (!['aprobado', 'rechazado'].includes(estado))
    return res.status(400).json({ error: 'estado debe ser aprobado o rechazado' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const dueno = await client.query(`SELECT id FROM users WHERE rol='dueno' LIMIT 1`);
    const vendedorId = dueno.rows[0]?.id;

    let procesadas = 0;
    for (const id of ids) {
      const res_r = await client.query(
        `UPDATE reservas_cliente SET estado=$1, nota_admin=$2, updated_at=NOW()
         WHERE id=$3 AND estado='pendiente' RETURNING *`,
        [estado, nota_admin || null, id]
      );
      if (!res_r.rows[0]) continue;
      const reserva = res_r.rows[0];

      if (estado === 'aprobado') {
        const rifa = await client.query(`SELECT precio FROM rifas WHERE id=$1`, [reserva.rifa_id]);
        await client.query(`
          INSERT INTO ventas
            (rifa_id, numero, vendedor_id, nombre_comprador, telefono, precio_venta, observacion)
          VALUES ($1,$2,$3,$4,$5,$6,$7)
          ON CONFLICT DO NOTHING
        `, [
          reserva.rifa_id, reserva.numero, vendedorId,
          reserva.nombre_cliente, reserva.telefono,
          rifa.rows[0]?.precio || 0,
          `Compra online - Reserva #${reserva.id.slice(0, 8)} - ${reserva.metodo_pago || ''}`,
        ]);
      }
      procesadas++;
    }

    await client.query('COMMIT');
    res.json({ ok: true, procesadas });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

module.exports = router;