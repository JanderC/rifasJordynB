// ============================================================
//  decoracion.js — Decoraciones de la página del cliente por fecha
//  (Navidad, Año Nuevo, Semana Santa, Halloween...). El dueño las arma
//  en el panel: colores, efecto e imágenes, y cuándo salen. Aquí se
//  valida lo que llega y se decide cuál toca hoy; se guardan en
//  config_sitio (services/sitio.js).
// ============================================================
const crypto = require('crypto');

const TZ_NEGOCIO = 'America/Caracas';
const MAX_DECORACIONES = 40;

const PLANTILLAS = ['navidad', 'anio_nuevo', 'semana_santa', 'halloween', 'carnaval', 'patrias', 'madres', 'amor', 'personalizada'];
const EFECTOS    = ['ninguno', 'nieve', 'confeti', 'estrellas', 'corazones', 'murcielagos', 'petalos', 'imagen'];
const GUIRNALDAS = ['ninguna', 'luces', 'banderines', 'estrellas', 'murcielagos', 'corazones', 'flores', 'imagen'];
const ESQUINAS   = ['ninguna', 'acebo', 'telarana', 'globos', 'flores'];
const INTENSIDADES = ['poca', 'media', 'mucha'];
const CUANDO     = ['manual', 'fijas', 'cada_anio', 'semana_santa', 'carnaval'];

const IMAGENES = ['img_banner_pc', 'img_banner_movil', 'img_fondo', 'img_esquina_izq', 'img_esquina_der', 'img_guirnalda', 'img_efecto', 'img_logo'];

const HEX_RE   = /^#[0-9a-f]{6}$/i;
const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;
const MES_DIA_RE = /^\d{2}-\d{2}$/;

const texto = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const opcion = (v, lista, defecto) => (lista.includes(v) ? v : defecto);
const color = (v, defecto) => (HEX_RE.test(String(v || '')) ? String(v).toLowerCase() : defecto);

// Las imágenes van a CSS y a <img>: solo se aceptan las de nuestra cuenta de Cloudinary
function imagen(v) {
  const t = String(v || '').trim();
  if (!t) return '';
  let u;
  try { u = new URL(t); } catch { return null; }
  const propia = u.protocol === 'https:' && u.hostname === 'res.cloudinary.com'
    && (!process.env.CLOUDINARY_CLOUD_NAME || u.pathname.startsWith(`/${process.env.CLOUDINARY_CLOUD_NAME}/`));
  return propia && !/["'()\\\s]/.test(t) ? t : null;
}

function limpiarDecoracion(d) {
  const nombre = texto(d?.nombre, 60);
  if (!nombre) throw new Error('Cada decoración necesita un nombre');
  const cuando = opcion(d.cuando, CUANDO, 'manual');
  const limpia = {
    id: /^[\w-]{6,40}$/.test(String(d.id || '')) ? d.id : crypto.randomUUID(),
    nombre,
    plantilla: opcion(d.plantilla, PLANTILLAS, 'personalizada'),
    activa: d.activa !== false,
    cuando,
    desde: '', hasta: '',
    color1: color(d.color1, '#0abfbc'),
    color2: color(d.color2, '#ffd166'),
    color_fondo: color(d.color_fondo, '#e9fafa'),
    tono: d.tono === 'oscuro' ? 'oscuro' : 'claro',
    velo: Math.min(90, Math.max(0, Math.round(Number(d.velo)) || 0)),
    efecto: opcion(d.efecto, EFECTOS, 'ninguno'),
    intensidad: opcion(d.intensidad, INTENSIDADES, 'media'),
    guirnalda: opcion(d.guirnalda, GUIRNALDAS, 'ninguna'),
    esquinas: opcion(d.esquinas, ESQUINAS, 'ninguna'),
    mensaje: texto(d.mensaje, 80),
    titulo1: texto(d.titulo1, 60),
    titulo2: texto(d.titulo2, 60),
  };
  for (const k of IMAGENES) {
    const url = imagen(d[k]);
    if (url === null) throw new Error('Una de las imágenes no es válida. Vuelve a subirla');
    limpia[k] = url;
  }
  if (cuando === 'fijas') {
    if (!FECHA_RE.test(d.desde || '') || !FECHA_RE.test(d.hasta || '')) throw new Error(`Faltan las fechas de "${nombre}"`);
    if (d.desde > d.hasta) throw new Error(`En "${nombre}" la fecha final es antes de la inicial`);
    limpia.desde = d.desde; limpia.hasta = d.hasta;
  }
  if (cuando === 'cada_anio') {
    if (!MES_DIA_RE.test(d.desde || '') || !MES_DIA_RE.test(d.hasta || '')) throw new Error(`Faltan las fechas de "${nombre}"`);
    limpia.desde = d.desde; limpia.hasta = d.hasta;
  }
  return limpia;
}

// Lo que llega del panel: { modo, lista }. modo: 'auto' (por fechas), 'apagada' o el id de una decoración.
function limpiarConfig(cambios) {
  if (!Array.isArray(cambios?.lista)) throw new Error('Datos de decoración inválidos');
  if (cambios.lista.length > MAX_DECORACIONES) throw new Error(`Máximo ${MAX_DECORACIONES} decoraciones`);
  const lista = cambios.lista.map(limpiarDecoracion);
  const modo = cambios.modo === 'apagada' || lista.some((d) => d.id === cambios.modo) ? cambios.modo : 'auto';
  return { modo, lista };
}

const hoyNegocio = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ_NEGOCIO, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

const aFecha = (iso) => new Date(`${iso}T12:00:00Z`);
const aIso = (d) => d.toISOString().slice(0, 10);
const sumarDias = (iso, n) => { const d = aFecha(iso); d.setUTCDate(d.getUTCDate() + n); return aIso(d); };

// Domingo de Pascua (cálculo gregoriano de Meeus/Jones/Butcher)
function pascua(anio) {
  const a = anio % 19, b = Math.floor(anio / 100), c = anio % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31), dia = ((h + l - 7 * m + 114) % 31) + 1;
  return `${anio}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

// Semana Santa: del Domingo de Ramos al de Resurrección. Carnaval: del viernes al martes.
const RANGO_MOVIL = {
  semana_santa: (anio) => ({ desde: sumarDias(pascua(anio), -7), hasta: pascua(anio) }),
  carnaval:     (anio) => ({ desde: sumarDias(pascua(anio), -51), hasta: sumarDias(pascua(anio), -47) }),
};

// El rango de la decoración que incluye `hoy`, o la próxima vez que le toca
function rangoDe(d, hoy) {
  const anio = Number(hoy.slice(0, 4));
  if (d.cuando === 'fijas') return { desde: d.desde, hasta: d.hasta };
  if (RANGO_MOVIL[d.cuando]) {
    const r = RANGO_MOVIL[d.cuando](anio);
    return r.hasta < hoy ? RANGO_MOVIL[d.cuando](anio + 1) : r;
  }
  if (d.cuando === 'cada_anio') {
    const cruza = d.desde > d.hasta;   // 24-12 → 02-01 pasa al año siguiente
    for (const a of [anio - 1, anio, anio + 1]) {
      const r = { desde: `${a}-${d.desde}`, hasta: `${cruza ? a + 1 : a}-${d.hasta}` };
      if (r.hasta >= hoy) return r;
    }
  }
  return null;
}

const dias = (r) => Math.round((aFecha(r.hasta) - aFecha(r.desde)) / 86400000);

// La que se ve hoy: la forzada, o la de fechas. Si dos coinciden gana la de rango
// más corto: Año Nuevo se ve encima de una Navidad que dure todo diciembre.
function vigente(cfg, hoy = hoyNegocio()) {
  if (!cfg || cfg.modo === 'apagada') return null;
  const lista = cfg.lista || [];
  if (cfg.modo && cfg.modo !== 'auto') return lista.find((d) => d.id === cfg.modo) || null;
  const candidatas = lista
    .filter((d) => d.activa)
    .map((d) => ({ d, r: rangoDe(d, hoy) }))
    .filter(({ r }) => r && r.desde <= hoy && hoy <= r.hasta)
    .sort((a, b) => dias(a.r) - dias(b.r));
  return candidatas[0]?.d || null;
}

// Para el panel: cuál se ve y las próximas fechas de cada una
function resumen(cfg, hoy = hoyNegocio()) {
  const anio = Number(hoy.slice(0, 4));
  const proximo = (m) => { const r = RANGO_MOVIL[m](anio); return r.hasta < hoy ? RANGO_MOVIL[m](anio + 1) : r; };
  const rangos = {};
  for (const d of cfg.lista) rangos[d.id] = rangoDe(d, hoy);
  return {
    ...cfg,
    hoy,
    vigente_id: vigente(cfg, hoy)?.id || null,
    rangos,
    moviles: { semana_santa: proximo('semana_santa'), carnaval: proximo('carnaval') },
  };
}

module.exports = { limpiarConfig, vigente, resumen, pascua, rangoDe, hoyNegocio };
