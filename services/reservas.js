// ============================================================
//  reservas.js — Lógica única de disponibilidad, reservas y aprobación
//  La usan: la pantalla pública (/publico/reservar), el bot de WhatsApp
//  y la aprobación desde GestionReservas (web o con envío por WhatsApp).
//
//  Al aprobar, SIEMPRE se registra la venta en `ventas` con su origen
//  ('web' | 'whatsapp') para que Caja pueda cuadrar lo vendido en línea.
// ============================================================
const pool = require('../config/db');
const bus  = require('./waBus');

// ── Esquema: columnas nuevas (idempotente) ───────────────────
const esquemaListo = (async () => {
  const sqls = [
    `ALTER TABLE ventas ADD COLUMN IF NOT EXISTS origen VARCHAR(20)`,
    `ALTER TABLE ventas ADD COLUMN IF NOT EXISTS reserva_id UUID`,
    `ALTER TABLE reservas_cliente ADD COLUMN IF NOT EXISTS comprobante_datos JSONB`,
    `ALTER TABLE reservas_cliente ADD COLUMN IF NOT EXISTS wa_jid TEXT`,
    `CREATE INDEX IF NOT EXISTS idx_ventas_rifa_origen ON ventas (rifa_id, origen)`,
    `CREATE INDEX IF NOT EXISTS idx_reservas_telefono ON reservas_cliente (telefono)`,
  ];
  for (const sql of sqls) {
    try { await pool.query(sql); } catch (e) { console.error('[reservas] esquema:', e.message); }
  }
})();

// Mejor precio total aplicando ofertas (p. ej. 3 números por $X)
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

async function infoRifa(db, rifaId) {
  const r = await db.query(`
    SELECT id, nombre, premio, precio, descripcion, activa,
           COALESCE(estado, 'activa')     AS estado,
           COALESCE(tipo, 'sencilla')     AS tipo,
           COALESCE(cifras, 3)            AS cifras,
           COALESCE(ofertas, '[]'::jsonb) AS ofertas,
           fecha_sorteo::text             AS fecha_sorteo,
           hora_sorteo::text              AS hora_sorteo,
           loteria_ref, fecha_desactivacion_compra
      FROM rifas WHERE id = $1`, [rifaId]);
  return r.rows[0] || null;
}

// Rifas donde un cliente puede comprar ahora mismo
async function rifasEnVenta(db = pool) {
  const r = await db.query(`
    SELECT id, nombre, premio, precio, descripcion,
           COALESCE(tipo, 'sencilla')     AS tipo,
           COALESCE(cifras, 3)            AS cifras,
           COALESCE(ofertas, '[]'::jsonb) AS ofertas,
           fecha_sorteo::text             AS fecha_sorteo,
           hora_sorteo::text              AS hora_sorteo,
           loteria_ref
      FROM rifas
     WHERE activa = true
       AND COALESCE(estado, 'activa') = 'activa'
       AND (fecha_desactivacion_compra IS NULL OR fecha_desactivacion_compra > NOW())
       -- el bot no ofrece rifas cuyo sorteo ya pasó aunque sigan marcadas activas
       AND (fecha_sorteo IS NULL OR fecha_sorteo >= (NOW() AT TIME ZONE 'America/Caracas')::date)
     ORDER BY fecha_sorteo NULLS LAST, created_at DESC`);
  return r.rows;
}

// "7" → "007" según las cifras de la rifa; null si no cabe
function normalizarNumero(n, cifras) {
  const raw = String(n ?? '').replace(/\D/g, '');
  if (!raw || raw.length > Number(cifras)) return null;
  return raw.padStart(Number(cifras), '0');
}

// Ocupación de varios números en una sola pasada (misma regla que /reservar):
// ventas + reservas pendientes + números asignados a vendedores (fijos/extras).
async function ocupacionNumeros(db, rifa, numeros) {
  const maxRanuras = rifa.tipo === 'simultanea' ? 2 : 1;
  const consultas = [
    [`SELECT numero, COUNT(*)::int n FROM ventas WHERE rifa_id=$1 AND numero = ANY($2) GROUP BY numero`],
    [`SELECT numero, COUNT(*)::int n FROM reservas_cliente WHERE rifa_id=$1 AND numero = ANY($2) AND estado='pendiente' GROUP BY numero`],
    [`SELECT numero, COUNT(DISTINCT serie)::int n FROM (
        SELECT numero, COALESCE(serie,'A') AS serie FROM numeros_vendedor WHERE rifa_id=$1 AND numero = ANY($2)
        UNION
        SELECT numero, serie FROM boleteria_numeros_extra WHERE rifa_id=$1 AND numero = ANY($2)
      ) s GROUP BY numero`],
  ];
  // Con el pool van en paralelo; dentro de una transacción (un solo cliente) en serie
  const ejecutar = ([sql]) => db.query(sql, [rifa.id, numeros]);
  const [vend, pend, asig] = db === pool
    ? await Promise.all(consultas.map(ejecutar))
    : [await ejecutar(consultas[0]), await ejecutar(consultas[1]), await ejecutar(consultas[2])];
  const aMapa = (rows) => Object.fromEntries(rows.map((x) => [String(x.numero).trim(), x.n]));
  const v = aMapa(vend.rows), p = aMapa(pend.rows), a = aMapa(asig.rows);
  const out = {};
  for (const numero of numeros) {
    const vendidas = v[numero] || 0, pendientes = p[numero] || 0, asignadas = a[numero] || 0;
    const ocupadas = vendidas + pendientes + asignadas;
    let razon = null;
    if (ocupadas >= maxRanuras) {
      razon = vendidas >= maxRanuras ? 'vendido'
            : asignadas > 0 && vendidas + asignadas >= maxRanuras ? 'asignado_vendedor'
            : 'reservado';
    }
    out[numero] = { numero, disponible: ocupadas < maxRanuras, razon };
  }
  return out;
}

// Números libres al azar (opcionalmente que terminen en X)
async function numerosLibres(db, rifa, { cantidad = 5, terminacion = '' } = {}) {
  const cifras = Number(rifa.cifras) || 3;
  const total = 10 ** cifras;
  const term = String(terminacion || '').replace(/\D/g, '');
  const candidatos = [];
  for (let i = 0; i < total; i++) {
    const n = String(i).padStart(cifras, '0');
    if (!term || n.endsWith(term)) candidatos.push(n);
  }
  const occ = await ocupacionNumeros(db, rifa, candidatos);
  const libres = candidatos.filter((n) => occ[n].disponible);
  for (let i = libres.length - 1; i > 0; i--) {           // barajar
    const j = Math.floor(Math.random() * (i + 1));
    [libres[i], libres[j]] = [libres[j], libres[i]];
  }
  return { libres: libres.slice(0, Math.min(20, cantidad)).sort(), totalLibres: libres.length };
}

// ── Crear reservas (pendientes de aprobación) dentro de una transacción ──
// Devuelve { ok, status?, error?, reservas, conflictos }
async function crearReservasTx(client, datos) {
  const {
    rifa_id, nombre_cliente, cedula, correo, telefono, metodo_pago,
    comprobanteUrl, comprobante_nombre, comprobante_datos, wa_jid,
    origen = 'web',
  } = datos;
  const numeros = [...datos.numeros];

  const rifa = await infoRifa(client, rifa_id);
  if (!rifa) return { ok: false, status: 404, error: 'Rifa no encontrada' };

  const cifras = Number(rifa.cifras) || 3;
  for (let i = 0; i < numeros.length; i++) {
    const n = normalizarNumero(numeros[i], cifras);
    if (!n) return { ok: false, status: 400, error: `Número fuera de rango para rifa de ${cifras} cifras: ${numeros[i]}` };
    numeros[i] = n;
  }
  if (rifa.fecha_desactivacion_compra && new Date(rifa.fecha_desactivacion_compra) <= new Date()) {
    return { ok: false, status: 403, error: 'La compra de esta rifa está desactivada. El sorteo ya fue realizado.', compra_desactivada: true };
  }

  const esSimultanea = rifa.tipo === 'simultanea';
  const aProcesar = esSimultanea ? numeros : [...new Set(numeros)];
  const reservas = [];
  const conflictos = [];

  // Uno por uno: en simultánea el mismo número puede venir dos veces y la
  // primera inserción cuenta como pendiente para la segunda.
  for (const numero of aProcesar) {
    const occ = (await ocupacionNumeros(client, rifa, [numero]))[numero];
    if (!occ.disponible) {
      conflictos.push({ numero, razon: occ.razon === 'vendido' ? 'agotado' : occ.razon === 'reservado' ? 'reserva_pendiente' : occ.razon });
      continue;
    }
    const r = await client.query(`
      INSERT INTO reservas_cliente
        (rifa_id, numero, nombre_cliente, cedula, correo, telefono, metodo_pago,
         comprobante_base64, comprobante_nombre, origen, comprobante_datos, wa_jid)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      RETURNING id, numero, nombre_cliente, cedula, correo, estado, created_at`,
    [
      rifa_id, numero, String(nombre_cliente).trim(), String(cedula || '').trim() || null,
      correo?.trim() || null, telefono || null, metodo_pago || null,
      comprobanteUrl, comprobante_nombre || null, origen,
      comprobante_datos ? JSON.stringify(comprobante_datos) : null, wa_jid || null,
    ]);
    reservas.push(r.rows[0]);
  }

  if (reservas.length === 0) return { ok: false, status: 409, error: 'Ningún número pudo reservarse', reservas, conflictos };
  return { ok: true, reservas, conflictos, rifa };
}

// ── Aprobar reservas pendientes → crea las ventas ────────────
// Precio con ofertas por cliente+rifa. Si el número ya alcanzó su máximo de
// ventas, la reserva se auto-rechaza. Devuelve el detalle de lo procesado.
async function aprobarReservasTx(client, ids, nota) {
  const dueno = await client.query(`SELECT id FROM users WHERE rol='dueno' LIMIT 1`);
  const vendedorId = dueno.rows[0]?.id || null;

  const reservasQ = await client.query(`
    SELECT rc.id, rc.rifa_id, rc.nombre_cliente, r.precio, COALESCE(r.ofertas, '[]'::jsonb) AS ofertas
      FROM reservas_cliente rc JOIN rifas r ON r.id = rc.rifa_id
     WHERE rc.id = ANY($1) AND rc.estado = 'pendiente'`, [ids]);

  const grupos = {};
  for (const row of reservasQ.rows) {
    const key = `${String(row.nombre_cliente).trim().toLowerCase()}||${row.rifa_id}`;
    if (!grupos[key]) grupos[key] = { precio: Number(row.precio), ofertas: row.ofertas, ids: [] };
    grupos[key].ids.push(row.id);
  }
  const preciosMap = {};
  for (const g of Object.values(grupos)) {
    const unit = calcularPrecioReal(g.ids.length, g.ofertas, g.precio) / g.ids.length;
    for (const id of g.ids) preciosMap[id] = unit;
  }

  const aprobadas = [];
  const autoRechazadas = [];
  const enTx = {};
  for (const id of ids) {
    const upd = await client.query(`
      UPDATE reservas_cliente SET estado='aprobado', nota_admin=$1, updated_at=NOW()
       WHERE id=$2 AND estado='pendiente' RETURNING *`, [nota || null, id]);
    const reserva = upd.rows[0];
    if (!reserva) continue;

    const rifaInfo = (await client.query(
      `SELECT precio, COALESCE(tipo,'sencilla') AS tipo FROM rifas WHERE id=$1`, [reserva.rifa_id])).rows[0];
    const maxVentas = rifaInfo?.tipo === 'simultanea' ? 2 : 1;
    const clave = `${reserva.rifa_id}|${reserva.numero}`;
    const enBD = parseInt((await client.query(
      `SELECT COUNT(*) FROM ventas WHERE rifa_id=$1 AND numero=$2`, [reserva.rifa_id, reserva.numero])).rows[0].count, 10);

    if (enBD + (enTx[clave] || 0) >= maxVentas) {
      await client.query(
        `UPDATE reservas_cliente SET estado='rechazado', nota_admin=$1, updated_at=NOW() WHERE id=$2`,
        [`Auto-rechazado: el número ${reserva.numero} ya alcanzó el máximo de ventas permitidas`, id]);
      autoRechazadas.push({ ...reserva, estado: 'rechazado' });
      continue;
    }
    enTx[clave] = (enTx[clave] || 0) + 1;

    const origen = reserva.origen === 'whatsapp' ? 'whatsapp' : 'web';
    await client.query(`
      INSERT INTO ventas
        (rifa_id, numero, vendedor_id, nombre_comprador, cedula, correo, telefono,
         precio_venta, observacion, origen, reserva_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT DO NOTHING`,
    [
      reserva.rifa_id, reserva.numero, vendedorId, reserva.nombre_cliente,
      reserva.cedula || null, reserva.correo || null, reserva.telefono,
      preciosMap[id] ?? Number(rifaInfo?.precio || 0),
      `Compra ${origen === 'whatsapp' ? 'por WhatsApp' : 'online'} - Reserva #${reserva.id.slice(0, 8)} - ${reserva.metodo_pago || ''}`,
      origen, reserva.id,
    ]);
    aprobadas.push(reserva);
  }
  return { aprobadas, autoRechazadas };
}

async function rechazarReservasTx(client, ids, nota, { soloPendientes = true } = {}) {
  const r = await client.query(`
    UPDATE reservas_cliente SET estado='rechazado', nota_admin=$1, updated_at=NOW()
     WHERE id = ANY($2) ${soloPendientes ? "AND estado='pendiente'" : ''}
     RETURNING *`, [nota || null, ids]);
  return r.rows;
}

// Avisos para el bot (se emiten DESPUÉS del COMMIT)
function avisarAprobadas(reservas) { if (reservas?.length) bus.emit('reservas:aprobadas', reservas); }
function avisarRechazadas(reservas) { if (reservas?.length) bus.emit('reservas:rechazadas', reservas); }

module.exports = {
  esquemaListo,
  calcularPrecioReal,
  infoRifa,
  rifasEnVenta,
  normalizarNumero,
  ocupacionNumeros,
  numerosLibres,
  crearReservasTx,
  aprobarReservasTx,
  rechazarReservasTx,
  avisarAprobadas,
  avisarRechazadas,
};
