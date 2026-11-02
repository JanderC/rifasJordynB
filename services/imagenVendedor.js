// ============================================================
//  imagenVendedor.js — Imagen con los números disponibles de un vendedor
//  La misma del panel (utils/imagenVendedor.js en el frontend), hecha en
//  el servidor para los envíos programados: la publicidad de la rifa
//  arriba y sus números en cuadritos.
// ============================================================
const sharp = require('sharp');
const { TITULO, DIGITOS } = require('./glifos');

const ANCHO    = 1080;
const MARGEN   = 40;
const PADDING  = 34;
const INTERIOR = ANCHO - MARGEN * 2 - PADDING * 2;
const FOTO_MAX = 720;
const GAP      = 10;
const FRANJA   = 84;

const columnasPara = (total, dig) => {
  const cols = total <= 36 ? 6 : total <= 80 ? 8 : total <= 150 ? 10 : 12;
  return dig >= 4 ? Math.min(cols, 8) : cols;
};

// Un texto de dígitos centrado en (cx, cy), con el tamaño de letra dado
function numeroSvg(numero, cx, cy, fuente) {
  const glifos = String(numero).split('').map((c) => DIGITOS[c]).filter(Boolean);
  const escala = fuente / 1000;
  const total = glifos.reduce((s, g) => s + g.ancho, 0) * escala;
  let x = cx - total / 2;
  const y = cy + fuente * 0.35;
  return glifos.map((g) => {
    const p = `<path transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) scale(${escala.toFixed(4)})" d="${g.d}"/>`;
    x += g.ancho * escala;
    return p;
  }).join('');
}

async function traerFoto(url) {
  if (!url) return null;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) return null;
    return Buffer.from(await r.arrayBuffer());
  } catch { return null; }
}

// numeros: ya ordenados. Devuelve un JPEG en un Buffer.
async function generarImagenVendedor({ numeros, dig, imagen }) {
  const original = await traerFoto(imagen);
  const meta = original ? await sharp(original).metadata().catch(() => null) : null;
  const foto = meta?.width ? original : null;

  const cols = columnasPara(numeros.length, dig);
  const celda = (INTERIOR - GAP * (cols - 1)) / cols;
  const altoCelda = Math.round(celda * 0.64);
  const fuente = Math.round(celda * (dig >= 4 ? 0.3 : 0.36));
  const filas = Math.ceil(numeros.length / cols);

  const escalaFoto = foto ? Math.min((ANCHO - MARGEN * 2) / meta.width, FOTO_MAX / meta.height) : 0;
  const altoFoto = foto ? Math.round(meta.height * escalaFoto) : 0;
  const anchoFoto = foto ? Math.round(meta.width * escalaFoto) : 0;
  const altoTarjeta = PADDING + FRANJA + 22 + filas * (altoCelda + GAP) - GAP + PADDING;
  const altoTotal = MARGEN + (foto ? altoFoto + 28 : 0) + altoTarjeta + MARGEN;

  // Fondo: la misma publicidad difuminada y oscurecida
  const fondo = foto
    ? await sharp(foto).resize(ANCHO, altoTotal, { fit: 'cover' }).blur(40).modulate({ brightness: 0.55 }).png().toBuffer()
    : await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${ANCHO}" height="${altoTotal}"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0a3d62"/><stop offset="1" stop-color="#0b6e5f"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/></svg>`)).png().toBuffer();

  const capas = [];
  let y = MARGEN;
  if (foto) {
    const mascara = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${anchoFoto}" height="${altoFoto}"><rect width="100%" height="100%" rx="22"/></svg>`);
    const redondeada = await sharp(foto).resize(anchoFoto, altoFoto).composite([{ input: mascara, blend: 'dest-in' }]).png().toBuffer();
    capas.push({ input: redondeada, left: Math.round((ANCHO - anchoFoto) / 2), top: y });
    y += altoFoto + 28;
  }

  const y0 = y;
  const x0 = MARGEN + PADDING;
  const yFranja = y0 + PADDING;
  const yNumeros = yFranja + FRANJA + 22;
  const escalaTitulo = 40 / 1000;
  const anchoTitulo = TITULO.ancho * escalaTitulo;
  const celdas = numeros.map((n, i) => {
    const fila = Math.floor(i / cols);
    const x = x0 + (i % cols) * (celda + GAP);
    const yc = yNumeros + fila * (altoCelda + GAP);
    return `<rect x="${x.toFixed(1)}" y="${yc}" width="${celda.toFixed(1)}" height="${altoCelda}" rx="10" fill="url(#verde)" stroke="#10261a" stroke-width="3"/>`
      + numeroSvg(n, x + celda / 2, yc + altoCelda / 2, fuente);
  }).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${ANCHO}" height="${altoTotal}">
    <defs><linearGradient id="verde" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#b4e0bc"/><stop offset="1" stop-color="#6fae82"/></linearGradient></defs>
    <rect x="${MARGEN}" y="${y0}" width="${ANCHO - MARGEN * 2}" height="${altoTarjeta}" rx="26" fill="#ffffff"/>
    <rect x="${x0}" y="${yFranja}" width="${INTERIOR}" height="${FRANJA}" rx="16" fill="#0a3d62"/>
    <path fill="#ffffff" transform="translate(${((ANCHO - anchoTitulo) / 2).toFixed(1)} ${yFranja + FRANJA / 2 + 15}) scale(${escalaTitulo})" d="${TITULO.d}"/>
    <g fill="#0a1a12">${celdas}</g>
  </svg>`;
  capas.push({ input: Buffer.from(svg), left: 0, top: 0 });

  return sharp(fondo).composite(capas).jpeg({ quality: 90 }).toBuffer();
}

module.exports = { generarImagenVendedor };
