// ============================================================
//  numeroPersonal.js — El WhatsApp personal del dueño, solo para enviar
//
//  Una segunda conexión, aparte de la del negocio:
//   • Se vincula SOLO con código (WhatsApp → Dispositivos vinculados →
//     Vincular con número de teléfono). Nunca se muestra un QR.
//   • Solo el número de config/numeroPersonal.js. Si se vincula otro, se
//     desvincula solo.
//   • Solo envía: no escucha mensajes, no baja el historial y no guarda
//     ni muestra sus chats.
//   • Su sesión se respalda en su propia tabla (wa_personal_sesion_archivos)
//     para sobrevivir a los despliegues.
//   • El dueño elige si los recordatorios de pago salen por aquí.
// ============================================================
const {
  default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, Browsers,
} = require('@whiskeysockets/baileys');
const path = require('path');
const fs = require('fs');
const pino = require('pino');
const pool = require('../config/db');
const { crear } = require('./sesionDB');
const { NUMERO, VISIBLE, TERMINOS, AVISO } = require('../config/numeroPersonal');

const DIR = process.env.WA_PERSONAL_SESSION_PATH || path.join(__dirname, 'sessions_personal');
const sesion = crear('wa_personal_sesion_archivos', 'Número personal');
const CODIGO_VENCE_MS = 3 * 60 * 1000;
const MAX_POR_DIA = 150;            // tope de envíos por día desde el número personal
const PAUSA = [8000, 18000];        // entre un envío y otro (además de la pausa de los recordatorios)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const azar = (a, b) => Math.floor(a + Math.random() * Math.max(1, b - a));
const hoyVE = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Caracas' });
const numeroDe = (id) => String(id || '').split(':')[0].split('@')[0];

const tablaLista = pool.query(`
  CREATE TABLE IF NOT EXISTS wa_numero_personal (
    id                 INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    recordatorios      BOOLEAN NOT NULL DEFAULT FALSE,   -- los recordatorios de pago salen por este número
    terminos_at        TIMESTAMPTZ,
    terminos_por       TEXT,
    vinculado_at       TIMESTAMPTZ,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`)
  .then(() => pool.query(`INSERT INTO wa_numero_personal (id) VALUES (1) ON CONFLICT DO NOTHING`))
  .then(() => pool.query(`
    CREATE TABLE IF NOT EXISTS wa_personal_envios (
      id          BIGSERIAL PRIMARY KEY,
      jid         TEXT NOT NULL,
      tipo        VARCHAR(20) NOT NULL,     -- recordatorio | prueba
      estado      VARCHAR(10) NOT NULL,     -- enviado | error
      error       TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`))
  .catch((e) => console.error('[numeroPersonal] esquema:', e.message));

// ── Estado ───────────────────────────────────────────────────
let sock = null;
let estado = 'desvinculado';   // desvinculado | iniciando | esperando_codigo | conectado | reemplazado
let listoParaCodigo = false;   // el socket ya puede pedir el código (WhatsApp emitió su QR interno)
let codigo = null;             // { code, at }
let ultimoError = null;        // { motivo, at }
let conectadoDesde = null;
let reintentos = 0;
let timer = null;
let vence = null;
let usarEnRecordatorios = false;

async function leerConfig() {
  await tablaLista;
  const r = (await pool.query(`SELECT * FROM wa_numero_personal WHERE id = 1`)).rows[0] || {};
  usarEnRecordatorios = !!r.recordatorios;
  return r;
}

function soltar() {
  const s = sock;
  sock = null;
  listoParaCodigo = false;
  if (!s) return null;
  try { s.ev.removeAllListeners(); } catch (_) {}
  return s;
}

function borrarDisco() {
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (_) {}
}

async function olvidarSesion() {
  borrarDisco();
  await sesion.borrar().catch((e) => console.error('❌ [Número personal] borrar sesión:', e.message));
}

let respaldoTimer = null;
function programarRespaldo(ms = 4000) {
  clearTimeout(respaldoTimer);
  respaldoTimer = setTimeout(() => sesion.respaldar(DIR).catch((e) => console.error('❌ [Número personal] respaldo:', e.message)), ms);
}

async function iniciar() {
  clearTimeout(timer);
  const anterior = soltar();
  if (anterior) { try { anterior.end(undefined); } catch (_) {} }
  estado = 'iniciando';
  await sesion.restaurar(DIR).catch((e) => console.error('❌ [Número personal] restaurar:', e.message));
  const { state, saveCreds } = await useMultiFileAuthState(DIR);
  let version;
  try { ({ version } = await fetchLatestBaileysVersion()); } catch (_) {}
  sock = makeWASocket({
    ...(version ? { version } : {}),
    logger: pino({ level: 'silent' }),
    auth: state,
    browser: Browsers.windows('Chrome'),
    markOnlineOnConnect: false,          // no aparece "en línea" por el sistema
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => false,   // no baja sus chats
    generateHighQualityLinkPreview: false,
    getMessage: async () => undefined,
  });
  const este = sock;
  sock.ev.on('creds.update', async () => { await saveCreds(); programarRespaldo(); });
  sock.ev.on('connection.update', (u) => { if (este === sock) alCambiar(u).catch((e) => console.error('❌ [Número personal]', e.message)); });
  // A propósito no se escucha 'messages.upsert': de este número no se lee nada.
}

function reintentar(ms) {
  clearTimeout(timer);
  timer = setTimeout(() => iniciar().catch((e) => {
    ultimoError = { motivo: e.message, at: new Date() };
    reintentar(15000);
  }), ms);
}

async function alCambiar({ connection, lastDisconnect, qr }) {
  if (qr) listoParaCodigo = true;   // el QR nunca se muestra: solo indica que ya se puede pedir el código

  if (connection === 'open') {
    const vinculado = numeroDe(sock?.user?.id);
    if (vinculado !== NUMERO) {
      // Otro número: se desvincula ya
      console.log(`⛔ [Número personal] Se intentó vincular ${vinculado}: solo se permite ${NUMERO}.`);
      const s = soltar();
      if (s) { try { await s.logout(); } catch (_) {} }
      await olvidarSesion();
      estado = 'desvinculado';
      codigo = null;
      ultimoError = { motivo: `Solo se puede vincular ${VISIBLE}. Se desvinculó el otro número.`, at: new Date() };
      return;
    }
    clearTimeout(vence);
    estado = 'conectado';
    codigo = null;
    reintentos = 0;
    ultimoError = null;
    conectadoDesde = new Date();
    await pool.query(`UPDATE wa_numero_personal SET vinculado_at = COALESCE(vinculado_at, NOW()), updated_at = NOW() WHERE id = 1`).catch(() => {});
    console.log(`✅ [Número personal] Conectado (${VISIBLE}).`);
    programarRespaldo(3000);
    return;
  }

  if (connection !== 'close') return;
  const code = lastDisconnect?.error?.output?.statusCode;
  const registrado = !!sock?.authState?.creds?.registered;
  conectadoDesde = null;
  listoParaCodigo = false;

  if (code === DisconnectReason.loggedOut) {
    soltar();
    await olvidarSesion();
    estado = 'desvinculado';
    codigo = null;
    ultimoError = { motivo: 'Se desvinculó desde el teléfono.', at: new Date() };
    await pool.query(`UPDATE wa_numero_personal SET vinculado_at = NULL WHERE id = 1`).catch(() => {});
    console.log('⚠️  [Número personal] Desvinculado desde el teléfono.');
    return;
  }
  if (code === DisconnectReason.connectionReplaced) {
    soltar();
    estado = 'reemplazado';
    ultimoError = { motivo: 'La sesión se abrió en otro servidor.', at: new Date() };
    return;
  }
  if (code === DisconnectReason.restartRequired) { reintentar(0); return; }   // normal justo después de meter el código
  // Sin vincular todavía: si hay un código vigente se sigue esperando; si no, se apaga
  if (!registrado && !codigo) { soltar(); estado = 'desvinculado'; return; }
  reintentos += 1;
  estado = registrado ? 'iniciando' : 'esperando_codigo';
  reintentar(Math.min(60000, 2000 * 2 ** Math.min(reintentos, 5)));
}

// ── Acciones del panel ───────────────────────────────────────
async function pedirCodigo(usuario) {
  await tablaLista;
  if (estado === 'conectado') throw new Error('El número personal ya está vinculado.');
  // Siempre desde cero: un código solo sirve con una sesión nueva
  clearTimeout(timer);
  const s = soltar();
  if (s) { try { s.end(undefined); } catch (_) {} }
  await olvidarSesion();
  await iniciar();
  const limite = Date.now() + 25000;
  while (!listoParaCodigo && Date.now() < limite) await sleep(400);
  if (!listoParaCodigo || !sock) throw new Error('WhatsApp aún no está listo. Intenta de nuevo en unos segundos.');
  const code = await sock.requestPairingCode(NUMERO);
  codigo = { code, at: Date.now() };
  estado = 'esperando_codigo';
  ultimoError = null;
  await pool.query(`UPDATE wa_numero_personal SET terminos_at = NOW(), terminos_por = $1, updated_at = NOW() WHERE id = 1`, [usuario || null]);
  console.log('🔢 [Número personal] Código de vinculación generado.');
  // Si no lo mete a tiempo, se apaga para no dejar una conexión colgada
  clearTimeout(vence);
  vence = setTimeout(async () => {
    if (estado === 'conectado') return;
    const x = soltar();
    if (x) { try { x.end(undefined); } catch (_) {} }
    clearTimeout(timer);
    await olvidarSesion();
    codigo = null;
    estado = 'desvinculado';
    ultimoError = { motivo: 'El código venció sin usarse. Pide uno nuevo.', at: new Date() };
  }, CODIGO_VENCE_MS);
  return code;
}

async function desvincular() {
  clearTimeout(timer);
  clearTimeout(vence);
  const s = soltar();
  if (s) { try { await s.logout(); } catch (_) { try { s.end(undefined); } catch (__) {} } }
  await olvidarSesion();
  estado = 'desvinculado';
  codigo = null;
  conectadoDesde = null;
  await pool.query(`UPDATE wa_numero_personal SET vinculado_at = NULL, recordatorios = FALSE, updated_at = NOW() WHERE id = 1`).catch(() => {});
  usarEnRecordatorios = false;
  console.log('🔌 [Número personal] Desvinculado desde el panel.');
}

async function usarParaRecordatorios(si) {
  await tablaLista;
  await pool.query(`UPDATE wa_numero_personal SET recordatorios = $1, updated_at = NOW() WHERE id = 1`, [!!si]);
  usarEnRecordatorios = !!si;
}

async function panel() {
  const cfg = await leerConfig();
  const hoy = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE estado = 'enviado')::int AS enviados, COUNT(*) FILTER (WHERE estado = 'error')::int AS errores
       FROM wa_personal_envios WHERE created_at >= (($1::date)::timestamp AT TIME ZONE 'America/Caracas')`, [hoyVE()]);
  const vigente = codigo && Date.now() - codigo.at < CODIGO_VENCE_MS ? codigo : null;
  return {
    numero: NUMERO, visible: VISIBLE, terminos: TERMINOS, aviso: AVISO,
    estado, conectado: estado === 'conectado', conectado_desde: conectadoDesde,
    codigo: vigente ? vigente.code : null, codigo_vence: vigente ? new Date(vigente.at + CODIGO_VENCE_MS) : null,
    ultimo_error: ultimoError,
    recordatorios: !!cfg.recordatorios,
    terminos_at: cfg.terminos_at || null, vinculado_at: cfg.vinculado_at || null,
    enviados_hoy: hoy.rows[0].enviados, errores_hoy: hoy.rows[0].errores, tope_dia: MAX_POR_DIA,
    en_cola: cola.length,
  };
}

// ── Envíos (uno a la vez, con pausas) ────────────────────────
const cola = [];
let trabajando = false;
let ultimo = 0;
let cuenta = { fecha: hoyVE(), n: 0 };

async function procesar() {
  if (trabajando) return;
  trabajando = true;
  while (cola.length) {
    const tarea = cola.shift();
    try {
      if (cuenta.fecha !== hoyVE()) cuenta = { fecha: hoyVE(), n: 0 };
      if (cuenta.n >= MAX_POR_DIA) throw new Error(`Límite diario de ${MAX_POR_DIA} mensajes del número personal (protección anti-bloqueo).`);
      if (estado !== 'conectado' || !sock) throw new Error('El número personal no está conectado.');
      const falta = azar(...PAUSA) - (Date.now() - ultimo);
      if (falta > 0) await sleep(falta);
      const r = await tarea.fn();
      cuenta.n += 1;
      ultimo = Date.now();
      pool.query(`INSERT INTO wa_personal_envios (jid, tipo, estado) VALUES ($1, $2, 'enviado')`, [tarea.jid, tarea.tipo]).catch(() => {});
      tarea.resolve(r);
    } catch (e) {
      pool.query(`INSERT INTO wa_personal_envios (jid, tipo, estado, error) VALUES ($1, $2, 'error', $3)`, [tarea.jid, tarea.tipo, String(e.message).slice(0, 300)]).catch(() => {});
      tarea.reject(e);
    }
  }
  trabajando = false;
}

function encolar(jid, tipo, fn) {
  return new Promise((resolve, reject) => { cola.push({ jid, tipo, fn, resolve, reject }); procesar(); });
}

async function escribiendo(jid) {
  try {
    await sock.presenceSubscribe(jid);
    await sock.sendPresenceUpdate('composing', jid);
    await sleep(azar(1500, 3500));
    await sock.sendPresenceUpdate('paused', jid);
  } catch (_) {}
}

const enviarTexto = (jid, texto, tipo = 'recordatorio') => encolar(jid, tipo, async () => {
  await escribiendo(jid);
  return sock.sendMessage(jid, { text: texto });
});
const enviarImagen = (jid, url, caption, tipo = 'recordatorio') => encolar(jid, tipo, async () => {
  await escribiendo(jid);
  return sock.sendMessage(jid, { image: { url }, caption });
});

async function enviarPrueba(telefono) {
  let n = String(telefono || '').replace(/\D/g, '');
  if (n.startsWith('0')) n = '58' + n.slice(1);
  if (n.length < 10) throw new Error('Escribe un teléfono válido');
  if (estado !== 'conectado') throw new Error('El número personal no está conectado.');
  await enviarTexto(`${n}@s.whatsapp.net`, '✅ Prueba del número personal: los recordatorios pueden salir por aquí.', 'prueba');
}

const conectado = () => estado === 'conectado' && !!sock;
// Para recordatorios.js: si toca usar este número ahora
const listoParaRecordatorios = () => usarEnRecordatorios && conectado();

// Al arrancar: solo si ya había una sesión vinculada (sin sesión no se abre nada)
async function arrancar() {
  await leerConfig().catch(() => {});
  if (!(await sesion.hay().catch(() => false))) return;
  iniciar().catch((e) => { ultimoError = { motivo: e.message, at: new Date() }; reintentar(15000); });
}

module.exports = {
  arrancar, panel, pedirCodigo, desvincular, usarParaRecordatorios, enviarPrueba,
  enviarTexto, enviarImagen, conectado, listoParaRecordatorios, NUMERO,
};
