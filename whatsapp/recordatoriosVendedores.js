// ============================================================
//  recordatoriosVendedores.js — Mensaje diario a los vendedores
//  Al crear o editar la rifa el dueño elige días y horas. A esa hora,
//  hasta el sorteo, a cada vendedor con teléfono y números libres le llega
//  la publicidad de su ciudad para ese día ("juega el sábado", "mañana" u
//  "hoy") con sus números, y el texto con la tasa y las cuentas.
//  Sale por la cola de envíos (anti-bloqueo).
// ============================================================
const pool = require('../config/db');
const { cloudinary } = require('../config/cloudinary');
const { CARPETAS } = require('../services/imagenes');
const { generarImagenVendedor } = require('../services/imagenVendedor');
const { datosBoleteria } = require('../services/boleteria');
const metodosPago = require('../services/metodosPago');
const opciones = require('../services/rifaOpciones');
const envios = require('./envios');
const { DEMAS, limpiarConfig, limpiarImagenes, momentoDe, imagenDe } = require('../services/vendedoresRifa');

const TZ = 'America/Caracas';
const VENTANA_MIN = 30;   // si el servidor o WhatsApp estuvieron caídos, una hora atrasada ya no sale

const MENSAJE_DEFECTO = '¡Hola {nombre}! {cuando} juega *{rifa}* 🍀\n\n💱 Tasa del día: {tasa}\n\n🏦 Cuentas disponibles:\n{cuentas}\n\n¡Buenas ventas! 🙌';

const tablaLista = pool.query(`
  CREATE TABLE IF NOT EXISTS wa_vendedores_turnos (
    rifa_id    UUID NOT NULL,
    turno      VARCHAR(20) NOT NULL,   -- AAAA-MM-DDTHH:mm (Venezuela)
    enviados   INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (rifa_id, turno)
  )`).catch((e) => console.error('[recordatoriosVendedores] esquema:', e.message));

function ahoraVE(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return {
    fecha: `${p.year}-${p.month}-${p.day}`, hora: `${p.hour}:${p.minute}`,
    dia: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday),
    minutos: Number(p.hour) * 60 + Number(p.minute),
  };
}

// Sus números libres de menor a mayor. Si tiene uno en las dos series, sale dos veces.
function numerosLibres(v, dig) {
  const series = {};
  for (const n of v.numeros_fijos || []) {
    if (n.disponible === false) continue;
    (series[n.serie || 'A'] ||= new Set()).add(String(n.numero).trim().padStart(dig, '0'));
  }
  return Object.values(series).flatMap((s) => [...s]).sort();
}

const digitos = (rifa) => ([2, 4].includes(Number(rifa.cifras)) ? Number(rifa.cifras) : 3);

// Lo que dice el mensaje según la imagen que toca: "Hoy", "Mañana" o "El sábado"
function cuandoJuega(momento, fechaSorteo) {
  if (momento === 'hoy') return 'Hoy';
  if (momento === 'manana') return 'Mañana';
  return `El ${new Date(`${String(fechaSorteo).slice(0, 10)}T12:00:00Z`).toLocaleDateString('es-VE', { weekday: 'long', timeZone: 'UTC' })}`;
}

function textoCuentas(moneda) {
  return metodosPago.metodosDeRifa(moneda)
    .map((titulo) => ({ titulo, ...metodosPago.METODOS_PAGO[titulo] }))
    .filter((m) => m.campos && !m.presencial)
    .map((m) => [`*${m.titulo}*`, ...m.campos.map((c) => `${c.label}: ${c.valor}`)].join('\n'))
    .join('\n\n');
}

function armarTexto({ config, rifa, vendedor, momento, tasas, libres }) {
  const fmt = (n, d = 2) => new Intl.NumberFormat('es-VE', { minimumFractionDigits: d, maximumFractionDigits: d }).format(n);
  const fecha = String(rifa.fecha_sorteo).slice(0, 10);
  const v = {
    nombre: String(vendedor.vendedor_nombre || '').trim().split(/\s+/)[0],
    rifa: rifa.nombre,
    cuando: cuandoJuega(momento, fecha),
    precio: metodosPago.fmtEnMoneda(Number(rifa.precio) || 0, rifa.moneda, 'pesos'),
    fecha: new Date(`${fecha}T12:00:00Z`).toLocaleDateString('es-VE', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }),
    tasa: tasas.bsdUsd ? `Bs. ${fmt(tasas.bsdUsd)} por dólar` : '',
    tasa_pesos: tasas.copUsd ? `${fmt(tasas.copUsd, 0)} pesos por dólar` : '',
    cuentas: textoCuentas(rifa.moneda),
    cantidad: String(libres),
  };
  return (config.mensaje || MENSAJE_DEFECTO).replace(/\{(\w+)\}/g, (todo, k) => (k.toLowerCase() in v ? v[k.toLowerCase()] : todo)).trim();
}

const leerRifa = async (id) => (await pool.query(`
  SELECT id, nombre, imagen_url, cifras, moneda, precio, fecha_sorteo::text AS fecha_sorteo, hora_sorteo, activa,
         COALESCE(imagenes_ubicacion, '[]'::jsonb) AS imagenes_ubicacion,
         COALESCE(recordatorio_vendedores, '{}'::jsonb) AS recordatorio_vendedores
    FROM rifas WHERE id = $1`, [id])).rows[0];

// Sube una sola imagen por rifa y vendedor: la de cada día reemplaza a la anterior
async function subir(buffer, rifaId, vendedorId) {
  const r = await cloudinary.uploader.upload(`data:image/jpeg;base64,${buffer.toString('base64')}`, {
    folder: CARPETAS.numerosVendedor, public_id: `${rifaId}_${vendedorId}`, overwrite: true, invalidate: true,
  });
  return r.secure_url;
}

// Prepara y deja en la cola el envío de un vendedor. Devuelve si quedó en cola.
async function encolarVendedor({ rifa, v, config, hoy, tasas }) {
  const dig = digitos(rifa);
  const numeros = numerosLibres(v, dig);
  if (!numeros.length || !v.telefono) return false;
  const momento = momentoDe(rifa.fecha_sorteo, hoy);
  let nota = armarTexto({ config, rifa, vendedor: v, momento, tasas, libres: numeros.length });
  const flyer = imagenDe(rifa, v.ubicacion, momento);
  let imagenUrl = flyer;
  try {
    imagenUrl = await subir(await generarImagenVendedor({ numeros, dig, imagen: flyer }), rifa.id, v.vendedor_id);
  } catch (e) {
    // Sin la imagen armada sale la publicidad sola, con los números en el texto
    console.error(`⚠️ [Vendedores] Imagen de ${v.vendedor_nombre}: ${e.message}`);
    nota += `\n\nTus números disponibles: ${numeros.join(', ')}`;
  }
  await envios.encolarNumerosVendedor({
    rifaId: rifa.id, rifaNombre: rifa.nombre, vendedorId: v.vendedor_id, nombre: v.vendedor_nombre,
    destino: v.telefono, imagenUrl, nota,
  });
  return true;
}

async function lanzar(rifa, config, hoy) {
  const [bol, tasas] = await Promise.all([datosBoleteria(rifa.id), metodosPago.obtenerTasas()]);
  let n = 0;
  for (const v of bol?.vendedores || []) {
    try { if (await encolarVendedor({ rifa, v, config, hoy, tasas })) n += 1; }
    catch (e) { console.error(`❌ [Vendedores] ${v.vendedor_nombre}: ${e.message}`); }
  }
  return n;
}

// Las rifas a las que les toca ahora. Un turno solo corre una vez, aunque el servidor reinicie.
async function revisar(cuando = new Date()) {
  await opciones.esquemaListo;
  await tablaLista;
  if (!envios.conectado()) return;
  const ve = ahoraVE(cuando);
  const r = await pool.query(`
    SELECT id FROM rifas
     WHERE activa AND fecha_sorteo >= $1::date AND (recordatorio_vendedores->>'activo') = 'true'`, [ve.fecha]);
  for (const { id } of r.rows) {
    const rifa = await leerRifa(id);
    const momento = opciones.momentoSorteo(rifa);
    if (momento && momento.getTime() <= cuando.getTime()) continue;
    const config = limpiarConfig(rifa.recordatorio_vendedores);
    if (!config.dias.includes(ve.dia)) continue;
    for (const hora of config.horas) {
      const [h, m] = hora.split(':').map(Number);
      const atraso = ve.minutos - (h * 60 + m);
      if (atraso < 0 || atraso >= VENTANA_MIN) continue;
      const turno = `${ve.fecha}T${hora}`;
      const nuevo = await pool.query(`INSERT INTO wa_vendedores_turnos (rifa_id, turno) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING turno`, [id, turno]);
      if (!nuevo.rows[0]) continue;
      const n = await lanzar(rifa, config, ve.fecha);
      await pool.query(`UPDATE wa_vendedores_turnos SET enviados = $1 WHERE rifa_id = $2 AND turno = $3`, [n, id, turno]);
      console.log(`📣 [Vendedores] ${rifa.nombre} · ${turno}: ${n} en cola`);
    }
  }
}

// ── Panel ────────────────────────────────────────────────────
async function panel(rifaId) {
  await opciones.esquemaListo;
  await tablaLista;
  const rifa = await leerRifa(rifaId);
  if (!rifa) return null;
  const bol = await datosBoleteria(rifaId);
  const conNumeros = (bol?.vendedores || []).filter((v) => numerosLibres(v, digitos(rifa)).length);
  const turnos = await pool.query(`SELECT turno, enviados FROM wa_vendedores_turnos WHERE rifa_id = $1 ORDER BY turno DESC LIMIT 5`, [rifaId]);
  const jids = conNumeros.filter((v) => v.telefono).map((v) => envios.aJid(v.telefono));
  const escribieron = jids.length ? (await pool.query(`SELECT DISTINCT jid FROM wa_chat_mensajes WHERE jid = ANY($1) AND NOT de_mi`, [jids])).rowCount : 0;
  return {
    ubicaciones: [...new Set(conNumeros.map((v) => v.ubicacion).filter(Boolean))].sort(),
    con_telefono: jids.length,
    sin_telefono: conNumeros.length - jids.length,
    sin_ubicacion: conNumeros.filter((v) => !v.ubicacion).length,
    nuevos: jids.length - escribieron,
    turnos: turnos.rows,
    conectado: envios.conectado(),
  };
}

// El vendedor de ejemplo: el de esa ciudad, o el primero con números.
// momento: la imagen que se quiere ver ('dia', 'manana' u 'hoy'); sin él, la de hoy.
async function ejemplo(rifaId, { config, imagenes_ubicacion: imagenes, ubicacion, momento }) {
  const rifa = await leerRifa(rifaId);
  if (!rifa) throw new Error('Rifa no encontrada');
  const prueba = { ...rifa, imagenes_ubicacion: limpiarImagenes(imagenes) };
  const [bol, tasas] = await Promise.all([datosBoleteria(rifaId), metodosPago.obtenerTasas()]);
  const dig = digitos(rifa);
  const lista = (bol?.vendedores || []).filter((v) => numerosLibres(v, dig).length);
  const igual = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
  const v = lista.find((x) => (ubicacion === DEMAS ? !prueba.imagenes_ubicacion.some((i) => igual(i.ubicacion, x.ubicacion)) : igual(x.ubicacion, ubicacion))) || lista[0];
  if (!v) throw new Error('Esta rifa no tiene vendedores con números asignados todavía');
  const cual = ['dia', 'manana', 'hoy'].includes(momento) ? momento : momentoDe(rifa.fecha_sorteo, ahoraVE().fecha);
  const numeros = numerosLibres(v, dig);
  const jpeg = await generarImagenVendedor({ numeros, dig, imagen: imagenDe(prueba, ubicacion === DEMAS ? null : ubicacion ?? v.ubicacion, cual) });
  return {
    vendedor: v.vendedor_nombre, jpeg, numeros: numeros.length,
    texto: armarTexto({ config: limpiarConfig(config), rifa, vendedor: v, momento: cual, tasas, libres: numeros.length }),
  };
}

// Prueba a un teléfono cualquiera, sin tocar lo de los vendedores
async function enviarPrueba(rifaId, datos, telefono) {
  if (String(telefono || '').replace(/\D/g, '').length < 10) throw new Error('Escribe un teléfono válido');
  if (!envios.conectado()) throw new Error('WhatsApp no está conectado.');
  const e = await ejemplo(rifaId, datos);
  const r = await cloudinary.uploader.upload(`data:image/jpeg;base64,${e.jpeg.toString('base64')}`, {
    folder: CARPETAS.numerosVendedor, public_id: `${rifaId}_prueba`, overwrite: true, invalidate: true,
  });
  await envios.encolarPrueba({ destino: telefono, imagenUrl: r.secure_url, nota: e.texto, rifaNombre: (await leerRifa(rifaId)).nombre });
}

// Al arrancar se comprueba que el servidor pueda armar la imagen
generarImagenVendedor({ numeros: ['001'], dig: 3, imagen: null })
  .then(() => console.log('✅ [Vendedores] Imagen de números lista'))
  .catch((e) => console.error('❌ [Vendedores] No se puede armar la imagen:', e.message));

let corriendo = false;
setInterval(() => {
  if (corriendo) return;
  corriendo = true;
  revisar().catch((e) => console.error('❌ [Vendedores]', e.message)).finally(() => { corriendo = false; });
}, 60000).unref();

module.exports = { revisar, panel, ejemplo, enviarPrueba, numerosLibres, cuandoJuega, armarTexto, ahoraVE, MENSAJE_DEFECTO };
