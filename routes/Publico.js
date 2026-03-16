// ============================================================
//   RIFAS JORDYN — Rutas Públicas (sin autenticación)
//   ✅ ACTUALIZADO: campo `ofertas` expuesto, precio real en aprobación
//   ✅ FIX PUNTO 1: fecha_sorteo devuelta como ISO 8601 con to_char()
//      para evitar desfases de zona horaria en el frontend.
// ============================================================
const router = require('express').Router();
const pool   = require('../config/db');
const { authMiddleware, soloDueno } = require('../middleware/auth');

/* ──────────────────────────────────────────────────────────
   Helper: calcula el precio total aplicando ofertas
   Replica la lógica del frontend para que el admin
   registre el monto real pagado por el cliente.
────────────────────────────────────────────────────────── */
function calcularPrecioReal(cantidad, ofertas, precioUnitario) {
  if (!Array.isArray(ofertas) || ofertas.length === 0 || cantidad === 0) {
    return precioUnitario * cantidad;
  }
  let mejorTotal = precioUnitario * cantidad; // precio sin oferta
  for (const o of ofertas) {
    if (cantidad >= o.cantidad && cantidad % o.cantidad === 0) {
      const veces = cantidad / o.cantidad;
      const totalConOferta = o.precio_total * veces;
      if (totalConOferta < mejorTotal) {
        mejorTotal = totalConOferta;
      }
    }
  }
  return mejorTotal;
}

/*
  FIX PUNTO 1 — HELPER SQL para fecha_sorteo
  ─────────────────────────────────────────────────────────
  Problema original:
    El campo fecha_sorteo salía de PostgreSQL como un objeto
    Date serializado sin zona horaria explícita, p.ej.:
      "2025-07-15T08:00:00.000Z"
    El frontend lo parseaba con new Date(f) que en algunos
    navegadores (Safari, Firefox) falla con strings "YYYY-MM-DD HH:MM:SS"
    (con espacio, sin T), devolviendo NaN y rompiendo el countdown.

  Solución:
    Usamos to_char() en cada SELECT para emitir siempre un string
    ISO 8601 limpio: "2025-07-15T08:00:00Z"

  ⚠️ ZONA HORARIA:
    Si tu columna fecha_sorteo almacena la hora en UTC y quieres
    mostrarla en UTC:
      to_char(r.fecha_sorteo AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')

    Si tu columna almacena la hora en hora local (Venezuela UTC-4)
    y NO quieres conversión:
      to_char(r.fecha_sorteo, 'YYYY-MM-DD"T"HH24:MI:SS')

    El valor por defecto aquí es WITHOUT TIME ZONE (sin conversión),
    que es el más común en instalaciones sin configuración de TZ.
    Cámbialo según tu setup.
─────────────────────────────────────────────────────────
*/
const FECHA_SQL = (alias = 'r') =>
  `to_char(${alias}.fecha_sorteo, 'YYYY-MM-DD"T"HH24:MI:SS') AS fecha_sorteo`;

/* ──────────────────────────────────────────────────────────
   GET /api/publico/rifas
   ✅ Incluye campo `ofertas` para que el frontend pueda
      mostrar los packs y calcular descuentos.
   ✅ FIX: fecha_sorteo como ISO string limpio
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
        ${FECHA_SQL('r')},
        r.loteria_ref,
        r.activa,
        r.imagen_url,
        COALESCE(r.tipo,   'sencilla') AS tipo,
        COALESCE(r.estado, 'activa')   AS estado,
        COALESCE(r.ofertas, '[]'::jsonb) AS ofertas,
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
   ✅ Acepta `numeros` (array) además del legacy `numero` (string)
   Body:
     {
       rifa_id, nombre_cliente, telefono, metodo_pago,
       comprobante_base64, comprobante_nombre,
       numeros: ['001','045','123']
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
   FIX: fecha_sorteo como ISO string limpio
────────────────────────────────────────────────────────── */
router.get('/reserva/:id', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT rc.id, rc.numero, rc.nombre_cliente, rc.estado, rc.nota_admin,
              rc.created_at, rc.updated_at,
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

/* ──────────────────────────────────────────────────────────
   GET /api/publico/reservas-cliente
   Busca TODAS las reservas de un cliente por nombre + rifa
   Query params: nombre_cliente, rifa_id
   FIX: fecha_sorteo como ISO string limpio
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

/* ── GET /api/publico/admin/reservas ──────────────────────
   FIX: fecha_sorteo como ISO string limpio
*/
router.get('/admin/reservas', authMiddleware, soloDueno, async (req, res) => {
  const { estado } = req.query;
  try {
    const r = await pool.query(`
      SELECT
        rc.*,
        r.nombre  AS rifa_nombre,
        r.precio,
        r.premio,
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

      // ✅ Obtener precio Y ofertas para calcular el precio real con descuento
      const rifa = await client.query(
        `SELECT precio, COALESCE(ofertas, '[]'::jsonb) AS ofertas FROM rifas WHERE id=$1`,
        [reserva.rifa_id]
      );
      const rifaData = rifa.rows[0];

      // Buscar cuántas reservas aprobadas tiene este cliente en esta rifa
      // para determinar el precio unitario correcto (no aplica oferta por número individual)
      const precioVenta = rifaData?.precio || 0;

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
   Aprobar / rechazar múltiples reservas a la vez
   Body: { ids: [...], estado, nota_admin }
   ✅ ACTUALIZADO: aplica precio real con oferta agrupada por cliente+rifa
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

    // ── Si aprobamos, cargar todas las reservas de una vez para agrupar por cliente+rifa
    // y calcular precio con oferta correctamente
    let reservasInfo = {};
    if (estado === 'aprobado') {
      // Agrupar ids por (cliente, rifa) para calcular oferta en bloque
      const reservasQ = await client.query(
        `SELECT rc.id, rc.rifa_id, rc.nombre_cliente,
                r.precio, COALESCE(r.ofertas, '[]'::jsonb) AS ofertas
         FROM reservas_cliente rc
         JOIN rifas r ON r.id = rc.rifa_id
         WHERE rc.id = ANY($1) AND rc.estado = 'pendiente'`,
        [ids]
      );

      // Agrupar por cliente+rifa → calcular precio unitario proporcional con oferta
      const grupos = {};
      for (const row of reservasQ.rows) {
        const key = `${row.nombre_cliente}||${row.rifa_id}`;
        if (!grupos[key]) grupos[key] = { precio: row.precio, ofertas: row.ofertas, ids: [] };
        grupos[key].ids.push(row.id);
      }

      for (const [, g] of Object.entries(grupos)) {
        const totalCantidad = g.ids.length;
        const totalReal     = calcularPrecioReal(totalCantidad, g.ofertas, g.precio);
        const precioUnit    = totalReal / totalCantidad;
        for (const id of g.ids) {
          reservasInfo[id] = precioUnit;
        }
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
        const precioVenta = reservasInfo[id] ?? (
          // fallback: precio unitario normal
          (await client.query(`SELECT precio FROM rifas WHERE id=$1`, [reserva.rifa_id])).rows[0]?.precio || 0
        );

        await client.query(`
          INSERT INTO ventas
            (rifa_id, numero, vendedor_id, nombre_comprador, telefono, precio_venta, observacion)
          VALUES ($1,$2,$3,$4,$5,$6,$7)
          ON CONFLICT DO NOTHING
        `, [
          reserva.rifa_id, reserva.numero, vendedorId,
          reserva.nombre_cliente, reserva.telefono,
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