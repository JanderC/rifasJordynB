// routes/resultadosPublicados.js
// ── Resultados de los sorteos (imágenes) ──────────────────
// El dueño publica la imagen del resultado en el panel (módulo Resultados).
// Sale en la página del cliente y el bot la envía al grupo de WhatsApp.
// Las imágenes se guardan en Cloudinary; en la BD solo queda la URL.
// (El número ganador que usa el bot para responder "¿qué cayó?" se sigue
//  cargando en WhatsApp → Resultados; esto es la imagen para publicar.)
const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const pool    = require('../config/db');
const { authMiddleware, soloDueno } = require('../middleware/auth');
const { cloudinary, eliminarImagen, extraerPublicId } = require('../config/cloudinary');
const grupo = require('../whatsapp/grupo');

const tablaLista = (async () => {
  try {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS resultados_publicados (
         id            BIGSERIAL PRIMARY KEY,
         titulo        TEXT NOT NULL,
         descripcion   TEXT,
         rifa_id       UUID REFERENCES rifas(id) ON DELETE SET NULL,
         fecha         DATE,                               -- fecha del sorteo
         imagen_url    TEXT NOT NULL,
         visible       BOOLEAN NOT NULL DEFAULT TRUE,      -- oculto = no sale en la página pública
         enviado_grupo TIMESTAMPTZ,                        -- cuándo lo publicó el bot en el grupo
         created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )`);
  } catch (e) { console.error('[resultados] esquema:', e.message); }
})();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },   // 10MB máx
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Solo se permiten imágenes'), false);
  },
});
const recibirImagen = (req, res, next) => upload.single('imagen')(req, res, (err) => {
  if (!err) return next();
  res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'La imagen pesa más de 10MB' : err.message });
});

function subirACloudinary(buffer) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: 'rifas-jordyn/resultados',
        tags: ['resultado', 'rifas-jordyn'],
        transformation: [{ width: 1600, height: 1600, crop: 'limit', quality: 'auto' }],
      },
      (error, result) => (error ? reject(error) : resolve(result.secure_url))
    );
    stream.end(buffer);
  });
}

const COLUMNAS = `id, titulo, descripcion, rifa_id, TO_CHAR(fecha, 'YYYY-MM-DD') AS fecha, imagen_url, visible, enviado_grupo, created_at`;
const ORDEN = `ORDER BY fecha DESC NULLS LAST, created_at DESC`;

const limpio = (v, max) => { const t = String(v ?? '').trim().slice(0, max); return t || null; };
const fechaValida = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? v : null);
const uuidValido = (v) => (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || '')) ? v : null);
const esVerdadero = (v) => v === true || v === 'true' || v === '1';

// El bot publica la imagen en el grupo. Devuelve { ok, error? } y marca cuándo salió.
async function enviarAlGrupo(r) {
  try {
    await grupo.enviarResultado(r);
    const u = await pool.query(`UPDATE resultados_publicados SET enviado_grupo = NOW() WHERE id = $1 RETURNING ${COLUMNAS}`, [r.id]);
    return { ok: true, resultado: u.rows[0] };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── GET /api/resultados ────────────────────────────────────
// Pública: la consume la página del cliente (solo los visibles)
router.get('/', async (req, res) => {
  try {
    await tablaLista;
    const r = await pool.query(`SELECT ${COLUMNAS} FROM resultados_publicados WHERE visible ${ORDEN} LIMIT 60`);
    res.json(r.rows);
  } catch (err) {
    console.error('[Resultados] Error listando:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ── GET /api/resultados/admin ──────────────────────────────
router.get('/admin', authMiddleware, soloDueno, async (req, res) => {
  try {
    await tablaLista;
    const r = await pool.query(`SELECT ${COLUMNAS} FROM resultados_publicados ${ORDEN}`);
    res.json(r.rows);
  } catch (err) {
    console.error('[Resultados] Error listando (admin):', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ── POST /api/resultados ───────────────────────────────────
// Form-data: imagen (archivo) + titulo, descripcion, rifa_id, fecha, visible, enviar_grupo
router.post('/', authMiddleware, soloDueno, recibirImagen, async (req, res) => {
  const titulo = limpio(req.body.titulo, 160);
  if (!titulo)   return res.status(400).json({ error: 'Escribe el título del resultado' });
  if (!req.file) return res.status(400).json({ error: 'Sube la imagen del resultado' });

  let url = null;
  try {
    await tablaLista;
    url = await subirACloudinary(req.file.buffer);
    const r = await pool.query(
      `INSERT INTO resultados_publicados (titulo, descripcion, rifa_id, fecha, imagen_url, visible)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${COLUMNAS}`,
      [titulo, limpio(req.body.descripcion, 600), uuidValido(req.body.rifa_id), fechaValida(req.body.fecha), url,
       req.body.visible === undefined ? true : esVerdadero(req.body.visible)]);
    let resultado = r.rows[0];
    let grupoInfo = null;
    if (esVerdadero(req.body.enviar_grupo)) {
      grupoInfo = await enviarAlGrupo(resultado);
      if (grupoInfo.ok) resultado = grupoInfo.resultado;
    }
    res.status(201).json({ ...resultado, grupo: grupoInfo ? { ok: grupoInfo.ok, error: grupoInfo.error || null } : null });
  } catch (err) {
    console.error('[Resultados] Error creando:', err);
    if (url) await eliminarImagen(extraerPublicId(url));
    res.status(500).json({ error: 'No se pudo guardar el resultado' });
  }
});

// ── POST /api/resultados/:id/enviar-grupo ──────────────────
// Publica (o vuelve a publicar) la imagen en el grupo de WhatsApp
router.post('/:id/enviar-grupo', authMiddleware, soloDueno, async (req, res) => {
  try {
    await tablaLista;
    const r = await pool.query(`SELECT ${COLUMNAS} FROM resultados_publicados WHERE id = $1`, [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Resultado no encontrado' });
    const g = await enviarAlGrupo(r.rows[0]);
    if (!g.ok) return res.status(400).json({ error: g.error });
    res.json(g.resultado);
  } catch (err) {
    console.error('[Resultados] Error enviando al grupo:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ── PUT /api/resultados/:id ────────────────────────────────
// Mismos campos; la imagen es opcional (si viene, reemplaza la anterior)
router.put('/:id', authMiddleware, soloDueno, recibirImagen, async (req, res) => {
  const titulo = limpio(req.body.titulo, 160);
  if (!titulo) return res.status(400).json({ error: 'Escribe el título del resultado' });

  let urlNueva = null;
  try {
    await tablaLista;
    const actual = await pool.query('SELECT imagen_url FROM resultados_publicados WHERE id = $1', [req.params.id]);
    if (!actual.rows[0]) return res.status(404).json({ error: 'Resultado no encontrado' });
    if (req.file) urlNueva = await subirACloudinary(req.file.buffer);
    const r = await pool.query(
      `UPDATE resultados_publicados
          SET titulo = $1, descripcion = $2, rifa_id = $3, fecha = $4,
              imagen_url = COALESCE($5, imagen_url), visible = $6
        WHERE id = $7 RETURNING ${COLUMNAS}`,
      [titulo, limpio(req.body.descripcion, 600), uuidValido(req.body.rifa_id), fechaValida(req.body.fecha),
       urlNueva, esVerdadero(req.body.visible), req.params.id]);
    if (urlNueva) await eliminarImagen(extraerPublicId(actual.rows[0].imagen_url));
    res.json(r.rows[0]);
  } catch (err) {
    console.error('[Resultados] Error actualizando:', err);
    if (urlNueva) await eliminarImagen(extraerPublicId(urlNueva));
    res.status(500).json({ error: 'No se pudo actualizar el resultado' });
  }
});

// ── PATCH /api/resultados/:id/visible ──────────────────────
router.patch('/:id/visible', authMiddleware, soloDueno, async (req, res) => {
  try {
    await tablaLista;
    const r = await pool.query(
      `UPDATE resultados_publicados SET visible = $1 WHERE id = $2 RETURNING ${COLUMNAS}`,
      [esVerdadero(req.body?.visible), req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Resultado no encontrado' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error('[Resultados] Error cambiando visibilidad:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ── DELETE /api/resultados/:id ─────────────────────────────
router.delete('/:id', authMiddleware, soloDueno, async (req, res) => {
  try {
    await tablaLista;
    const r = await pool.query('DELETE FROM resultados_publicados WHERE id = $1 RETURNING imagen_url', [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Resultado no encontrado' });
    const publicId = extraerPublicId(r.rows[0].imagen_url);
    if (publicId) await eliminarImagen(publicId);
    res.json({ ok: true });
  } catch (err) {
    console.error('[Resultados] Error eliminando:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

module.exports = router;
