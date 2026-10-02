// ============================================================
//  vendedores.js — Directorio de vendedores (solo lectura)
//  Junta lo que ya existe en el sistema: datos del vendedor, sus
//  números fijos por categoría (Números Fijos) y las rifas donde
//  participa con los números que tiene en cada una.
//  Lo usan el panel (Vendedores) y el bot cuando pregunta el dueño.
// ============================================================
const pool = require('../config/db');

// Rifas que se muestran: las activas y las sorteadas en los últimos días
const DIAS_RIFAS_PASADAS = 30;

const porSerie = (filas) => {
  const out = {};
  for (const f of filas) (out[f.serie] = out[f.serie] || []).push(f.numero);
  for (const s of Object.keys(out)) out[s].sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
  return out;
};

// texto: filtra por nombre, usuario o cédula (opcional)
async function directorio({ texto = '' } = {}) {
  const filtro = String(texto || '').trim();
  const usuarios = await pool.query(`
    SELECT u.id, u.nombre, u.usuario, u.cedula, u.activo, u.created_at,
           COUNT(v.id)::int AS total_ventas, COALESCE(SUM(v.precio_venta), 0) AS total_ingresos,
           MAX(v.created_at) AS ultima_venta
      FROM users u
      LEFT JOIN ventas v ON v.vendedor_id = u.id AND COALESCE(v.origen, 'vendedor') = 'vendedor'
     WHERE u.rol = 'vendedor'
       AND ($1 = '' OR u.nombre ILIKE '%' || $1 || '%' OR u.usuario ILIKE '%' || $1 || '%' OR COALESCE(u.cedula, '') ILIKE '%' || $1 || '%')
     GROUP BY u.id
     ORDER BY u.activo DESC, u.nombre`, [filtro]);
  if (!usuarios.rows.length) return [];
  const ids = usuarios.rows.map((u) => u.id);

  const [fijos, enRifas, seleccion, ventasRifa] = await Promise.all([
    // Números fijos: lo asignado en cada categoría de Números Fijos
    pool.query(`
      SELECT cga.vendedor_id, cg.id AS categoria_id, cg.nombre AS categoria, cg.tipo,
             TRIM(cga.numero::text) AS numero, COALESCE(TRIM(cga.serie::text), 'A') AS serie
        FROM cat_global_asignaciones cga JOIN categorias_globales cg ON cg.id = cga.categoria_id
       WHERE cga.vendedor_id = ANY($1::uuid[])`, [ids]),
    // Números que tiene en cada rifa (los fijos que bajaron a la rifa + los extra de boletería)
    pool.query(`
      SELECT x.vendedor_id, x.rifa_id, x.numero, x.serie, x.origen
        FROM (
          SELECT vendedor_id, rifa_id, TRIM(numero::text) AS numero, COALESCE(TRIM(serie::text), 'A') AS serie, 'fijo' AS origen FROM numeros_vendedor
          UNION ALL
          SELECT vendedor_id, rifa_id, TRIM(numero::text), COALESCE(TRIM(serie::text), 'A'), 'extra' FROM boleteria_numeros_extra
        ) x JOIN rifas r ON r.id = x.rifa_id
       WHERE x.vendedor_id = ANY($1::uuid[])
         AND (r.activa OR r.fecha_sorteo >= (NOW() AT TIME ZONE 'America/Caracas')::date - $2::int)`, [ids, DIAS_RIFAS_PASADAS]),
    // Rifas donde fue seleccionado (aunque todavía no tenga números) y con qué categoría
    pool.query(`
      SELECT s.vendedor_id, r.id AS rifa_id, r.nombre, r.activa, COALESCE(r.tipo, 'sencilla') AS tipo,
             r.fecha_sorteo::text AS fecha_sorteo, cg.nombre AS categoria
        FROM rifas r
        JOIN (
          SELECT rifa_id, vendedor_id, categoria_global_id FROM rifa_vendedores_sel
          UNION
          SELECT rifa_id, vendedor_id, NULL::uuid FROM numeros_vendedor
          UNION
          SELECT rifa_id, vendedor_id, NULL::uuid FROM boleteria_numeros_extra
        ) s ON s.rifa_id = r.id
        LEFT JOIN categorias_globales cg ON cg.id = s.categoria_global_id
       WHERE s.vendedor_id = ANY($1::uuid[])
         AND (r.activa OR r.fecha_sorteo >= (NOW() AT TIME ZONE 'America/Caracas')::date - $2::int)`, [ids, DIAS_RIFAS_PASADAS]),
    pool.query(`
      SELECT vendedor_id, rifa_id, COUNT(*)::int AS n FROM ventas
       WHERE vendedor_id = ANY($1::uuid[]) AND COALESCE(origen, 'vendedor') = 'vendedor' GROUP BY 1, 2`, [ids]),
  ]);

  const ventasDe = new Map(ventasRifa.rows.map((x) => [`${x.vendedor_id}|${x.rifa_id}`, x.n]));

  return usuarios.rows.map((u) => {
    // Números fijos agrupados por categoría
    const cats = new Map();
    for (const f of fijos.rows) {
      if (f.vendedor_id !== u.id) continue;
      const c = cats.get(f.categoria_id) || { categoria: f.categoria, tipo: f.tipo, filas: [] };
      c.filas.push(f);
      cats.set(f.categoria_id, c);
    }
    const numeros_fijos = [...cats.values()]
      .map((c) => ({ categoria: c.categoria, tipo: c.tipo, cantidad: c.filas.length, series: porSerie(c.filas) }))
      .sort((a, b) => a.categoria.localeCompare(b.categoria));

    // Rifas donde participa (una fila por rifa; la categoría viene de la selección)
    const rifas = new Map();
    for (const s of seleccion.rows) {
      if (s.vendedor_id !== u.id) continue;
      const r = rifas.get(s.rifa_id) || { rifa_id: s.rifa_id, rifa: s.nombre, activa: s.activa, tipo: s.tipo, fecha_sorteo: s.fecha_sorteo, categoria: null, filas: [] };
      if (s.categoria) r.categoria = s.categoria;
      rifas.set(s.rifa_id, r);
    }
    for (const n of enRifas.rows) {
      if (n.vendedor_id === u.id) rifas.get(n.rifa_id)?.filas.push(n);
    }
    const listaRifas = [...rifas.values()]
      .map((r) => ({
        rifa_id: r.rifa_id, rifa: r.rifa, activa: r.activa, tipo: r.tipo, fecha_sorteo: r.fecha_sorteo, categoria: r.categoria,
        cantidad: r.filas.length, extras: r.filas.filter((f) => f.origen === 'extra').length,
        vendidos: ventasDe.get(`${u.id}|${r.rifa_id}`) || 0,
        series: porSerie(r.filas),
      }))
      .sort((a, b) => Number(b.activa) - Number(a.activa) || String(b.fecha_sorteo || '').localeCompare(String(a.fecha_sorteo || '')));

    return {
      id: u.id, nombre: u.nombre, usuario: u.usuario, cedula: u.cedula, activo: u.activo, created_at: u.created_at,
      total_ventas: u.total_ventas, total_ingresos: Number(u.total_ingresos), ultima_venta: u.ultima_venta,
      total_numeros_fijos: numeros_fijos.reduce((s, c) => s + c.cantidad, 0),
      numeros_fijos, rifas: listaRifas,
    };
  });
}

module.exports = { directorio };
