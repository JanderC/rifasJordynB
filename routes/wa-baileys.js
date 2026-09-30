/**
 * routes/wa-baileys.js — Conexión de WhatsApp (Baileys) y envío de tickets
 *
 *   GET  /api/baileys/status              estado de la conexión
 *   GET  /api/baileys/qr                  QR para vincular (imagen)
 *   POST /api/baileys/pairing-code        código de 8 dígitos para vincular sin QR
 *   POST /api/baileys/reconnect           reconectar sin borrar la sesión
 *   POST /api/baileys/logout              cerrar sesión (queda un QR nuevo)
 *   POST /api/baileys/reset               borrar sesión local y pedir QR nuevo
 *   POST /api/baileys/send/text           enviar texto a un número
 *   POST /api/baileys/send/image          enviar imagen a un número
 *   POST /api/baileys/send/ticket         enviar ticket(s) sin cambiar la BD
 *   POST /api/baileys/reservas/:id/confirmar
 *        → aprueba la reserva (registra la VENTA, cuadra en Caja) y envía
 *          el ticket por WhatsApp al chat del cliente.
 *
 * Los chats en tiempo real y la configuración del bot están en routes/wa-chat.js
 */

const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const pool    = require('../config/db');
const { authMiddleware } = require('../middleware/auth');
const { aprobarReservasTx, avisarAprobadas } = require('../services/reservas');
const envios = require('../whatsapp/envios');

const {
  sendText,
  sendImage,
  sendTicketConfirmacion,
  getStatus,
  getQRBase64,
  requestPairingCode,
  reconectar,
  logout,
  resetAndReconnect,
} = require('../whatsapp/whatsappService');

// ── Multer en memoria ───────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('Solo imágenes.'), false);
    cb(null, true);
  },
});

// ── Middleware de auth para control de la conexión ──────────
// Acepta el JWT del frontend (solo dueño) o la clave x-wa-key.
// Si WA_SECRET_KEY está vacía NO queda abierto: sin JWT de dueño → 401.
function waAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      const jwt = require('jsonwebtoken');
      req.user = jwt.verify(authHeader.slice(7), process.env.JWT_SECRET);
      if (req.user.rol !== 'dueno') return res.status(403).json({ error: 'Solo el dueño puede gestionar WhatsApp.' });
      return next();
    } catch (_) {}
  }
  const secret = process.env.WA_SECRET_KEY;
  if (secret && req.headers['x-wa-key'] === secret) return next();
  return res.status(401).json({ error: 'No autorizado.' });
}

// ── Conexión ────────────────────────────────────────────────
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

// Vincular con código de 8 dígitos (sin escanear QR). Body: { numero: "584241234567" }
router.post('/pairing-code', waAuth, async (req, res) => {
  try {
    const code = await requestPairingCode(req.body?.numero);
    res.json({ ok: true, code });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.post('/reconnect', waAuth, (req, res) => {
  reconectar();
  res.json({ ok: true, message: 'Reconectando…' });
});

router.post('/logout', waAuth, async (req, res) => {
  try {
    await logout();
    res.json({ ok: true, message: 'Sesión cerrada.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/reset', waAuth, async (req, res) => {
  try {
    await resetAndReconnect();
    res.json({ ok: true, message: 'Reset iniciado' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Envío directo ───────────────────────────────────────────
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
      if (req.file)                    imageSource = req.file.buffer;
      else if (req.body?.imagenUrl)    imageSource = req.body.imagenUrl;
      else if (req.body?.imagenBase64) imageSource = req.body.imagenBase64;
      else return res.status(400).json({ error: "Se requiere imagen: 'imagen', 'imagenUrl' o 'imagenBase64'." });

      const result = await sendImage(numero, imageSource, caption);
      res.json({ ok: true, ...result });
    } catch (err) { res.status(500).json({ error: err.message }); }
  }
);

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
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ────────────────────────────────────────────────────────────
// POST /api/baileys/reservas/:id/confirmar
// Auth: JWT del dueño (Bearer) o x-wa-key.
// Body: { nota?, ticketUrls?: string[], ticketsBase64?: string[], pdfBase64?, mensajeTexto }
// Aprueba también las demás reservas pendientes del mismo cliente en la rifa.
// ────────────────────────────────────────────────────────────
function extraerUrlsDelMensaje(texto) {
  const cloudinary = texto.match(/https:\/\/res\.cloudinary\.com\/[^\s\n]+/g) || [];
  const otras      = texto.match(/https:\/\/[^\s\n]+\.(?:png|jpg|jpeg|webp)/gi) || [];
  return [...new Set([...cloudinary, ...otras])];
}

router.post('/reservas/:id/confirmar', waAuth, async (req, res) => {
  const { id } = req.params;
  const { nota, ticketsBase64 = [], ticketUrls = [], pdfBase64, mensajeTexto } = req.body;
  if (!mensajeTexto) return res.status(400).json({ error: "Se requiere 'mensajeTexto'." });

  const imagenesParaWA = ticketUrls.length > 0
    ? ticketUrls
    : ticketsBase64.length > 0 ? ticketsBase64 : extraerUrlsDelMensaje(mensajeTexto);

  const client = await pool.connect();
  let reserva, aprobadas, autoRechazadas;
  try {
    await client.query('BEGIN');
    const rRes = await client.query(`SELECT * FROM reservas_cliente WHERE id = $1`, [id]);
    reserva = rRes.rows[0];
    if (!reserva) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Reserva no encontrada.' }); }
    if (reserva.estado === 'aprobado') { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Reserva ya aprobada.' }); }

    const herRes = await client.query(`
      SELECT id FROM reservas_cliente
       WHERE rifa_id = $1 AND LOWER(TRIM(nombre_cliente)) = LOWER(TRIM($2))
         AND estado = 'pendiente' AND id != $3`, [reserva.rifa_id, reserva.nombre_cliente, id]);

    // Antes solo marcaba 'aprobado' sin registrar la venta: el número quedaba
    // vendido pero no aparecía en ventas/Caja. Ahora usa la aprobación única.
    ({ aprobadas, autoRechazadas } = await aprobarReservasTx(client, [id, ...herRes.rows.map((r) => r.id)], nota));
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ [Confirmar] Error BD:', err.message);
    return res.status(500).json({ error: err.message });
  } finally { client.release(); }

  avisarAprobadas(aprobadas);
  if (!aprobadas.length) {
    return res.status(409).json({
      error: autoRechazadas.length
        ? `El número ${String(autoRechazadas[0].numero).trim()} ya alcanzó el máximo de ventas; la reserva se rechazó automáticamente.`
        : 'La reserva ya no estaba pendiente.',
      auto_rechazado: autoRechazadas.length > 0,
    });
  }

  // El ticket NO se envía aquí: se encola y sale de forma dinámica (anti-bloqueo).
  // Así aprobar es instantáneo y varias aprobaciones seguidas no generan ráfagas.
  const destino = reserva.wa_jid || reserva.telefono;
  let envio = null, waError = null;
  if (destino) {
    // Foto de cada número aprobado (en su orden); si no vino emparejada, en el orden recibido
    const porNumero = new Map((req.body.tickets || []).filter((x) => x?.url).map((x) => [String(x.numero).trim(), x.url]));
    const tickets = porNumero.size
      ? aprobadas.map((r) => ({ numero: String(r.numero).trim(), url: porNumero.get(String(r.numero).trim()) })).filter((x) => x.url)
      : imagenesParaWA.filter((u) => /^https?:\/\//.test(u)).map((url, i) => ({ numero: String(aprobadas[i]?.numero || '').trim(), url }));
    try {
      envio = await envios.encolarTicket({ reservas: aprobadas, tickets, nota, destino });
    } catch (e) {
      console.error('⚠️  [Confirmar] No se pudo encolar el ticket:', e.message);
      waError = e.message;
    }
  }

  res.json({
    ok: true,
    aprobados: aprobadas.length,
    ids: aprobadas.map((r) => r.id),
    auto_rechazados: autoRechazadas.length,
    envio,                                  // { id, estado: 'en_cola', frio, ... }
    waEncolado: !!envio, waError: waError || undefined,
    sinTelefono: !destino,
  });
});

// Reintentar un envío de ticket que falló
router.post('/envios/:id/reintentar', waAuth, async (req, res) => {
  try { res.json(await envios.reintentar(Number(req.params.id))); } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
