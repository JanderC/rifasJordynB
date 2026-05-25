// routes/upload.js
// ── Endpoint dedicado para subir imágenes a Cloudinary ────
const express  = require('express');
const router   = express.Router();
const pool     = require('../config/db');
const multer   = require('multer');
const { authMiddleware, soloDueno } = require('../middleware/auth');
const { uploadRifa, eliminarImagen, extraerPublicId, cloudinary } = require('../config/cloudinary');

// Storage en memoria para tickets (no necesitan guardarse en BD)
const uploadMemoria = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },   // 10MB máx
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Solo imágenes'), false);
  },
});

/* ── POST /api/upload/ticket ───────────────────────────────
   Sube un ticket generado (PNG) a Cloudinary y devuelve su URL pública.
   Form-data: campo "ticket" con el archivo PNG del ticket.
   Devuelve: { ok, url }
   No requiere autenticación de dueño — cualquier usuario logueado puede usarlo.
────────────────────────────────────────────────────────────*/
router.post(
  '/ticket',
  authMiddleware,
  uploadMemoria.single('ticket'),
  async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'No se recibió ninguna imagen de ticket' });
    }

    try {
      // Subir el buffer directamente a Cloudinary via stream
      const resultado = await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          {
            folder:   'rifas-jordyn/tickets',
            format:   'png',
            // Los tickets son temporales — Cloudinary los puede limpiar con reglas de tag
            tags:     ['ticket', 'rifas-jordyn'],
            // Transformación opcional: asegura calidad alta
            transformation: [{ quality: 'auto:best' }],
          },
          (error, result) => {
            if (error) reject(error);
            else resolve(result);
          }
        );
        stream.end(req.file.buffer);
      });

      res.json({ ok: true, url: resultado.secure_url });
    } catch (err) {
      console.error('[Upload Ticket] Error:', err);
      res.status(500).json({ error: 'Error subiendo ticket a Cloudinary' });
    }
  }
);

/* ── POST /api/upload/rifa/:id/imagen ──────────────────────
   Sube o reemplaza la imagen de una rifa.
   Form-data: campo "imagen" con el archivo.
   Devuelve: { ok, imagen_url }
────────────────────────────────────────────────────────────*/
router.post(
  '/rifa/:id/imagen',
  authMiddleware,
  soloDueno,
  uploadRifa.single('imagen'),   // campo del form-data
  async (req, res) => {
    const { id } = req.params;

    if (!req.file) {
      return res.status(400).json({ error: 'No se recibió ninguna imagen' });
    }

    try {
      // 1. Obtener la URL anterior para eliminarla de Cloudinary
      const rifaActual = await pool.query(
        'SELECT imagen_url FROM rifas WHERE id = $1',
        [id]
      );
      if (!rifaActual.rows[0]) {
        return res.status(404).json({ error: 'Rifa no encontrada' });
      }

      const urlAnterior = rifaActual.rows[0].imagen_url;
      const publicIdAnterior = extraerPublicId(urlAnterior);

      // 2. La nueva URL ya viene en req.file.path (Cloudinary la subió)
      const nuevaUrl = req.file.path;

      // 3. Actualizar la BD
      await pool.query(
        'UPDATE rifas SET imagen_url = $1 WHERE id = $2',
        [nuevaUrl, id]
      );

      // 4. Eliminar imagen anterior de Cloudinary (si existía)
      if (publicIdAnterior) {
        await eliminarImagen(publicIdAnterior);
      }

      res.json({ ok: true, imagen_url: nuevaUrl });
    } catch (err) {
      console.error('[Upload] Error subiendo imagen:', err);
      res.status(500).json({ error: 'Error subiendo imagen' });
    }
  }
);

/* ── DELETE /api/upload/rifa/:id/imagen ────────────────────
   Elimina la imagen de una rifa (Cloudinary + BD).
────────────────────────────────────────────────────────────*/
router.delete(
  '/rifa/:id/imagen',
  authMiddleware,
  soloDueno,
  async (req, res) => {
    const { id } = req.params;

    try {
      const result = await pool.query(
        'SELECT imagen_url FROM rifas WHERE id = $1',
        [id]
      );
      if (!result.rows[0]) {
        return res.status(404).json({ error: 'Rifa no encontrada' });
      }

      const url = result.rows[0].imagen_url;
      const publicId = extraerPublicId(url);

      // Borrar en Cloudinary
      if (publicId) await eliminarImagen(publicId);

      // Limpiar en BD
      await pool.query(
        'UPDATE rifas SET imagen_url = NULL WHERE id = $1',
        [id]
      );

      res.json({ ok: true, mensaje: 'Imagen eliminada' });
    } catch (err) {
      console.error('[Upload] Error eliminando imagen:', err);
      res.status(500).json({ error: 'Error eliminando imagen' });
    }
  }
);

module.exports = router;