/**
 * whatsappService.js — Conexión con WhatsApp (Baileys)
 *
 *  - Conexión estable: reconexión sin límite, sin borrar la sesión.
 *  - Todo mensaje se guarda en la BD (services/waChats) y se emite en
 *    tiempo real al panel de Chats. Las fotos/audios/documentos se suben
 *    a Cloudinary: nada de base64 guardado.
 *  - Envíos por una cola anti-bloqueo: límite por minuto y por día, pausas
 *    aleatorias, "escribiendo…" y tope de chats nuevos iniciados por nosotros.
 *  - Los mensajes de clientes pasan al bot conversacional (whatsapp/bot.js).
 */

const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  generateMessageIDV2,
  Browsers,
} = require('@whiskeysockets/baileys');

const path         = require('path');
const fs           = require('fs');
const pino         = require('pino');
const EventEmitter = require('events');
const pool         = require('../config/db');
const { cloudinary } = require('../config/cloudinary');
const chats        = require('../services/waChats');
const bot          = require('./bot');
const { obtenerConfig } = require('./botConfig');

// La sesión vive fuera del código; WA_SESSION_PATH permite ponerla en un
// disco persistente si el servidor se redespliega.
const SESSION_PATH = process.env.WA_SESSION_PATH || path.join(__dirname, 'sessions');
const waEvents     = new EventEmitter();
const logger       = pino({ level: 'silent' });

let sock             = null;
let currentQR        = null;
let pairingCode      = null;   // { code, numero, at } — vinculación por número
let connectionStatus = 'disconnected';   // 'disconnected' | 'connecting' | 'open' | 'replaced'
let reconnectAttempts = 0;
let reconnectTimer   = null;
let iniciando        = false;
let ultimoError      = null;   // { code, motivo, at }
let conectadoDesde   = null;
const MAX_ESPERA_RECONEXION_MS = 60 * 1000;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
const azar = (a, b) => Math.floor(a + Math.random() * Math.max(1, b - a));

// ── Limpieza de sesión ─────────────────────────────────────
function clearSession() {
  try {
    if (fs.existsSync(SESSION_PATH)) {
      fs.rmSync(SESSION_PATH, { recursive: true, force: true });
      console.log('🗑️  [WhatsApp] Sesión borrada correctamente.');
    }
  } catch (err) {
    console.error('❌ [WhatsApp] Error borrando sesión:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────
// ANTI-BLOQUEO: cola única de envío
//  - Tope por minuto: si se llena, ESPERA (no falla).
//  - Tope diario: si se llena, falla con un mensaje claro.
//  - Pausa aleatoria entre mensajes (más corta si escribe una persona).
//  - Tope de chats nuevos por día (números que nunca nos escribieron).
// ─────────────────────────────────────────────────────────────
const hoyVE = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Caracas' });
const cuota = {
  minuto: { inicio: Date.now(), n: 0 },
  dia: { fecha: hoyVE(), n: 0, chatsNuevos: new Set() },
};
const cola = [];
let procesandoCola = false;
let ultimoEnvio = 0;

function resetCuotas() {
  if (Date.now() - cuota.minuto.inicio >= 60000) cuota.minuto = { inicio: Date.now(), n: 0 };
  if (cuota.dia.fecha !== hoyVE()) cuota.dia = { fecha: hoyVE(), n: 0, chatsNuevos: new Set() };
}

async function procesarCola() {
  if (procesandoCola) return;
  procesandoCola = true;
  while (cola.length) {
    const tarea = cola.shift();
    try {
      const ab = (await obtenerConfig()).antiban;
      resetCuotas();
      if (cuota.dia.n >= ab.max_por_dia) throw new Error(`Límite diario de ${ab.max_por_dia} mensajes alcanzado (protección anti-bloqueo).`);
      while (cuota.minuto.n >= ab.max_por_minuto) {
        await sleep(Math.max(500, 60000 - (Date.now() - cuota.minuto.inicio)));
        resetCuotas();
      }
      const pausa = tarea.prioridad === 'humano' ? azar(300, 1000) : azar(ab.espera_min_ms, ab.espera_max_ms);
      const falta = pausa - (Date.now() - ultimoEnvio);
      if (falta > 0) await sleep(falta);
      const r = await tarea.fn();
      cuota.minuto.n++;
      cuota.dia.n++;
      ultimoEnvio = Date.now();
      tarea.resolve(r);
    } catch (err) { tarea.reject(err); }
  }
  procesandoCola = false;
}

function enqueue(fn, prioridad = 'bot') {
  return new Promise((resolve, reject) => {
    const tarea = { fn, resolve, reject, prioridad };
    // Lo que escribe una persona desde el panel pasa delante del bot
    if (prioridad === 'humano') {
      const i = cola.findIndex((t) => t.prioridad !== 'humano');
      if (i === -1) cola.push(tarea); else cola.splice(i, 0, tarea);
    } else cola.push(tarea);
    procesarCola();
  });
}

// Escribirle primero a un número que nunca nos escribió es lo que más
// dispara los bloqueos: se limita por día.
async function verificarChatNuevo(jid) {
  const r = await pool.query(`SELECT 1 FROM wa_chat_mensajes WHERE jid=$1 AND de_mi = FALSE LIMIT 1`, [jid]);
  if (r.rows.length) return;
  resetCuotas();
  if (cuota.dia.chatsNuevos.has(jid)) return;
  const max = (await obtenerConfig()).antiban.max_chats_nuevos_dia;
  if (cuota.dia.chatsNuevos.size >= max) {
    throw new Error(`Límite de ${max} chats nuevos por día alcanzado (protección anti-bloqueo). El cliente puede escribirnos primero.`);
  }
  cuota.dia.chatsNuevos.add(jid);
}

// ── Inicio de WhatsApp ─────────────────────────────────────
const MOTIVOS = {
  [DisconnectReason.loggedOut]:           'Sesión cerrada desde el teléfono',
  [DisconnectReason.connectionReplaced]:  'Se abrió la misma sesión en otro servidor',
  [DisconnectReason.restartRequired]:     'Reinicio requerido tras vincular',
  [DisconnectReason.timedOut]:            'Tiempo de espera agotado',
  [DisconnectReason.connectionClosed]:    'Conexión cerrada',
  [DisconnectReason.badSession]:          'Sesión dañada',
  [DisconnectReason.forbidden]:           'Número bloqueado por WhatsApp',
  [DisconnectReason.multideviceMismatch]: 'Versión de dispositivos incompatible',
  [DisconnectReason.unavailableService]:  'Servicio de WhatsApp no disponible',
};

// Programa un (re)inicio; nunca hay dos pendientes a la vez
function programarInicio(ms) {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    startWhatsApp().catch((err) => {
      console.error('❌ [WhatsApp] Error iniciando:', err.message);
      ultimoError = { code: null, motivo: err.message, at: new Date() };
      programarInicio(10000);
    });
  }, ms);
}

// Cierra el socket actual sin disparar su lógica de reconexión
function soltarSocket() {
  const s = sock;
  sock = null;
  if (!s) return null;
  try { s.ev.removeAllListeners(); } catch (_) {}
  return s;
}

async function startWhatsApp() {
  if (iniciando) return;
  iniciando = true;
  try {
    clearTimeout(reconnectTimer);
    const anterior = soltarSocket();
    if (anterior) { try { anterior.end(undefined); } catch (_) {} }

    const { state, saveCreds } = await useMultiFileAuthState(SESSION_PATH);
    // Si WhatsApp no responde la versión, Baileys usa la que trae incluida
    let version;
    try { ({ version } = await fetchLatestBaileysVersion()); } catch (_) {}

    connectionStatus = 'connecting';
    sock = makeWASocket({
      ...(version ? { version } : {}),
      logger: pino({ level: 'silent' }),
      auth: state,
      browser: Browsers.windows('Chrome'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      retryRequestDelayMs: 2000,
      maxMsgRetryCount: 2,
    });
    const esteSock = sock;

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (update) => {
      if (esteSock !== sock) return;   // eventos de un socket viejo
      onConnectionUpdate(update);
    });
    registrarMensajes(sock);
  } finally {
    iniciando = false;
  }
}

function onConnectionUpdate({ connection, lastDisconnect, qr }) {
  if (qr) {
    currentQR        = qr;
    connectionStatus = 'connecting';
    waEvents.emit('qr', qr);
    console.log('📱 [WhatsApp] QR generado.');
  }

  if (connection === 'open') {
    currentQR         = null;
    pairingCode       = null;
    connectionStatus  = 'open';
    reconnectAttempts = 0;
    ultimoError       = null;
    conectadoDesde    = new Date();
    waEvents.emit('ready');
    console.log(`✅ [WhatsApp] Conectado como ${sock?.user?.id || '?'}.`);
  }

  if (connection !== 'close') return;

  const code   = lastDisconnect?.error?.output?.statusCode;
  const motivo = MOTIVOS[code] || lastDisconnect?.error?.message || 'Desconocido';
  currentQR        = null;
  pairingCode      = null;
  conectadoDesde   = null;
  connectionStatus = 'disconnected';
  ultimoError      = { code: code ?? null, motivo, at: new Date() };
  waEvents.emit('disconnected');
  console.log(`⚠️  [WhatsApp] Desconectado (${code}): ${motivo}`);

  // Cerró sesión desde el teléfono: la sesión ya no sirve → nuevo QR
  if (code === DisconnectReason.loggedOut) {
    soltarSocket();
    clearSession();
    reconnectAttempts = 0;
    programarInicio(2000);
    return;
  }

  // Otra instancia (p. ej. el backend corriendo en local) tomó la sesión.
  // No reconectamos solos para no pelear entre servidores.
  if (code === DisconnectReason.connectionReplaced) {
    soltarSocket();
    connectionStatus = 'replaced';
    return;
  }

  // Normal justo después de escanear: reiniciar de inmediato
  if (code === DisconnectReason.restartRequired) {
    programarInicio(0);
    return;
  }

  // Cualquier otra caída: reintentar SIEMPRE, sin borrar la sesión
  // (antes a los 5 intentos se borraba y había que volver a escanear).
  reconnectAttempts++;
  const espera = Math.min(MAX_ESPERA_RECONEXION_MS, 2000 * 2 ** Math.min(reconnectAttempts, 5));
  console.log(`🔄 [WhatsApp] Reintento ${reconnectAttempts} en ${Math.round(espera / 1000)}s...`);
  programarInicio(espera);
}


// ─────────────────────────────────────────────────────────────
// MENSAJES ENTRANTES / ESTADOS
// ─────────────────────────────────────────────────────────────
const IGNORAR_JID = /@(g\.us|broadcast|newsletter)$|^status@/;
const ESTADOS_WA = { 0: 'error', 1: 'pendiente', 2: 'enviado', 3: 'entregado', 4: 'leido', 5: 'leido' };

// Desenvuelve mensajes temporales / de una sola vista
function contenidoReal(message) {
  let m = message || {};
  for (let i = 0; i < 4; i++) {
    const w = m.ephemeralMessage || m.viewOnceMessage || m.viewOnceMessageV2 || m.viewOnceMessageV2Extension || m.documentWithCaptionMessage;
    if (!w?.message) break;
    m = w.message;
  }
  return m;
}

function clasificar(m) {
  if (m.conversation) return { tipo: 'texto', texto: m.conversation };
  if (m.extendedTextMessage) return { tipo: 'texto', texto: m.extendedTextMessage.text };
  if (m.imageMessage) return { tipo: 'imagen', texto: m.imageMessage.caption || null, media: true, mime: m.imageMessage.mimetype };
  if (m.audioMessage) return { tipo: 'audio', media: true, mime: m.audioMessage.mimetype };
  if (m.documentMessage) return { tipo: 'documento', texto: m.documentMessage.caption || m.documentMessage.fileName || null, media: true, mime: m.documentMessage.mimetype };
  if (m.stickerMessage) return { tipo: 'sticker', media: true, mime: m.stickerMessage.mimetype };
  if (m.videoMessage) return { tipo: 'video', texto: m.videoMessage.caption || null };
  if (m.buttonsResponseMessage) return { tipo: 'texto', texto: m.buttonsResponseMessage.selectedDisplayText };
  if (m.listResponseMessage) return { tipo: 'texto', texto: m.listResponseMessage.title };
  if (m.contactMessage) return { tipo: 'otro', texto: `👤 Contacto: ${m.contactMessage.displayName || ''}` };
  if (m.locationMessage) return { tipo: 'otro', texto: '📍 Ubicación' };
  return null;   // reacciones, protocolo, etc.: no se guardan
}

function subirACloudinary(buffer, { tipo }) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: 'rifas-jordyn/whatsapp', resource_type: 'auto', tags: ['whatsapp', tipo] },
      (err, res) => (err ? reject(err) : resolve(res.secure_url)),
    );
    stream.end(buffer);
  });
}

// En Baileys v7 un chat puede venir con un id anónimo (@lid): usamos el
// número real (@s.whatsapp.net) cuando se conoce, para unir el chat con
// las reservas por teléfono.
async function jidCanonico(key) {
  const principal = key.remoteJid;
  if (!principal?.endsWith('@lid')) return principal;
  if (key.remoteJidAlt?.endsWith('@s.whatsapp.net')) return key.remoteJidAlt;
  try {
    const pn = await sock?.signalRepository?.lidMapping?.getPNForLID(principal);
    if (pn) return pn.includes('@') ? pn.replace(/:\d+@/, '@') : `${pn}@s.whatsapp.net`;
  } catch (_) {}
  return principal;
}

async function alRecibirMensaje(msg, tipoEvento) {
  if (!msg?.key?.remoteJid || IGNORAR_JID.test(msg.key.remoteJid)) return;
  const m = contenidoReal(msg.message);
  const info = clasificar(m);
  if (!info) return;

  const jid = await jidCanonico(msg.key);
  const deMi = !!msg.key.fromMe;
  const fecha = msg.messageTimestamp ? new Date(Number(msg.messageTimestamp) * 1000) : new Date();

  let mediaUrl = null;
  if (info.media) {
    try {
      const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
      if (buffer && buffer.length < 15 * 1024 * 1024) mediaUrl = await subirACloudinary(buffer, info);
    } catch (err) {
      console.error('❌ [WhatsApp] No se pudo guardar el adjunto:', err.message);
    }
  }

  const guardado = await chats.guardarMensaje({
    jid, deMi, autor: deMi ? 'telefono' : 'cliente',
    tipo: info.tipo, texto: info.texto, mediaUrl, mediaMime: info.mime || null,
    waId: msg.key.id, waKey: deMi ? null : { remoteJid: msg.key.remoteJid, id: msg.key.id, fromMe: false, participant: msg.key.participant },
    nombre: deMi ? null : (msg.pushName || null),
    estado: deMi ? 'enviado' : null,
    noLeido: tipoEvento === 'notify',
    fecha,
  });

  // Chat "Tú" del propio número: si el dueño usa el mismo número del bot,
  // lo que escribe ahí son órdenes para su asistente (no las respuestas del bot:
  // esas ya estaban guardadas y no llegan aquí).
  const propio = sock?.user?.id ? `${sock.user.id.split(':')[0].split('@')[0]}@s.whatsapp.net` : null;
  if (guardado && deMi && tipoEvento === 'notify' && jid === propio) {
    bot.alRecibirPropio(guardado.mensaje).catch((e) => console.error('❌ [Dueño]', e.message));
  }

  // Solo mensajes nuevos de clientes van al bot (no el historial sincronizado)
  if (guardado && !deMi && tipoEvento === 'notify') {
    bot.alRecibir({ mensaje: guardado.mensaje, chat: guardado.chat }).catch((e) => console.error('❌ [Bot]', e.message));
    waEvents.emit('mensaje', guardado);
  }
}

// Dentro del handler se usa `sock` (el socket vigente del módulo), no `s`:
// si hubo una reconexión mientras tanto, se usa la nueva.
function registrarMensajes(s) {
  s.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify' && type !== 'append') return;
    for (const msg of messages) {
      try { await alRecibirMensaje(msg, type); }
      catch (err) { console.error('❌ [WhatsApp] Error guardando mensaje:', err.message); }
    }
  });

  // ✓ ✓✓ y azul: enviado / entregado / leído
  s.ev.on('messages.update', async (updates) => {
    for (const { key, update } of updates) {
      if (!key?.fromMe || update?.status == null) continue;
      const estado = ESTADOS_WA[update.status];
      if (estado) chats.actualizarEstadoMensaje(key.id, estado).catch(() => {});
    }
  });
}

// ─────────────────────────────────────────────────────────────
// ENVÍO (todo pasa por aquí: bot, panel, tickets)
// ─────────────────────────────────────────────────────────────
function toJID(numero) {
  const s = String(numero || '').trim();
  if (s.includes('@')) return s;
  let n = s.replace(/\D/g, '');
  if (n.startsWith('0')) n = '58' + n.slice(1);
  return n + '@s.whatsapp.net';
}

function assertConnected() {
  if (!sock || connectionStatus !== 'open') {
    throw new Error('WhatsApp no está conectado. Vincúlalo desde WhatsApp → Conexión.');
  }
}

/**
 * Envía y registra un mensaje.
 *  contenido: objeto de Baileys ({ text } | { image, caption } | { document, ... })
 *  opts: { autor: 'bot'|'humano'|'sistema', tipo, texto, mediaUrl, mediaMime, prioridad }
 */
async function enviar(jid, contenido, opts = {}) {
  assertConnected();
  await verificarChatNuevo(jid);
  const waId = generateMessageIDV2(sock.user?.id);
  await chats.guardarMensaje({
    jid, waId, deMi: true, autor: opts.autor || 'humano', tipo: opts.tipo || 'texto',
    texto: opts.texto ?? contenido.text ?? contenido.caption ?? null,
    mediaUrl: opts.mediaUrl || null, mediaMime: opts.mediaMime || null, estado: 'pendiente',
  });
  try {
    await enqueue(() => {
      assertConnected();
      return sock.sendMessage(jid, contenido, { messageId: waId });
    }, opts.prioridad || (opts.autor === 'humano' ? 'humano' : 'bot'));
    await chats.actualizarEstadoMensaje(waId, 'enviado');
  } catch (err) {
    await chats.actualizarEstadoMensaje(waId, 'error').catch(() => {});
    throw err;
  }
  return { ok: true, to: jid, waId };
}

async function enviarTexto(jid, texto, opts = {}) {
  return enviar(jid, { text: texto }, { ...opts, tipo: 'texto', texto });
}

// imagen: URL https, Buffer o dataURL/base64
async function enviarImagen(jid, imagen, caption = '', opts = {}) {
  let fuente, mediaUrl = null;
  if (Buffer.isBuffer(imagen)) {
    fuente = imagen;
    mediaUrl = await subirACloudinary(imagen, { tipo: 'imagen' }).catch(() => null);
  } else if (typeof imagen === 'string' && imagen.startsWith('http')) {
    fuente = { url: imagen };
    mediaUrl = imagen;
  } else if (typeof imagen === 'string') {
    fuente = Buffer.from(imagen.includes(',') ? imagen.split(',')[1] : imagen, 'base64');
    mediaUrl = await subirACloudinary(fuente, { tipo: 'imagen' }).catch(() => null);
  } else {
    throw new Error('Formato de imagen no reconocido.');
  }
  return enviar(jid, { image: fuente, caption }, { ...opts, tipo: 'imagen', texto: caption || null, mediaUrl, mediaMime: 'image/jpeg' });
}

async function escribiendo(jid, ms) {
  if (!sock || connectionStatus !== 'open') return;
  try {
    await sock.presenceSubscribe(jid).catch(() => {});
    await sock.sendPresenceUpdate('composing', jid);
    await sleep(ms);
    await sock.sendPresenceUpdate('paused', jid);
  } catch (_) {}
}

async function leer(jid, keys) {
  if (!sock || connectionStatus !== 'open' || !keys?.length) return;
  await sock.readMessages(keys);
}

// Marca el chat como leído en el panel y en el teléfono del cliente (✓✓ azul)
async function marcarChatLeido(jid) {
  const keys = await chats.marcarLeido(jid);
  await leer(jid, keys).catch(() => {});
}

bot.init({ enviarTexto, escribiendo, leer, conectado: () => !!sock && connectionStatus === 'open' });

// ── API usada por otras rutas ──────────────────────────────
async function sendText(numero, mensaje) {
  return enviarTexto(toJID(numero), mensaje, { autor: 'humano' });
}

async function sendImage(numero, imagen, caption = '') {
  return enviarImagen(toJID(numero), imagen, caption, { autor: 'humano' });
}

/**
 * Ticket de confirmación al aprobar una reserva: texto + imágenes (URLs de
 * Cloudinary o base64) + PDF opcional. `destino` puede ser teléfono o JID.
 */
async function sendTicketConfirmacion(destino, texto, imagenes = [], pdfBuffer = null) {
  assertConnected();
  const jid = toJID(destino);
  await enviarTexto(jid, texto, { autor: 'sistema', prioridad: 'humano' });
  for (let i = 0; i < imagenes.length; i++) {
    const caption = imagenes.length > 1 ? `🎟️ Ticket ${i + 1} de ${imagenes.length}` : '🎟️ Tu ticket — ¡guárdalo!';
    await enviarImagen(jid, imagenes[i], caption, { autor: 'sistema', prioridad: 'humano' });
  }
  if (pdfBuffer && pdfBuffer.length > 0) {
    await enviar(jid, {
      document: pdfBuffer, mimetype: 'application/pdf', fileName: 'tickets-rifas-jordyn.pdf',
      caption: '📄 Todos tus tickets en PDF 🎉',
    }, { autor: 'sistema', tipo: 'documento', texto: '📄 tickets-rifas-jordyn.pdf', prioridad: 'humano' });
  }
  console.log(`✅ [Ticket] Confirmación enviada → ${jid} (${imagenes.length} imagen(es))`);
  return { ok: true, to: jid };
}

function getStatus() {
  resetCuotas();
  // El código de vinculación vence a los ~2 min (o antes si WhatsApp rota la conexión)
  const codigoVigente = pairingCode && Date.now() - pairingCode.at < 2 * 60 * 1000 ? pairingCode : null;
  return {
    status: connectionStatus,
    hasQR: !!currentQR,
    pairingCode: codigoVigente ? codigoVigente.code : null,
    pairingNumero: codigoVigente ? codigoVigente.numero : null,
    numeroConectado: sock?.user?.id ? sock.user.id.split(':')[0].split('@')[0] : null,
    nombreConectado: sock?.user?.name || null,
    conectadoDesde,
    reintentos: reconnectAttempts,
    ultimoError,
    queueLength: cola.length,
    rateLimitInfo: {
      sentInLastMinute: cuota.minuto.n,
      enviadosHoy: cuota.dia.n,
      chatsNuevosHoy: cuota.dia.chatsNuevos.size,
    },
  };
}

async function getQRBase64() {
  if (!currentQR) return null;
  const QRCode = require('qrcode');
  return await QRCode.toDataURL(currentQR, { margin: 1, width: 320 });
}

// Vincular sin QR: WhatsApp → Dispositivos vinculados → Vincular con número de teléfono
async function requestPairingCode(numero) {
  let n = String(numero || '').replace(/\D/g, '');
  if (n.startsWith('0')) n = '58' + n.slice(1);   // mismo criterio que toJID
  if (n.length < 10) throw new Error('Número inválido: incluye el código de país (ej. 584241234567).');
  if (connectionStatus === 'open') throw new Error('WhatsApp ya está conectado.');

  if (!sock) await startWhatsApp();
  if (sock?.authState?.creds?.registered) {
    throw new Error('Ya hay una sesión vinculada. Usa "Reset forzado" para vincular otro número.');
  }

  // El código solo se puede pedir con el socket listo (cuando ya emitió QR)
  const limite = Date.now() + 25000;
  while (!currentQR && Date.now() < limite) await sleep(500);
  if (!currentQR || !sock) throw new Error('WhatsApp aún no está listo, intenta de nuevo en unos segundos.');

  const code = await sock.requestPairingCode(n);
  pairingCode = { code, numero: n, at: Date.now() };
  console.log(`🔢 [WhatsApp] Código de vinculación generado para ${n}.`);
  return code;
}

// Reconectar con la sesión guardada (sin borrarla)
function reconectar() {
  reconnectAttempts = 0;
  programarInicio(0);
}

// Cerrar sesión: desvincula el dispositivo y deja un QR nuevo listo
async function logout() {
  clearTimeout(reconnectTimer);
  const s = soltarSocket();
  if (s) { try { await s.logout(); } catch (_) {} }
  connectionStatus  = 'disconnected';
  currentQR         = null;
  pairingCode       = null;
  reconnectAttempts = 0;
  clearSession();
  programarInicio(1000);
}

// Reset forzado: borra la sesión local (sin avisar al teléfono) y pide QR nuevo
async function resetAndReconnect() {
  console.log('🔁 [WhatsApp] Reset forzado solicitado...');
  clearTimeout(reconnectTimer);
  const s = soltarSocket();
  if (s) { try { s.end(undefined); } catch (_) {} }
  connectionStatus  = 'disconnected';
  currentQR         = null;
  pairingCode       = null;
  reconnectAttempts = 0;
  clearSession();
  programarInicio(1000);
}

module.exports = {
  startWhatsApp,
  // envío
  enviarTexto,
  enviarImagen,
  marcarChatLeido,
  sendText,
  sendImage,
  sendTicketConfirmacion,
  toJID,
  // conexión
  getStatus,
  getQRBase64,
  requestPairingCode,
  reconectar,
  logout,
  resetAndReconnect,
  clearSession,
  waEvents,
};
