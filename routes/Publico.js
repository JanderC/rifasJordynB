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
    // 1. Tipo de rifa
    const rifaR = await pool.query(
      `SELECT COALESCE(tipo, 'sencilla') AS tipo FROM rifas WHERE id = $1`,
      [req.params.id]
    );
    if (!rifaR.rows[0]) return res.status(404).json({ error: 'Rifa no encontrada' });
    const esSimultanea = rifaR.rows[0].tipo === 'simultanea';
    const maxRanuras   = esSimultanea ? 2 : 1;

    // 2. Ventas por número
    const vendidos = await pool.query(
      `SELECT numero, COUNT(*) AS veces FROM ventas WHERE rifa_id=$1 GROUP BY numero`,
      [req.params.id]
    );

    // 3. Reservas pendientes por número (contamos cuántas hay, no solo si existe una)
    const reservados = await pool.query(
      `SELECT numero, COUNT(*) AS veces FROM reservas_cliente WHERE rifa_id=$1 AND estado='pendiente' GROUP BY numero`,
      [req.params.id]
    );

    // 4. Asignaciones de vendedor por serie
    const asignadosVendedor = await pool.query(
      `SELECT numero, COALESCE(serie, 'A') AS serie FROM numeros_vendedor WHERE rifa_id=$1`,
      [req.params.id]
    );

    // Mapa de conteos por número: { "009": { vendidas: 1, pendientes: 1 } }
    const conteos = {};
    vendidos.rows.forEach(r => {
      if (!conteos[r.numero]) conteos[r.numero] = { vendidas: 0, pendientes: 0 };
      conteos[r.numero].vendidas = parseInt(r.veces);
    });
    reservados.rows.forEach(r => {
      if (!conteos[r.numero]) conteos[r.numero] = { vendidas: 0, pendientes: 0 };
      conteos[r.numero].pendientes = parseInt(r.veces);
    });

    // Mapa de series ocupadas por vendedores
    const seriesOcupadas = {};
    asignadosVendedor.rows.forEach(r => {
      if (!seriesOcupadas[r.numero]) seriesOcupadas[r.numero] = new Set();
      seriesOcupadas[r.numero].add(r.serie.toUpperCase());
    });

    // 5. Generar listado
    const numeros = [];
    for (let i = 0; i < 1000; i++) {
      const n       = String(i).padStart(3, '0');
      const c       = conteos[n] || { vendidas: 0, pendientes: 0 };
      const ocupadas = seriesOcupadas[n] || new Set();

      if (esSimultanea) {
        // En simultánea hay 2 ranuras (serie A y serie B).
        // Cada ranura puede estar: libre, reservada (pendiente) o vendida.
        // Calculamos cuántas ranuras están libres para mostrarlas disponibles.
        const ranurasTomadas = c.vendidas + c.pendientes; // vendidas + pendientes cubren ranuras
        const ranurasLibres  = Math.max(0, maxRanuras - ranurasTomadas);

        // Ranuras bloqueadas por vendedor (serie A u B asignada)
        const bloqueadasVendedor = ocupadas.size; // cuántas series tiene el vendedor

        // De las ranuras libres, descontar las bloqueadas por vendedor
        // (el vendedor ocupa serie A o B, esas no están disponibles para el cliente)
        const disponiblesParaCliente = Math.max(0, ranurasLibres - bloqueadasVendedor);

        // Ranuras que están pendientes (reservadas pero no vendidas) — se muestran como reservado
        // Solo si el número tiene alguna reserva pendiente pero aún le quedan ranuras
        const pendientesAMostrar = Math.min(c.pendientes, maxRanuras - c.vendidas - bloqueadasVendedor);

        // Ranuras agotadas (todas vendidas)
        if (c.vendidas >= maxRanuras) {
          numeros.push({ numero: n, estado: 'agotado' });
          continue;
        }

        // Mostrar cada ranura disponible
        for (let r = 0; r < disponiblesParaCliente; r++) {
          numeros.push({ numero: n, estado: 'disponible' });
        }

        // Mostrar ranuras pendientes (para información, no seleccionables)
        for (let r = 0; r < pendientesAMostrar; r++) {
          numeros.push({ numero: n, estado: 'reservado' });
        }

        // Si ninguna ranura queda disponible ni visible, pero todas están cubiertas por pendientes
        if (disponiblesParaCliente === 0 && pendientesAMostrar === 0 && c.vendidas < maxRanuras) {
          if (c.pendientes + c.vendidas >= maxRanuras) {
            // Todas las ranuras están reservadas pendientes → mostrar como agotado al cliente
            numeros.push({ numero: n, estado: 'agotado' });
          }
        }

      } else {
        // Sencilla: 1 ranura por número
        if (c.vendidas >= 1) {
          numeros.push({ numero: n, estado: 'vendido_1' });
        } else if (c.pendientes >= 1) {
          numeros.push({ numero: n, estado: 'reservado' });
        } else if (ocupadas.size === 0) {
          numeros.push({ numero: n, estado: 'disponible' });
        }
      }
    }

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

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Obtener tipo de rifa para saber si es simultánea
    const rifaTipoR = await client.query(
      `SELECT COALESCE(tipo, 'sencilla') AS tipo FROM rifas WHERE id=$1`,
      [rifa_id]
    );
    const esSimultanea = rifaTipoR.rows[0]?.tipo === 'simultanea';

    // En simultánea se permiten hasta 2 reservas del mismo número (serie A y B).
    // El cliente puede enviar el mismo número dos veces si seleccionó ambas entradas.
    // Preservamos duplicados para simultánea; deduplicamos en sencilla.
    const numerosAProcesar = esSimultanea ? numeros : [...new Set(numeros)];

    const reservasCreadas = [];
    const conflictos      = [];

    for (const numero of numerosAProcesar) {
      const vendidos = await client.query(
        `SELECT COUNT(*) FROM ventas WHERE rifa_id=$1 AND numero=$2`,
        [rifa_id, numero]
      );
      const vecesVendidas = parseInt(vendidos.rows[0].count);

      const reservasPendientes = await client.query(
        `SELECT COUNT(*) FROM reservas_cliente WHERE rifa_id=$1 AND numero=$2 AND estado='pendiente'`,
        [rifa_id, numero]
      );
      const vecesPendientes = parseInt(reservasPendientes.rows[0].count);

      // Cuántas ranuras ya están ocupadas (vendidas + pendientes)
      const ocupadas   = vecesVendidas + vecesPendientes;
      const maxRanuras = esSimultanea ? 2 : 1;

      if (ocupadas >= maxRanuras) {
        const razon = vecesVendidas >= maxRanuras ? 'agotado' : 'reserva_pendiente';
        conflictos.push({ numero, razon }); continue;
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
        `SELECT precio, COALESCE(tipo, 'sencilla') AS tipo FROM rifas WHERE id=$1`,
        [reserva.rifa_id]
      );
      const precioVenta  = rifa.rows[0]?.precio || 0;
      const esSimultanea = rifa.rows[0]?.tipo === 'simultanea';
      const maxVentas    = esSimultanea ? 2 : 1;

      // Verificar cuántas ventas ya existen para este número en esta rifa
      const ventasExistentes = await client.query(
        `SELECT COUNT(*) FROM ventas WHERE rifa_id=$1 AND numero=$2`,
        [reserva.rifa_id, reserva.numero]
      );
      const ventasActuales = parseInt(ventasExistentes.rows[0].count);

      if (ventasActuales >= maxVentas) {
        // Ya está al tope — rechazar esta reserva automáticamente en lugar de explotar
        await client.query(
          `UPDATE reservas_cliente SET estado='rechazado', nota_admin=$1, updated_at=NOW() WHERE id=$2`,
          [`Auto-rechazado: el número ${reserva.numero} ya alcanzó el máximo de ventas permitidas`, reserva.id]
        );
        await client.query('COMMIT');
        return res.status(409).json({
          error: `El número ${reserva.numero} ya tiene ${ventasActuales} venta(s) registrada(s) y no puede aprobarse nuevamente.`,
          auto_rechazado: true,
        });
      }

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

    // Contador en memoria de ventas insertadas en esta transacción por (rifa_id, numero)
    // para respetar el límite de la constraint max_dos_ventas sin consultar la BD en cada iteración
    const ventasEnTransaccion = {}; // key: "rifa_id|numero" → count

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
        // Verificar límite de ventas para este número
        const claveNum = `${reserva.rifa_id}|${reserva.numero}`;
        const rifaInfo = (await client.query(
          `SELECT precio, COALESCE(tipo, 'sencilla') AS tipo FROM rifas WHERE id=$1`,
          [reserva.rifa_id]
        )).rows[0];
        const esSimultanea = rifaInfo?.tipo === 'simultanea';
        const maxVentas    = esSimultanea ? 2 : 1;

        // Ventas ya existentes en BD + las que ya insertamos en esta transacción
        const ventasEnBD = parseInt(
          (await client.query(`SELECT COUNT(*) FROM ventas WHERE rifa_id=$1 AND numero=$2`,
            [reserva.rifa_id, reserva.numero])).rows[0].count
        );
        const ventasTx   = ventasEnTransaccion[claveNum] || 0;
        const totalOcupadas = ventasEnBD + ventasTx;

        if (totalOcupadas >= maxVentas) {
          // No se puede insertar más — auto-rechazar esta reserva
          await client.query(
            `UPDATE reservas_cliente SET estado='rechazado', nota_admin=$1, updated_at=NOW() WHERE id=$2`,
            [`Auto-rechazado: número ${reserva.numero} ya alcanzó el máximo de ventas`, id]
          );
          continue;
        }

        ventasEnTransaccion[claveNum] = ventasTx + 1;

        const precioVenta = preciosMap[id] ?? (rifaInfo?.precio || 0);
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