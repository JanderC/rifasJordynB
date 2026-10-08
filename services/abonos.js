// ============================================================
//  abonos.js — Pagos parciales de números apartados
//
//  En las rifas con pago diferido el cliente aparta y puede ir pagando
//  por partes (abona 20.000 de 60.000 y el resto después).
//   • Cada abono llega a Reservas como "por confirmar" con su comprobante.
//   • Al confirmarlo cuenta como dinero recibido (Caja lo muestra aparte:
//     "abonos de apartados") y baja lo que el cliente debe.
//   • Con un abono confirmado el número ya NO se libera solo al vencer
//     el plazo (hay dinero de por medio): lo decide el dueño.
//   • Cuando los abonos cubren el total, los números pasan a "pendiente"
//     para aprobarlos como cualquier reserva: ahí se crea la venta por el
//     total y sale el ticket. En ese momento los abonos quedan "aplicados"
//     y Caja deja de contarlos aparte (ya están dentro de la venta).
//  Los montos van en la moneda de las rifas (pesos).
// ============================================================
const pool = require('../config/db');
const bus  = require('./waBus');
const opciones = require('./rifaOpciones');
const reservas = require('./reservas');

const redondear = (n) => Math.round(Number(n) || 0);
const soloDigitos = (t) => String(t || '').replace(/\D/g, '');

// Registra un abono. estado 'pendiente' = espera confirmación del dueño.
// g: grupo de apartados del cliente en la rifa (de reservas.apartadosDe)
async function crear(db, { g, monto, metodo = null, comprobanteUrl = null, datos = null, origen = 'web', jid = null, pagador = null }) {
  await opciones.esquemaListo;
  const r = await db.query(
    `INSERT INTO reserva_abonos (rifa_id, reserva_ids, nombre_cliente, cedula, telefono, wa_jid, monto, metodo_pago, comprobante_url, comprobante_datos, origen, pagador)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
    [g.rifa.id, g.ids, g.nombre, g.cedula || null, g.telefono || null, jid || g.wa_jid || null, redondear(monto), metodo, comprobanteUrl,
     datos ? JSON.stringify(datos) : null, origen, String(pagador || '').trim().slice(0, 120) || null]);
  return r.rows[0];
}

// Apartados vivos a los que pertenece un abono, con sus sumas (o null si ya no existen)
async function grupoDe(db, abono) {
  const r = await db.query(
    `SELECT id, TRIM(numero) AS numero, apartado_hasta, wa_jid FROM reservas_cliente
      WHERE id = ANY($1) AND estado = 'apartado' ORDER BY created_at`, [abono.reserva_ids]);
  if (!r.rows.length) return null;
  // El cliente pudo apartar más números después: entran todos los suyos en esa rifa
  const todos = await db.query(
    `SELECT id, TRIM(numero) AS numero, apartado_hasta, wa_jid FROM reservas_cliente
      WHERE rifa_id = $1 AND estado = 'apartado' AND pago_diferido
        AND ($2 <> '' AND RIGHT(regexp_replace(COALESCE(telefono, ''), '\\D', '', 'g'), 10) = RIGHT($2, 10) OR id = ANY($3))
      ORDER BY created_at`, [abono.rifa_id, soloDigitos(abono.telefono), abono.reserva_ids]);
  const rifa = await reservas.infoRifa(db, abono.rifa_id);
  const ids = todos.rows.map((x) => x.id);
  const total = reservas.calcularPrecioReal(ids.length, rifa.ofertas, Number(rifa.precio));
  const s = await db.query(
    `SELECT COALESCE(SUM(monto) FILTER (WHERE estado = 'aprobado'), 0) AS abonado
       FROM reserva_abonos WHERE reserva_ids && $1::uuid[] AND NOT aplicado`, [ids]);
  const abonado = Number(s.rows[0].abonado);
  return {
    rifa, ids, numeros: todos.rows.map((x) => x.numero), total, abonado, saldo: Math.max(total - abonado, 0),
    limite: todos.rows.reduce((m, x) => (x.apartado_hasta && (!m || new Date(x.apartado_hasta) < m) ? new Date(x.apartado_hasta) : m), null),
    jid: abono.wa_jid || todos.rows.find((x) => x.wa_jid)?.wa_jid || null,
  };
}

// Confirma un abono. Si con él se cubre el total, los números pasan a "pendiente"
// (se aprueban en Reservas → venta por el total + ticket) y los abonos quedan aplicados.
// monto: lo que realmente llegó (el dueño puede corregirlo al confirmar)
async function aprobar(id, { monto = null, nota = null } = {}) {
  await opciones.esquemaListo;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const a = (await client.query(`SELECT * FROM reserva_abonos WHERE id = $1 FOR UPDATE`, [id])).rows[0];
    if (!a) { await client.query('ROLLBACK'); return { ok: false, status: 404, error: 'Abono no encontrado' }; }
    if (a.estado !== 'pendiente') { await client.query('ROLLBACK'); return { ok: false, status: 409, error: 'Ese abono ya fue procesado' }; }
    const valor = redondear(monto ?? a.monto);
    if (valor <= 0) { await client.query('ROLLBACK'); return { ok: false, status: 400, error: 'El monto del abono debe ser mayor a cero' }; }

    const antes = await grupoDe(client, a);
    if (!antes) { await client.query('ROLLBACK'); return { ok: false, status: 409, error: 'Esos números ya no están apartados (se pagaron o se liberaron). Rechaza el abono o regístralo a mano.' }; }

    const abono = (await client.query(
      `UPDATE reserva_abonos SET estado = 'aprobado', monto = $2, nota_admin = COALESCE($3, nota_admin), updated_at = NOW() WHERE id = $1 RETURNING *`,
      [id, valor, nota])).rows[0];
    await client.query(`UPDATE reservas_cliente SET tiene_abono = TRUE WHERE id = ANY($1)`, [antes.ids]);

    const abonado = antes.abonado + valor;
    const saldo = Math.max(antes.total - abonado, 0);
    const completo = saldo <= 0;
    if (completo) {
      // Pago completo: a Pendientes con el último comprobante y el detalle de lo abonado
      await client.query(
        `UPDATE reservas_cliente
            SET estado = 'pendiente', apartado_hasta = NULL, comprobante_base64 = COALESCE($2, comprobante_base64),
                comprobante_nombre = 'comprobante-abono', metodo_pago = COALESCE($3, metodo_pago),
                comprobante_datos = $4, nota_admin = $5, updated_at = NOW()
          WHERE id = ANY($1) AND estado = 'apartado'`,
        [antes.ids, abono.comprobante_url, abono.metodo_pago,
         JSON.stringify({ metodo: abono.metodo_pago, pagado_con_abonos: true, total_abonado: abonado, monto_esperado: `${antes.total.toLocaleString('es-CO')} pesos` }),
         `Pagado con abonos (${abonado.toLocaleString('es-CO')} pesos en total)`]);
      await client.query(`UPDATE reserva_abonos SET aplicado = TRUE, updated_at = NOW() WHERE reserva_ids && $1::uuid[] AND estado = 'aprobado'`, [antes.ids]);
    }
    await client.query('COMMIT');
    const info = { abono, completo, abonado, saldo, total: antes.total, numeros: antes.numeros, rifa: antes.rifa, limite: antes.limite, jid: antes.jid };
    bus.emit('abono:aprobado', info);   // el bot le confirma al cliente y le dice cuánto falta
    return { ok: true, ...info };
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
  finally { client.release(); }
}

async function rechazar(id, nota = null) {
  await opciones.esquemaListo;
  const r = await pool.query(
    `UPDATE reserva_abonos SET estado = 'rechazado', nota_admin = $2, updated_at = NOW() WHERE id = $1 AND estado = 'pendiente' RETURNING *`, [id, nota]);
  if (!r.rows[0]) return { ok: false, status: 409, error: 'Ese abono ya fue procesado' };
  const g = await grupoDe(pool, r.rows[0]);
  bus.emit('abono:rechazado', { abono: r.rows[0], numeros: g?.numeros || [], rifa: g?.rifa || null, jid: r.rows[0].wa_jid || g?.jid || null });
  return { ok: true, abono: r.rows[0] };
}

// Para Reservas: abonos con el estado de los apartados a los que pertenecen
async function listar({ estado = null } = {}) {
  await opciones.esquemaListo;
  const r = await pool.query(
    `SELECT a.*, ri.nombre AS rifa_nombre, ri.precio
       FROM reserva_abonos a JOIN rifas ri ON ri.id = a.rifa_id
      WHERE ($1::text IS NULL OR a.estado = $1)
      ORDER BY (a.estado = 'pendiente') DESC, a.created_at DESC LIMIT 200`, [estado]);
  const out = [];
  for (const a of r.rows) {
    const g = a.aplicado ? null : await grupoDe(pool, a);
    out.push({
      ...a, monto: Number(a.monto),
      numeros: g?.numeros || [], total: g?.total ?? null, abonado: g?.abonado ?? null, saldo: g?.saldo ?? null,
      limite: g?.limite || null, apartado_vigente: !!g,
    });
  }
  return out;
}

// Para Caja: dinero recibido en abonos de apartados que todavía no son venta
async function resumenRifa(rifaId) {
  await opciones.esquemaListo;
  const r = await pool.query(
    `SELECT a.id, a.nombre_cliente, a.telefono, a.monto, a.metodo_pago, a.origen, a.created_at, a.comprobante_url, a.reserva_ids,
            (SELECT ARRAY_AGG(TRIM(rc.numero) ORDER BY rc.numero) FROM reservas_cliente rc WHERE rc.id = ANY(a.reserva_ids) AND rc.estado IN ('apartado', 'pendiente')) AS numeros,
            a.aplicado AS completo
       FROM reserva_abonos a
      WHERE a.rifa_id = $1 AND a.estado = 'aprobado'
        -- Cuenta hasta que exista la venta: abonos de apartados sin completar, y los ya
        -- completos cuya reserva todavía espera la aprobación final en Reservas
        AND (NOT a.aplicado OR EXISTS (SELECT 1 FROM reservas_cliente rc WHERE rc.id = ANY(a.reserva_ids) AND rc.estado = 'pendiente'))
      ORDER BY a.created_at DESC`, [rifaId]);
  const porConfirmar = await pool.query(
    `SELECT COUNT(*)::int n, COALESCE(SUM(monto), 0) AS monto FROM reserva_abonos WHERE rifa_id = $1 AND estado = 'pendiente'`, [rifaId]);
  const lista = r.rows.map((x) => ({ ...x, monto: Number(x.monto), numeros: x.numeros || [], reserva_ids: undefined }));
  return {
    recibido: lista.reduce((s, x) => s + x.monto, 0),
    cantidad: lista.length,
    por_confirmar: { cantidad: porConfirmar.rows[0].n, monto: Number(porConfirmar.rows[0].monto) },
    lista,
  };
}

module.exports = { crear, aprobar, rechazar, listar, resumenRifa, grupoDe };
