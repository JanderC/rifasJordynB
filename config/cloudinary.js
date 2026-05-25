// config/cloudinary.js
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const multer = require('multer');

// ── Configurar SDK con variables de entorno ────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ── Storage para imágenes de rifas ────────────────────────
const storageRifas = new CloudinaryStorage({
  cloudinary,
  params: {
    folder:         'rifas-jordyn/rifas',   // carpeta en tu cuenta Cloudinary
    allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
    transformation: [{ width: 1200, height: 800, crop: 'limit', quality: 'auto' }],
  },
});

// ── Middleware de upload (máx 5MB por imagen) ─────────────
const uploadRifa = multer({
  storage: storageRifas,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Solo se permiten imágenes'), false);
    }
  },
});

// ── Eliminar imagen de Cloudinary por su public_id ────────
async function eliminarImagen(public_id) {
  try {
    await cloudinary.uploader.destroy(public_id);
  } catch (err) {
    console.error('[Cloudinary] Error eliminando imagen:', err.message);
  }
}

// ── Extraer public_id desde una URL de Cloudinary ─────────
// Ej: https://res.cloudinary.com/dvlke3252/image/upload/v123/rifas-jordyn/rifas/abc.jpg
// → "rifas-jordyn/rifas/abc"
function extraerPublicId(url) {
  if (!url) return null;
  try {
    const match = url.match(/\/upload\/(?:v\d+\/)?(.+?)(\.[^.]+)?$/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

module.exports = { cloudinary, uploadRifa, eliminarImagen, extraerPublicId };