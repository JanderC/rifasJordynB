// ============================================================
//  imagenes.js — Nada de base64 en la BD
//  Cualquier imagen que llegue como dataURL (data:image/...;base64,...)
//  se sube a Cloudinary y en la BD solo se guarda la URL.
// ============================================================
const { cloudinary } = require('../config/cloudinary');

const DATA_URL_RE = /^data:([\w/+.-]+);base64,/i;

function esDataUrl(valor) {
  return typeof valor === 'string' && DATA_URL_RE.test(valor);
}

// Sube un dataURL a Cloudinary y devuelve la secure_url.
// Si el valor no es un dataURL (ya es una URL, null, etc.) lo devuelve tal cual.
async function subirSiEsBase64(valor, { folder, transformation } = {}) {
  if (!esDataUrl(valor)) return valor;
  const r = await cloudinary.uploader.upload(valor, {
    folder,
    resource_type: 'auto',     // imágenes y también PDFs (comprobantes)
    ...(transformation ? { transformation } : {}),
  });
  return r.secure_url;
}

// Recorre un objeto/array (p. ej. el design JSON de un ticket) y reemplaza
// cada dataURL por su URL de Cloudinary. Devuelve una copia nueva.
// Un mismo dataURL repetido se sube una sola vez.
async function reemplazarBase64EnJson(obj, { folder } = {}) {
  const cache = new Map();
  const visitar = async (v) => {
    if (esDataUrl(v)) {
      if (!cache.has(v)) cache.set(v, subirSiEsBase64(v, { folder }));
      return cache.get(v);
    }
    if (Array.isArray(v)) return Promise.all(v.map(visitar));
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, val] of Object.entries(v)) out[k] = await visitar(val);
      return out;
    }
    return v;
  };
  return visitar(obj);
}

const CARPETAS = {
  rifas:         'rifas-jordyn/rifas',
  ticketDesigns: 'rifas-jordyn/ticket-designs',
  comprobantes:  'rifas-jordyn/comprobantes',
};

// Misma transformación que usa uploadRifa en config/cloudinary.js
const TRANSFORM_RIFA = [{ width: 1200, height: 800, crop: 'limit', quality: 'auto' }];

module.exports = { esDataUrl, subirSiEsBase64, reemplazarBase64EnJson, CARPETAS, TRANSFORM_RIFA };
