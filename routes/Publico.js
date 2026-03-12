// ============================================================
//   RIFAS JORDYN — Rutas Públicas (sin autenticación)
// ============================================================
const router = require('express').Router();
const pool   = require('../config/db');
const { authMiddleware, soloDueno } = require('../middleware/auth');

/* ──────────────────────────────────────────────────────────
   GET /api/publico/rifas
   ⚠️  CORRECCIÓN: incluye imagen_url + filtra solo activas
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
        r.imagen_url,                        -- ← campo que faltaba llegar al cliente
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
      `SELECT numero FROM reservas_cliente WHERE rifa_id=$1 AND estado='pendiente'`,
      [req.params.id]
    );
    // Números asignados a vendedores → NO aparecen en el grid público
    const asignadosVendedor = await pool.query(
      `SELECT numero FROM numeros_vendedor WHERE rifa_id=$1`,
      [req.params.id]
    );

    const mapa = {};
    vendidos.rows.forEach(r => { mapa[r.numero] = parseInt(r.veces) >= 2 ? 'agotado' : 'vendido_1'; });
    reservados.rows.forEach(r => { if (!mapa[r.numero]) mapa[r.numero] = 'reservado'; });
    // Marcar como 'vendedor' para excluirlos del resultado público
    asignadosVendedor.rows.forEach(r => { if (!mapa[r.numero]) mapa[r.numero] = 'vendedor'; });

    const numeros = [];
    for (let i = 0; i < 1000; i++) {
      const n = String(i).padStart(3, '0');
      const estado = mapa[n] || 'disponible';
      // Excluir completamente los números de vendedor del listado público
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
────────────────────────────────────────────────────────── */
router.post('/reservar', async (req, res) => {
  const { rifa_id, numero, nombre_cliente, telefono, metodo_pago, comprobante_base64, comprobante_nombre } = req.body;

  if (!rifa_id || !numero || !nombre_cliente)
    return res.status(400).json({ error: 'rifa_id, numero y nombre_cliente son requeridos' });

  if (!comprobante_base64)
    return res.status(400).json({ error: 'El comprobante de pago es obligatorio para reservar un número' });

  if (!/^\d{3}$/.test(numero))
    return res.status(400).json({ error: 'Número inválido' });

  try {
    const vendidos = await pool.query(
      `SELECT COUNT(*) FROM ventas WHERE rifa_id=$1 AND numero=$2`,
      [rifa_id, numero]
    );
    if (parseInt(vendidos.rows[0].count) >= 2)
      return res.status(409).json({ error: 'Este número ya está agotado' });

    const reservaExiste = await pool.query(
      `SELECT id FROM reservas_cliente WHERE rifa_id=$1 AND numero=$2 AND estado='pendiente'`,
      [rifa_id, numero]
    );
    if (reservaExiste.rows.length > 0)
      return res.status(409).json({ error: 'Este número ya tiene una reserva pendiente de aprobación' });

    const r = await pool.query(`
      INSERT INTO reservas_cliente
        (rifa_id, numero, nombre_cliente, telefono, metodo_pago, comprobante_base64, comprobante_nombre)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      RETURNING id, numero, nombre_cliente, estado, created_at
    `, [rifa_id, numero, nombre_cliente.trim(), telefono || null, metodo_pago || null, comprobante_base64, comprobante_nombre || null]);

    res.status(201).json({ ok: true, reserva: r.rows[0], mensaje: '¡Reserva enviada! El administrador verificará tu pago pronto.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ──────────────────────────────────────────────────────────
   GET /api/publico/reserva/:id
────────────────────────────────────────────────────────── */
router.get('/reserva/:id', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT rc.id, rc.numero, rc.nombre_cliente, rc.estado, rc.nota_admin, rc.created_at, rc.updated_at,
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

/* ══════════════════════════════════════════════════════════
   ADMIN
══════════════════════════════════════════════════════════ */

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
      ${estado ? 'WHERE rc.estado=$1' : ''}
      ORDER BY rc.created_at DESC
    `, estado ? [estado] : []);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/admin/reservas/:id', authMiddleware, soloDueno, async (req, res) => {
  const { estado, nota_admin } = req.body;
  if (!['aprobado','rechazado'].includes(estado))
    return res.status(400).json({ error: 'estado debe ser aprobado o rechazado' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const res_r = await client.query(
      `UPDATE reservas_cliente SET estado=$1, nota_admin=$2, updated_at=NOW() WHERE id=$3 RETURNING *`,
      [estado, nota_admin || null, req.params.id]
    );
    if (!res_r.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'No encontrada' }); }

    const reserva = res_r.rows[0];

    if (estado === 'aprobado') {
      const dueno = await client.query(`SELECT id FROM users WHERE rol='dueno' LIMIT 1`);
      const vendedorId = dueno.rows[0]?.id;
      const rifa = await client.query(`SELECT precio FROM rifas WHERE id=$1`, [reserva.rifa_id]);

      await client.query(`
        INSERT INTO ventas (rifa_id, numero, vendedor_id, nombre_comprador, telefono, precio_venta, observacion)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
      `, [
        reserva.rifa_id, reserva.numero, vendedorId,
        reserva.nombre_cliente, reserva.telefono,
        rifa.rows[0]?.precio || 0,
        `Compra online - Reserva #${reserva.id.slice(0,8)} - ${reserva.metodo_pago || ''}`,
      ]);
    }

    await client.query('COMMIT');
    res.json({ ok: true, reserva: res_r.rows[0] });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

module.exports = router;