// ============================================================
//  recordatoriosVendedores.js — Mensaje diario a los vendedores
//  Al crear o editar la rifa el dueño elige días y horas. A esa hora,
//  hasta el sorteo, a cada vendedor con teléfono y números libres le llega
//  la publicidad de su ciudad para ese día ("juega el sábado", "mañana" u
//  "hoy"), tal cual (sin números: esos se mandan desde "Números por
//  vendedor"), con el texto de la tasa y las cuentas.
//  Sale por la cola de envíos (anti-bloqueo).
// ============================================================
const pool = require('../config/db');
const { datosBoleteria } = require('../services/boleteria');
const metodosPago = require('../services/metodosPago');
const opciones = require('../services/rifaOpciones');
const envios = require('./envios');
const tasasRuta = require('../routes/tasas');
const { DEMAS, limpiarConfig, limpiarImagenes, momentoDe, imagenDe, mismaCiudad } = require('../services/vendedoresRifa');

const TZ = 'America/Caracas';
const VENTANA_MIN = 30;   // si el servidor o WhatsApp estuvieron caídos, una hora atrasada ya no sale

// La plantilla de Jordyn: con ella arranca toda rifa nueva
const MENSAJE_DEFECTO = [
  '‼️JUEGA {CUANDO}‼️',
  '💎PRECIO DEL TICKET: {precio}',
  '',
  '💱TASAS DE CAMBIO:',
  'BS: {tasa}',
  'DOLAR POR ZELLE: {tasa_pesos}',
  'DOLAR EN EFECTIVO:{tasa_efectivo}',
  '',
  '🏦 Cuentas disponibles:',
  '{cuentas}',
  '',
  'LES DESEAMOS:',
  '🙌EXITOS, BENDICIONES Y SUERTE🙌',
].join('\n');
// Plantillas anteriores del sistema: una rifa que quedó con una de estas usa la de Jordyn
const MENSAJES_VIEJOS = [
  '¡Hola {nombre}! {cuando} juega *{rifa}* 🍀\n\n💱 Tasa del día: {tasa}\n\n🏦 Cuentas disponibles:\n{cuentas}\n\n¡Buenas ventas! 🙌',
  '¡Hola {nombre}! 👋\n{cuando} juega *{rifa}* 🍀\n\n💱 Tasa del día: *{tasa}*\n🏛️ Dólar BCV: {tasa_bcv}\n\n🏦 Cuentas disponibles:\n{cuentas}\n\n¡Buenas ventas! 🙌',
];
const plano = (x) => String(x || '').replace(/\r/g, '').trim();
const mensajeDe = (config) => (!plano(config?.mensaje) || MENSAJES_VIEJOS.map(plano).includes(plano(config.mensaje)) ? MENSAJE_DEFECTO : config.mensaje);

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

// Todas las cuentas activas (también Nequi y Bancolombia en las rifas en dólares):
// el vendedor ve dónde puede pagar su cliente
function textoCuentas() {
  return Object.keys(metodosPago.METODOS_PAGO)
    .map((titulo) => ({ titulo, ...metodosPago.METODOS_PAGO[titulo] }))
    .filter((m) => m.campos && !m.presencial)
    .map((m) => [`*${m.titulo}*`, ...m.campos.map((c) => `${c.label}: ${c.valor}`)].join('\n'))
    .join('\n\n');
}

// Las tasas que van en el mensaje. Si la del BCV no responde, esa línea no sale.
async function tasasDelDia() {
  const [t, ref] = await Promise.all([
    metodosPago.obtenerTasas(),
    tasasRuta.referencias().catch(() => ({})),
  ]);
  // Dólar en efectivo: el dólar de Colombia automático; si no responde, la tasa de pesos de los bolívares
  return { ...t, bcv: ref?.bcv?.valor || 0, efectivo: ref?.oficial?.valor || t.copUsdBs || 0 };
}

function armarTexto({ config, rifa, vendedor, momento, tasas, libres }) {
  const fmt = (n, d = 2) => new Intl.NumberFormat('es-VE', { minimumFractionDigits: d, maximumFractionDigits: d }).format(n);
  // "Se está recibiendo a 3,19": pesos por cada bolívar, con las mismas tasas con que se cobra el Pago Móvil
  const pesosPorBs = tasas.bsdUsd ? (tasas.copUsdBs || tasas.copUsd) / tasas.bsdUsd : 0;
  const fecha = String(rifa.fecha_sorteo).slice(0, 10);
  const v = {
    nombre: String(vendedor.vendedor_nombre || '').trim().split(/\s+/)[0],
    rifa: rifa.nombre,
    cuando: cuandoJuega(momento, fecha),
    precio: metodosPago.fmtEnMoneda(Number(rifa.precio) || 0, rifa.moneda, 'pesos'),
    fecha: new Date(`${fecha}T12:00:00Z`).toLocaleDateString('es-VE', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }),
    tasa: pesosPorBs ? fmt(pesosPorBs) : '',
    tasa_bcv: tasas.bcv ? `Bs. ${fmt(tasas.bcv)}` : '',
    tasa_dolar: tasas.bsdUsd ? `Bs. ${fmt(tasas.bsdUsd)} por dólar` : '',
    tasa_pesos: tasas.copUsd ? `${fmt(tasas.copUsd, 0)} pesos` : '',   // el dólar por Zelle (la que pone el dueño)
    tasa_efectivo: tasas.efectivo ? `${fmt(tasas.efectivo, 0)} pesos` : '',
    cuentas: textoCuentas(),
    cantidad: String(libres),
  };
  // Sale como se escribió la variable: {CUANDO} → "EL SÁBADO", {Cuando} → "El sábado"
  const comoSeEscribio = (k, val) => {
    if (k === k.toUpperCase()) return val.toLocaleUpperCase('es');
    if (k[0] === k[0].toUpperCase()) return val.charAt(0).toLocaleUpperCase('es') + val.slice(1);
    return val;
  };
  const poner = (linea) => linea.replace(/\{(\w+)\}/g, (todo, k) => (k.toLowerCase() in v ? comoSeEscribio(k, v[k.toLowerCase()]) : todo));
  // Una línea cuyas variables quedaron todas vacías (p. ej. el BCV no respondió) no sale
  return mensajeDe(config).split('\n')
    .filter((linea) => {
      const vars = [...linea.matchAll(/\{(\w+)\}/g)].map((m) => m[1].toLowerCase()).filter((k) => k in v);
      return !vars.length || vars.some((k) => v[k]);
    })
    .map(poner).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

const leerRifa = async (id) => (await pool.query(`
  SELECT id, nombre, imagen_url, cifras, moneda, precio, fecha_sorteo::text AS fecha_sorteo, hora_sorteo, activa,
         COALESCE(imagenes_ubicacion, '[]'::jsonb) AS imagenes_ubicacion,
         COALESCE(recordatorio_vendedores, '{}'::jsonb) AS recordatorio_vendedores
    FROM rifas WHERE id = $1`, [id])).rows[0];

// Deja en la cola la publicidad de su ciudad con el mensaje. Devuelve si quedó en cola.
async function encolarVendedor({ rifa, v, config, hoy, tasas }) {
  // Va sin números: le llega a todo vendedor de la rifa con teléfono, tenga o no números
  if (!v.telefono) return false;
  const numeros = numerosLibres(v, digitos(rifa));
  const momento = momentoDe(rifa.fecha_sorteo, hoy);
  await envios.encolarPublicidadVendedor({
    rifaId: rifa.id, rifaNombre: rifa.nombre, nombre: v.vendedor_nombre, destino: v.telefono,
    imagenUrl: imagenDe(rifa, v.ubicacion, momento),
    nota: armarTexto({ config, rifa, vendedor: v, momento, tasas, libres: numeros.length }),
  });
  return true;
}

async function lanzar(rifa, config, hoy) {
  const [bol, tasas] = await Promise.all([datosBoleteria(rifa.id), tasasDelDia()]);
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
    // Sin días marcados = todos los días
    if (config.dias.length && !config.dias.includes(ve.dia)) continue;
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
  const conNumeros = bol?.vendedores || [];   // todos los de la rifa: la publicidad va sin números
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
  const [bol, tasas] = await Promise.all([datosBoleteria(rifaId), tasasDelDia()]);
  const dig = digitos(rifa);
  const lista = bol?.vendedores || [];
  const v = lista.find((x) => (ubicacion === DEMAS ? !prueba.imagenes_ubicacion.some((i) => mismaCiudad(i.ubicacion, x.ubicacion)) : mismaCiudad(x.ubicacion, ubicacion)))
    || lista[0] || { vendedor_nombre: 'Pedro', ubicacion: null, numeros_fijos: [] };
  const cual = ['dia', 'manana', 'hoy'].includes(momento) ? momento : momentoDe(rifa.fecha_sorteo, ahoraVE().fecha);
  const libres = numerosLibres(v, dig).length;
  return {
    vendedor: v.vendedor_nombre,
    imagen: imagenDe(prueba, ubicacion === DEMAS ? null : ubicacion ?? v.ubicacion, cual),
    texto: armarTexto({ config: limpiarConfig(config), rifa, vendedor: v, momento: cual, tasas, libres }),
  };
}

// Prueba a un teléfono cualquiera, sin tocar lo de los vendedores
async function enviarPrueba(rifaId, datos, telefono) {
  if (String(telefono || '').replace(/\D/g, '').length < 10) throw new Error('Escribe un teléfono válido');
  if (!envios.conectado()) throw new Error('WhatsApp no está conectado.');
  const e = await ejemplo(rifaId, datos);
  await envios.encolarPrueba({ destino: telefono, imagenUrl: e.imagen, nota: e.texto, rifaNombre: (await leerRifa(rifaId)).nombre });
}

// Lo último que el dueño configuró en una rifa: así la próxima arranca igual
async function ultimaConfig() {
  await opciones.esquemaListo;
  const r = await pool.query(`
    SELECT recordatorio_vendedores AS c FROM rifas
     WHERE COALESCE(recordatorio_vendedores->>'mensaje', '') <> '' OR jsonb_array_length(COALESCE(recordatorio_vendedores->'horas', '[]'::jsonb)) > 0
     ORDER BY created_at DESC LIMIT 1`);
  if (!r.rows[0]) return null;
  const c = limpiarConfig(r.rows[0].c);
  return { ...c, mensaje: mensajeDe(c) };
}

let corriendo = false;
setInterval(() => {
  if (corriendo) return;
  corriendo = true;
  revisar().catch((e) => console.error('❌ [Vendedores]', e.message)).finally(() => { corriendo = false; });
}, 60000).unref();

module.exports = { MENSAJES_VIEJOS, revisar, panel, ejemplo, enviarPrueba, ultimaConfig, numerosLibres, cuandoJuega, armarTexto, ahoraVE, MENSAJE_DEFECTO };
