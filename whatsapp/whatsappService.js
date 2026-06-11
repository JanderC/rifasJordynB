/**
 * whatsappService.js — con protecciones anti-ban, respuestas automáticas (Groq AI),
 * gestión automática de sesiones y procesamiento de comprobantes de pago.
 *
 * ✅ NUEVO: manejo de mensajes con imagen → procesarComprobante()
 * ✅ NUEVO: sendTicketImage() para enviar imagen de ticket al confirmar
 * ✅ NUEVO: sendPDFTickets() para enviar PDF con varios tickets
 */

const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
} = require('@whiskeysockets/baileys');

const { Boom }    = require('@hapi/boom');
const path        = require('path');
const fs          = require('fs');
const pino        = require('pino');
const EventEmitter = require('events');
const { getAutoReply, procesarComprobante } = require('./autoReply');
const { acumularMensaje }                   = require('./Geminiservice');

const SESSION_PATH = path.join(__dirname, 'sessions');
const waEvents     = new EventEmitter();

let sock             = null;
let currentQR        = null;
let connectionStatus = 'disconnected';
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;

// ── Limpieza automática de sesión ──────────────────────────
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

// ── Rate limiting ──────────────────────────────────────────
const rateLimit = {
  windowMs: 60 * 1000,
  maxPerWindow: 10,
  minDelayMs: 2000,
  maxDelayMs: 5000,
  sentInWindow: 0,
  windowStart: Date.now(),
  lastSentAt: 0,
};

// ── Cola de mensajes ───────────────────────────────────────
const messageQueue   = [];
let isProcessingQueue = false;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function randomDelay() {
  const { minDelayMs, maxDelayMs } = rateLimit;
  return Math.floor(Math.random() * (maxDelayMs - minDelayMs + 1)) + minDelayMs;
}

function checkRateLimit() {
  const now = Date.now();
  if (now - rateLimit.windowStart > rateLimit.windowMs) {
    rateLimit.sentInWindow = 0;
    rateLimit.windowStart  = now;
  }
  if (rateLimit.sentInWindow >= rateLimit.maxPerWindow) {
    const waitMs = rateLimit.windowMs - (now - rateLimit.windowStart);
    throw new Error(`Límite alcanzado: máximo ${rateLimit.maxPerWindow} mensajes/min. Espera ${Math.ceil(waitMs / 1000)}s.`);
  }
}

async function processQueue() {
  if (isProcessingQueue) return;
  isProcessingQueue = true;
  while (messageQueue.length > 0) {
    const { task, resolve, reject } = messageQueue.shift();
    const delay = randomDelay();
    await sleep(delay);
    try {
      const result = await task();
      rateLimit.sentInWindow++;
      rateLimit.lastSentAt = Date.now();
      resolve(result);
    } catch (err) { reject(err); }
  }
  isProcessingQueue = false;
}

function enqueue(task) {
  return new Promise((resolve, reject) => {
    checkRateLimit();
    messageQueue.push({ task, resolve, reject });
    processQueue();
  });
}

// ── Anti-flood ─────────────────────────────────────────────
const recentlyReplied = new Set();

function markReplied(msgId) {
  recentlyReplied.add(msgId);
  setTimeout(() => recentlyReplied.delete(msgId), 5 * 60 * 1000);
}

// ── Extraer base64 de imagen de un mensaje ─────────────────
async function extractImageBase64(msg) {
  try {
    const buffer = await downloadMediaMessage(msg, 'buffer', {});
    return buffer ? buffer.toString('base64') : null;
  } catch (err) {
    console.error('❌ [WhatsApp] Error descargando imagen:', err.message);
    return null;
  }
}

// ── Inicio de WhatsApp ─────────────────────────────────────
async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_PATH);
  const { version }          = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: true,
    auth: state,
    browser: ['Windows', 'Chrome', '120.0.0'],
    generateHighQualityLinkPreview: false,
    retryRequestDelayMs: 2000,
    maxMsgRetryCount: 2,
  });

  // ── Conexión y QR ────────────────────────────────────────
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      currentQR        = qr;
      connectionStatus = 'connecting';
      waEvents.emit('qr', qr);
      console.log('📱 [WhatsApp] QR generado.');
    }

    if (connection === 'open') {
      currentQR        = null;
      connectionStatus = 'open';
      reconnectAttempts = 0;
      waEvents.emit('ready');
      console.log('✅ [WhatsApp] Conectado.');
    }

    if (connection === 'close') {
      connectionStatus = 'disconnected';
      waEvents.emit('disconnected');
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      console.log(`⚠️  [WhatsApp] Desconectado. Código: ${reason}`);

      if (reason === DisconnectReason.loggedOut) {
        console.log('🚪 [WhatsApp] Sesión cerrada remotamente. Limpiando y reconectando...');
        clearSession();
        reconnectAttempts = 0;
        await sleep(3000);
        startWhatsApp();
        return;
      }

      if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        reconnectAttempts++;
        const waitSec = Math.pow(2, reconnectAttempts) * 3;
        console.log(`🔄 [WhatsApp] Intento ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} en ${waitSec}s...`);
        await sleep(waitSec * 1000);
        startWhatsApp();
      } else {
        console.log('❌ [WhatsApp] Máximo de reconexiones. Limpiando sesión...');
        clearSession();
        reconnectAttempts = 0;
        waEvents.emit('session_expired');
      }
    }
  });

  // ── Mensajes entrantes ────────────────────────────────────
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      try {
        if (msg.key.fromMe) continue;
        if (msg.key.remoteJid.endsWith('@g.us')) continue;
        if (recentlyReplied.has(msg.key.id)) continue;

        const jid      = msg.key.remoteJid;
        const msgType  = Object.keys(msg.message || {})[0];

        // ── Imagen recibida → posible comprobante de pago ──
        const esImagen = ['imageMessage', 'stickerMessage'].includes(msgType);
        if (esImagen && msgType === 'imageMessage') {
          markReplied(msg.key.id);
          console.log(`📸 [AutoReply] Imagen de ${jid} — procesando como comprobante`);

          const base64    = await extractImageBase64(msg);
          const respuesta = await procesarComprobante(jid, base64);

          await sock.sendPresenceUpdate('composing', jid);
          await sleep(1500);
          await sock.sendPresenceUpdate('paused', jid);

          await enqueue(async () => {
            await sock.sendMessage(jid, { text: respuesta });
            console.log(`🤖 [AutoReply] Respuesta comprobante → ${jid}`);
            return { ok: true, to: jid };
          });

          waEvents.emit('comprobanteRecibido', { jid, base64 });
          continue;
        }

        // ── Texto normal ───────────────────────────────────
        const texto =
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          msg.message?.imageMessage?.caption ||
          '';

        if (!texto) continue;

        console.log(`📩 [AutoReply] De ${jid}: "${texto.substring(0, 50)}"`);
        markReplied(msg.key.id);

        // Acumular mensajes (debounce 4s) antes de responder
        acumularMensaje(jid, texto, async (jidFinal, textoAcumulado) => {
          try {
            const respuesta = await getAutoReply(jidFinal, textoAcumulado);

            await sock.sendPresenceUpdate('composing', jidFinal);
            await sleep(1500);
            await sock.sendPresenceUpdate('paused', jidFinal);

            await enqueue(async () => {
              await sock.sendMessage(jidFinal, { text: respuesta });
              console.log(`🤖 [AutoReply] Respondido a ${jidFinal}`);
              return { ok: true, to: jidFinal };
            });

            waEvents.emit('autoReply', { jid: jidFinal, incoming: textoAcumulado, response: respuesta });
          } catch (err) {
            console.error('❌ [AutoReply] Error enviando respuesta:', err.message);
          }
        });

      } catch (err) {
        console.error('❌ [AutoReply] Error procesando mensaje:', err.message);
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);
}

// ── Helpers ────────────────────────────────────────────────
function toJID(numero) {
  let n = numero.replace(/\D/g, '');
  if (n.startsWith('0')) n = '58' + n.slice(1);
  if (!n.includes('@')) n = n + '@s.whatsapp.net';
  return n;
}

function assertConnected() {
  if (!sock || connectionStatus !== 'open') {
    throw new Error('WhatsApp no está conectado. Escanea el QR primero.');
  }
}

// ── API pública ────────────────────────────────────────────

async function sendText(numero, mensaje) {
  assertConnected();
  const jid = toJID(numero);
  return enqueue(async () => {
    await sock.sendMessage(jid, { text: mensaje });
    console.log(`📤 [WhatsApp] Texto → ${jid}`);
    return { ok: true, to: jid };
  });
}

async function sendImage(numero, imagen, caption = '') {
  assertConnected();
  const jid = toJID(numero);

  let imageSource;
  if (Buffer.isBuffer(imagen)) {
    imageSource = imagen;
  } else if (typeof imagen === 'string' && imagen.startsWith('http')) {
    imageSource = { url: imagen };
  } else if (typeof imagen === 'string') {
    const base64 = imagen.includes(',') ? imagen.split(',')[1] : imagen;
    imageSource  = Buffer.from(base64, 'base64');
  } else {
    throw new Error('Formato de imagen no reconocido.');
  }

  return enqueue(async () => {
    await sock.sendMessage(jid, { image: imageSource, caption, mimetype: 'image/jpeg' });
    console.log(`🖼️  [WhatsApp] Imagen → ${jid}`);
    return { ok: true, to: jid };
  });
}

/**
 * ✅ Envía el ticket de confirmación a un cliente.
 *
 * Flujo:
 *  1. Texto de confirmación
 *  2. Imágenes de ticket — acepta URLs de Cloudinary (preferido) O base64
 *  3. PDF adjunto (opcional)
 *
 * @param {string}   numero       — Teléfono del cliente (ej: "04241234567")
 * @param {string}   texto        — Mensaje de confirmación
 * @param {string[]} imagenes     — Array de URLs (https://...) O base64 (data:image/...)
 * @param {Buffer|null} pdfBuffer — PDF con todos los tickets (opcional)
 */
async function sendTicketConfirmacion(numero, texto, imagenes = [], pdfBuffer = null) {
  assertConnected();
  const jid = toJID(numero);

  // 1. ── Texto de confirmación ─────────────────────────────
  await enqueue(async () => {
    await sock.sendMessage(jid, { text: texto });
    console.log(`📤 [Ticket] Texto → ${jid}`);
    return { ok: true };
  });

  await sleep(1000);

  // 2. ── Imágenes del ticket ────────────────────────────────
  for (let i = 0; i < imagenes.length; i++) {
    const src     = imagenes[i];
    const caption = imagenes.length > 1
      ? `🎟️ Ticket ${i + 1} de ${imagenes.length}`
      : '🎟️ Tu ticket — ¡guárdalo!';

    // Detectar si es URL de Cloudinary/https o base64
    const esUrl = typeof src === 'string' && src.startsWith('http');

    await enqueue(async () => {
      if (esUrl) {
        // Enviar por URL directa — Baileys descarga la imagen por nosotros
        await sock.sendMessage(jid, {
          image: { url: src },
          caption,
          mimetype: 'image/png',
        });
        console.log(`🖼️  [Ticket] Imagen URL → ${jid} (${src.substring(0, 60)}…)`);
      } else {
        // Fallback: base64
        const b64    = src.includes(',') ? src.split(',')[1] : src;
        const buffer = Buffer.from(b64, 'base64');
        await sock.sendMessage(jid, { image: buffer, caption, mimetype: 'image/png' });
        console.log(`🖼️  [Ticket] Imagen base64 → ${jid}`);
      }
      return { ok: true };
    });

    if (i < imagenes.length - 1) await sleep(900);
  }

  // 3. ── PDF adjunto ────────────────────────────────────────
  if (pdfBuffer && pdfBuffer.length > 0) {
    await sleep(900);
    await enqueue(async () => {
      await sock.sendMessage(jid, {
        document: pdfBuffer,
        mimetype: 'application/pdf',
        fileName: 'tickets-rifas-jordyn.pdf',
        caption: '📄 Todos tus tickets en PDF 🎉',
      });
      console.log(`📄 [Ticket] PDF → ${jid}`);
      return { ok: true };
    });
  }

  console.log(`✅ [Ticket] Confirmación completa → ${jid} (${imagenes.length} imagen(es))`);
  return { ok: true, to: jid };
}

function getStatus() {
  const now = Date.now();
  if (now - rateLimit.windowStart > rateLimit.windowMs) {
    rateLimit.sentInWindow = 0;
    rateLimit.windowStart  = now;
  }
  return {
    status: connectionStatus,
    hasQR: !!currentQR,
    queueLength: messageQueue.length,
    rateLimitInfo: {
      sentInLastMinute: rateLimit.sentInWindow,
      maxPerMinute: rateLimit.maxPerWindow,
      remaining: rateLimit.maxPerWindow - rateLimit.sentInWindow,
    },
  };
}

async function getQRBase64() {
  if (!currentQR) return null;
  const QRCode = require('qrcode');
  return await QRCode.toDataURL(currentQR);
}

async function logout() {
  if (sock) {
    try { await sock.logout(); } catch (_) {}
    sock             = null;
    connectionStatus = 'disconnected';
    currentQR        = null;
    reconnectAttempts = 0;
  }
  clearSession();
}

async function resetAndReconnect() {
  console.log('🔁 [WhatsApp] Reset forzado solicitado...');
  if (sock) {
    try { await sock.end(); } catch (_) {}
    sock = null;
  }
  connectionStatus  = 'disconnected';
  currentQR         = null;
  reconnectAttempts = 0;
  clearSession();
  await sleep(1000);
  await startWhatsApp();
  console.log('🔁 [WhatsApp] Reconectando con sesión limpia...');
}

module.exports = {
  startWhatsApp,
  sendText,
  sendImage,
  sendTicketConfirmacion,   // ✅ nuevo
  getStatus,
  getQRBase64,
  logout,
  resetAndReconnect,
  clearSession,
  waEvents,
};