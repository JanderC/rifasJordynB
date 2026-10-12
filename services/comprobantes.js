// ============================================================
//  comprobantes.js — Archivo de comprobantes de pago y su lectura con IA
//
//  Los comprobantes viven donde siempre (reservas_cliente y reserva_abonos);
//  aquí se listan juntos (últimos 30 días o más) y se leen con visión:
//  monto, referencia, banco, fecha y titular quedan guardados junto al
//  comprobante. Con eso se avisa cuando una misma referencia aparece en
//  otro pago (comprobante repetido).
//
//  La lectura se hace cuando el bot recibe la captura por WhatsApp o, si no
//  se había leído (compras por la página), cuando el dueño abre el comprobante.
// ============================================================
const pool = require('../config/db');
const opciones = require('./rifaOpciones');
const ia = require('../whatsapp/ia');
const { obtenerConfig } = require('../whatsapp/botConfig');

const DIAS_REPETIDOS = 60;   // ventana para buscar la misma referencia en otros pagos

// Referencia comparable: solo letras y números, sin ceros a la izquierda ("Ref: 000-123 456" → "123456")
function normalizarRef(ref) {
  const s = String(ref ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^0+/, '');
  return s.length >= 4 ? s : null;
}

// La imagen como { base64, mime } a partir de lo guardado: URL, data: URI o base64 suelto (comprobantes viejos)
async function imagenDe(fuente) {
  const s = String(fuente || '');
  if (/^https?:\/\//i.test(s)) {
    const r = await fetch(s, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`No se pudo descargar el comprobante (HTTP ${r.status})`);
    const mime = (r.headers.get('content-type') || 'image/jpeg').split(';')[0];
    return { base64: Buffer.from(await r.arrayBuffer()).toString('base64'), mime: /^image\//.test(mime) ? mime : 'image/jpeg' };
  }
  const m = s.match(/^data:(image\/[\w.+-]+);base64,(.+)$/s);
  if (m) return { base64: m[2], mime: m[1] };
  if (s.length > 100) return { base64: s, mime: 'image/jpeg' };
  throw new Error('Este pago no tiene comprobante.');
}

// Otros pagos (de los últimos DIAS_REPETIDOS días) con la misma referencia
async function repetidos(referencia, { fuente = null, abonoId = null } = {}) {
  const ref = normalizarRef(referencia);
  if (!ref) return [];
  const normSql = (col) => `NULLIF(LTRIM(REGEXP_REPLACE(UPPER(COALESCE(${col}->>'referencia', '')), '[^A-Z0-9]', '', 'g'), '0'), '')`;
  const r = await pool.query(`
    SELECT 'reserva' AS tipo, MIN(rc.id::text) AS id, rc.nombre_cliente AS nombre, rc.telefono, ri.nombre AS rifa,
           ARRAY_AGG(TRIM(rc.numero) ORDER BY rc.numero) AS numeros, MIN(rc.created_at) AS fecha,
           (ARRAY_AGG(rc.estado))[1] AS estado
      FROM reservas_cliente rc JOIN rifas ri ON ri.id = rc.rifa_id
     WHERE rc.comprobante_base64 IS NOT NULL AND rc.created_at > NOW() - ($2 || ' days')::interval
       AND ${normSql('rc.comprobante_datos')} = $1
       AND ($3::text IS NULL OR rc.comprobante_base64 <> $3)
     GROUP BY rc.rifa_id, ri.nombre, rc.nombre_cliente, rc.telefono, MD5(rc.comprobante_base64)
    UNION ALL
    SELECT 'abono', a.id::text, a.nombre_cliente, a.telefono, ri.nombre,
           ARRAY(SELECT TRIM(x.numero) FROM reservas_cliente x WHERE x.id = ANY(a.reserva_ids) ORDER BY x.numero), a.created_at, a.estado
      FROM reserva_abonos a JOIN rifas ri ON ri.id = a.rifa_id
     WHERE a.comprobante_url IS NOT NULL AND a.created_at > NOW() - ($2 || ' days')::interval
       AND ${normSql('a.comprobante_datos')} = $1
       AND ($4::bigint IS NULL OR a.id <> $4)
       AND ($3::text IS NULL OR a.comprobante_url <> $3)
     ORDER BY fecha DESC
     LIMIT 10`, [ref, String(DIAS_REPETIDOS), fuente, abonoId]);
  return r.rows;
}

// Lee (si hace falta) el comprobante de una reserva o un abono y guarda los datos.
// Devuelve { datos, repetidos, leido }. forzar = volver a leer aunque ya tenga datos.
async function leer({ tipo, id, forzar = false }) {
  await opciones.esquemaListo;
  const esAbono = tipo === 'abono';
  const fila = esAbono
    ? (await pool.query(`SELECT id, comprobante_url AS fuente, comprobante_datos AS datos FROM reserva_abonos WHERE id = $1`, [id])).rows[0]
    : (await pool.query(`SELECT id, rifa_id, telefono, comprobante_base64 AS fuente, comprobante_datos AS datos FROM reservas_cliente WHERE id = $1`, [id])).rows[0];
  if (!fila) { const e = new Error('No se encontró ese pago.'); e.status = 404; throw e; }
  if (!fila.fuente) { const e = new Error('Este pago no tiene comprobante.'); e.status = 400; throw e; }

  let datos = fila.datos || {};
  let leido = false, aviso = null;
  const yaLeido = !!datos.leido_en || datos.es_comprobante !== undefined;   // lo leyó el bot al recibirlo
  if (forzar || !yaLeido) {
    const cfg = await obtenerConfig();
    try {
      const d = await ia.leerComprobante(cfg, await imagenDe(fila.fuente));
      if (d) {
        // Lo que ya se sabía del pago (método, monto pedido…) se conserva; la lectura lo completa
        datos = { ...datos, ...d, leido_en: new Date().toISOString() };
        leido = true;
        if (esAbono) await pool.query(`UPDATE reserva_abonos SET comprobante_datos = $2 WHERE id = $1`, [id, JSON.stringify(datos)]);
        else {
          // Una compra de varios números comparte el mismo comprobante
          await pool.query(
            `UPDATE reservas_cliente SET comprobante_datos = COALESCE(comprobante_datos, '{}'::jsonb) || $3::jsonb
              WHERE rifa_id = $1 AND comprobante_base64 = $2`, [fila.rifa_id, fila.fuente, JSON.stringify({ ...d, leido_en: datos.leido_en })]);
        }
      } else aviso = 'La IA no pudo sacar los datos de esta imagen.';
    } catch (e) {
      aviso = e.message;
    }
  }
  return {
    datos, leido, aviso,
    repetidos: await repetidos(datos.referencia, { fuente: fila.fuente, abonoId: esAbono ? fila.id : null }),
  };
}

// Archivo: todos los comprobantes recibidos en los últimos `dias` (reservas y abonos)
async function archivo({ dias = 30 } = {}) {
  await opciones.esquemaListo;
  const d = String(Math.min(365, Math.max(1, Math.round(Number(dias)) || 30)));
  const r = await pool.query(`
    SELECT 'reserva' AS tipo, MIN(rc.id::text) AS id, rc.rifa_id, ri.nombre AS rifa, rc.nombre_cliente AS nombre, rc.telefono,
           ARRAY_AGG(TRIM(rc.numero) ORDER BY rc.numero) AS numeros, MIN(rc.created_at) AS fecha,
           (ARRAY_AGG(rc.estado))[1] AS estado, (ARRAY_AGG(rc.metodo_pago))[1] AS metodo, (ARRAY_AGG(rc.origen))[1] AS origen,
           (ARRAY_AGG(rc.comprobante_datos))[1] AS datos,
           CASE WHEN MIN(rc.comprobante_base64) ~* '^https?://' THEN MIN(rc.comprobante_base64) END AS url,
           NULL::numeric AS monto
      FROM reservas_cliente rc JOIN rifas ri ON ri.id = rc.rifa_id
     WHERE rc.comprobante_base64 IS NOT NULL AND rc.created_at > NOW() - ($1 || ' days')::interval
     GROUP BY rc.rifa_id, ri.nombre, rc.nombre_cliente, rc.telefono, MD5(rc.comprobante_base64)
    UNION ALL
    SELECT 'abono', a.id::text, a.rifa_id, ri.nombre, a.nombre_cliente, a.telefono,
           ARRAY(SELECT TRIM(x.numero) FROM reservas_cliente x WHERE x.id = ANY(a.reserva_ids) ORDER BY x.numero), a.created_at,
           a.estado, a.metodo_pago, a.origen, a.comprobante_datos, a.comprobante_url, a.monto
      FROM reserva_abonos a JOIN rifas ri ON ri.id = a.rifa_id
     WHERE a.comprobante_url IS NOT NULL AND a.created_at > NOW() - ($1 || ' days')::interval
     ORDER BY fecha DESC
     LIMIT 800`, [d]);
  // Referencias que salen en más de un comprobante
  const veces = new Map();
  for (const x of r.rows) { const k = normalizarRef(x.datos?.referencia); if (k) veces.set(k, (veces.get(k) || 0) + 1); }
  return r.rows.map((x) => ({ ...x, repetido: (veces.get(normalizarRef(x.datos?.referencia)) || 0) > 1 }));
}

module.exports = { leer, archivo, repetidos, normalizarRef, imagenDe };
