// routes/ganadores.js
// ── Galería de ganadores ──────────────────────────────────
// El dueño los carga en Configuración (foto + datos) y salen en la
// página pública del cliente. Las fotos se guardan en Cloudinary;
// en la BD solo queda la URL.
const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const pool    = require('../config/db');
const { authMiddleware, soloDueno } = require('../middleware/auth');
const { cloudinary, eliminarImagen, extraerPublicId } = require('../config/cloudinary');

const CARPETA = 'rifas-jordyn/ganadores';

const tablaLista = (async () => {
  try {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS ganadores (
         id          BIGSERIAL PRIMARY KEY,
         nombre      TEXT NOT NULL,
         premio      TEXT,
         numero      VARCHAR(10),
         rifa        TEXT,                              -- nombre del sorteo (texto libre)
         ciudad      TEXT,
         fecha       DATE,
         imagen_url  TEXT NOT NULL,
         visible     BOOLEAN NOT NULL DEFAULT TRUE,     -- oculto = no sale en la página pública
         created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )`
    );
  } catch (e) { console.error('[ganadores] esquema:', e.message); }
})();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },   // 10MB máx
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Solo se permiten imágenes'), false);
  },
});

// multer falla con su propio error (archivo muy grande, no es imagen): se responde 400 claro
const recibirImagen = (req, res, next) => upload.single('imagen')(req, res, (err) => {
  if (!err) return next();
  const msg = err.code === 'LIMIT_FILE_SIZE' ? 'La imagen pesa más de 10MB' : err.message;
  res.status(400).json({ error: msg });
});

function subirACloudinary(buffer) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: CARPETA,
        tags: ['ganador', 'rifas-jordyn'],
        transformation: [{ width: 1600, height: 1600, crop: 'limit', quality: 'auto' }],
      },
      (error, result) => (error ? reject(error) : resolve(result.secure_url))
    );
    stream.end(buffer);
  });
}

const COLUMNAS = `id, nombre, premio, numero, rifa, ciudad, TO_CHAR(fecha, 'YYYY-MM-DD') AS fecha, imagen_url, visible, created_at`;
const ORDEN = `ORDER BY fecha DESC NULLS LAST, created_at DESC`;

const limpio = (v, max = 200) => {
  const t = String(v ?? '').trim().slice(0, max);
  return t || null;
};
const fechaValida = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? v : null);
const esVerdadero = (v) => v === true || v === 'true' || v === '1';

// ── GET /api/ganadores ─────────────────────────────────────
// Pública: la consume la página del cliente (solo los visibles)
router.get('/', async (req, res) => {
  try {
    await tablaLista;
    const r = await pool.query(`SELECT ${COLUMNAS} FROM ganadores WHERE visible ${ORDEN}`);
    res.json(r.rows);
  } catch (err) {
    console.error('[Ganadores] Error listando:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ── GET /api/ganadores/admin ───────────────────────────────
// Todos (incluye ocultos), para el módulo de Configuración
router.get('/admin', authMiddleware, soloDueno, async (req, res) => {
  try {
    await tablaLista;
    const r = await pool.query(`SELECT ${COLUMNAS} FROM ganadores ${ORDEN}`);
    res.json(r.rows);
  } catch (err) {
    console.error('[Ganadores] Error listando (admin):', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ── POST /api/ganadores ────────────────────────────────────
// Form-data: imagen (archivo) + nombre, premio, numero, rifa, ciudad, fecha, visible
router.post('/', authMiddleware, soloDueno, recibirImagen, async (req, res) => {
  const nombre = limpio(req.body.nombre);
  if (!nombre)   return res.status(400).json({ error: 'El nombre del ganador es obligatorio' });
  if (!req.file) return res.status(400).json({ error: 'Sube la foto del ganador' });

  let url = null;
  try {
    await tablaLista;
    url = await subirACloudinary(req.file.buffer);
    const r = await pool.query(
      `INSERT INTO ganadores (nombre, premio, numero, rifa, ciudad, fecha, imagen_url, visible)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING ${COLUMNAS}`,
      [nombre, limpio(req.body.premio), limpio(req.body.numero, 10), limpio(req.body.rifa), limpio(req.body.ciudad),
       fechaValida(req.body.fecha), url, req.body.visible === undefined ? true : esVerdadero(req.body.visible)]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    console.error('[Ganadores] Error creando:', err);
    if (url) await eliminarImagen(extraerPublicId(url));   // no dejar la foto huérfana
    res.status(500).json({ error: 'No se pudo guardar el ganador' });
  }
});

// ── PUT /api/ganadores/:id ─────────────────────────────────
// Mismos campos; la imagen es opcional (si viene, reemplaza la anterior)
router.put('/:id', authMiddleware, soloDueno, recibirImagen, async (req, res) => {
  const nombre = limpio(req.body.nombre);
  if (!nombre) return res.status(400).json({ error: 'El nombre del ganador es obligatorio' });

  let urlNueva = null;
  try {
    await tablaLista;
    const actual = await pool.query('SELECT imagen_url FROM ganadores WHERE id = $1', [req.params.id]);
    if (!actual.rows[0]) return res.status(404).json({ error: 'Ganador no encontrado' });

    if (req.file) urlNueva = await subirACloudinary(req.file.buffer);
    const r = await pool.query(
      `UPDATE ganadores
          SET nombre = $1, premio = $2, numero = $3, rifa = $4, ciudad = $5, fecha = $6,
              imagen_url = COALESCE($7, imagen_url), visible = $8
        WHERE id = $9
        RETURNING ${COLUMNAS}`,
      [nombre, limpio(req.body.premio), limpio(req.body.numero, 10), limpio(req.body.rifa), limpio(req.body.ciudad),
       fechaValida(req.body.fecha), urlNueva, esVerdadero(req.body.visible), req.params.id]
    );
    if (urlNueva) await eliminarImagen(extraerPublicId(actual.rows[0].imagen_url));
    res.json(r.rows[0]);
  } catch (err) {
    console.error('[Ganadores] Error actualizando:', err);
    if (urlNueva) await eliminarImagen(extraerPublicId(urlNueva));
    res.status(500).json({ error: 'No se pudo actualizar el ganador' });
  }
});

// ── PATCH /api/ganadores/:id/visible ───────────────────────
// Mostrar / ocultar en la página pública. Body: { visible: true|false }
router.patch('/:id/visible', authMiddleware, soloDueno, async (req, res) => {
  try {
    await tablaLista;
    const r = await pool.query(
      `UPDATE ganadores SET visible = $1 WHERE id = $2 RETURNING ${COLUMNAS}`,
      [esVerdadero(req.body?.visible), req.params.id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Ganador no encontrado' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error('[Ganadores] Error cambiando visibilidad:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ── DELETE /api/ganadores/:id ──────────────────────────────
// Borra el ganador y su foto en Cloudinary
router.delete('/:id', authMiddleware, soloDueno, async (req, res) => {
  try {
    await tablaLista;
    const r = await pool.query('DELETE FROM ganadores WHERE id = $1 RETURNING imagen_url', [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Ganador no encontrado' });
    const publicId = extraerPublicId(r.rows[0].imagen_url);
    if (publicId) await eliminarImagen(publicId);
    res.json({ ok: true });
  } catch (err) {
    console.error('[Ganadores] Error eliminando:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

module.exports = router;
