// ============================================================
//  boleteria.js — Vendedores de una rifa y sus números
//  Quién tiene qué y qué sigue libre. Lo usan el panel (Rifas) y los
//  envíos programados a los vendedores.
// ============================================================
const pool = require('../config/db');
const envios = require('../whatsapp/envios');

async function datosBoleteria(rifa_id) {
  await envios.tablaLista;   // agrega users.telefono

  const rifaR = await pool.query(
    `SELECT id, nombre, COALESCE(tipo, 'sencilla') AS tipo, categoria_seleccionada_id,
            COALESCE(cifras, 3) AS cifras, COALESCE(imagenes_ubicacion, '[]'::jsonb) AS imagenes_ubicacion
     FROM rifas WHERE id = $1`,
    [rifa_id]
  );
  if (!rifaR.rows[0]) return null;
  const rifa         = rifaR.rows[0];
  const cifras       = Number(rifa.cifras) || 3;
  const esSimultanea = rifa.tipo === 'simultanea';

  const vendR = await pool.query(`
    WITH numeros_unidos AS (
      SELECT vendedor_id, numero, COALESCE(serie, 'A') AS serie, 'fijo'::text AS origen
        FROM numeros_vendedor
       WHERE rifa_id = $1
      UNION ALL
      SELECT vendedor_id, numero, serie, 'extra'::text AS origen
        FROM boleteria_numeros_extra
       WHERE rifa_id = $1
    ),
    miembros AS (
      -- Vendedores seleccionados para la rifa (con o sin números)
      SELECT vendedor_id FROM rifa_vendedores_sel WHERE rifa_id = $1
      UNION
      SELECT DISTINCT vendedor_id FROM numeros_unidos
    )
    SELECT
      u.id              AS vendedor_id,
      u.nombre          AS vendedor_nombre,
      u.cedula,
      u.telefono,
      u.ubicacion,
      COALESCE(
        JSON_AGG(
          JSON_BUILD_OBJECT(
            'numero', nu.numero,
            'serie',  nu.serie,
            'origen', nu.origen
          )
          ORDER BY nu.numero, nu.serie
        ) FILTER (WHERE nu.numero IS NOT NULL),
        '[]'::json
      ) AS numeros_fijos
    FROM miembros m
    JOIN users u ON u.id = m.vendedor_id
    LEFT JOIN numeros_unidos nu ON nu.vendedor_id = u.id
    GROUP BY u.id, u.nombre, u.cedula, u.telefono, u.ubicacion
    ORDER BY u.nombre
  `, [rifa_id]);

  let disponiblesA = [];
  let disponiblesB = [];

  const ocupadasPorNum = {};
  const marcar = (numero, serie) => {
    if (!ocupadasPorNum[numero]) ocupadasPorNum[numero] = new Set();
    ocupadasPorNum[numero].add(serie);
  };

  if (rifa.categoria_seleccionada_id) {
    const asigR = await pool.query(
      `SELECT numero, serie FROM cat_global_asignaciones WHERE categoria_id = $1`,
      [rifa.categoria_seleccionada_id]
    );
    asigR.rows.forEach(r => marcar(r.numero, r.serie));
  }

  const extraR = await pool.query(
    `SELECT numero, serie FROM boleteria_numeros_extra WHERE rifa_id = $1`,
    [rifa_id]
  );
  extraR.rows.forEach(r => marcar(r.numero, r.serie));

  const ventasR = await pool.query(
    `SELECT numero, COUNT(*)::int AS veces FROM ventas
      WHERE rifa_id = $1 GROUP BY numero`,
    [rifa_id]
  );
  ventasR.rows.forEach(r => {
    for (let i = 0; i < r.veces; i++) {
      if (!ocupadasPorNum[r.numero]?.has('A'))      marcar(r.numero, 'A');
      else if (!ocupadasPorNum[r.numero]?.has('B')) marcar(r.numero, 'B');
    }
  });

  const reservR = await pool.query(
    `SELECT numero, COUNT(*)::int AS veces FROM reservas_cliente
      WHERE rifa_id = $1 AND (estado = 'pendiente' OR (estado = 'apartado' AND (apartado_hasta > NOW() OR tiene_abono))) GROUP BY numero`,
    [rifa_id]
  );
  reservR.rows.forEach(r => {
    for (let i = 0; i < r.veces; i++) {
      if (!ocupadasPorNum[r.numero]?.has('A')) marcar(r.numero, 'A');
      else if (!ocupadasPorNum[r.numero]?.has('B')) marcar(r.numero, 'B');
    }
  });

  // Qué números de cada vendedor siguen libres (la imagen "Números disponibles").
  // Las ventas no guardan la serie: la venta del propio vendedor consume una de sus
  // series de ese número, y la de quien no lo tiene asignado (cliente por la página,
  // el dueño) se le descuenta a quien lo tiene: mejor esconder uno libre que ofrecer
  // uno vendido.
  const maxVeces = esSimultanea ? 2 : 1;
  const ventasPorVend = (await pool.query(
    `SELECT numero, vendedor_id, COUNT(*)::int AS veces FROM ventas
      WHERE rifa_id = $1 GROUP BY numero, vendedor_id`,
    [rifa_id]
  )).rows;
  const asignados = {};
  vendR.rows.forEach(v => (v.numeros_fijos || []).forEach(n => {
    (asignados[n.numero] ||= new Set()).add(v.vendedor_id);
  }));
  const vecesTotal = {}, propias = {}, ajenas = {};
  ventasPorVend.forEach(({ numero, vendedor_id, veces }) => {
    vecesTotal[numero] = (vecesTotal[numero] || 0) + veces;
    if (asignados[numero]?.has(vendedor_id)) propias[`${vendedor_id}|${numero}`] = veces;
    else ajenas[numero] = (ajenas[numero] || 0) + veces;
  });
  reservR.rows.forEach(({ numero, veces }) => {
    vecesTotal[numero] = (vecesTotal[numero] || 0) + veces;
    ajenas[numero] = (ajenas[numero] || 0) + veces;
  });
  vendR.rows.forEach(v => {
    const gastados = {};
    (v.numeros_fijos || []).forEach(n => {
      const gastar = (propias[`${v.vendedor_id}|${n.numero}`] || 0) + (ajenas[n.numero] || 0);
      gastados[n.numero] = (gastados[n.numero] || 0) + 1;
      n.disponible = (vecesTotal[n.numero] || 0) < maxVeces && gastados[n.numero] > gastar;
    });
  });

  for (let i = 0; i < 10 ** cifras; i++) {
    const numero   = String(i).padStart(cifras, '0');
    const ocupadas = ocupadasPorNum[numero] || new Set();
    if (!ocupadas.has('A'))                disponiblesA.push(numero);
    if (esSimultanea && !ocupadas.has('B')) disponiblesB.push(numero);
  }

  return {
    rifa_id,
    tipo:             rifa.tipo,
    cifras,
    es_simultanea:    esSimultanea,
    tiene_categoria:  !!rifa.categoria_seleccionada_id,
    vendedores:       vendR.rows,
    disponibles_a:    disponiblesA,
    disponibles_b:    esSimultanea ? disponiblesB : [],
    imagenes_ubicacion: rifa.imagenes_ubicacion,
  };
}

module.exports = { datosBoleteria };
