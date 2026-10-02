// ============================================================
//  ganadores.js — Galería de ganadores (foto + datos)
//  Los carga el dueño en Configuración. Salen en la página pública y el
//  bot de WhatsApp manda la foto cuando preguntan qué número cayó.
// ============================================================
const pool = require('../config/db');

const tablaLista = (async () => {
  const sqls = [
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
     )`,
    // Sorteo al que pertenece (opcional): con esto el bot sabe de qué resultado es la foto
    `ALTER TABLE ganadores ADD COLUMN IF NOT EXISTS rifa_id UUID REFERENCES rifas(id) ON DELETE SET NULL`,
  ];
  for (const sql of sqls) {
    try { await pool.query(sql); } catch (e) { console.error('[ganadores] esquema:', e.message); }
  }
})();

// "045" y "45" son el mismo número
const sinCeros = (n) => String(n ?? '').replace(/\D/g, '').replace(/^0+(?=\d)/, '');

// Foto del ganador de cada resultado de unos sorteos (los de resultados.sorteosRecientes).
// Devuelve Map: id del resultado → ganador { id, nombre, premio, numero, imagen_url }.
// Se empareja por el sorteo elegido al cargar la foto; si no se eligió, por número + fecha del sorteo.
async function fotosDeResultados(sorteos) {
  await tablaLista;
  const out = new Map();
  const conResultados = sorteos.filter((s) => Array.isArray(s.resultados) && s.resultados.length);
  if (!conResultados.length) return out;
  const r = await pool.query(
    `SELECT id, nombre, premio, numero, rifa_id, TO_CHAR(fecha, 'YYYY-MM-DD') AS fecha, imagen_url
       FROM ganadores
      WHERE visible AND (rifa_id = ANY($1::uuid[]) OR fecha = ANY($2::date[]))
      ORDER BY created_at DESC`,
    [conResultados.map((s) => s.id), conResultados.map((s) => s.fecha_sorteo)]);
  for (const s of conResultados) {
    const delSorteo = r.rows.filter((g) => g.rifa_id === s.id);
    const porFecha  = r.rows.filter((g) => !g.rifa_id && g.fecha === s.fecha_sorteo && g.numero);
    for (const x of s.resultados) {
      const g = delSorteo.find((d) => d.numero && sinCeros(d.numero) === sinCeros(x.numero))
        // Sorteo de un solo premio con la foto cargada sin número: es esa
        || (s.resultados.length === 1 ? delSorteo.find((d) => !d.numero) : null)
        || porFecha.find((d) => sinCeros(d.numero) === sinCeros(x.numero));
      if (g) out.set(x.id, g);
    }
  }
  return out;
}

async function porIds(ids) {
  await tablaLista;
  const limpios = [...new Set((ids || []).map(Number).filter(Number.isInteger))];
  if (!limpios.length) return [];
  const r = await pool.query(
    `SELECT id, nombre, premio, numero, rifa, imagen_url FROM ganadores WHERE visible AND id = ANY($1::bigint[])`, [limpios]);
  return r.rows;
}

module.exports = { tablaLista, fotosDeResultados, porIds };
