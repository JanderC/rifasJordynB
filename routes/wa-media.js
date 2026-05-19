// ============================================================
//  wa-media.js — Biblioteca de medios (imágenes, videos)
//  Sube archivos a Meta API y guarda la URL pública + media_id
// ============================================================
const express  = require('express');
const router   = express.Router();
const pool     = require('../config/db');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const FormData = require('form-data');
const { authMiddleware, soloDueno } = require('../middleware/auth');

// ── Multer: subida temporal al servidor ───────────────────────
const uploadDir = path.join(__dirname, '../uploads/wa-media');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename:    (req, file, cb) => {
    const ext  = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9_-]/g, '_');
    cb(null, `${Date.now()}_${base}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 16 * 1024 * 1024 }, // 16 MB
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg','image/png','image/webp','video/mp4','application/pdf'];
    cb(null, allowed.includes(file.mimetype));
  },
});

// Helper: subir a Meta Media API y obtener media_id
async function subirAMeta(filePath, mimeType, accessToken, phoneNumberId) {
  try {
    const form = new FormData();
    form.append('file', fs.createReadStream(filePath), { contentType: mimeType });
    form.append('messaging_product', 'whatsapp');

    const resp = await fetch(
      `https://graph.facebook.com/v19.0/${phoneNumberId}/media`,
      {
        method:  'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          ...form.getHeaders(),
        },
        body: form,
      }
    );
    const data = await resp.json();
    return data.id || null;
  } catch {
    return null;
  }
}

// ── GET /api/whatsapp/media ───────────────────────────────────
router.get('/', authMiddleware, soloDueno, async (req, res) => {
  try {
    const { tipo } = req.query;
    const values = [];
    let where = '';
    if (tipo) { where = 'WHERE tipo = $1'; values.push(tipo); }

    const r = await pool.query(
      `SELECT m.id, m.nombre, m.tipo, m.url_publica, m.media_id,
              m.mime_type, m.tamanio_kb, m.created_at,
              u.nombre AS creado_por
         FROM wa_media m
         LEFT JOIN users u ON u.id = m.created_by
         ${where}
         ORDER BY m.created_at DESC`,
      values
    );
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/whatsapp/media ──────────────────────────────────
// Acepta: multipart/form-data con campo "archivo" + "nombre" + "url_publica" (opcional)
// Si hay archivo físico, intenta subir a Meta y obtener media_id.
router.post('/', authMiddleware, soloDueno, upload.single('archivo'), async (req, res) => {
  const { nombre, url_publica } = req.body;

  if (!nombre) return res.status(400).json({ error: 'nombre es requerido' });

  let finalUrl    = url_publica || null;
  let media_id    = null;
  let mime_type   = null;
  let tamanio_kb  = null;
  let tipo        = 'image';

  if (req.file) {
    mime_type  = req.file.mimetype;
    tamanio_kb = Math.round(req.file.size / 1024);
    tipo       = mime_type.startsWith('video') ? 'video'
               : mime_type === 'application/pdf' ? 'document'
               : 'image';

    // Construir URL pública usando BASE_URL del entorno
    const baseUrl = process.env.BASE_URL || 'https://tudominio.com';
    finalUrl = `${baseUrl}/uploads/wa-media/${req.file.filename}`;

    // Intentar subir a Meta si hay config activa
    const cfgR = await pool.query(
      `SELECT access_token, phone_number_id FROM wa_config WHERE activo = true LIMIT 1`
    );
    if (cfgR.rows.length) {
      const { access_token, phone_number_id } = cfgR.rows[0];
      media_id = await subirAMeta(req.file.path, mime_type, access_token, phone_number_id);
    }
  } else if (!finalUrl) {
    return res.status(400).json({ error: 'Sube un archivo o proporciona url_publica' });
  }

  try {
    const r = await pool.query(
      `INSERT INTO wa_media (nombre, tipo, url_publica, media_id, mime_type, tamanio_kb, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [nombre, tipo, finalUrl, media_id, mime_type, tamanio_kb, req.user.id]
    );
    res.json({ ok: true, media: r.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/whatsapp/media/:id ───────────────────────────
router.delete('/:id', authMiddleware, soloDueno, async (req, res) => {
  try {
    const r = await pool.query(
      `DELETE FROM wa_media WHERE id = $1 RETURNING id, nombre`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Media no encontrado' });
    res.json({ ok: true, eliminado: r.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
