/**
 * routes/wa-baileys.js
 * Endpoints REST para controlar la instancia de WhatsApp con Baileys.
 *
 * Montar en server.js:
 *   app.use("/api/baileys", require("./routes/wa-baileys"));
 *
 * Endpoints:
 *   GET  /api/baileys/status          → estado de conexión
 *   GET  /api/baileys/qr              → imagen QR en base64
 *   POST /api/baileys/send/text       → enviar texto plano
 *   POST /api/baileys/send/image      → enviar imagen con caption
 *   POST /api/baileys/logout          → cerrar sesión
 *   GET  /api/baileys/guion           → ver guión activo (debug)
 *   POST /api/baileys/guion/test      → probar respuesta de un mensaje
 */

const express = require("express");
const router = express.Router();
const multer = require("multer");

const {
  sendText,
  sendImage,
  getStatus,
  getQRBase64,
  logout,
} = require("../whatsapp/whatsappService");

const { getAutoReply, getGuion } = require("../whatsapp/autoReply");

// ── Multer en memoria (imágenes sin guardar en disco) ───────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // máx 10 MB
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) {
      return cb(new Error("Solo se permiten imágenes."), false);
    }
    cb(null, true);
  },
});

// ── Middleware de auth simple ───────────────────────────────
function waAuth(req, res, next) {
  const secret = process.env.WA_SECRET_KEY;
  if (!secret) return next();
  const key = req.headers["x-wa-key"];
  if (key !== secret) {
    return res.status(401).json({ error: "No autorizado." });
  }
  next();
}

// ── GET /api/baileys/status ─────────────────────────────────
router.get("/status", waAuth, (req, res) => {
  res.json(getStatus());
});

// ── GET /api/baileys/qr ─────────────────────────────────────
router.get("/qr", waAuth, async (req, res) => {
  try {
    const qrBase64 = await getQRBase64();
    if (!qrBase64) {
      const { status } = getStatus();
      if (status === "open") {
        return res.json({ ok: true, message: "Ya conectado, no hay QR activo." });
      }
      return res.status(404).json({ error: "QR no disponible aún. Espera unos segundos." });
    }
    res.json({ ok: true, qr: qrBase64 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/baileys/send/text ─────────────────────────────
// Body JSON: { "numero": "04241234567", "mensaje": "Hola!" }
router.post("/send/text", waAuth, async (req, res) => {
  const { numero, mensaje } = req.body;

  if (!numero || !mensaje) {
    return res.status(400).json({ error: "Se requieren 'numero' y 'mensaje'." });
  }

  try {
    const result = await sendText(numero, mensaje);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/baileys/send/image ────────────────────────────
// Forma 1 — multipart/form-data: campo "imagen" + "numero" + "caption"
// Forma 2 — application/json:   { "numero", "imagenUrl" | "imagenBase64", "caption" }
router.post(
  "/send/image",
  waAuth,
  (req, res, next) => {
    const ct = req.headers["content-type"] || "";
    if (ct.includes("multipart/form-data")) {
      return upload.single("imagen")(req, res, next);
    }
    next();
  },
  async (req, res) => {
    try {
      const numero = req.body?.numero;
      const caption = req.body?.caption || "";

      if (!numero) {
        return res.status(400).json({ error: "Se requiere 'numero'." });
      }

      let imageSource;

      if (req.file) {
        imageSource = req.file.buffer;
      } else if (req.body?.imagenUrl) {
        imageSource = req.body.imagenUrl;
      } else if (req.body?.imagenBase64) {
        imageSource = req.body.imagenBase64;
      } else {
        return res.status(400).json({
          error: "Se requiere una imagen: campo 'imagen' (file), 'imagenUrl' o 'imagenBase64'.",
        });
      }

      const result = await sendImage(numero, imageSource, caption);
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// ── POST /api/baileys/logout ────────────────────────────────
router.post("/logout", waAuth, async (req, res) => {
  try {
    await logout();
    res.json({ ok: true, message: "Sesión cerrada. Reinicia el servidor para reconectar." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/baileys/guion ──────────────────────────────────
// Muestra el guión activo en memoria (útil para verificar sin reiniciar)
router.get("/guion", waAuth, (req, res) => {
  const guion = getGuion();
  res.json({
    ok: true,
    total: guion.length,
    guion: guion.map((g) => ({
      id: g.id,
      nombre: g.nombre,
      triggers: g.triggers,
      responsePreview: g.response.substring(0, 80) + "...",
    })),
  });
});

// ── POST /api/baileys/guion/test ────────────────────────────
// Prueba qué respuesta generaría un mensaje sin enviarlo
// Body JSON: { "mensaje": "hola quiero comprar" }
router.post("/guion/test", waAuth, (req, res) => {
  const { mensaje } = req.body;
  if (!mensaje) {
    return res.status(400).json({ error: "Se requiere 'mensaje'." });
  }
  const respuesta = getAutoReply(mensaje);
  res.json({ ok: true, input: mensaje, response: respuesta });
});

module.exports = router;