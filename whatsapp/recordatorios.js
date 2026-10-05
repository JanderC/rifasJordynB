// ============================================================
//  recordatorios.js — Recordatorios de pago de números apartados
//
//  En las rifas con "pago diferido" el cliente aparta sin pagar y tiene
//  hasta unas horas antes del sorteo. El bot le recuerda por WhatsApp:
//    - la víspera del sorteo (10:00 a. m.)
//    - el día del sorteo (9:00 a. m.)
//    - el aviso final, unas horas antes de que venza el plazo
//  Solo se manda el recordatorio que toca (nunca varios seguidos), de día,
//  uno por cliente y rifa, y por la cola anti-bloqueo.
//  Al recordarle, el chat queda listo para que pague por ahí: dice el
//  método, el sistema le manda los datos y él envía la captura.
// ============================================================
const pool = require('../config/db');
const chats = require('../services/waChats');
const reservas = require('../services/reservas');
const opciones = require('../services/rifaOpciones');
const metodosPago = require('../services/metodosPago');
const { obtenerConfig } = require('./botConfig');

let t = null;   // { enviar(jid, texto), conectado() } — lo inyecta bot.js
function init(transporte) { t = transporte; }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const soloDigitos = (x) => String(x || '').replace(/\D/g, '');

function horaVE() {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Caracas' }));
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
const deDia = () => { const h = horaVE(); return h >= '08:00' && h < '21:30'; };

function jidDe(telefono) {
  let n = soloDigitos(telefono);
  if (n.startsWith('0')) n = '58' + n.slice(1);
  return n.length >= 10 ? `${n}@s.whatsapp.net` : null;
}

// Estado de compra del chat para un grupo de apartados (el mismo que deja preparar_compra):
// con esto, cuando el cliente manda la captura, el sistema la registra sola.
function estadoDeApartado(g) {
  return {
    paso: 'esperando_comprobante', diferido: true,
    rifa_id: g.rifa.id, rifa_nombre: g.rifa.nombre, numeros: g.numeros,
    nombre: g.nombre, cedula: g.cedula || null, total: g.total, metodo: null,
    reservas: g.ids, apartado_hasta: new Date(g.limite).getTime(), desde: Date.now(),
  };
}

// Deja el chat apuntando a los apartados sin pagar del cliente (si no tiene otra compra en curso).
// Devuelve el estado puesto o null.
async function vincularApartados(jid, chat) {
  if (chat?.estado_compra?.paso && !chat.estado_compra.diferido) return null;
  const grupos = await reservas.apartadosDe({ jid, telefono: chat?.telefono || soloDigitos(String(jid).split('@')[0]) });
  if (!grupos.length) {
    // Tenía un apartado diferido que ya no existe (se pagó por la página o lo liberó el dueño)
    if (chat?.estado_compra?.diferido) { await chats.actualizarChat(jid, { estado_compra: null }); chat.estado_compra = null; }
    return null;
  }
  const g = grupos.sort((a, b) => a.limite - b.limite)[0];   // el que vence primero
  const previo = chat?.estado_compra;
  const mismo = previo?.diferido && previo.rifa_id === g.rifa.id && (previo.reservas || []).join() === g.ids.join();
  const estado = mismo ? previo : estadoDeApartado(g);
  if (!mismo) {
    await chats.actualizarChat(jid, { estado_compra: estado });
    await pool.query(`UPDATE reservas_cliente SET wa_jid = $1 WHERE id = ANY($2) AND wa_jid IS DISTINCT FROM $1`, [jid, g.ids]);
  }
  if (chat) chat.estado_compra = estado;
  return estado;
}

// ── Qué recordatorio toca ────────────────────────────────────
// Devuelve { etapa, marcar: [etapas ya vencidas que se dan por hechas] } o null
function etapaQueToca({ rifa, limite, creado, enviados, finalHoras }) {
  const ahora = Date.now();
  const sorteo = opciones.momentoSorteo(rifa);
  if (!sorteo || limite.getTime() - ahora < 20 * 60000) return null;
  const dia = String(rifa.fecha_sorteo).slice(0, 10);
  const vispera = new Date(new Date(`${dia}T10:00:00-04:00`).getTime() - 24 * 3600000);
  const etapas = [
    ['vispera', vispera.getTime()],
    ['dia', new Date(`${dia}T09:00:00-04:00`).getTime()],
    ['final', limite.getTime() - finalHoras * 3600000],
  ]
    // Las que ya pasaron cuando apartó no aplican (apartó hoy mismo: solo el aviso final)
    .filter(([, at]) => at <= ahora && at > creado.getTime() + 60 * 60000);
  const pendientes = etapas.filter(([e]) => !enviados.includes(e));
  if (!pendientes.length) return null;
  return { etapa: pendientes[pendientes.length - 1][0], marcar: etapas.map(([e]) => e) };
}

function duracion(ms) {
  const min = Math.max(1, Math.round(ms / 60000));
  if (min < 60) return `${min} minutos`;
  const h = Math.floor(min / 60), m = min % 60;
  return `${h} ${h === 1 ? 'hora' : 'horas'}${m >= 10 ? ` y ${m} minutos` : ''}`;
}

function textoRecordatorio(etapa, g, cfg) {
  const nombre = String(g.nombre || '').trim().split(/\s+/)[0] || '';
  const varios = g.numeros.length > 1;
  const nums = `${varios ? 'los números' : 'el número'} *${g.numeros.join(', ')}*`;
  const total = `${Math.round(g.total).toLocaleString('es-CO')} ${cfg.moneda || 'pesos'}`;
  const limite = opciones.fmtLimite(g.limite);
  const metodos = Object.keys(metodosPago.METODOS_PAGO).filter((m) => !metodosPago.METODOS_PAGO[m].presencial);
  const comoPagar = `¿Con qué vas a pagar? ${metodos.length ? `Tenemos ${metodos.join(', ')}. ` : ''}Dime y te paso los datos 👇`;
  const hora = g.limite.toLocaleTimeString('es-VE', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/Caracas' });
  if (etapa === 'final') {
    return `⏰ ${nombre ? `${nombre}, te` : 'Te'} quedan *${duracion(g.limite.getTime() - Date.now())}* para pagar ${nums} de *${g.rifa.nombre}*.\n\n` +
      `Total: *${total}*. Después de las ${hora} ${varios ? 'se liberan y los puede tomar' : 'se libera y lo puede tomar'} otra persona 🙏\n\n${comoPagar}`;
  }
  const cuando = etapa === 'vispera' ? 'mañana es el sorteo' : '¡hoy es el sorteo!';
  return `Hola${nombre ? ` ${nombre}` : ''} 👋 Te recuerdo que tienes ${varios ? 'apartados' : 'apartado'} ${nums} en *${g.rifa.nombre}* y ${cuando} 🎉\n\n` +
    `Total a pagar: *${total}*. Tienes hasta el ${limite}.\n\n${comoPagar}`;
}

// ── Revisión periódica ───────────────────────────────────────
const fallos = new Map();   // clave → cuándo reintentar (si no se pudo enviar)

async function revisar() {
  await opciones.esquemaListo;
  const cfg = await obtenerConfig();
  const rc = cfg.recordatorios_apartado || {};
  if (!cfg.activo || rc.activo === false || !t?.conectado() || !deDia()) return;
  const finalHoras = Math.min(12, Math.max(1, Number(rc.final_horas) || 2));

  const r = await pool.query(`
    SELECT rifa_id,
           COALESCE(NULLIF(RIGHT(regexp_replace(COALESCE(telefono, ''), '\\D', '', 'g'), 10), ''), wa_jid) AS persona,
           ARRAY_AGG(id ORDER BY created_at) AS ids, ARRAY_AGG(TRIM(numero) ORDER BY created_at) AS numeros,
           (ARRAY_AGG(nombre_cliente ORDER BY created_at))[1] AS nombre, (ARRAY_AGG(cedula ORDER BY created_at))[1] AS cedula,
           (ARRAY_AGG(telefono ORDER BY created_at))[1] AS telefono, MAX(wa_jid) AS wa_jid,
           MIN(apartado_hasta) AS limite, MIN(created_at) AS creado,
           (SELECT COALESCE(JSONB_AGG(DISTINCT e), '[]'::jsonb) FROM reservas_cliente x, JSONB_ARRAY_ELEMENTS(x.recordatorios) e
             WHERE x.id = ANY(ARRAY_AGG(rc.id))) AS enviados
      FROM reservas_cliente rc
     WHERE estado = 'apartado' AND pago_diferido AND apartado_hasta > NOW()
     GROUP BY rifa_id, persona
     ORDER BY MIN(apartado_hasta)
     LIMIT 200`);

  let enviadosAhora = 0;
  for (const x of r.rows) {
    if (enviadosAhora >= 12) break;   // el resto, en la próxima revisión
    const rifa = await reservas.infoRifa(pool, x.rifa_id);
    if (!rifa) continue;
    const limite = new Date(x.limite);
    const toca = etapaQueToca({ rifa, limite, creado: new Date(x.creado), enviados: x.enviados || [], finalHoras });
    if (!toca) continue;
    const jid = x.wa_jid || jidDe(x.telefono);
    if (!jid) continue;
    const clave = `${x.rifa_id}|${x.persona}|${toca.etapa}`;
    if ((fallos.get(clave) || 0) > Date.now()) continue;

    const g = {
      rifa, ids: x.ids, numeros: x.numeros, nombre: x.nombre, cedula: x.cedula, telefono: x.telefono, limite,
      total: reservas.calcularPrecioReal(x.numeros.length, rifa.ofertas, Number(rifa.precio)),
    };
    try {
      await t.enviar(jid, textoRecordatorio(toca.etapa, g, cfg));
      await pool.query(
        `UPDATE reservas_cliente
            SET recordatorios = (SELECT COALESCE(JSONB_AGG(DISTINCT e), '[]'::jsonb) FROM JSONB_ARRAY_ELEMENTS(recordatorios || $2::jsonb) e),
                wa_jid = COALESCE(wa_jid, $3)
          WHERE id = ANY($1)`, [x.ids, JSON.stringify(toca.marcar), jid]);
      // El chat queda listo para que pague por ahí
      const chat = await chats.obtenerChat(jid);
      if (chat && (!chat.estado_compra?.paso || chat.estado_compra.diferido)) {
        await chats.actualizarChat(jid, { estado_compra: estadoDeApartado(g) });
      }
      await chats.guardarMensaje({ jid, deMi: true, autor: 'sistema', tipo: 'texto', estado: null,
        texto: `🔔 Recordatorio de pago (${toca.etapa === 'final' ? 'aviso final' : toca.etapa === 'dia' ? 'día del sorteo' : 'víspera'}) · ${rifa.nombre} · números ${x.numeros.join(', ')}` });
      enviadosAhora++;
      await sleep(20000 + Math.random() * 20000);   // de a poco (anti-bloqueo)
    } catch (e) {
      console.error(`❌ [Recordatorios] ${jid}:`, e.message);
      fallos.set(clave, Date.now() + 60 * 60000);   // reintentar en una hora
      // Tope diario de chats nuevos o de mensajes: no seguir intentando en esta vuelta
      if (/Límite/i.test(e.message)) break;
    }
  }
  if (fallos.size > 2000) fallos.clear();
}

let revisando = false;
setInterval(() => {
  if (revisando) return;
  revisando = true;
  revisar().catch((e) => console.error('❌ [Recordatorios]', e.message)).finally(() => { revisando = false; });
}, 10 * 60000).unref();

module.exports = { init, revisar, vincularApartados, estadoDeApartado, etapaQueToca, textoRecordatorio };
