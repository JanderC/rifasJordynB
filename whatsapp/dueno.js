// ============================================================
//  dueno.js — El bot como "asistente" del dueño por WhatsApp
//
//  - Cuando un cliente necesita una persona, le escribe al dueño en tono
//    natural: quién es, qué quiere y qué le escribió.
//  - El dueño responde ahí mismo:
//      1            → lo atiende él (recibe el WhatsApp del cliente)
//      2            → que lo siga atendiendo el bot
//      cualquier texto → el bot se lo dice al cliente con sus palabras
//      cola         → lista de quienes esperan; luego el número para ver uno
//      siguiente    → el próximo de la cola
//      listo        → marcar como atendido
//  - Cada cierto tiempo le recuerda cuántos esperan y le deja elegir:
//      1 → el bot los responde poco a poco · 2 → uno por uno · 3 → el panel
//  - Respeta las horas de silencio (de noche no molesta).
// ============================================================
const chats = require('../services/waChats');
const { obtenerConfig } = require('./botConfig');

let deps = null;   // { enviarBloque, atenderConBot, conectado } — los inyecta bot.js
function init(d) { deps = d; }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const elegir = (arr) => arr[Math.floor(Math.random() * arr.length)];
const soloDigitos = (t) => String(t || '').replace(/\D/g, '');
const normalizar = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

// ── Quién es el dueño ────────────────────────────────────────
function telefonoDueno(cfg) {
  let t = soloDigitos(cfg.dueno?.telefono);
  if (t.startsWith('0')) t = '58' + t.slice(1);
  return t || null;
}
function jidDueno(cfg) {
  const t = telefonoDueno(cfg);
  return t ? `${t}@s.whatsapp.net` : null;
}
function esDueno(jid, cfg) {
  const t = telefonoDueno(cfg);
  return !!t && String(jid || '').split('@')[0].split(':')[0] === t;
}

function enSilencio(cfg) {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Caracas' }));
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const { silencio_desde: desde, silencio_hasta: hasta } = cfg.dueno || {};
  if (!desde || !hasta) return false;
  return desde > hasta ? (hhmm >= desde || hhmm < hasta) : (hhmm >= desde && hhmm < hasta);
}

// ── Formato ──────────────────────────────────────────────────
const nombreDe = (c) => c?.nombre_guardado || c?.nombre || (c?.telefono ? `+${c.telefono}` : 'un cliente');
const primerNombre = (c) => nombreDe(c).split(' ')[0];
function telefonoBonito(t) {
  const d = soloDigitos(t);
  if (d.startsWith('58') && d.length === 12) return `0${d.slice(2, 5)}-${d.slice(5, 8)}-${d.slice(8)}`;
  return d ? `+${d}` : '';
}
function haceCuanto(fecha) {
  if (!fecha) return '';
  const min = Math.round((Date.now() - new Date(fecha).getTime()) / 60000);
  if (min < 1) return 'ahorita';
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  return h < 24 ? `hace ${h} h` : `hace ${Math.round(h / 24)} d`;
}
const recortar = (t, n = 160) => (t && t.length > n ? t.slice(0, n - 1) + '…' : t);
// "Quiere pagar en efectivo" → "quiere pagar en efectivo"
const enMinuscula = (t) => (t ? t.charAt(0).toLowerCase() + t.slice(1).replace(/\.$/, '') : '');

// ── Estado de la conversación con el dueño ───────────────────
// foco: { tipo: 'chat', jid } | { tipo: 'lista', jids } | { tipo: 'resumen', jids }
let foco = null;
const avisados = new Map();   // jid → timestamp del último aviso (no repetir)
let ultimoResumen = { at: 0, firma: '' };

async function enviarAlDueno(texto) {
  const cfg = await obtenerConfig();
  const jid = jidDueno(cfg);
  if (!jid || !deps?.conectado()) return false;
  await deps.enviarBloque(jid, texto);
  return true;
}

async function cola() {
  const cfg = await obtenerConfig();
  return chats.colaAtencion(telefonoDueno(cfg));
}

// ── Aviso inmediato: un cliente necesita una persona ─────────
async function avisarAtencion(jid, motivo) {
  const cfg = await obtenerConfig();
  if (!cfg.dueno?.notificar || !jidDueno(cfg) || esDueno(jid, cfg)) return;
  const t = avisados.get(jid);
  if (t && Date.now() - t < 20 * 60000) return;       // ya se le avisó de este cliente
  if (enSilencio(cfg)) return;                        // de noche no: va en el resumen
  const chat = await chats.obtenerChat(jid);
  if (!chat) return;
  avisados.set(jid, Date.now());

  const [ultimo] = (await cola()).filter((c) => c.jid === jid).map((c) => c.ultimo_del_cliente);
  const nombre = cfg.dueno.nombre || 'jefe';
  const intro = elegir([
    `${nombre}, me estoy complicando con uno 😅`,
    `${nombre}, necesito una mano con un cliente 🙋`,
    `Epa ${nombre}, tengo uno que no sé bien cómo responder 🤔`,
  ]);
  const tel = telefonoBonito(chat.telefono);
  const texto =
    `${intro}\n\n` +
    `*${nombreDe(chat)}*${tel ? ` (${tel})` : ''} — se me complica responderle porque ${enMinuscula(motivo) || 'necesita que lo atienda una persona'}.` +
    (ultimo ? `\nMe escribió: "${recortar(ultimo)}"` : '') +
    `\n\n¿Qué hago? Contéstame por aquí:\n` +
    `*1* → lo atiendes tú${chat.telefono ? ` (wa.me/${chat.telefono})` : ''}\n` +
    `*2* → sigo yo con ${primerNombre(chat)}\n` +
    `o escríbeme qué le digo y yo se lo paso 😉`;
  if (await enviarAlDueno(texto)) foco = { tipo: 'chat', jid };
}

// ── Resumen periódico de pendientes ──────────────────────────
function lineaDe(c, i) {
  const motivo = c.necesita_humano && c.motivo_humano ? enMinuscula(c.motivo_humano) : `escribió "${recortar(c.ultimo_del_cliente || c.ultimo_mensaje, 60)}"`;
  return `${i + 1}. *${nombreDe(c)}* — ${motivo} (${haceCuanto(c.esperando_desde || c.ultimo_at)})`;
}

async function enviarResumen({ forzar = false } = {}) {
  const cfg = await obtenerConfig();
  const lista = await cola();
  if (!lista.length) {
    if (forzar) await enviarAlDueno(elegir(['Todo al día por aquí 🙌 no hay nadie esperando.', 'Tranquilo, no hay clientes esperando ahorita 👌']));
    return;
  }
  const n = lista.length;
  const texto =
    `${cfg.dueno?.nombre || 'Jefe'}, tienes *${n}* ${n === 1 ? 'chat esperando' : 'chats esperando'} respuesta en el sistema 📥\n\n` +
    lista.slice(0, 8).map(lineaDe).join('\n') + (n > 8 ? `\n…y ${n - 8} más` : '') +
    `\n\n¿Cómo le hacemos?\n` +
    `*1* → los respondo yo poco a poco\n` +
    `*2* → te los paso uno por uno\n` +
    `*3* → entras tú al panel${cfg.dueno?.panel_url ? `: ${cfg.dueno.panel_url}` : ''}`;
  if (await enviarAlDueno(texto)) {
    foco = { tipo: 'resumen', jids: lista.map((c) => c.jid) };
    ultimoResumen = { at: Date.now(), firma: lista.map((c) => c.jid).sort().join(',') };
  }
}

async function revisarResumen() {
  const cfg = await obtenerConfig();
  const cada = Number(cfg.dueno?.resumen_cada_min) || 0;
  if (!cfg.dueno?.notificar || !cada || !jidDueno(cfg) || enSilencio(cfg) || !deps?.conectado()) return;
  if (Date.now() - ultimoResumen.at < cada * 60000) return;
  const lista = await cola();
  if (!lista.length) return;
  const firma = lista.map((c) => c.jid).sort().join(',');
  // Si la cola no cambió, no insistir más de cada 3 h
  if (firma === ultimoResumen.firma && Date.now() - ultimoResumen.at < 3 * 3600000) return;
  await enviarResumen();
}
setInterval(() => revisarResumen().catch((e) => console.error('❌ [Dueño] resumen:', e.message)), 5 * 60000).unref();

// ── Detalle de un chat (cuando lo elige de la lista) ─────────
async function enviarDetalle(jid, prefijo = '') {
  const lista = await cola();
  const c = lista.find((x) => x.jid === jid) || await chats.obtenerChat(jid);
  if (!c) return enviarAlDueno('Ese chat ya no está en la cola 👍');
  foco = { tipo: 'chat', jid };
  const tel = telefonoBonito(c.telefono);
  return enviarAlDueno(
    `${prefijo}*${nombreDe(c)}*${tel ? ` (${tel})` : ''}` +
    (c.necesita_humano && c.motivo_humano ? `\n${c.motivo_humano}` : '') +
    (c.ultimo_del_cliente ? `\nÚltimo mensaje: "${recortar(c.ultimo_del_cliente)}"` : '') +
    `\n\n*1* → lo atiendes tú${c.telefono ? ` (wa.me/${c.telefono})` : ''}\n*2* → lo atiendo yo\no dime qué le respondo 👇`);
}

async function siguiente(anteriorJid) {
  const lista = (await cola()).filter((c) => c.jid !== anteriorJid);
  if (!lista.length) { foco = null; return enviarAlDueno(elegir(['Listo, no queda nadie esperando 🙌', 'Ya está, cola limpia 🎉'])); }
  return enviarDetalle(lista[0].jid, `Te quedan ${lista.length}. El próximo:\n\n`);
}

// ── Mensajes del dueño ───────────────────────────────────────
async function alRecibirDueno(texto) {
  const t = normalizar(texto);
  if (!t) return;
  const f = foco;

  if (/^(cola|pendientes?|mensajes|que hay|lista|quien espera)\b/.test(t)) return enviarResumen({ forzar: true });
  if (/^(siguiente|proximo|otro)\b/.test(t)) return siguiente(f?.tipo === 'chat' ? f.jid : null);
  if (/^(ayuda|menu|comandos|\?)$/.test(t)) {
    return enviarAlDueno('Así me puedes mandar 👇\n*cola* → quién está esperando\n*siguiente* → el próximo\n*1* → lo atiendes tú · *2* → lo atiendo yo\n*listo* → ya lo atendiste\no escríbeme qué le digo al cliente y se lo paso.');
  }

  // Respuesta al resumen
  if (f?.tipo === 'resumen') {
    if (/^1\b|^(respondelos|atiendelos|hazlo tu|dale tu)/.test(t)) {
      await enviarAlDueno(`Dale, me encargo de los ${f.jids.length} poco a poco 💪 te aviso si alguno se me complica.`);
      foco = null;
      for (const jid of f.jids) {
        avisados.set(jid, Date.now());   // no volver a avisar de los mismos enseguida
        await deps.atenderConBot(jid, null).catch((e) => console.error('❌ [Dueño] atender:', e.message));
        await sleep(20000 + Math.random() * 20000);   // de a poco (anti-bloqueo)
      }
      return;
    }
    if (/^2\b|^(uno por uno|pasamelos)/.test(t)) return siguiente(null);
    if (/^3\b/.test(t)) {
      const cfg = await obtenerConfig();
      foco = null;
      return enviarAlDueno(`Aquí está el panel 👉 ${cfg.dueno?.panel_url || ''}\nAhí los ves todos con sus mensajes.`);
    }
  }

  // Eligió un número de la lista
  if (f?.tipo === 'resumen' || f?.tipo === 'lista') {
    const n = Number(t.replace(/^#/, ''));
    if (Number.isInteger(n) && n >= 1 && n <= f.jids.length) return enviarDetalle(f.jids[n - 1]);
  }

  // Hablando de un cliente en particular
  if (f?.tipo === 'chat') {
    const chat = await chats.obtenerChat(f.jid);
    const quien = primerNombre(chat);
    if (/^1\b|^(yo lo atiendo|lo atiendo yo|dejamelo|yo le escribo|yo me encargo)/.test(t)) {
      await chats.actualizarChat(f.jid, { bot_activo: false, necesita_humano: false, motivo_humano: null });
      foco = null;
      return enviarAlDueno(`Perfecto, ${quien} es todo tuyo 👍${chat?.telefono ? `\nwa.me/${chat.telefono}` : ''}\nYo no le respondo más hasta que me lo devuelvas desde el panel.`);
    }
    if (/^2\b|^(atiendelo tu|sigue tu|siguelo|respondele tu|encargate)/.test(t)) {
      avisados.set(f.jid, Date.now());
      await enviarAlDueno(elegir([`Va, sigo yo con ${quien} 👌`, `Listo, me encargo de ${quien} 💪`]));
      await deps.atenderConBot(f.jid, null);
      return siguienteSiHay(f.jid);
    }
    if (/^(listo|ya|ya esta|atendido|ya lo atendi|ok listo)$/.test(t)) {
      await chats.actualizarChat(f.jid, { necesita_humano: false, motivo_humano: null });
      await enviarAlDueno(elegir(['Anotado ✅', 'Perfecto, lo marco como atendido ✅']));
      return siguienteSiHay(f.jid);
    }
    // Cualquier otro texto: instrucción de qué responderle al cliente
    avisados.set(f.jid, Date.now());
    const enviado = await deps.atenderConBot(f.jid, texto);
    await enviarAlDueno(enviado?.length
      ? `Listo, le escribí a ${quien}:\n"${recortar(enviado.join(' '), 300)}"`
      : `Listo, ya le respondí a ${quien} 👍`);
    return siguienteSiHay(f.jid);
  }

  // Sin contexto
  const lista = await cola();
  if (!lista.length) return enviarAlDueno(elegir(['Todo al día por aquí 🙌 no hay nadie esperando.', 'Por ahora nadie esperando 👌 cuando alguien me necesite te aviso.']));
  return enviarResumen({ forzar: true });
}

async function siguienteSiHay(jidActual) {
  const quedan = (await cola()).filter((c) => c.jid !== jidActual);
  if (!quedan.length) { foco = null; return; }
  foco = { tipo: 'lista', jids: quedan.map((c) => c.jid) };
  await sleep(1500);
  return enviarAlDueno(`Te ${quedan.length === 1 ? 'queda 1' : `quedan ${quedan.length}`} esperando. Escribe *siguiente* para verlo${quedan.length === 1 ? '' : 's'} o *cola* para la lista.`);
}

// Mensaje de prueba desde el panel
async function probar() {
  const cfg = await obtenerConfig({ fresca: true });
  if (!jidDueno(cfg)) throw new Error('Configura primero el teléfono del dueño.');
  if (!deps?.conectado()) throw new Error('WhatsApp no está conectado.');
  const n = (await cola()).length;
  await deps.enviarBloque(jidDueno(cfg),
    `Hola ${cfg.dueno?.nombre || ''} 👋 soy el bot de ventas. Desde aquí te voy a avisar cuando un cliente te necesite, y me puedes responder directo.\n\n` +
    (n ? `Ahorita tienes *${n}* esperando. Escríbeme *cola* para verlos.` : 'Ahorita no hay nadie esperando 🙌') +
    '\n\nEscribe *ayuda* cuando quieras ver lo que me puedes pedir.');
  return { ok: true, pendientes: n };
}

module.exports = { init, esDueno, jidDueno, telefonoDueno, avisarAtencion, alRecibirDueno, enviarResumen, probar };
