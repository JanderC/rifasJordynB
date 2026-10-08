// routes/metodosPago.js
// ── Cuentas bancarias / métodos de pago (solo dueño) ──────
// Lo que se guarda aquí es lo que ve el cliente en la página y lo que
// el bot de WhatsApp le envía al cobrar (GET /api/publico/metodos-pago
// entrega solo las activas).
const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const pool    = require('../config/db');
const { authMiddleware, soloDueno } = require('../middleware/auth');
const { MONEDAS, tablaLista, recargar } = require('../services/metodosPago');
const { cloudinary, eliminarImagen, extraerPublicId } = require('../config/cloudinary');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },   // 5MB máx
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Solo se permiten imágenes'), false);
  },
});
const recibirImagen = (req, res, next) => upload.single('imagen')(req, res, (err) => {
  if (!err) return next();
  res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'La imagen pesa más de 5MB' : err.message });
});

// Los logos se guardan pequeños (se muestran a ~50px); png conserva la transparencia
function subirLogo(buffer) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: 'rifas-jordyn/metodos-pago',
        tags: ['metodo-pago', 'rifas-jordyn'],
        transformation: [{ width: 400, height: 400, crop: 'limit', quality: 'auto' }],
      },
      (error, result) => (error ? reject(error) : resolve(result.secure_url))
    );
    stream.end(buffer);
  });
}

router.use(authMiddleware, soloDueno);

const limpio = (v, max) => String(v ?? '').trim().slice(0, max);

// Valida y normaliza el cuerpo. Devuelve { error } o { datos }.
function leerCuerpo(body) {
  const nombre = limpio(body.nombre, 40);
  if (!nombre) return { error: 'El nombre de la cuenta es obligatorio' };
  const moneda = String(body.moneda || 'COP').toUpperCase();
  if (!MONEDAS.includes(moneda)) return { error: 'Moneda inválida. Debe ser COP, VES o USD' };
  const campos = (Array.isArray(body.campos) ? body.campos : [])
    .map((c) => ({ label: limpio(c?.label, 40), valor: limpio(c?.valor, 160) }))
    .filter((c) => c.label && c.valor)
    .slice(0, 10);
  if (!campos.length) return { error: 'Agrega al menos un dato de la cuenta (por ejemplo: Banco, Número, Titular)' };
  const color = /^#[0-9a-f]{6}$/i.test(String(body.color || '')) ? body.color.toLowerCase() : null;
  return {
    datos: {
      nombre, moneda, campos, color,
      icono: limpio(body.icono, 8) || '💳',
      pais: limpio(body.pais, 60) || null,
      nota: limpio(body.nota, 160) || null,
      presencial: body.presencial === true,
      pedir_titular: body.pedir_titular === true,
      activo: body.activo !== false,
    },
  };
}

const duplicado = (err, res) => {
  if (err.code === '23505') { res.status(409).json({ error: 'Ya existe una cuenta con ese nombre' }); return true; }
  return false;
};

// ── GET /api/metodos-pago ──────────────────────────────────
// Todas (incluye las desactivadas), en el orden en que salen
router.get('/', async (req, res) => {
  try {
    await tablaLista;
    const r = await pool.query(`SELECT * FROM metodos_pago ORDER BY orden, id`);
    res.json(r.rows);
  } catch (err) {
    console.error('[MetodosPago] Error listando:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ── POST /api/metodos-pago ─────────────────────────────────
router.post('/', async (req, res) => {
  const { error, datos: d } = leerCuerpo(req.body || {});
  if (error) return res.status(400).json({ error });
  try {
    await tablaLista;
    const r = await pool.query(
      `INSERT INTO metodos_pago (nombre, icono, color, moneda, pais, campos, nota, presencial, activo, pedir_titular, orden)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, (SELECT COALESCE(MAX(orden), -1) + 1 FROM metodos_pago))
       RETURNING *`,
      [d.nombre, d.icono, d.color, d.moneda, d.pais, JSON.stringify(d.campos), d.nota, d.presencial, d.activo, d.pedir_titular]);
    await recargar();
    res.status(201).json(r.rows[0]);
  } catch (err) {
    if (duplicado(err, res)) return;
    console.error('[MetodosPago] Error creando:', err);
    res.status(500).json({ error: 'No se pudo guardar la cuenta' });
  }
});

// ── PUT /api/metodos-pago/orden ────────────────────────────
// Body: { ids: [id, id, ...] } en el orden en que deben salir
router.put('/orden', async (req, res) => {
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter(Number.isInteger);
  if (!ids.length) return res.status(400).json({ error: 'Falta el orden' });
  try {
    await tablaLista;
    await pool.query(
      `UPDATE metodos_pago m SET orden = x.pos, updated_at = NOW()
         FROM (SELECT id, (ord - 1)::int AS pos FROM unnest($1::bigint[]) WITH ORDINALITY AS t(id, ord)) x
        WHERE m.id = x.id`, [ids]);
    await recargar();
    res.json({ ok: true });
  } catch (err) {
    console.error('[MetodosPago] Error ordenando:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ── PUT /api/metodos-pago/:id ──────────────────────────────
router.put('/:id', async (req, res) => {
  const { error, datos: d } = leerCuerpo(req.body || {});
  if (error) return res.status(400).json({ error });
  try {
    await tablaLista;
    const r = await pool.query(
      `UPDATE metodos_pago
          SET nombre = $1, icono = $2, color = $3, moneda = $4, pais = $5, campos = $6,
              nota = $7, presencial = $8, activo = $9, pedir_titular = $11, updated_at = NOW()
        WHERE id = $10 RETURNING *`,
      [d.nombre, d.icono, d.color, d.moneda, d.pais, JSON.stringify(d.campos), d.nota, d.presencial, d.activo, req.params.id, d.pedir_titular]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Cuenta no encontrada' });
    await recargar();
    res.json(r.rows[0]);
  } catch (err) {
    if (duplicado(err, res)) return;
    console.error('[MetodosPago] Error actualizando:', err);
    res.status(500).json({ error: 'No se pudo actualizar la cuenta' });
  }
});

// ── POST /api/metodos-pago/:id/imagen ──────────────────────
// Sube o reemplaza el logo de la cuenta. Form-data: campo "imagen".
router.post('/:id/imagen', recibirImagen, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibió ninguna imagen' });
  let url = null;
  try {
    await tablaLista;
    const actual = await pool.query(`SELECT imagen_url FROM metodos_pago WHERE id = $1`, [req.params.id]);
    if (!actual.rows[0]) return res.status(404).json({ error: 'Cuenta no encontrada' });
    url = await subirLogo(req.file.buffer);
    const r = await pool.query(
      `UPDATE metodos_pago SET imagen_url = $1, updated_at = NOW() WHERE id = $2 RETURNING *`, [url, req.params.id]);
    const anterior = extraerPublicId(actual.rows[0].imagen_url);
    if (anterior) await eliminarImagen(anterior);
    await recargar();
    res.json(r.rows[0]);
  } catch (err) {
    console.error('[MetodosPago] Error subiendo imagen:', err);
    if (url) await eliminarImagen(extraerPublicId(url));
    res.status(500).json({ error: 'No se pudo subir la imagen' });
  }
});

// ── DELETE /api/metodos-pago/:id/imagen ────────────────────
// Quita el logo: la cuenta vuelve a mostrar su ícono
router.delete('/:id/imagen', async (req, res) => {
  try {
    await tablaLista;
    const actual = await pool.query(`SELECT imagen_url FROM metodos_pago WHERE id = $1`, [req.params.id]);
    if (!actual.rows[0]) return res.status(404).json({ error: 'Cuenta no encontrada' });
    const r = await pool.query(
      `UPDATE metodos_pago SET imagen_url = NULL, updated_at = NOW() WHERE id = $1 RETURNING *`, [req.params.id]);
    const publicId = extraerPublicId(actual.rows[0].imagen_url);
    if (publicId) await eliminarImagen(publicId);
    await recargar();
    res.json(r.rows[0]);
  } catch (err) {
    console.error('[MetodosPago] Error quitando imagen:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ── PATCH /api/metodos-pago/:id/activo ─────────────────────
// Mostrar / ocultar sin borrar. Body: { activo: true|false }
router.patch('/:id/activo', async (req, res) => {
  try {
    await tablaLista;
    const r = await pool.query(
      `UPDATE metodos_pago SET activo = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [req.body?.activo === true, req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Cuenta no encontrada' });
    await recargar();
    res.json(r.rows[0]);
  } catch (err) {
    console.error('[MetodosPago] Error cambiando estado:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ── DELETE /api/metodos-pago/:id ───────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    await tablaLista;
    const r = await pool.query(`DELETE FROM metodos_pago WHERE id = $1 RETURNING id, imagen_url`, [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Cuenta no encontrada' });
    const publicId = extraerPublicId(r.rows[0].imagen_url);
    if (publicId) await eliminarImagen(publicId);
    await recargar();
    res.json({ ok: true });
  } catch (err) {
    console.error('[MetodosPago] Error eliminando:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

module.exports = router;
