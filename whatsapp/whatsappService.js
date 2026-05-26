/**
 * whatsappService.js — con protecciones anti-ban
 */

const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");

const { Boom } = require("@hapi/boom");
const path = require("path");
const pino = require("pino");
const EventEmitter = require("events");

const SESSION_PATH = path.join(__dirname, "sessions");
const waEvents = new EventEmitter();

let sock = null;
let currentQR = null;
let connectionStatus = "disconnected";
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;

// ── Rate limiting ──────────────────────────────────────────
// Controla cuántos mensajes se envían y con qué frecuencia
const rateLimit = {
  windowMs: 60 * 1000,       // ventana de 1 minuto
  maxPerWindow: 10,           // máx 10 mensajes por minuto
  minDelayMs: 2000,           // mínimo 2s entre mensajes
  maxDelayMs: 5000,           // máximo 5s entre mensajes (aleatorio)
  sentInWindow: 0,
  windowStart: Date.now(),
  lastSentAt: 0,
};

// ── Cola de mensajes ───────────────────────────────────────
// En vez de enviar todo junto, los mensajes se encolan y
// se envían de uno en uno con delay aleatorio
const messageQueue = [];
let isProcessingQueue = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay() {
  const { minDelayMs, maxDelayMs } = rateLimit;
  return Math.floor(Math.random() * (maxDelayMs - minDelayMs + 1)) + minDelayMs;
}

function checkRateLimit() {
  const now = Date.now();

  // Reinicia la ventana si ya pasó 1 minuto
  if (now - rateLimit.windowStart > rateLimit.windowMs) {
    rateLimit.sentInWindow = 0;
    rateLimit.windowStart = now;
  }

  if (rateLimit.sentInWindow >= rateLimit.maxPerWindow) {
    const waitMs = rateLimit.windowMs - (now - rateLimit.windowStart);
    throw new Error(
      `Límite alcanzado: máximo ${rateLimit.maxPerWindow} mensajes/min. Espera ${Math.ceil(waitMs / 1000)}s.`
    );
  }
}

async function processQueue() {
  if (isProcessingQueue) return;
  isProcessingQueue = true;

  while (messageQueue.length > 0) {
    const { task, resolve, reject } = messageQueue.shift();

    // Espera el delay antes de enviar
    const delay = randomDelay();
    console.log(`⏳ [WhatsApp] Enviando en ${delay}ms...`);
    await sleep(delay);

    try {
      const result = await task();
      rateLimit.sentInWindow++;
      rateLimit.lastSentAt = Date.now();
      resolve(result);
    } catch (err) {
      reject(err);
    }
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

// ── Inicio de WhatsApp ─────────────────────────────────────
async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_PATH);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    logger: pino({ level: "silent" }),
    printQRInTerminal: true,
    auth: state,
    // Simula un navegador real para reducir detección
    browser: ["Windows", "Chrome", "120.0.0"],
    generateHighQualityLinkPreview: false,
    // Retries internos de Baileys
    retryRequestDelayMs: 2000,
    maxMsgRetryCount: 2,
  });

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      currentQR = qr;
      connectionStatus = "connecting";
      waEvents.emit("qr", qr);
      console.log("📱 [WhatsApp] QR generado.");
    }

    if (connection === "open") {
      currentQR = null;
      connectionStatus = "open";
      reconnectAttempts = 0;
      waEvents.emit("ready");
      console.log("✅ [WhatsApp] Conectado.");
    }

    if (connection === "close") {
      connectionStatus = "disconnected";
      waEvents.emit("disconnected");
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      console.log(`⚠️  [WhatsApp] Desconectado. Código: ${reason}`);

      if (reason === DisconnectReason.loggedOut) {
        console.log("🚪 [WhatsApp] Sesión cerrada. Borra sessions/ y reinicia.");
        return;
      }

      // Reconexión con backoff exponencial para no spamear
      if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        reconnectAttempts++;
        const waitSec = Math.pow(2, reconnectAttempts) * 3; // 6s, 12s, 24s, 48s...
        console.log(`🔄 [WhatsApp] Intento ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} en ${waitSec}s...`);
        await sleep(waitSec * 1000);
        startWhatsApp();
      } else {
        console.log("❌ [WhatsApp] Máximo de reconexiones alcanzado. Reinicia el servidor manualmente.");
      }
    }
  });

  sock.ev.on("creds.update", saveCreds);
}

// ── Helpers ────────────────────────────────────────────────
function toJID(numero) {
  let n = numero.replace(/\D/g, "");
  if (n.startsWith("0")) n = "58" + n.slice(1);
  if (!n.includes("@")) n = n + "@s.whatsapp.net";
  return n;
}

function assertConnected() {
  if (!sock || connectionStatus !== "open") {
    throw new Error("WhatsApp no está conectado. Escanea el QR primero.");
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

async function sendImage(numero, imagen, caption = "") {
  assertConnected();
  const jid = toJID(numero);

  let imageSource;
  if (Buffer.isBuffer(imagen)) {
    imageSource = imagen;
  } else if (typeof imagen === "string" && imagen.startsWith("http")) {
    imageSource = { url: imagen };
  } else if (typeof imagen === "string") {
    const base64 = imagen.includes(",") ? imagen.split(",")[1] : imagen;
    imageSource = Buffer.from(base64, "base64");
  } else {
    throw new Error("Formato de imagen no reconocido.");
  }

  return enqueue(async () => {
    await sock.sendMessage(jid, { image: imageSource, caption, mimetype: "image/jpeg" });
    console.log(`🖼️  [WhatsApp] Imagen → ${jid}`);
    return { ok: true, to: jid };
  });
}

function getStatus() {
  const now = Date.now();
  // Reinicia conteo si ya expiró la ventana
  if (now - rateLimit.windowStart > rateLimit.windowMs) {
    rateLimit.sentInWindow = 0;
    rateLimit.windowStart = now;
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
  const QRCode = require("qrcode");
  return await QRCode.toDataURL(currentQR);
}

async function logout() {
  if (sock) {
    await sock.logout();
    sock = null;
    connectionStatus = "disconnected";
    currentQR = null;
    reconnectAttempts = 0;
  }
}

module.exports = {
  startWhatsApp,
  sendText,
  sendImage,
  getStatus,
  getQRBase64,
  logout,
  waEvents,
};