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
const { subirSiEsBase64, CARPETAS } = require('../services/imagenes');
const { eliminarImagen, extraerPublicId } = require('../config/cloudinary');
const {
  crearReservasTx, aprobarReservasTx, rechazarReservasTx,
  avisarAprobadas, avisarRechazadas,
} = require('../services/reservas');
const { metodosActivos, obtenerTasas } = require('../services/metodosPago');
const opciones = require('../services/rifaOpciones');
const reservasSvc = require('../services/reservas');
const abonos = require('../services/abonos');


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
        ${opciones.COLUMNAS('r')},
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
          ) / (power(10, COALESCE(r.cifras, 3))::numeric / 100), 2
        ) AS porcentaje_comprado
      FROM rifas r
      LEFT JOIN ventas v ON v.rifa_id = r.id
      WHERE r.activa = TRUE
        AND r.publicada                              -- el dueño decide cuáles salen en la página
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
    const rifas = r.rows.map(rifa => {
      const compra_activa = !rifa.fecha_desactivacion_compra
        || new Date(rifa.fecha_desactivacion_compra) > new Date(ahora);
      // Apartar sin pagar: solo si la rifa lo permite y todavía hay tiempo para pagar
      const limite = compra_activa && opciones.puedeApartarse(rifa) ? opciones.limiteDePago(rifa) : null;
      return {
        ...rifa,
        compra_activa,
        rifa_con_apartado: !!rifa.pago_diferido,   // la rifa trabaja con apartados (aunque ya no se pueda apartar)
        pago_diferido: !!limite,
        pago_hasta: limite ? limite.toISOString() : null,
        pago_hasta_texto: limite ? opciones.fmtLimite(limite) : null,
      };
    });

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
      pool.query(`SELECT COUNT(*)::int n FROM reservas_cliente WHERE rifa_id=$1 AND numero=$2 AND (estado = 'pendiente' OR (estado = 'apartado' AND (apartado_hasta > NOW() OR tiene_abono)))`, [req.params.id, numero]),
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
      `SELECT numero, COUNT(*) AS veces FROM reservas_cliente WHERE rifa_id=$1 AND (estado = 'pendiente' OR (estado = 'apartado' AND (apartado_hasta > NOW() OR tiene_abono))) GROUP BY numero`,
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
    for (let i = 0; i < 10 ** cifras; i++) {
      const n       = String(i).padStart(cifras, '0');
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
      `SELECT id, COALESCE(tipo, 'sencilla') AS tipo, COALESCE(cifras, 3) AS cifras
         FROM rifas
        WHERE id = $1`,
      [req.params.id]
    );
    if (!rifaR.rows[0]) return res.status(404).json({ error: 'Rifa no encontrada' });

    const esSimultanea = rifaR.rows[0].tipo === 'simultanea';
    // Terminal (2 cifras) = 100 números por serie; el resto se mantiene en 1000
    const porSerie     = Number(rifaR.rows[0].cifras) === 2 ? 100 : 1000;
    const total        = esSimultanea ? porSerie * 2 : porSerie;

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
              WHERE rifa_id = $1 AND (estado = 'pendiente' OR (estado = 'apartado' AND (apartado_hasta > NOW() OR tiene_abono)))`,
            [req.params.id]
          )
        : pool.query(
            `SELECT COUNT(DISTINCT numero)::int AS n
               FROM reservas_cliente
              WHERE rifa_id = $1 AND (estado = 'pendiente' OR (estado = 'apartado' AND (apartado_hasta > NOW() OR tiene_abono)))`,
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
   APARTAR SIN PAGAR (rifas con pago diferido)
   El número queda bloqueado para el cliente hasta la fecha límite
   de pago de la rifa. Si no paga, se libera solo. El bot le
   recuerda por WhatsApp, así que el teléfono es obligatorio.
────────────────────────────────────────────────────────── */
const digitos = (t) => String(t || '').replace(/\D/g, '');

async function apartarSinPago(req, res, numeros) {
  const { rifa_id, nombre_cliente, cedula, correo, telefono, metodo_pago } = req.body;
  if (digitos(telefono).length < 10)
    return res.status(400).json({ error: 'Para apartar necesitamos tu WhatsApp: por ahí te recordamos el pago y te llega tu ticket' });

  const client = await pool.connect();
  try {
    const rifa = await reservasSvc.infoRifa(pool, rifa_id);
    if (!rifa) return res.status(404).json({ error: 'Rifa no encontrada' });
    if (!opciones.puedeApartarse(rifa))
      return res.status(403).json({ error: 'Esta rifa ya no permite apartar sin pagar. Puedes comprar enviando tu comprobante.', sin_apartado: true });
    const limite = opciones.limiteDePago(rifa);

    // Tope de números apartados sin pagar por persona
    const yaTiene = (await reservasSvc.apartadosDe({ telefono, rifaId: rifa.id }))[0]?.numeros.length || 0;
    const max = Number(rifa.diferido_max_numeros) || 10;
    if (yaTiene + numeros.length > max) {
      return res.status(400).json({
        error: yaTiene
          ? `Ya tienes ${yaTiene} número${yaTiene === 1 ? '' : 's'} apartado${yaTiene === 1 ? '' : 's'} sin pagar. El máximo es ${max}: paga los que tienes o aparta menos.`
          : `Puedes apartar máximo ${max} números sin pagar. Para llevar más, paga de una vez con tu comprobante.`,
      });
    }

    await client.query('BEGIN');
    const r = await crearReservasTx(client, {
      rifa_id, numeros, nombre_cliente, cedula, correo, telefono, metodo_pago: metodo_pago || null,
      comprobanteUrl: null, origen: 'web', estado: 'apartado', apartadoHasta: limite, pagoDiferido: true,
    });
    if (!r.ok) {
      await client.query('ROLLBACK');
      const body = { error: r.error };
      if (r.conflictos?.length) body.conflictos = r.conflictos;
      if (r.compra_desactivada) body.compra_desactivada = true;
      return res.status(r.status || 400).json(body);
    }
    await client.query('COMMIT');

    const respuesta = {
      ok: true, apartado: true, reservas: r.reservas, total_reservados: r.reservas.length,
      pago_hasta: limite.toISOString(), pago_hasta_texto: opciones.fmtLimite(limite),
      mensaje: `¡${r.reservas.length === 1 ? 'Número apartado' : `${r.reservas.length} números apartados`}! Tienes hasta el ${opciones.fmtLimite(limite)} para pagar.`,
    };
    if (r.conflictos.length > 0) respuesta.conflictos = r.conflictos;
    if (r.reservas.length === 1) respuesta.reserva = r.reservas[0];
    res.status(201).json(respuesta);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
}

/* ── GET /api/publico/apartados?telefono=&cedula= ──────────
   Números que una persona tiene apartados sin pagar. Pide teléfono
   Y cédula (los dos con los que apartó) para que nadie consulte
   los apartados de otro.
────────────────────────────────────────────────────────── */
const mismaCedula = (a, b) => digitos(a) !== '' && digitos(a) === digitos(b);

router.get('/apartados', async (req, res) => {
  const { telefono, cedula } = req.query;
  if (digitos(telefono).length < 10 || digitos(cedula).length < 5)
    return res.status(400).json({ error: 'Escribe el WhatsApp y la cédula con los que apartaste' });
  try {
    const grupos = (await reservasSvc.apartadosDe({ telefono })).filter((g) => mismaCedula(g.cedula, cedula));
    res.json(grupos.map((g) => ({
      rifa_id: g.rifa.id, rifa: g.rifa.nombre, premio: g.rifa.premio, numeros: g.numeros, nombre: g.nombre,
      total: g.total, pago_hasta: g.limite.toISOString(), pago_hasta_texto: opciones.fmtLimite(g.limite),
      // Abonos: lo confirmado, lo enviado sin confirmar y lo que falta por pagar
      abonado: g.abonado, por_confirmar: g.por_confirmar, saldo: g.saldo,
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── POST /api/publico/apartados/pagar ─────────────────────
   El cliente sube el comprobante de sus números apartados.
   - Pago completo de una vez: pasan a "pendiente" y el dueño los aprueba en Reservas.
   - Abono (paga una parte, o ya venía abonando): queda como abono por confirmar;
     los números siguen apartados hasta completar el total.
   Body: { rifa_id, telefono, cedula, metodo_pago, comprobante_base64, monto? }
         monto (en pesos) = cuánto está pagando ahora; sin monto = todo lo que falta
────────────────────────────────────────────────────────── */
router.post('/apartados/pagar', async (req, res) => {
  const { rifa_id, telefono, cedula, metodo_pago, comprobante_base64 } = req.body;
  if (!rifa_id || digitos(telefono).length < 10 || digitos(cedula).length < 5)
    return res.status(400).json({ error: 'Faltan datos para identificar tus números apartados' });
  const montoPedido = req.body.monto === undefined || req.body.monto === null || req.body.monto === '' ? null : Math.round(Number(req.body.monto));
  if (montoPedido !== null && !(montoPedido > 0)) return res.status(400).json({ error: 'Escribe cuánto vas a abonar' });
  if (!comprobante_base64)
    return res.status(400).json({ error: 'Adjunta el comprobante de pago' });

  let url = null, confirmado = false;
  const client = await pool.connect();
  try {
    const grupo = (await reservasSvc.apartadosDe({ telefono, rifaId: rifa_id })).find((g) => mismaCedula(g.cedula, cedula));
    if (!grupo) return res.status(404).json({ error: 'No encontramos números apartados con esos datos. Puede que ya se hayan pagado o que se venció el plazo.' });

    // Lo que falta contando lo ya confirmado y lo que está por confirmar
    const falta = Math.max(grupo.saldo - grupo.por_confirmar, 0);
    if (falta <= 0) return res.status(409).json({ error: 'Ya enviaste el pago completo de estos números. Estamos verificándolo.' });
    const monto = Math.min(montoPedido ?? falta, falta);

    url = await subirSiEsBase64(comprobante_base64, { folder: CARPETAS.comprobantes });

    // Abono: paga una parte, o ya tenía abonos (el último también es un abono: al confirmarlo se completa)
    if (monto < grupo.total || grupo.abonado > 0 || grupo.por_confirmar > 0) {
      const a = await abonos.crear(pool, {
        g: grupo, monto, metodo: metodo_pago || null, comprobanteUrl: url, origen: 'web',
        datos: { metodo: metodo_pago || null, monto_declarado: monto, total: grupo.total, abonado_antes: grupo.abonado },
      });
      confirmado = true;
      const restante = Math.max(falta - monto, 0);
      return res.json({
        ok: true, abono: true, id: a.id, monto, restante, numeros: grupo.numeros,
        mensaje: restante > 0
          ? `¡Abono recibido! Apenas lo verifiquemos te confirmamos por WhatsApp. Te quedarían ${restante.toLocaleString('es-CO')} pesos por pagar antes del ${opciones.fmtLimite(grupo.limite)}.`
          : '¡Comprobante recibido! Con este pago completas el total. Apenas lo verifiquemos te llega tu ticket por WhatsApp.',
      });
    }

    await client.query('BEGIN');
    const filas = await reservasSvc.confirmarApartadoTx(client, grupo.ids, {
      comprobanteUrl: url, metodo_pago: metodo_pago || null, comprobante_nombre: 'comprobante-web',
      comprobante_datos: { metodo: metodo_pago || null, monto_esperado: `${Math.round(grupo.total).toLocaleString('es-CO')} pesos` },
    });
    if (!filas.length) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Esos números ya no están apartados.' }); }
    await client.query('COMMIT');
    confirmado = true;
    res.json({
      ok: true, numeros: filas.map((f) => String(f.numero).trim()), reservas: filas,
      mensaje: '¡Comprobante recibido! Apenas verifiquemos el pago te llega tu ticket por WhatsApp.',
    });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[apartados/pagar]', e);
    res.status(500).json({ error: 'No se pudo registrar el pago, intenta de nuevo' });
  } finally {
    client.release();
    if (url && url !== comprobante_base64 && !confirmado) eliminarImagen(extraerPublicId(url));
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
  // apartar=true: reservar sin pagar todavía (solo en rifas con pago diferido)
  const apartar = req.body.apartar === true;

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

  const invalidos = numeros.filter(n => !/^\d{2,4}$/.test(String(n)));
  if (invalidos.length > 0)
    return res.status(400).json({ error: `Números con formato inválido: ${invalidos.join(', ')}` });

  if (correo && correo.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo.trim()))
    return res.status(400).json({ error: 'El correo electrónico no tiene un formato válido' });

  if (apartar) return apartarSinPago(req, res, numeros);

  if (!comprobante_base64)
    return res.status(400).json({ error: 'El comprobante de pago es obligatorio para reservar' });

  // El comprobante se sube UNA vez a Cloudinary y todas las filas guardan la URL
  // (antes se guardaba el base64 completo repetido en cada número reservado).
  let comprobanteUrl;
  try {
    comprobanteUrl = await subirSiEsBase64(comprobante_base64, { folder: CARPETAS.comprobantes });
  } catch (e) {
    console.error('[reservar] Error subiendo comprobante a Cloudinary:', e);
    return res.status(502).json({ error: 'No se pudo subir el comprobante, intenta de nuevo' });
  }
  const comprobanteSubido = comprobanteUrl !== comprobante_base64;
  let reservaConfirmada = false;

  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const r = await crearReservasTx(client, {
      rifa_id, numeros, nombre_cliente, cedula, correo, telefono, metodo_pago,
      comprobanteUrl, comprobante_nombre, origen: 'web',
    });
    if (!r.ok) {
      await client.query('ROLLBACK');
      const body = { error: r.error };
      if (r.conflictos?.length) body.conflictos = r.conflictos;
      if (r.compra_desactivada) body.compra_desactivada = true;
      return res.status(r.status || 400).json(body);
    }

    await client.query('COMMIT');
    reservaConfirmada = true;
    const reservasCreadas = r.reservas;

    const respuesta = {
      ok: true, reservas: reservasCreadas,
      total_reservados: reservasCreadas.length,
      mensaje: reservasCreadas.length === 1
        ? '¡Reserva enviada! El administrador verificará tu pago pronto.'
        : `¡${reservasCreadas.length} números reservados! El administrador verificará tu pago pronto.`,
    };
    if (r.conflictos.length > 0) respuesta.conflictos = r.conflictos;
    if (reservasCreadas.length === 1) respuesta.reserva = reservasCreadas[0];

    res.status(201).json(respuesta);
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
    // Si no se creó ninguna reserva, no dejamos el comprobante huérfano en Cloudinary
    if (comprobanteSubido && !reservaConfirmada) {
      eliminarImagen(extraerPublicId(comprobanteUrl));
    }
  }
});

/* ── GET /api/publico/metodos-pago ─────────────────────────
   Datos de pago + tasas del día. Fuente única que usan la
   pantalla del cliente y el bot de WhatsApp.
────────────────────────────────────────────────────────── */
// Número de WhatsApp del negocio (para "Recibir mi ticket por WhatsApp"):
// que el cliente escriba primero es la forma más segura de enviarle el ticket.
router.get('/whatsapp-negocio', (req, res) => {
  try {
    const { getStatus } = require('../whatsapp/whatsappService');
    const s = getStatus();
    res.json({ numero: s.status === 'open' ? s.numeroConectado : null });
  } catch (_) { res.json({ numero: null }); }
});

router.get('/metodos-pago', async (req, res) => {
  try {
    res.json({ metodos: await metodosActivos(), tasas: await obtenerTasas() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── GET /api/publico/reserva/:id ───────────────────────── */
// Devuelve cédula y correo del cliente: solo el dueño puede consultarla
router.get('/reserva/:id', authMiddleware, soloDueno, async (req, res) => {
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
// Busca por nombre y devuelve datos personales: solo el dueño puede consultarla
router.get('/reservas-cliente', authMiddleware, soloDueno, async (req, res) => {
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
             COALESCE(r.ofertas, '[]'::jsonb) AS ofertas,
             env.id AS envio_id, env.estado AS envio_estado, env.error AS envio_error,
             env.frio AS envio_frio, env.enviado_at AS envio_enviado_at,
             -- Abonos confirmados del cliente sobre este apartado (el mismo valor en todos sus números)
             (SELECT COALESCE(SUM(a.monto), 0) FROM reserva_abonos a
               WHERE rc.id = ANY(a.reserva_ids) AND a.estado = 'aprobado' AND NOT a.aplicado) AS abonado
      FROM reservas_cliente rc
      JOIN rifas r ON r.id = rc.rifa_id
      -- Estado del envío del ticket por WhatsApp (cola anti-bloqueo)
      LEFT JOIN LATERAL (
        SELECT e.id, e.estado, e.error, e.frio, e.enviado_at FROM wa_envios e
         WHERE rc.id = ANY(e.reserva_ids) ORDER BY e.id DESC LIMIT 1
      ) env ON TRUE
      ${estado && estado !== 'todos' ? 'WHERE rc.estado=$1' : "WHERE rc.estado <> 'apartado'"}   -- los apartados sin comprobante no se aprueban
      ORDER BY rc.created_at DESC
    `, estado && estado !== 'todos' ? [estado] : []);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── PUT /api/publico/admin/apartados/pagado ──────────────
   El dueño recibió el pago por fuera (efectivo, en persona).
   Body: { ids: [], nota? } → pasan a "pendiente" para aprobarlos
   como cualquier reserva (ahí se genera y envía el ticket).
────────────────────────────────────────────────────────── */
router.put('/admin/apartados/pagado', authMiddleware, soloDueno, async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  if (!ids.length) return res.status(400).json({ error: 'ids[] es requerido' });
  try {
    const filas = await reservasSvc.marcarApartadosPagados(ids, req.body.nota || 'Pago recibido directamente');
    res.json({ ok: true, procesadas: filas.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── GET /api/publico/admin/abonos?estado= ────────────────
   Abonos de números apartados (por confirmar primero)
────────────────────────────────────────────────────────── */
router.get('/admin/abonos', authMiddleware, soloDueno, async (req, res) => {
  try {
    const estado = ['pendiente', 'aprobado', 'rechazado'].includes(req.query.estado) ? req.query.estado : null;
    res.json(await abonos.listar({ estado }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── PUT /api/publico/admin/abonos/:id ────────────────────
   Body: { accion: 'aprobar' | 'rechazar', monto?, nota? }
   Al aprobar se puede corregir el monto (lo que realmente llegó).
────────────────────────────────────────────────────────── */
router.put('/admin/abonos/:id', authMiddleware, soloDueno, async (req, res) => {
  try {
    const { accion, monto, nota } = req.body || {};
    const r = accion === 'rechazar'
      ? await abonos.rechazar(req.params.id, nota || null)
      : accion === 'aprobar'
        ? await abonos.aprobar(req.params.id, { monto: monto ?? null, nota: nota || null })
        : { ok: false, status: 400, error: "accion debe ser 'aprobar' o 'rechazar'" };
    if (!r.ok) return res.status(r.status || 400).json({ error: r.error });
    res.json({ ok: true, completo: !!r.completo, abonado: r.abonado, saldo: r.saldo, total: r.total });
  } catch (e) { console.error('[abonos]', e); res.status(500).json({ error: e.message }); }
});

/* ── POST /api/publico/admin/abonos ───────────────────────
   El dueño recibió un abono por fuera (efectivo, en persona).
   Body: { ids: [apartados del cliente], monto, nota?, metodo_pago? }
   Queda confirmado de una vez.
────────────────────────────────────────────────────────── */
router.post('/admin/abonos', authMiddleware, soloDueno, async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  const monto = Math.round(Number(req.body?.monto));
  if (!ids.length) return res.status(400).json({ error: 'ids[] es requerido' });
  if (!(monto > 0)) return res.status(400).json({ error: 'Escribe el monto del abono' });
  try {
    const filas = await pool.query(
      `SELECT id, rifa_id, nombre_cliente, cedula, telefono, wa_jid FROM reservas_cliente WHERE id = ANY($1) AND estado = 'apartado'`, [ids]);
    const f = filas.rows[0];
    if (!f) return res.status(404).json({ error: 'Esos números ya no están apartados' });
    const rifa = await reservasSvc.infoRifa(pool, f.rifa_id);
    const a = await abonos.crear(pool, {
      g: { rifa, ids: filas.rows.map((x) => x.id), nombre: f.nombre_cliente, cedula: f.cedula, telefono: f.telefono, wa_jid: f.wa_jid },
      monto, metodo: req.body.metodo_pago || 'Efectivo', origen: 'panel',
    });
    const r = await abonos.aprobar(a.id, { nota: req.body.nota || 'Abono recibido directamente' });
    if (!r.ok) return res.status(r.status || 400).json({ error: r.error });
    res.json({ ok: true, completo: r.completo, abonado: r.abonado, saldo: r.saldo, total: r.total });
  } catch (e) { console.error('[abonos]', e); res.status(500).json({ error: e.message }); }
});

/* ── PUT /api/publico/admin/reservas-a-abono ──────────────
   Un comprobante llegó como pago completo pero en realidad fue un abono
   (el cliente mandó la captura de una parte sin avisar). Los números
   vuelven a "apartado" y el comprobante queda como abono confirmado.
   Body: { ids: [reservas pendientes], monto }
────────────────────────────────────────────────────────── */
router.put('/admin/reservas-a-abono', authMiddleware, soloDueno, async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  const monto = Math.round(Number(req.body?.monto));
  if (!ids.length) return res.status(400).json({ error: 'ids[] es requerido' });
  if (!(monto > 0)) return res.status(400).json({ error: 'Escribe cuánto abonó' });
  try {
    const filas = await pool.query(
      `SELECT * FROM reservas_cliente WHERE id = ANY($1) AND estado = 'pendiente' AND pago_diferido`, [ids]);
    const f = filas.rows[0];
    if (!f) return res.status(404).json({ error: 'Solo aplica a pagos por aprobar de números que se habían apartado para pagar después' });
    const rifa = await reservasSvc.infoRifa(pool, f.rifa_id);
    const idsOk = filas.rows.map((x) => x.id);
    const total = reservasSvc.calcularPrecioReal(idsOk.length, rifa.ofertas, Number(rifa.precio));
    if (monto >= total) return res.status(400).json({ error: `Ese monto cubre el total (${total.toLocaleString('es-CO')} pesos): apruébalo como pago completo` });
    // Vuelven a apartado hasta el límite de la rifa (o un día más si ya pasó)
    const limiteRifa = opciones.limiteDePago(rifa);
    const limite = limiteRifa && limiteRifa > new Date() ? limiteRifa : new Date(Date.now() + 24 * 3600000);
    await pool.query(
      `UPDATE reservas_cliente SET estado = 'apartado', apartado_hasta = $2, comprobante_base64 = NULL, comprobante_nombre = NULL, comprobante_datos = NULL, updated_at = NOW()
        WHERE id = ANY($1)`, [idsOk, limite]);
    const a = await abonos.crear(pool, {
      g: { rifa, ids: idsOk, nombre: f.nombre_cliente, cedula: f.cedula, telefono: f.telefono, wa_jid: f.wa_jid },
      monto, metodo: f.metodo_pago, comprobanteUrl: /^https?:\/\//.test(f.comprobante_base64 || '') ? f.comprobante_base64 : null,
      origen: f.origen === 'whatsapp' ? 'whatsapp' : 'web', datos: f.comprobante_datos,
    });
    const r = await abonos.aprobar(a.id, { nota: 'Registrado como abono parcial' });
    if (!r.ok) return res.status(r.status || 400).json({ error: r.error });
    res.json({ ok: true, abonado: r.abonado, saldo: r.saldo, total: r.total });
  } catch (e) { console.error('[abonos]', e); res.status(500).json({ error: e.message }); }
});

/* ── DELETE /api/publico/admin/apartados ──────────────────
   Libera números apartados sin pagar. Body: { ids: [] }
────────────────────────────────────────────────────────── */
router.delete('/admin/apartados', authMiddleware, soloDueno, async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  if (!ids.length) return res.status(400).json({ error: 'ids[] es requerido' });
  try {
    const filas = await reservasSvc.liberarApartados(ids);
    res.json({ ok: true, liberados: filas.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── PUT /api/publico/admin/reservas/:id ──────────────────
   Aprobar: crea la venta (con origen web/whatsapp) vía services/reservas
   Rechazar: libera el número
────────────────────────────────────────────────────────── */
router.put('/admin/reservas/:id', authMiddleware, soloDueno, async (req, res) => {
  const { estado, nota_admin } = req.body;
  if (!['aprobado', 'rechazado'].includes(estado))
    return res.status(400).json({ error: 'estado debe ser aprobado o rechazado' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (estado === 'rechazado') {
      const rechazadas = await rechazarReservasTx(client, [req.params.id], nota_admin, { soloPendientes: false });
      if (!rechazadas[0]) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'No encontrada' });
      }
      await client.query('COMMIT');
      avisarRechazadas(rechazadas);
      return res.json({ ok: true, reserva: rechazadas[0] });
    }

    const { aprobadas, autoRechazadas } = await aprobarReservasTx(client, [req.params.id], nota_admin);
    await client.query('COMMIT');
    avisarAprobadas(aprobadas);

    if (autoRechazadas[0]) {
      return res.status(409).json({
        error: `El número ${autoRechazadas[0].numero} ya alcanzó el máximo de ventas y no puede aprobarse nuevamente.`,
        auto_rechazado: true,
      });
    }
    if (!aprobadas[0]) {
      const existe = await pool.query('SELECT * FROM reservas_cliente WHERE id=$1', [req.params.id]);
      if (!existe.rows[0]) return res.status(404).json({ error: 'No encontrada' });
      return res.json({ ok: true, reserva: existe.rows[0] });   // ya estaba procesada
    }
    res.json({ ok: true, reserva: aprobadas[0] });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

/* ── PUT /api/publico/admin/reservas-bulk ───────────────── */
router.put('/admin/reservas-bulk', authMiddleware, soloDueno, async (req, res) => {
  const { ids, estado, nota_admin } = req.body;
  if (!Array.isArray(ids) || ids.length === 0)
    return res.status(400).json({ error: 'ids[] es requerido' });
  if (!['aprobado', 'rechazado'].includes(estado))
    return res.status(400).json({ error: 'estado debe ser aprobado o rechazado' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (estado === 'rechazado') {
      const rechazadas = await rechazarReservasTx(client, ids, nota_admin);
      await client.query('COMMIT');
      avisarRechazadas(rechazadas);
      return res.json({ ok: true, procesadas: rechazadas.length });
    }
    const { aprobadas, autoRechazadas } = await aprobarReservasTx(client, ids, nota_admin);
    await client.query('COMMIT');
    avisarAprobadas(aprobadas);
    res.json({ ok: true, procesadas: aprobadas.length + autoRechazadas.length, aprobadas: aprobadas.length, auto_rechazadas: autoRechazadas.length });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

module.exports = router;