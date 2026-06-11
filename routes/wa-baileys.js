/**
 * routes/wa-baileys.js
 * Endpoints REST para controlar la instancia de WhatsApp con Baileys.
 *
 * Montar en server.js:
 *   app.use("/api/baileys", require("./routes/wa-baileys"));
 *
 * Endpoints existentes:
 *   GET  /api/baileys/status
 *   GET  /api/baileys/qr
 *   POST /api/baileys/send/text
 *   POST /api/baileys/send/image
 *   POST /api/baileys/logout
 *   GET  /api/baileys/guion
 *   POST /api/baileys/guion/test
 *
 * ✅ NUEVOS endpoints:
 *   POST /api/baileys/reservas/:id/confirmar
 *        → Aprueba la reserva en BD y envía ticket(s) al cliente por Baileys
 *        Body: { nota?, ticketsBase64?: string[], pdfBase64?: string }
 *
 *   POST /api/baileys/send/ticket
 *        → Envía ticket(s) a cualquier número (sin cambiar estado en BD)
 *        Body: { numero, texto, ticketsBase64?, pdfBase64? }
 */

const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const pool    = require('../config/db');
const { authMiddleware } = require('../middleware/auth');

const {
  sendText,
  sendImage,
  sendTicketConfirmacion,
  getStatus,
  getQRBase64,
  logout,
} = require('../whatsapp/whatsappService');

const { getAutoReply, getGuion } = require('../whatsapp/autoReply');

// ── Multer en memoria ───────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('Solo imágenes.'), false);
    cb(null, true);
  },
});

// ── Middleware de auth simple ───────────────────────────────
function waAuth(req, res, next) {
  const secret = process.env.WA_SECRET_KEY;
  if (!secret) return next();
  const key = req.headers['x-wa-key'];
  if (key !== secret) return res.status(401).json({ error: 'No autorizado.' });
  next();
}

// ────────────────────────────────────────────────────────────
// ENDPOINTS EXISTENTES
// ────────────────────────────────────────────────────────────

router.get('/status', waAuth, (req, res) => res.json(getStatus()));

router.get('/qr', waAuth, async (req, res) => {
  try {
    const qrBase64 = await getQRBase64();
    if (!qrBase64) {
      const { status } = getStatus();
      if (status === 'open') return res.json({ ok: true, message: 'Ya conectado, no hay QR activo.' });
      return res.status(404).json({ error: 'QR no disponible aún. Espera unos segundos.' });
    }
    res.json({ ok: true, qr: qrBase64 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/send/text', waAuth, async (req, res) => {
  const { numero, mensaje } = req.body;
  if (!numero || !mensaje) return res.status(400).json({ error: "Se requieren 'numero' y 'mensaje'." });
  try {
    const result = await sendText(numero, mensaje);
    res.json({ ok: true, ...result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post(
  '/send/image',
  waAuth,
  (req, res, next) => {
    const ct = req.headers['content-type'] || '';
    if (ct.includes('multipart/form-data')) return upload.single('imagen')(req, res, next);
    next();
  },
  async (req, res) => {
    try {
      const numero  = req.body?.numero;
      const caption = req.body?.caption || '';
      if (!numero) return res.status(400).json({ error: "Se requiere 'numero'." });

      let imageSource;
      if (req.file)                  imageSource = req.file.buffer;
      else if (req.body?.imagenUrl)  imageSource = req.body.imagenUrl;
      else if (req.body?.imagenBase64) imageSource = req.body.imagenBase64;
      else return res.status(400).json({ error: "Se requiere imagen: 'imagen', 'imagenUrl' o 'imagenBase64'." });

      const result = await sendImage(numero, imageSource, caption);
      res.json({ ok: true, ...result });
    } catch (err) { res.status(500).json({ error: err.message }); }
  }
);

router.post('/logout', waAuth, async (req, res) => {
  try {
    await logout();
    res.json({ ok: true, message: 'Sesión cerrada.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/guion', waAuth, (req, res) => {
  const g = getGuion();
  res.json({
    ok: true,
    total: g.length,
    guion: g.map(i => ({ id: i.id, nombre: i.nombre, triggers: i.triggers, responsePreview: i.response.substring(0, 80) + '...' })),
  });
});

router.post('/guion/test', waAuth, async (req, res) => {
  const { mensaje } = req.body;
  if (!mensaje) return res.status(400).json({ error: "Se requiere 'mensaje'." });
  const respuesta = await getAutoReply('test@test', mensaje);
  res.json({ ok: true, input: mensaje, response: respuesta });
});

// ────────────────────────────────────────────────────────────
// POST /api/baileys/reservas/:id/confirmar
//
// AUTH dual: acepta JWT (Bearer) o WA_SECRET_KEY (x-wa-key)
// El frontend React manda el token JWT; el HTML de pruebas usa x-wa-key.
//
// Body JSON:
// {
//   nota?:          string
//   ticketsBase64?: string[]   ← base64 (fallback)
//   ticketUrls?:    string[]   ← URLs de Cloudinary (preferido)
//   pdfBase64?:     string
//   mensajeTexto:   string
// }
// El endpoint también extrae URLs de Cloudinary del propio mensajeTexto.
// ────────────────────────────────────────────────────────────
function authDual(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      const jwt = require('jsonwebtoken');
      req.user = jwt.verify(authHeader.slice(7), process.env.JWT_SECRET || 'secret');
      return next();
    } catch (_) {}
  }
  const secret = process.env.WA_SECRET_KEY;
  if (secret && req.headers['x-wa-key'] === secret) return next();
  if (!secret && !authHeader) return next(); // sin seguridad configurada → permitir
  return res.status(401).json({ error: 'Token no proporcionado o inválido.' });
}

function extraerUrlsDelMensaje(texto) {
  const cloudinary = texto.match(/https:\/\/res\.cloudinary\.com\/[^\s\n]+/g) || [];
  const otras      = texto.match(/https:\/\/[^\s\n]+\.(?:png|jpg|jpeg|webp)/gi) || [];
  return [...new Set([...cloudinary, ...otras])];
}

router.post('/reservas/:id/confirmar', authDual, async (req, res) => {
  const { id } = req.params;
  const { nota, ticketsBase64 = [], ticketUrls = [], pdfBase64, mensajeTexto } = req.body;

  if (!mensajeTexto) {
    return res.status(400).json({ error: "Se requiere 'mensajeTexto'." });
  }

  // Resolver imágenes: URLs > base64 > extraídas del mensaje
  const imagenesParaWA = ticketUrls.length > 0
    ? ticketUrls
    : ticketsBase64.length > 0
      ? ticketsBase64
      : extraerUrlsDelMensaje(mensajeTexto);

  console.log(`📋 [Confirmar] ${id} — ${imagenesParaWA.length} imagen(es)`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const rRes = await client.query(
      `SELECT rc.*, r.nombre AS rifa_nombre, r.premio, r.fecha_sorteo::text AS fecha_sorteo
         FROM reservas_cliente rc
         JOIN rifas r ON r.id = rc.rifa_id
        WHERE rc.id = $1`,
      [id]
    );
    if (!rRes.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Reserva no encontrada.' }); }
    const reserva = rRes.rows[0];

    if (reserva.estado === 'aprobado') { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Reserva ya aprobada.' }); }

    const herRes = await client.query(
      `SELECT id FROM reservas_cliente
        WHERE rifa_id = $1 AND LOWER(TRIM(nombre_cliente)) = LOWER(TRIM($2))
          AND estado = 'pendiente' AND id != $3`,
      [reserva.rifa_id, reserva.nombre_cliente, id]
    );
    const idsAprobar = [id, ...herRes.rows.map(r => r.id)];

    await client.query(
      `UPDATE reservas_cliente SET estado = 'aprobado', nota_admin = $1, updated_at = NOW() WHERE id = ANY($2::uuid[])`,
      [nota || null, idsAprobar]
    );
    await client.query('COMMIT');
    console.log(`✅ [Confirmar] ${idsAprobar.length} reserva(s) aprobada(s) en BD`);

    let waSent = false, waError = null;

    if (reserva.telefono) {
      try {
        const pdfBuffer = pdfBase64
          ? Buffer.from(pdfBase64.includes(',') ? pdfBase64.split(',')[1] : pdfBase64, 'base64')
          : null;
        await sendTicketConfirmacion(reserva.telefono, mensajeTexto, imagenesParaWA, pdfBuffer);
        waSent = true;
        console.log(`📲 [Confirmar] WA enviado a ${reserva.telefono}`);
      } catch (waErr) {
        console.error('⚠️  [Confirmar] Error WA:', waErr.message);
        waError = waErr.message;
      }
    }

    res.json({ ok: true, aprobados: idsAprobar.length, ids: idsAprobar, waSent, waError: waError || undefined, sinTelefono: !reserva.telefono, imagenesEnviadas: imagenesParaWA.length });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ [Confirmar] Error BD:', err.message);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});
// }
// ────────────────────────────────────────────────────────────
router.post('/send/ticket', authMiddleware, async (req, res) => {
  const { numero, mensajeTexto, ticketsBase64 = [], pdfBase64 } = req.body;

  if (!numero || !mensajeTexto) {
    return res.status(400).json({ error: "Se requieren 'numero' y 'mensajeTexto'." });
  }

  try {
    const pdfBuffer = pdfBase64
      ? Buffer.from(pdfBase64.includes(',') ? pdfBase64.split(',')[1] : pdfBase64, 'base64')
      : null;

    const result = await sendTicketConfirmacion(numero, mensajeTexto, ticketsBase64, pdfBuffer);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

// ────────────────────────────────────────────────────────────
// ✅ ENDPOINTS IA — system prompt + stats + test
// ────────────────────────────────────────────────────────────

const {
  getHistoryStats,
  clearAllHistories,
  clearHistory,
} = require('../whatsapp/Geminiservice');

// Prompts guardados en memoria (o en .env como fallback).
// Para persistencia real, guárdalos en BD o en un archivo JSON.
let _customPrompt = null;

// GET /api/baileys/ia/prompt
router.get('/ia/prompt', authMiddleware, (req, res) => {
  const { SYSTEM_PROMPT } = require('../whatsapp/Geminiservice');
  res.json({ prompt: _customPrompt || SYSTEM_PROMPT || '' });
});

// PUT /api/baileys/ia/prompt
router.put('/ia/prompt', authMiddleware, (req, res) => {
  const { prompt } = req.body;
  if (!prompt || typeof prompt !== 'string' || !prompt.trim())
    return res.status(400).json({ error: 'Prompt inválido' });
  _customPrompt = prompt.trim();

  // Intentar actualizar el prompt en caliente (si el módulo lo soporta)
  try {
    const gemini = require('../whatsapp/Geminiservice');
    if (typeof gemini.setSystemPrompt === 'function') gemini.setSystemPrompt(_customPrompt);
  } catch (_) { /* no soportado, aplica en el próximo reinicio */ }

  res.json({ ok: true, length: _customPrompt.length });
});

// GET /api/baileys/ia/stats
router.get('/ia/stats', authMiddleware, (req, res) => {
  const stats = getHistoryStats();
  res.json({
    ...stats,
    apiKeyOk: !!(process.env.GROQ_API_KEY || process.env.GEMINI_API_KEY),
    modelo: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
  });
});

// POST /api/baileys/ia/test
router.post('/ia/test', authMiddleware, async (req, res) => {
  const { mensaje } = req.body;
  if (!mensaje) return res.status(400).json({ error: "Se requiere 'mensaje'" });
  try {
    const { getGeminiReply } = require('../whatsapp/Geminiservice');
    const respuesta = await getGeminiReply('admin_test@test', mensaje);
    // Limpiar el historial de prueba para no contaminar
    clearHistory('admin_test@test');
    res.json({ ok: true, respuesta });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/baileys/ia/clear-history  — borra todos los historiales
router.post('/ia/clear-history', authMiddleware, (req, res) => {
  clearAllHistories();
  res.json({ ok: true });
});

// DELETE /api/baileys/ia/history/:numero  — borra historial de un número
router.delete('/ia/history/:numero', authMiddleware, (req, res) => {
  const jid = req.params.numero.includes('@')
    ? req.params.numero
    : req.params.numero + '@s.whatsapp.net';
  clearHistory(jid);
  res.json({ ok: true });
});

// GET /api/baileys/reset  — reset forzado (también POST)
router.post('/reset', authMiddleware, async (req, res) => {
  try {
    const { resetAndReconnect } = require('../whatsapp/whatsappService');
    await resetAndReconnect();
    res.json({ ok: true, message: 'Reset iniciado' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Endpoints para editar el guión desde el frontend ────────

// PUT /api/baileys/guion/:id
router.put('/guion/:id', authMiddleware, async (req, res) => {
  const { nombre, triggers, response } = req.body;
  if (!nombre || !Array.isArray(triggers) || !response)
    return res.status(400).json({ error: 'nombre, triggers (array) y response son requeridos' });
  try {
    await pool.query(
      `UPDATE bot_guiones SET nombre=$1, triggers=$2, response=$3, updated_at=NOW() WHERE id=$4`,
      [nombre, JSON.stringify(triggers), response, req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    // Si no existe la tabla, responde con un aviso amigable
    res.status(500).json({ error: err.message, hint: 'La tabla bot_guiones puede no existir aún.' });
  }
});

// POST /api/baileys/guion
router.post('/guion', authMiddleware, async (req, res) => {
  const { nombre, triggers, response } = req.body;
  if (!nombre || !Array.isArray(triggers) || !response)
    return res.status(400).json({ error: 'nombre, triggers (array) y response son requeridos' });
  try {
    const r = await pool.query(
      `INSERT INTO bot_guiones (nombre, triggers, response, activo) VALUES ($1,$2,$3,true) RETURNING id`,
      [nombre, JSON.stringify(triggers), response]
    );
    res.json({ ok: true, id: r.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: err.message, hint: 'La tabla bot_guiones puede no existir aún.' });
  }
});