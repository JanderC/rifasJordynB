// ============================================================
//   RIFAS JORDYN — Rutas Públicas (sin autenticación)
//   ✅ ACTUALIZADO: campo `ofertas` expuesto, precio real en aprobación
//   ✅ FIX PUNTO 1: fecha_sorteo devuelta como ISO 8601 con to_char()
//   ✅ NUEVO: cedula (obligatoria) y correo (opcional) en reservas y ventas
// ============================================================
const router = require('express').Router();
const pool   = require('../config/db');
const { authMiddleware, soloDueno } = require('../middleware/auth');

function calcularPrecioReal(cantidad, ofertas, precioUnitario) {
  if (!Array.isArray(ofertas) || ofertas.length === 0 || cantidad === 0)
    return precioUnitario * cantidad;
  let mejorTotal = precioUnitario * cantidad;
  for (const o of ofertas) {
    if (cantidad >= o.cantidad && cantidad % o.cantidad === 0) {
      const total = o.precio_total * (cantidad / o.cantidad);
      if (total < mejorTotal) mejorTotal = total;
    }
  }
  return mejorTotal;
}

const FECHA_SQL = (alias = 'r') =>
  `to_char(${alias}.fecha_sorteo, 'YYYY-MM-DD"T"HH24:MI:SS') AS fecha_sorteo`;

/* ── GET /api/publico/rifas ─────────────────────────────── */
router.get('/rifas', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT
        r.id, r.nombre, r.descripcion, r.premio, r.precio,
        ${FECHA_SQL('r')},
        r.loteria_ref, r.activa, r.imagen_url,
        COALESCE(r.tipo,   'sencilla') AS tipo,
        COALESCE(r.estado, 'activa')   AS estado,
        COALESCE(r.ofertas, '[]'::jsonb) AS ofertas,
        COALESCE(COUNT(DISTINCT v.numero), 0)::int AS numeros_vendidos,
        COALESCE(SUM(v.precio_venta), 0)           AS recaudado,
        ROUND(COALESCE(COUNT(DISTINCT v.numero), 0)::numeric / 10, 2) AS porcentaje
      FROM rifas r
      LEFT JOIN ventas v ON v.rifa_id = r.id
      WHERE r.activa = TRUE AND COALESCE(r.estado, 'activa') != 'archivada'
      GROUP BY r.id
      ORDER BY r.created_at DESC
    `);
    res.json(r.rows);
  } catch (e) {
    console.error('Error obteniendo rifas públicas:', e);
    res.status(500).json({ error: e.message });
  }
});

/* ── GET /api/publico/rifas/:id/numeros-disponibles ─────── */
router.get('/rifas/:id/numeros-disponibles', async (req, res) => {
  try {
    // 1. Obtener el tipo de la rifa para saber si es simultánea o no
    const rifaR = await pool.query(
      `SELECT COALESCE(tipo, 'sencilla') AS tipo FROM rifas WHERE id = $1`,
      [req.params.id]
    );
    if (!rifaR.rows[0]) return res.status(404).json({ error: 'Rifa no encontrada' });
    const esSimultanea = rifaR.rows[0].tipo === 'simultanea';

    // 2. Números vendidos y reservados (igual que antes)
    const vendidos   = await pool.query(
      `SELECT numero, COUNT(*) AS veces FROM ventas WHERE rifa_id=$1 GROUP BY numero`,
      [req.params.id]
    );
    const reservados = await pool.query(
      `SELECT numero FROM reservas_cliente WHERE rifa_id=$1 AND estado='pendiente'`,
      [req.params.id]
    );

    // 3. Números asignados a vendedores, con su serie (A o B si existe)
    const asignadosVendedor = await pool.query(
      `SELECT numero, COALESCE(serie, 'A') AS serie
       FROM numeros_vendedor
       WHERE rifa_id=$1`,
      [req.params.id]
    );

    // Construir mapa de ventas/reservas (igual que antes)
    const mapa = {};
    vendidos.rows.forEach(r => {
      mapa[r.numero] = parseInt(r.veces) >= 2 ? 'agotado' : 'vendido_1';
    });
    reservados.rows.forEach(r => {
      if (!mapa[r.numero]) mapa[r.numero] = 'reservado';
    });

    // 4. Construir mapa de series ocupadas por vendedores
    //    seriesOcupadas[numero] = Set de series que tiene algún vendedor
    const seriesOcupadas = {};
    asignadosVendedor.rows.forEach(r => {
      if (!seriesOcupadas[r.numero]) seriesOcupadas[r.numero] = new Set();
      seriesOcupadas[r.numero].add(r.serie.toUpperCase());
    });

    // 5. Generar el listado de números visibles al cliente
    //    Regla simultánea: un número aparece (una sola vez) si tiene
    //    al menos una serie (A o B) NO asignada a ningún vendedor.
    //    Regla no-simultánea: el número aparece si no está asignado
    //    a ningún vendedor en ninguna serie (comportamiento anterior).
    const numeros = [];
    for (let i = 0; i < 1000; i++) {
      const n      = String(i).padStart(3, '0');
      const estado = mapa[n] || 'disponible';

      // Si ya está vendido/reservado se muestra igual (no se oculta por vendedor)
      if (estado === 'agotado' || estado === 'vendido_1' || estado === 'reservado') {
        numeros.push({ numero: n, estado });
        continue;
      }

      // Número disponible: evaluar asignaciones de vendedor
      const ocupadas = seriesOcupadas[n] || new Set();

      if (esSimultanea) {
        // Simultánea: hay serie A y serie B.
        // El número aparece UNA VEZ por cada serie que esté libre.
        // - Libre en A y libre en B  -> aparece 2 veces
        // - Libre en A, ocupado en B -> aparece 1 vez
        // - Ocupado en A, libre en B -> aparece 1 vez
        // - Ocupado en A y ocupado en B -> no aparece
        if (!ocupadas.has('A')) numeros.push({ numero: n, estado: 'disponible' });
        if (!ocupadas.has('B')) numeros.push({ numero: n, estado: 'disponible' });
      } else {
        // No simultánea (sencilla/parcial): aparece si no tiene
        // ninguna serie asignada a vendedor
        if (ocupadas.size === 0) {
          numeros.push({ numero: n, estado: 'disponible' });
        }
      }
    }

    // Agregar idx unico para que el frontend pueda identificar
    // cada entrada por separado (un mismo numero puede aparecer 2 veces en simultanea)
    const numerosConIdx = numeros.map((item, idx) => ({ ...item, idx }));
    res.json(numerosConIdx);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ──────────────────────────────────────────────────────────
   POST /api/publico/reservar
   NUEVO: acepta cedula (obligatoria) y correo (opcional)
   Body:
     {
       rifa_id, nombre_cliente,
       cedula,            ← NUEVO obligatorio
       correo,            ← NUEVO opcional
       telefono, metodo_pago,
       comprobante_base64, comprobante_nombre,
       numeros: ['001','045']
     }
────────────────────────────────────────────────────────── */
router.post('/reservar', async (req, res) => {
  const {
    rifa_id, nombre_cliente,
    cedula, correo,
    telefono, metodo_pago,
    comprobante_base64, comprobante_nombre,
  } = req.body;

  let numeros = req.body.numeros;
  if (!numeros && req.body.numero) numeros = [req.body.numero];

  // ── Validaciones ─────────────────────────────────────
  if (!rifa_id || !nombre_cliente)
    return res.status(400).json({ error: 'rifa_id y nombre_cliente son requeridos' });

  if (!cedula || !cedula.trim())
    return res.status(400).json({ error: 'La cédula es obligatoria' });

  if (!numeros || !Array.isArray(numeros) || numeros.length === 0)
    return res.status(400).json({ error: 'Debes seleccionar al menos un número' });

  if (numeros.length > 50)
    return res.status(400).json({ error: 'Máximo 50 números por reserva' });

  const invalidos = numeros.filter(n => !/^\d{3}$/.test(n));
  if (invalidos.length > 0)
    return res.status(400).json({ error: `Números con formato inválido: ${invalidos.join(', ')}` });

  if (correo && correo.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo.trim()))
    return res.status(400).json({ error: 'El correo electrónico no tiene un formato válido' });

  if (!comprobante_base64)
    return res.status(400).json({ error: 'El comprobante de pago es obligatorio para reservar' });

  const numerosUnicos = [...new Set(numeros)];
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const reservasCreadas = [];
    const conflictos      = [];

    for (const numero of numerosUnicos) {
      const vendidos = await client.query(
        `SELECT COUNT(*) FROM ventas WHERE rifa_id=$1 AND numero=$2`,
        [rifa_id, numero]
      );
      if (parseInt(vendidos.rows[0].count) >= 2) {
        conflictos.push({ numero, razon: 'agotado' }); continue;
      }

      const reservaExiste = await client.query(
        `SELECT id FROM reservas_cliente WHERE rifa_id=$1 AND numero=$2 AND estado='pendiente'`,
        [rifa_id, numero]
      );
      if (reservaExiste.rows.length > 0) {
        conflictos.push({ numero, razon: 'reserva_pendiente' }); continue;
      }

      const r = await client.query(`
        INSERT INTO reservas_cliente
          (rifa_id, numero, nombre_cliente, cedula, correo,
           telefono, metodo_pago, comprobante_base64, comprobante_nombre)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        RETURNING id, numero, nombre_cliente, cedula, correo, estado, created_at
      `, [
        rifa_id, numero,
        nombre_cliente.trim(),
        cedula.trim(),
        correo?.trim() || null,
        telefono       || null,
        metodo_pago    || null,
        comprobante_base64,
        comprobante_nombre || null,
      ]);
      reservasCreadas.push(r.rows[0]);
    }

    if (reservasCreadas.length === 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Ningún número pudo reservarse', conflictos });
    }

    await client.query('COMMIT');

    const respuesta = {
      ok: true, reservas: reservasCreadas,
      total_reservados: reservasCreadas.length,
      mensaje: reservasCreadas.length === 1
        ? '¡Reserva enviada! El administrador verificará tu pago pronto.'
        : `¡${reservasCreadas.length} números reservados! El administrador verificará tu pago pronto.`,
    };
    if (conflictos.length > 0) respuesta.conflictos = conflictos;
    if (reservasCreadas.length === 1) respuesta.reserva = reservasCreadas[0];

    res.status(201).json(respuesta);
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

/* ── GET /api/publico/reserva/:id ───────────────────────── */
router.get('/reserva/:id', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT rc.id, rc.numero, rc.nombre_cliente, rc.cedula, rc.correo,
              rc.estado, rc.nota_admin, rc.created_at, rc.updated_at,
              r.nombre AS rifa_nombre, r.premio, r.precio,
              ${FECHA_SQL('r')},
              COALESCE(r.ofertas, '[]'::jsonb) AS ofertas
       FROM reservas_cliente rc
       JOIN rifas r ON r.id = rc.rifa_id
       WHERE rc.id=$1`,
      [req.params.id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Reserva no encontrada' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── GET /api/publico/reservas-cliente ─────────────────── */
router.get('/reservas-cliente', async (req, res) => {
  const { nombre_cliente, rifa_id } = req.query;
  if (!nombre_cliente)
    return res.status(400).json({ error: 'nombre_cliente es requerido' });
  try {
    const params = [nombre_cliente.trim()];
    let extra = '';
    if (rifa_id) { params.push(rifa_id); extra = `AND rc.rifa_id = $${params.length}`; }

    const r = await pool.query(`
      SELECT rc.id, rc.numero, rc.nombre_cliente, rc.cedula, rc.correo,
             rc.estado, rc.nota_admin, rc.created_at, rc.updated_at,
             r.nombre AS rifa_nombre, r.premio, r.precio,
             ${FECHA_SQL('r')},
             COALESCE(r.ofertas, '[]'::jsonb) AS ofertas
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

/* ── GET /api/publico/admin/reservas ─────────────────────  */
router.get('/admin/reservas', authMiddleware, soloDueno, async (req, res) => {
  const { estado } = req.query;
  try {
    const r = await pool.query(`
      SELECT rc.*,
             r.nombre AS rifa_nombre, r.precio, r.premio,
             ${FECHA_SQL('r')},
             COALESCE(r.ofertas, '[]'::jsonb) AS ofertas
      FROM reservas_cliente rc
      JOIN rifas r ON r.id = rc.rifa_id
      ${estado && estado !== 'todos' ? 'WHERE rc.estado=$1' : ''}
      ORDER BY rc.created_at DESC
    `, estado && estado !== 'todos' ? [estado] : []);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── PUT /api/publico/admin/reservas/:id ──────────────────
   Al aprobar: propaga cedula y correo de la reserva a la venta
────────────────────────────────────────────────────────── */
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

      const rifa = await client.query(
        `SELECT precio FROM rifas WHERE id=$1`, [reserva.rifa_id]
      );
      const precioVenta = rifa.rows[0]?.precio || 0;

      await client.query(`
        INSERT INTO ventas
          (rifa_id, numero, vendedor_id, nombre_comprador,
           cedula, correo, telefono, precio_venta, observacion)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      `, [
        reserva.rifa_id,
        reserva.numero,
        vendedorId,
        reserva.nombre_cliente,
        reserva.cedula  || null,
        reserva.correo  || null,
        reserva.telefono,
        precioVenta,
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
   Al aprobar en bloque: propaga cedula y correo a cada venta
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

    let preciosMap = {};
    let extrasMap  = {}; // { id: { cedula, correo } }

    if (estado === 'aprobado') {
      const reservasQ = await client.query(
        `SELECT rc.id, rc.rifa_id, rc.nombre_cliente, rc.cedula, rc.correo,
                r.precio, COALESCE(r.ofertas, '[]'::jsonb) AS ofertas
         FROM reservas_cliente rc
         JOIN rifas r ON r.id = rc.rifa_id
         WHERE rc.id = ANY($1) AND rc.estado = 'pendiente'`,
        [ids]
      );

      const grupos = {};
      for (const row of reservasQ.rows) {
        const key = `${row.nombre_cliente}||${row.rifa_id}`;
        if (!grupos[key]) grupos[key] = { precio: row.precio, ofertas: row.ofertas, ids: [] };
        grupos[key].ids.push(row.id);
        extrasMap[row.id] = { cedula: row.cedula || null, correo: row.correo || null };
      }
      for (const [, g] of Object.entries(grupos)) {
        const totalReal  = calcularPrecioReal(g.ids.length, g.ofertas, g.precio);
        const precioUnit = totalReal / g.ids.length;
        for (const id of g.ids) preciosMap[id] = precioUnit;
      }
    }

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
        const precioVenta = preciosMap[id] ?? (
          (await client.query(`SELECT precio FROM rifas WHERE id=$1`, [reserva.rifa_id])).rows[0]?.precio || 0
        );
        const { cedula = null, correo = null } = extrasMap[id] || {};

        await client.query(`
          INSERT INTO ventas
            (rifa_id, numero, vendedor_id, nombre_comprador,
             cedula, correo, telefono, precio_venta, observacion)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
          ON CONFLICT DO NOTHING
        `, [
          reserva.rifa_id, reserva.numero, vendedorId,
          reserva.nombre_cliente,
          cedula, correo,
          reserva.telefono,
          precioVenta,
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