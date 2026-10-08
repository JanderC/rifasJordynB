// ============================================================
//  sesionDB.js — La sesión de WhatsApp sobrevive a los despliegues
//
//  Baileys guarda la sesión en archivos (carpeta sessions/). En Railway esa
//  carpeta vive dentro del contenedor y se borra en cada despliegue, así que
//  había que volver a escanear el QR cada vez que se subía un cambio.
//
//  Aquí se respalda esa carpeta en la base de datos (tabla wa_sesion_archivos)
//  y se restaura al arrancar si la carpeta está vacía. Baileys sigue usando
//  sus archivos como siempre: esto solo los copia de ida y de vuelta.
//   • restaurar(dir)  — al iniciar: si no hay creds.json en disco, baja todo de la BD
//   • respaldar(dir)  — sube los archivos nuevos o cambiados y quita los que ya no existen
//   • borrar()        — al cerrar sesión: vacía el respaldo (para no restaurar una sesión muerta)
// ============================================================
const fs = require('fs');
const path = require('path');
const pool = require('../config/db');

const tablaLista = (async () => {
  try {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS wa_sesion_archivos (
         nombre      TEXT PRIMARY KEY,
         contenido   TEXT NOT NULL,
         updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )`);
  } catch (e) { console.error('[sesionDB] esquema:', e.message); }
})();

// nombre → mtime del archivo cuando se respaldó por última vez
const respaldados = new Map();

// Devuelve cuántos archivos restauró (0 si ya había sesión en disco o no hay respaldo)
async function restaurar(dir) {
  await tablaLista;
  if (fs.existsSync(path.join(dir, 'creds.json'))) return 0;
  const r = await pool.query(`SELECT nombre, contenido FROM wa_sesion_archivos`);
  if (!r.rows.some((x) => x.nombre === 'creds.json')) return 0;   // sin credenciales no hay sesión que restaurar
  fs.mkdirSync(dir, { recursive: true });
  for (const { nombre, contenido } of r.rows) {
    // Solo nombres de archivo simples: nada de rutas
    if (path.basename(nombre) !== nombre) continue;
    const f = path.join(dir, nombre);
    fs.writeFileSync(f, contenido);
    respaldados.set(nombre, fs.statSync(f).mtimeMs);
  }
  console.log(`♻️  [WhatsApp] Sesión restaurada desde la base de datos (${r.rows.length} archivos).`);
  return r.rows.length;
}

let respaldando = false;
// Sube lo nuevo/cambiado y elimina del respaldo lo que Baileys ya borró del disco
async function respaldar(dir) {
  await tablaLista;
  if (respaldando || !fs.existsSync(path.join(dir, 'creds.json'))) return 0;
  respaldando = true;
  try {
    const enDisco = fs.readdirSync(dir).filter((n) => {
      try { return fs.statSync(path.join(dir, n)).isFile(); } catch { return false; }
    });
    const cambiados = [];
    for (const nombre of enDisco) {
      let st; try { st = fs.statSync(path.join(dir, nombre)); } catch { continue; }
      if (respaldados.get(nombre) === st.mtimeMs) continue;
      let contenido; try { contenido = fs.readFileSync(path.join(dir, nombre), 'utf8'); } catch { continue; }
      if (!contenido) continue;   // a medio escribir: va en la próxima pasada
      cambiados.push({ nombre, contenido, mtime: st.mtimeMs });
    }
    for (let i = 0; i < cambiados.length; i += 150) {
      const lote = cambiados.slice(i, i + 150);
      await pool.query(
        `INSERT INTO wa_sesion_archivos (nombre, contenido, updated_at)
         SELECT n, c, NOW() FROM unnest($1::text[], $2::text[]) AS t(n, c)
         ON CONFLICT (nombre) DO UPDATE SET contenido = EXCLUDED.contenido, updated_at = NOW()`,
        [lote.map((x) => x.nombre), lote.map((x) => x.contenido)]);
      lote.forEach((x) => respaldados.set(x.nombre, x.mtime));
    }
    const quitados = await pool.query(`DELETE FROM wa_sesion_archivos WHERE NOT (nombre = ANY($1::text[]))`, [enDisco]);
    for (const n of [...respaldados.keys()]) if (!enDisco.includes(n)) respaldados.delete(n);
    return cambiados.length + quitados.rowCount;
  } finally { respaldando = false; }
}

async function borrar() {
  await tablaLista;
  respaldados.clear();
  await pool.query(`DELETE FROM wa_sesion_archivos`);
}

module.exports = { restaurar, respaldar, borrar, tablaLista };
