// ============================================================
//   RIFAS JORDYN — Rutas Públicas (sin autenticación)
//   ✅ ACTUALIZADO: campo `ofertas` expuesto, precio real en aprobación
//   ✅ FIX PUNTO 1: fecha_sorteo devuelta como ISO 8601 con to_char()
//   ✅ NUEVO: cedula (obligatoria) y correo (opcional) en reservas y ventas
//   ✅ NUEVO: fecha_desactivacion_compra y fecha_eliminacion_pantalla
//   ✅ NUEVO: campo compra_activa y porcentaje_comprado en listado de rifas
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

/* ─────────────────────────────────────────────────────────────
   CAMPOS DE FECHA PARA EL CLIENTE
   - fecha_sorteo:     DATE puro (YYYY-MM-DD)  -- como rifas.js
   - hora_sorteo:      TIME puro (HH:MM:SS)
   - datetime_sorteo:  ISO UTC con Z, calculado a partir de la
                       hora local Venezuela (America/Caracas).
                       Esto se usa para el countdown en el front.

   Importante: la fecha y hora se guardaron como "hora Venezuela".
   PostgreSQL trata las columnas DATE/TIME como sin TZ, así que las
   convertimos explícitamente: timestamp(fecha+hora) AT TIME ZONE
   'America/Caracas' → da el UTC real correspondiente.
───────────────────────────────────────────────────────────── */
const FECHA_SQL = (alias = 'r') => `
  ${alias}.fecha_sorteo::text AS fecha_sorteo,
  ${alias}.hora_sorteo::text  AS hora_sorteo,
  CASE
    WHEN ${alias}.fecha_sorteo IS NOT NULL THEN
      to_char(
        ((${alias}.fecha_sorteo + COALESCE(${alias}.hora_sorteo, '00:00:00'::time))
          AT TIME ZONE 'America/Caracas')
          AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS"Z"'
      )
    ELSE NULL
  END AS datetime_sorteo
`;

/* ── GET /api/publico/rifas ─────────────────────────────── */
router.get('/rifas', async (req, res) => {
  try {
    const ahora = new Date().toISOString();

    const r = await pool.query(`
      SELECT
        r.id, r.nombre, r.descripcion, r.premio, r.precio,
        ${FECHA_SQL('r')},
        r.loteria_ref, r.activa, r.imagen_url,
        COALESCE(r.tipo,   'sencilla') AS tipo,
        COALESCE(r.estado, 'activa')   AS estado,
        COALESCE(r.cifras, 3)          AS cifras,
        COALESCE(r.ofertas, '[]'::jsonb) AS ofertas,
        r.fecha_desactivacion_compra,
        r.fecha_eliminacion_pantalla,
        COALESCE(COUNT(DISTINCT v.numero), 0)::int AS numeros_vendidos,
        COALESCE(SUM(v.precio_venta), 0)           AS recaudado,
        -- Porcentaje de números NO disponibles (vendidos + asignados a vendedor).
        -- Se calcula sobre 1000 números totales.
        -- Los números "no visibles" al cliente = ventas + asignaciones de vendedor
        ROUND(
          (
            COALESCE(COUNT(DISTINCT v.numero), 0)::numeric +
            COALESCE((
              SELECT COUNT(DISTINCT numero)
              FROM numeros_vendedor nv2
              WHERE nv2.rifa_id = r.id
            ), 0)::numeric +
            COALESCE((
              SELECT COUNT(DISTINCT numero)
              FROM boleteria_numeros_extra bne2
              WHERE bne2.rifa_id = r.id
            ), 0)::numeric
          ) / (power(10, COALESCE(r.cifras, 3)) / 100.0), 2
        ) AS porcentaje_comprado
      FROM rifas r
      LEFT JOIN ventas v ON v.rifa_id = r.id
      WHERE r.activa = TRUE
        AND COALESCE(r.estado, 'activa') != 'archivada'
        -- Ocultar completamente si ya pasó la fecha de eliminación
        AND (
          r.fecha_eliminacion_pantalla IS NULL
          OR r.fecha_eliminacion_pantalla > $1
        )
      GROUP BY r.id
      ORDER BY r.created_at DESC
    `, [ahora]);

    // Enriquecer cada rifa con el flag compra_activa
    const rifas = r.rows.map(rifa => ({
      ...rifa,
      compra_activa: !rifa.fecha_desactivacion_compra
        || new Date(rifa.fecha_desactivacion_compra) > new Date(ahora),
    }));

    res.json(rifas);
  } catch (e) {
    console.error('Error obteniendo rifas públicas:', e);
    res.status(500).json({ error: e.message });
  }
});

/* ── GET /api/publico/rifas/:id/numero/:n  → estado de UN número ──
   Pensado para rifas de 4 cifras (buscador). También sirve para 3. */
router.get('/rifas/:id/numero/:n', async (req, res) => {
  try {
    const rifaR = await pool.query(
      `SELECT COALESCE(tipo,'sencilla') AS tipo, COALESCE(cifras,3) AS cifras
         FROM rifas WHERE id=$1`, [req.params.id]);
    if (!rifaR.rows[0]) return res.status(404).json({ error: 'Rifa no encontrada' });

    const { tipo, cifras } = rifaR.rows[0];
    const maxRanuras = tipo === 'simultanea' ? 2 : 1;

    const raw = String(req.params.n).replace(/\D/g, '');
    if (!raw || raw.length > Number(cifras))
      return res.status(400).json({ error: 'Número inválido' });
    const numero = raw.padStart(Number(cifras), '0');

    const [vend, resv, asig] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int n FROM ventas WHERE rifa_id=$1 AND numero=$2`, [req.params.id, numero]),
      pool.query(`SELECT COUNT(*)::int n FROM reservas_cliente WHERE rifa_id=$1 AND numero=$2 AND estado='pendiente'`, [req.params.id, numero]),
      pool.query(`SELECT 1 FROM numeros_vendedor WHERE rifa_id=$1 AND numero=$2
                  UNION SELECT 1 FROM boleteria_numeros_extra WHERE rifa_id=$1 AND numero=$2 LIMIT 1`,
                 [req.params.id, numero]),
    ]);

    const vendidas   = vend.rows[0].n;
    const pendientes = resv.rows[0].n;
    const bloqueado  = asig.rows.length > 0;

    let estado = 'disponible';
    if (vendidas >= maxRanuras) estado = 'agotado';
    else if (bloqueado)         estado = 'agotado';
    else if (pendientes >= maxRanuras - vendidas) estado = 'reservado';
    else if (vendidas >= 1)     estado = (maxRanuras > 1 ? 'disponible' : 'vendido_1');

    res.json({ numero, estado, vendidas, pendientes });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── GET /api/publico/rifas/:id/numeros-disponibles ─────── */
router.get('/rifas/:id/numeros-disponibles', async (req, res) => {
  try {
    // 1. Tipo de rifa
    const rifaR = await pool.query(
      `SELECT COALESCE(tipo, 'sencilla') AS tipo, COALESCE(cifras, 3) AS cifras FROM rifas WHERE id = $1`,
      [req.params.id]
    );
    if (!rifaR.rows[0]) return res.status(404).json({ error: 'Rifa no encontrada' });
    const esSimultanea = rifaR.rows[0].tipo === 'simultanea';
    const maxRanuras   = esSimultanea ? 2 : 1;
    const cifras       = Number(rifaR.rows[0].cifras) || 3;

    // Rifas de 4 cifras (0000-9999): NO se entrega cuadrícula de 10.000.
    // El cliente usa el buscador puntual (GET /rifas/:id/numero/:n).
    if (cifras >= 4) {
      return res.json({ modo: 'buscador', cifras, numeros: [] });
    }

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
    //    Incluye:
    //      - numeros_vendedor       (números fijos del vendedor)
    //      - boleteria_numeros_extra (números extra asignados solo a esta rifa)
    //    Ambos bloquean al cliente: una vez asignados a un vendedor, ese
    //    (numero, serie) deja de estar disponible para reservar.
    const asignadosVendedor = await pool.query(
      `SELECT numero, COALESCE(serie, 'A') AS serie
         FROM numeros_vendedor
        WHERE rifa_id = $1
       UNION
       SELECT numero, serie
         FROM boleteria_numeros_extra
        WHERE rifa_id = $1`,
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
        const ranurasTomadas = c.vendidas + c.pendientes;
        const ranurasLibres  = Math.max(0, maxRanuras - ranurasTomadas);
        const bloqueadasVendedor = ocupadas.size;
        const disponiblesParaCliente = Math.max(0, ranurasLibres - bloqueadasVendedor);
        const pendientesAMostrar = Math.min(c.pendientes, maxRanuras - c.vendidas - bloqueadasVendedor);

        if (c.vendidas >= maxRanuras) {
          numeros.push({ numero: n, estado: 'agotado' });
          continue;
        }

        for (let r = 0; r < disponiblesParaCliente; r++) {
          numeros.push({ numero: n, estado: 'disponible' });
        }

        for (let r = 0; r < pendientesAMostrar; r++) {
          numeros.push({ numero: n, estado: 'reservado' });
        }

        if (disponiblesParaCliente === 0 && pendientesAMostrar === 0 && c.vendidas < maxRanuras) {
          if (c.pendientes + c.vendidas >= maxRanuras) {
            numeros.push({ numero: n, estado: 'agotado' });
          }
        }

      } else {
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
   GET /api/publico/rifas/:id/progreso
   Devuelve el progreso de venta de una rifa de forma limpia
   y consistente para mostrar la barra de % en el cliente.

   Cálculo (NO depende del endpoint numeros-disponibles):
     - total           = ranuras totales de la rifa
                          · sencilla   = 1000
                          · simultanea = 2000  (2 series × 1000)
     - vendidos        = ventas registradas
     - reservados      = reservas pendientes (aún sin aprobar)
     - asignados_vend  = números en poder de vendedores
                         (numeros_vendedor + boleteria_numeros_extra)
     - tomados         = vendidos + reservados + asignados_vend
     - disponibles     = total - tomados
     - pct             = (tomados / total) * 100  (2 decimales)

   En rifas SENCILLAS se cuenta cada número una vez.
   En rifas SIMULTÁNEAS cada (numero, serie) cuenta por separado.
────────────────────────────────────────────────────────── */
router.get('/rifas/:id/progreso', async (req, res) => {
  try {
    const rifaR = await pool.query(
      `SELECT id, COALESCE(tipo, 'sencilla') AS tipo
         FROM rifas
        WHERE id = $1`,
      [req.params.id]
    );
    if (!rifaR.rows[0]) return res.status(404).json({ error: 'Rifa no encontrada' });

    const esSimultanea = rifaR.rows[0].tipo === 'simultanea';
    const total        = esSimultanea ? 2000 : 1000;

    // Conteos en paralelo
    const [vendQ, resQ, asigQ] = await Promise.all([
      // Ventas
      esSimultanea
        ? pool.query(
            `SELECT COUNT(*)::int AS n FROM ventas WHERE rifa_id = $1`,
            [req.params.id]
          )
        : pool.query(
            `SELECT COUNT(DISTINCT numero)::int AS n FROM ventas WHERE rifa_id = $1`,
            [req.params.id]
          ),
      // Reservas pendientes (todavía no aprobadas → ocupan ranura)
      esSimultanea
        ? pool.query(
            `SELECT COUNT(*)::int AS n
               FROM reservas_cliente
              WHERE rifa_id = $1 AND estado = 'pendiente'`,
            [req.params.id]
          )
        : pool.query(
            `SELECT COUNT(DISTINCT numero)::int AS n
               FROM reservas_cliente
              WHERE rifa_id = $1 AND estado = 'pendiente'`,
            [req.params.id]
          ),
      // Números en poder de vendedores
      // (numeros_vendedor + boleteria_numeros_extra, unidos por numero+serie)
      pool.query(
        `SELECT COUNT(*)::int AS n FROM (
           SELECT DISTINCT numero, COALESCE(serie,'A') AS serie
             FROM numeros_vendedor
            WHERE rifa_id = $1
           UNION
           SELECT DISTINCT numero, serie
             FROM boleteria_numeros_extra
            WHERE rifa_id = $1
         ) t`,
        [req.params.id]
      ),
    ]);

    const vendidos        = vendQ.rows[0]?.n || 0;
    const reservados      = resQ.rows[0]?.n  || 0;
    const asignadosVend   = asigQ.rows[0]?.n || 0;

    // Saneo por si la suma supera el total (datos inconsistentes)
    const tomadosRaw      = vendidos + reservados + asignadosVend;
    const tomados         = Math.min(total, Math.max(0, tomadosRaw));
    const disponibles     = Math.max(0, total - tomados);
    const pct             = total > 0 ? Math.round((tomados / total) * 10000) / 100 : 0;

    res.json({
      rifa_id: parseInt(req.params.id),
      tipo: esSimultanea ? 'simultanea' : 'sencilla',
      total,
      vendidos,
      reservados,
      asignados_vendedor: asignadosVend,
      tomados,
      disponibles,
      pct,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


/* ──────────────────────────────────────────────────────────
   POST /api/publico/reservar
   Bloquea reservas si fecha_desactivacion_compra ya pasó
   Body:
     {
       rifa_id, nombre_cliente,
       cedula,            ← obligatorio
       correo,            ← opcional
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

  const invalidos = numeros.filter(n => !/^\d{3,4}$/.test(String(n)));
  if (invalidos.length > 0)
    return res.status(400).json({ error: `Números con formato inválido: ${invalidos.join(', ')}` });

  if (correo && correo.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo.trim()))
    return res.status(400).json({ error: 'El correo electrónico no tiene un formato válido' });

  if (!comprobante_base64)
    return res.status(400).json({ error: 'El comprobante de pago es obligatorio para reservar' });

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // ── Verificar que la compra esté activa ───────────
    const rifaCheck = await client.query(
      `SELECT COALESCE(tipo, 'sencilla') AS tipo,
              COALESCE(cifras, 3) AS cifras,
              fecha_desactivacion_compra
       FROM rifas WHERE id=$1`,
      [rifa_id]
    );
    if (!rifaCheck.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Rifa no encontrada' });
    }

    const { fecha_desactivacion_compra, tipo: tipoRifa } = rifaCheck.rows[0];
    const cifrasRifa = Number(rifaCheck.rows[0].cifras) || 3;

    // Normalizamos cada número a la cantidad de cifras de la rifa (000 / 0000)
    for (let i = 0; i < numeros.length; i++) {
      const raw = String(numeros[i]).replace(/\D/g, '');
      if (!raw || raw.length > cifrasRifa) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Número fuera de rango para rifa de ${cifrasRifa} cifras: ${numeros[i]}` });
      }
      numeros[i] = raw.padStart(cifrasRifa, '0');
    }
    if (fecha_desactivacion_compra && new Date(fecha_desactivacion_compra) <= new Date()) {
      await client.query('ROLLBACK');
      return res.status(403).json({
        error: 'La compra de esta rifa está desactivada. El sorteo ya fue realizado.',
        compra_desactivada: true,
      });
    }

    const esSimultanea = tipoRifa === 'simultanea';
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

      const seriesVendedor = await client.query(
        `SELECT COUNT(*)::int AS cnt FROM (
           SELECT COALESCE(serie,'A') AS serie FROM numeros_vendedor
            WHERE rifa_id = $1 AND numero = $2
           UNION
           SELECT serie FROM boleteria_numeros_extra
            WHERE rifa_id = $1 AND numero = $2
         ) AS s`,
        [rifa_id, numero]
      );
      const bloqueadasVendedor = seriesVendedor.rows[0].cnt;

      const ocupadas   = vecesVendidas + vecesPendientes + bloqueadasVendedor;
      const maxRanuras = esSimultanea ? 2 : 1;

      if (ocupadas >= maxRanuras) {
        let razon = 'agotado';
        if (vecesVendidas >= maxRanuras) razon = 'agotado';
        else if (bloqueadasVendedor > 0 && (vecesVendidas + bloqueadasVendedor) >= maxRanuras) razon = 'asignado_vendedor';
        else if (vecesPendientes > 0) razon = 'reserva_pendiente';
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

      const ventasExistentes = await client.query(
        `SELECT COUNT(*) FROM ventas WHERE rifa_id=$1 AND numero=$2`,
        [reserva.rifa_id, reserva.numero]
      );
      const ventasActuales = parseInt(ventasExistentes.rows[0].count);

      if (ventasActuales >= maxVentas) {
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
    let extrasMap  = {};

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

    const ventasEnTransaccion = {};

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
        const claveNum = `${reserva.rifa_id}|${reserva.numero}`;
        const rifaInfo = (await client.query(
          `SELECT precio, COALESCE(tipo, 'sencilla') AS tipo FROM rifas WHERE id=$1`,
          [reserva.rifa_id]
        )).rows[0];
        const esSimultanea = rifaInfo?.tipo === 'simultanea';
        const maxVentas    = esSimultanea ? 2 : 1;

        const ventasEnBD = parseInt(
          (await client.query(`SELECT COUNT(*) FROM ventas WHERE rifa_id=$1 AND numero=$2`,
            [reserva.rifa_id, reserva.numero])).rows[0].count
        );
        const ventasTx   = ventasEnTransaccion[claveNum] || 0;
        const totalOcupadas = ventasEnBD + ventasTx;

        if (totalOcupadas >= maxVentas) {
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