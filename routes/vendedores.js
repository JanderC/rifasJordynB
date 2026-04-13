// ============================================================
//   RIFAS JORDYN — Vendedores + Categorías Globales  (v6)
//
//   CAMBIOS v6:
//   ─────────────────────────────────────────────────────────
//   • resolverSerie (SIMULTÁNEA): un vendedor SÍ puede tener
//     el mismo número en Serie A y en Serie B.
//     - Vendedor tiene A, B libre   → asignar B  ← NUEVO
//     - Vendedor tiene B, A libre   → asignar A  ← edge-case
//     - Vendedor tiene A y B        → sin espacio ← NUEVO
//     - Vendedor tiene A, B tomada por otro → sin espacio
//
//   • asignarSeriesParaVendedor: "pendiente" = número que NO
//     tiene AMBAS series asignadas (simultánea). Parcial = igual.
//
//   • POST /numeros: si número ya está en pool y categoría es
//     simultánea, auto-asigna la siguiente serie disponible.
//
//   • GET /vendedores-resumen: COUNT(DISTINCT cvn.numero) para
//     evitar doble-conteo cuando vendedor tiene A y B del mismo
//     número.
//
//   TABLAS (sin cambios de schema):
//   ─────────────────────────────────────────────
//   cat_vendedor_numeros
//     UNIQUE (categoria_id, vendedor_id, numero)
//
//   cat_global_asignaciones
//     UNIQUE (categoria_id, numero, serie)   ← 1 dueño por serie
// ============================================================

const express = require('express');
const router  = express.Router();
const bcrypt  = require('bcryptjs');
const pool    = require('../config/db');
const { authMiddleware, soloDueno } = require('../middleware/auth');

/* ══════════════════════════════════════════════════════════════
   FUNCIÓN CENTRAL: resolverSerie  (v6)
══════════════════════════════════════════════════════════════ */
async function resolverSerie(client, categoriaId, numero, vendedorId, tipo) {
  const r = await client.query(
    `SELECT cga.serie, cga.vendedor_id, u.nombre
     FROM cat_global_asignaciones cga
     JOIN users u ON u.id = cga.vendedor_id
     WHERE cga.categoria_id = $1 AND cga.numero = $2
     ORDER BY cga.serie`,
    [categoriaId, numero]
  );

  const ocupadaA = r.rows.find(x => x.serie === 'A') || null;
  const ocupadaB = r.rows.find(x => x.serie === 'B') || null;

  // ── PARCIAL ───────────────────────────────────────────────
  if (tipo === 'parcial') {
    if (!ocupadaA) {
      return { serie: 'A', disponible: true, ocupadaA: null, ocupadaB: null,
        mensaje: 'Número libre. Se asignará en Serie A.' };
    }
    if (String(ocupadaA.vendedor_id) === String(vendedorId)) {
      return { serie: null, disponible: false, ocupadaA, ocupadaB: null,
        mensaje: 'Ya tienes este número asignado (Serie A).' };
    }
    return { serie: null, disponible: false, ocupadaA, ocupadaB: null,
      mensaje: `Número ocupado por ${ocupadaA.nombre} (Serie A).` };
  }

  // ── SIMULTÁNEA (v6) ───────────────────────────────────────
  const selfA = ocupadaA && String(ocupadaA.vendedor_id) === String(vendedorId);
  const selfB = ocupadaB && String(ocupadaB.vendedor_id) === String(vendedorId);

  // Vendedor ya tiene AMBAS series → sin espacio
  if (selfA && selfB) {
    return { serie: null, disponible: false, ocupadaA, ocupadaB,
      mensaje: `Ya tienes el ${numero} en Serie A y en Serie B. No hay más espacio.` };
  }

  // Vendedor tiene A, B libre → asignar B (segunda serie del mismo vendedor)
  if (selfA && !ocupadaB) {
    return { serie: 'B', disponible: true, ocupadaA, ocupadaB: null,
      mensaje: `Ya tienes Serie A. Se asignará en Serie B.` };
  }

  // Vendedor tiene A, B ocupada por otro → sin espacio
  if (selfA && ocupadaB && !selfB) {
    return { serie: null, disponible: false, ocupadaA, ocupadaB,
      mensaje: `Ya tienes Serie A. Serie B está ocupada por ${ocupadaB.nombre}.` };
  }

  // Vendedor tiene B, A libre → asignar A (edge-case: puede pasar si A fue liberada)
  if (selfB && !ocupadaA) {
    return { serie: 'A', disponible: true, ocupadaA: null, ocupadaB,
      mensaje: `Ya tienes Serie B. Se asignará en Serie A.` };
  }

  // Vendedor tiene B, A ocupada por otro → sin espacio
  if (selfB && ocupadaA && !selfA) {
    return { serie: null, disponible: false, ocupadaA, ocupadaB,
      mensaje: `Ya tienes Serie B. Serie A está ocupada por ${ocupadaA.nombre}.` };
  }

  // Flujo normal: vendedor no tiene ninguna serie de este número
  if (!ocupadaA) {
    return { serie: 'A', disponible: true, ocupadaA: null, ocupadaB,
      mensaje: 'Serie A libre. Se asignará en Serie A.' };
  }
  if (!ocupadaB) {
    return { serie: 'B', disponible: true, ocupadaA, ocupadaB: null,
      mensaje: `Serie A ocupada por ${ocupadaA.nombre}. Se asignará en Serie B.` };
  }

  // Ambas tomadas por otros
  return { serie: null, disponible: false, ocupadaA, ocupadaB,
    mensaje: `Sin espacio. Serie A: ${ocupadaA.nombre} / Serie B: ${ocupadaB.nombre}.` };
}

/* ══════════════════════════════════════════════════════════════
   HELPER: asignarSeriesParaVendedor  (v6)
   Para simultánea: "pendiente" = no tiene AÚN las 2 series.
   Para parcial: "pendiente" = sin ninguna asignación (igual).
══════════════════════════════════════════════════════════════ */
async function asignarSeriesParaVendedor(client, categoriaId, vendedorId, tipo) {
  const poolR = await client.query(
    `SELECT numero FROM cat_vendedor_numeros
     WHERE categoria_id = $1 AND vendedor_id = $2
     ORDER BY numero`,
    [categoriaId, vendedorId]
  );
  if (!poolR.rows.length) return { insertados: [], colisiones: [] };

  // Obtener todas las asignaciones existentes del vendedor (numero + serie)
  const asigR = await client.query(
    `SELECT numero, serie FROM cat_global_asignaciones
     WHERE categoria_id = $1 AND vendedor_id = $2`,
    [categoriaId, vendedorId]
  );

  // Mapa: numero → ['A'], ['B'], o ['A','B']
  const seriesMap = {};
  asigR.rows.forEach(row => {
    if (!seriesMap[row.numero]) seriesMap[row.numero] = [];
    seriesMap[row.numero].push(row.serie);
  });

  // Filtrar los pendientes
  const pendientes = poolR.rows.map(r => r.numero).filter(n => {
    if (tipo === 'simultanea') {
      // Pendiente si tiene 0 o 1 series (puede obtener otra)
      return (seriesMap[n] || []).length < 2;
    } else {
      // Parcial: pendiente si no tiene ninguna
      return !(seriesMap[n] && seriesMap[n].length > 0);
    }
  });

  if (!pendientes.length) return { insertados: [], colisiones: [] };

  const insertados = [];
  const colisiones = [];

  for (const numero of pendientes) {
    const resolucion = await resolverSerie(client, categoriaId, numero, vendedorId, tipo);

    if (resolucion.disponible) {
      const ins = await client.query(
        `INSERT INTO cat_global_asignaciones (categoria_id, vendedor_id, numero, serie)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (categoria_id, numero, serie) DO NOTHING
         RETURNING id, numero, serie`,
        [categoriaId, vendedorId, numero, resolucion.serie]
      );
      if (ins.rows[0]) {
        insertados.push({ numero, serie: resolucion.serie, mensaje: resolucion.mensaje });
      } else {
        // Rarísimo: concurrencia → re-resolver
        const reintento = await resolverSerie(client, categoriaId, numero, vendedorId, tipo);
        if (reintento.disponible) {
          const ins2 = await client.query(
            `INSERT INTO cat_global_asignaciones (categoria_id, vendedor_id, numero, serie)
             VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING id, numero, serie`,
            [categoriaId, vendedorId, numero, reintento.serie]
          );
          if (ins2.rows[0]) insertados.push({ numero, serie: reintento.serie, mensaje: reintento.mensaje });
          else colisiones.push({ numero, ...reintento });
        } else {
          colisiones.push({ numero, ...reintento });
        }
      }
    } else {
      colisiones.push({ numero, ...resolucion });
    }
  }

  return { insertados, colisiones };
}

function generarCredenciales(nombre) {
  const base = nombre.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, '').trim()
    .split(/\s+/).join('_').slice(0, 20);
  const sufijo = Math.floor(1000 + Math.random() * 9000);
  return { usuario: `${base}_${sufijo}`, password: `${base}${sufijo}` };
}

/* ══════════════════════════════════════════════════════════════
   RUTAS DE VENDEDORES  —  /api/vendedores
══════════════════════════════════════════════════════════════ */

router.get('/', authMiddleware, soloDueno, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT u.id, u.nombre, u.usuario, u.cedula, u.rol, u.activo, u.created_at,
        COUNT(DISTINCT v.id)::int              AS total_ventas,
        COALESCE(SUM(v.precio_venta), 0)       AS total_ingresos,
        COUNT(DISTINCT cvn.numero || cvn.categoria_id::text)::int AS numeros_count,
        COUNT(DISTINCT cvn.categoria_id)::int  AS categorias_count
      FROM users u
      LEFT JOIN ventas v               ON v.vendedor_id = u.id
      LEFT JOIN cat_vendedor_numeros cvn ON cvn.vendedor_id = u.id
      WHERE u.rol = 'vendedor'
      GROUP BY u.id, u.nombre, u.usuario, u.cedula, u.rol, u.activo, u.created_at
      ORDER BY u.nombre
    `);
    res.json(result.rows);
  } catch (err) { console.error('GET /vendedores:', err); res.status(500).json({ error: 'Error del servidor' }); }
});

router.get('/:id', authMiddleware, soloDueno, async (req, res) => {
  try {
    const [userR, numerosR, rifasR, ventasR] = await Promise.all([
      pool.query('SELECT id, nombre, usuario, cedula, rol, activo, created_at FROM users WHERE id=$1', [req.params.id]),
      pool.query(
        `SELECT cvn.categoria_id, cg.nombre AS categoria_nombre, cg.tipo,
                JSON_AGG(DISTINCT cvn.numero ORDER BY cvn.numero) AS numeros
         FROM cat_vendedor_numeros cvn
         JOIN categorias_globales cg ON cg.id = cvn.categoria_id
         WHERE cvn.vendedor_id = $1
         GROUP BY cvn.categoria_id, cg.nombre, cg.tipo ORDER BY cg.nombre`,
        [req.params.id]
      ),
      pool.query(
        `SELECT nv.rifa_id, r.nombre AS rifa_nombre, r.activa,
                COUNT(nv.numero)::int AS numeros_en_rifa, COUNT(v.id)::int AS ventas_en_rifa
         FROM numeros_vendedor nv JOIN rifas r ON r.id = nv.rifa_id
         LEFT JOIN ventas v ON v.rifa_id=nv.rifa_id AND v.numero=nv.numero AND v.vendedor_id=nv.vendedor_id
         WHERE nv.vendedor_id=$1 GROUP BY nv.rifa_id, r.nombre, r.activa ORDER BY r.activa DESC`,
        [req.params.id]
      ),
      pool.query(
        `SELECT v.*, r.nombre AS rifa_nombre FROM ventas v JOIN rifas r ON r.id=v.rifa_id
         WHERE v.vendedor_id=$1 ORDER BY v.created_at DESC LIMIT 20`,
        [req.params.id]
      ),
    ]);
    if (!userR.rows[0]) return res.status(404).json({ error: 'Vendedor no encontrado' });
    res.json({ vendedor: userR.rows[0], numeros_por_cat: numerosR.rows, rifas_participando: rifasR.rows, ventas_recientes: ventasR.rows });
  } catch (err) { console.error('GET /vendedores/:id:', err); res.status(500).json({ error: 'Error del servidor' }); }
});

router.put('/:id', authMiddleware, soloDueno, async (req, res) => {
  const { nombre, password, activo, cedula } = req.body;
  try {
    const fields = []; const params = []; let i = 1;
    if (nombre)                     { fields.push(`nombre=$${i++}`);  params.push(nombre); }
    if (typeof activo === 'boolean') { fields.push(`activo=$${i++}`);  params.push(activo); }
    if (cedula !== undefined)        { fields.push(`cedula=$${i++}`);  params.push(cedula || null); }
    if (password) {
      if (password.length < 6) return res.status(400).json({ error: 'Contraseña mínimo 6 caracteres' });
      fields.push(`password=$${i++}`); params.push(await bcrypt.hash(password, 10));
    }
    if (!fields.length) return res.status(400).json({ error: 'Nada que actualizar' });
    params.push(req.params.id);
    const r = await pool.query(`UPDATE users SET ${fields.join(',')} WHERE id=$${i} RETURNING id,nombre,usuario,cedula,rol,activo`, params);
    if (!r.rows[0]) return res.status(404).json({ error: 'Vendedor no encontrado' });
    res.json({ message: 'Vendedor actualizado', vendedor: r.rows[0] });
  } catch (err) { console.error('PUT /vendedores/:id:', err); res.status(500).json({ error: 'Error del servidor' }); }
});

router.delete('/:id', authMiddleware, soloDueno, async (req, res) => {
  try {
    const v = await pool.query('SELECT COUNT(*) FROM ventas WHERE vendedor_id=$1', [req.params.id]);
    if (parseInt(v.rows[0].count) > 0)
      return res.status(400).json({ error: 'No se puede eliminar: tiene ventas registradas. Desactívalo.' });
    await pool.query('DELETE FROM numeros_vendedor WHERE vendedor_id=$1', [req.params.id]);
    await pool.query('DELETE FROM users WHERE id=$1', [req.params.id]);
    res.json({ message: 'Vendedor eliminado' });
  } catch (err) { console.error('DELETE /vendedores/:id:', err); res.status(500).json({ error: 'Error del servidor' }); }
});

/* ══════════════════════════════════════════════════════════════
   RUTAS DE CATEGORÍAS GLOBALES  —  /api/categorias-globales
══════════════════════════════════════════════════════════════ */
const catRouter = express.Router();

catRouter.get('/', authMiddleware, soloDueno, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT cg.id, cg.nombre, cg.tipo, cg.monto, cg.descripcion, cg.created_at,
        COUNT(DISTINCT cga.vendedor_id)::int                      AS total_vendedores,
        COUNT(DISTINCT cga.id)::int                               AS total_asignaciones,
        COUNT(CASE WHEN cga.serie='A' THEN 1 END)::int            AS numeros_serie_a,
        COUNT(CASE WHEN cga.serie='B' THEN 1 END)::int            AS numeros_serie_b,
        COUNT(DISTINCT cvn.numero)::int                           AS total_numeros_definidos
      FROM categorias_globales cg
      LEFT JOIN cat_global_asignaciones cga ON cga.categoria_id=cg.id
      LEFT JOIN cat_vendedor_numeros    cvn ON cvn.categoria_id=cg.id
      GROUP BY cg.id,cg.nombre,cg.tipo,cg.monto,cg.descripcion,cg.created_at
      ORDER BY cg.nombre
    `);
    res.json(r.rows);
  } catch (err) { console.error('GET /categorias-globales:', err); res.status(500).json({ error: 'Error del servidor' }); }
});

catRouter.post('/', authMiddleware, soloDueno, async (req, res) => {
  const { nombre, tipo = 'parcial', monto, descripcion } = req.body;
  if (!nombre?.trim()) return res.status(400).json({ error: 'El nombre es requerido' });
  if (!['parcial', 'simultanea'].includes(tipo)) return res.status(400).json({ error: 'Tipo inválido' });
  try {
    const r = await pool.query(
      `INSERT INTO categorias_globales (nombre,tipo,monto,descripcion,created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING id,nombre,tipo,monto,descripcion,created_at`,
      [nombre.trim(), tipo, monto || null, descripcion || null, req.user?.id || null]
    );
    res.status(201).json({ ...r.rows[0], total_vendedores:0, total_asignaciones:0, numeros_serie_a:0, numeros_serie_b:0, total_numeros_definidos:0 });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Ya existe una categoría con ese nombre' });
    console.error('POST /categorias-globales:', err); res.status(500).json({ error: 'Error del servidor' });
  }
});

catRouter.put('/:id', authMiddleware, soloDueno, async (req, res) => {
  const { nombre, monto, descripcion } = req.body;
  try {
    const fields=[]; const params=[]; let i=1;
    if (nombre!==undefined)      { fields.push(`nombre=$${i++}`);      params.push(nombre.trim()); }
    if (monto!==undefined)       { fields.push(`monto=$${i++}`);       params.push(monto||null); }
    if (descripcion!==undefined) { fields.push(`descripcion=$${i++}`); params.push(descripcion||null); }
    if (!fields.length) return res.status(400).json({ error: 'Nada que actualizar' });
    params.push(req.params.id);
    const r = await pool.query(`UPDATE categorias_globales SET ${fields.join(',')},updated_at=now() WHERE id=$${i} RETURNING id,nombre,tipo,monto,descripcion`, params);
    if (!r.rows[0]) return res.status(404).json({ error: 'Categoría no encontrada' });
    res.json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Ya existe una categoría con ese nombre' });
    console.error('PUT /categorias-globales/:id:', err); res.status(500).json({ error: 'Error del servidor' });
  }
});

catRouter.delete('/:id', authMiddleware, soloDueno, async (req, res) => {
  try {
    const r = await pool.query('DELETE FROM categorias_globales WHERE id=$1 RETURNING id', [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Categoría no encontrada' });
    res.json({ message: 'Categoría eliminada.' });
  } catch (err) { console.error('DELETE /categorias-globales/:id:', err); res.status(500).json({ error: 'Error del servidor' }); }
});

/* ──────────────────────────────────────────────────────────────────
   GET /api/categorias-globales/:id/vendedores-resumen  (v6)
   FIX: COUNT(DISTINCT cvn.numero) para evitar doble-conteo cuando
   un vendedor tiene el mismo número en Serie A y en Serie B.
──────────────────────────────────────────────────────────────────*/
catRouter.get('/:id/vendedores-resumen', authMiddleware, soloDueno, async (req, res) => {
  try {
    const catR = await pool.query('SELECT id,tipo FROM categorias_globales WHERE id=$1', [req.params.id]);
    if (!catR.rows[0]) return res.status(404).json({ error: 'Categoría no encontrada' });

    const r = await pool.query(
      `SELECT
         cvn.vendedor_id,
         u.nombre  AS vendedor_nombre,
         u.cedula,
         COUNT(DISTINCT cvn.numero)::int                          AS total_numeros,
         COUNT(cga.id)::int                                       AS total_asignados,
         COUNT(CASE WHEN cga.serie='A' THEN 1 END)::int          AS serie_a,
         COUNT(CASE WHEN cga.serie='B' THEN 1 END)::int          AS serie_b,
         JSON_AGG(
           JSON_BUILD_OBJECT(
             'numero',        cvn.numero,
             'serie',         cga.serie,
             'asignacion_id', cga.id
           ) ORDER BY cvn.numero, cga.serie NULLS LAST
         ) AS numeros
       FROM cat_vendedor_numeros cvn
       JOIN users u ON u.id = cvn.vendedor_id
       LEFT JOIN cat_global_asignaciones cga
         ON cga.categoria_id = cvn.categoria_id
        AND cga.vendedor_id  = cvn.vendedor_id
        AND cga.numero       = cvn.numero
       WHERE cvn.categoria_id = $1
       GROUP BY cvn.vendedor_id, u.nombre, u.cedula
       ORDER BY u.nombre`,
      [req.params.id]
    );
    res.json({ tipo: catR.rows[0].tipo, vendedores: r.rows });
  } catch (err) { console.error('vendedores-resumen:', err); res.status(500).json({ error: 'Error del servidor' }); }
});

/* ──────────────────────────────────────────────────────────────────
   GET /api/categorias-globales/:id/validar-numero  (v6)
   Ahora retorna: ya_tiene_a, ya_tiene_b para el frontend.
──────────────────────────────────────────────────────────────────*/
catRouter.get('/:id/validar-numero', authMiddleware, soloDueno, async (req, res) => {
  const { numero, vendedor_id } = req.query;
  if (!numero || !/^\d{3}$/.test(numero))
    return res.status(400).json({ error: 'numero debe ser exactamente 3 dígitos (000-999)' });
  if (!vendedor_id)
    return res.status(400).json({ error: 'vendedor_id es requerido' });

  const client = await pool.connect();
  try {
    const catR = await client.query('SELECT id,tipo FROM categorias_globales WHERE id=$1', [req.params.id]);
    if (!catR.rows[0]) return res.status(404).json({ error: 'Categoría no encontrada' });
    const { tipo } = catR.rows[0];

    const enPoolR = await client.query(
      `SELECT id FROM cat_vendedor_numeros WHERE categoria_id=$1 AND vendedor_id=$2 AND numero=$3`,
      [req.params.id, vendedor_id, numero]
    );
    const yaEnPool = enPoolR.rows.length > 0;

    // Qué series ya tiene el vendedor para este número
    const misSeriesR = await client.query(
      `SELECT serie FROM cat_global_asignaciones WHERE categoria_id=$1 AND vendedor_id=$2 AND numero=$3`,
      [req.params.id, vendedor_id, numero]
    );
    const mySeries = misSeriesR.rows.map(r => r.serie);

    const resolucion = await resolverSerie(client, req.params.id, numero, vendedor_id, tipo);

    res.json({
      numero,
      tipo,
      disponible:    resolucion.disponible,
      serie_destino: resolucion.serie,
      serie_a: {
        libre: !resolucion.ocupadaA,
        dueno: resolucion.ocupadaA?.nombre || null,
      },
      serie_b: tipo === 'simultanea' ? {
        libre: !resolucion.ocupadaB,
        dueno: resolucion.ocupadaB?.nombre || null,
      } : undefined,
      ya_en_pool:  yaEnPool,
      ya_tiene_a:  mySeries.includes('A'),
      ya_tiene_b:  mySeries.includes('B'),
      mensaje:     resolucion.mensaje,
    });
  } catch (err) {
    console.error('GET /validar-numero:', err);
    res.status(500).json({ error: 'Error del servidor' });
  } finally { client.release(); }
});

/* ──────────────────────────────────────────────────────────────────
   POST /api/categorias-globales/:id/vendedores/:vendedorId/numeros
   v6: Si número ya estaba en pool y categoría es SIMULTÁNEA,
   auto-asigna la siguiente serie disponible (A→B ó B→A).
──────────────────────────────────────────────────────────────────*/
catRouter.post('/:id/vendedores/:vendedorId/numeros', authMiddleware, soloDueno, async (req, res) => {
  const { numeros } = req.body;
  if (!Array.isArray(numeros) || !numeros.length)
    return res.status(400).json({ error: 'numeros[] es requerido' });

  const invalidos = numeros.filter(n => !/^\d{3}$/.test(n));
  if (invalidos.length)
    return res.status(400).json({ error: `Números inválidos: ${invalidos.join(', ')}` });

  const numerosUnicos = [...new Set(numeros)];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const catR = await client.query('SELECT id,tipo FROM categorias_globales WHERE id=$1', [req.params.id]);
    if (!catR.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Categoría no encontrada' }); }
    const { tipo } = catR.rows[0];

    const vendR = await client.query('SELECT id,nombre,activo FROM users WHERE id=$1 AND rol=$2', [req.params.vendedorId, 'vendedor']);
    if (!vendR.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Vendedor no encontrado' }); }
    if (!vendR.rows[0].activo) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'El vendedor está inactivo' }); }

    // Cuáles ya están en el pool
    const existR = await client.query(
      `SELECT numero FROM cat_vendedor_numeros WHERE categoria_id=$1 AND vendedor_id=$2 AND numero=ANY($3::char[])`,
      [req.params.id, req.params.vendedorId, numerosUnicos]
    );
    const yaExisten = new Set(existR.rows.map(r => r.numero));
    const nuevos    = numerosUnicos.filter(n => !yaExisten.has(n));

    // Insertar nuevos al pool
    for (const num of nuevos) {
      await client.query(
        `INSERT INTO cat_vendedor_numeros (categoria_id, vendedor_id, numero) VALUES ($1,$2,$3)`,
        [req.params.id, req.params.vendedorId, num]
      );
    }

    // Info de series para los números nuevos
    const infoSeries = [];
    for (const num of nuevos) {
      const r = await resolverSerie(client, req.params.id, num, req.params.vendedorId, tipo);
      infoSeries.push({
        numero:        num,
        disponible:    r.disponible,
        serie_destino: r.serie,
        serie_a:       { libre: !r.ocupadaA, dueno: r.ocupadaA?.nombre || null },
        ...(tipo === 'simultanea' ? { serie_b: { libre: !r.ocupadaB, dueno: r.ocupadaB?.nombre || null } } : {}),
        mensaje:       r.mensaje,
      });
    }

    // v6: Para números ya en pool en SIMULTÁNEA → auto-asignar siguiente serie
    const asignacionesExtra = [];
    const colisionesExtra   = [];

    if (tipo === 'simultanea' && yaExisten.size > 0) {
      for (const num of [...yaExisten]) {
        const r = await resolverSerie(client, req.params.id, num, req.params.vendedorId, tipo);
        if (r.disponible) {
          const ins = await client.query(
            `INSERT INTO cat_global_asignaciones (categoria_id, vendedor_id, numero, serie)
             VALUES ($1,$2,$3,$4) ON CONFLICT (categoria_id, numero, serie) DO NOTHING
             RETURNING id, numero, serie`,
            [req.params.id, req.params.vendedorId, num, r.serie]
          );
          if (ins.rows[0]) {
            asignacionesExtra.push({ numero: num, serie: r.serie, mensaje: r.mensaje });
          } else {
            const r2 = await resolverSerie(client, req.params.id, num, req.params.vendedorId, tipo);
            if (r2.disponible) {
              const ins2 = await client.query(
                `INSERT INTO cat_global_asignaciones (categoria_id, vendedor_id, numero, serie)
                 VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id, numero, serie`,
                [req.params.id, req.params.vendedorId, num, r2.serie]
              );
              if (ins2.rows[0]) asignacionesExtra.push({ numero: num, serie: r2.serie, mensaje: r2.mensaje });
              else colisionesExtra.push({ numero: num, mensaje: r2.mensaje, dueno_a: r2.ocupadaA?.nombre || null, dueno_b: r2.ocupadaB?.nombre || null });
            } else {
              colisionesExtra.push({ numero: num, mensaje: r2.mensaje, dueno_a: r2.ocupadaA?.nombre || null, dueno_b: r2.ocupadaB?.nombre || null });
            }
          }
        } else {
          colisionesExtra.push({
            numero:  num,
            mensaje: r.mensaje,
            dueno_a: r.ocupadaA?.nombre || null,
            dueno_b: r.ocupadaB?.nombre || null,
          });
        }
      }
    }

    await client.query('COMMIT');

    const mensajes = [];
    if (nuevos.length)             mensajes.push(`${nuevos.length} número(s) agregados al pool`);
    if (asignacionesExtra.length)  mensajes.push(`${asignacionesExtra.length} número(s) asignados a segunda serie`);
    if (colisionesExtra.length)    mensajes.push(`${colisionesExtra.length} número(s) sin serie disponible`);

    res.status(201).json({
      message:            mensajes.join('. ') || 'Sin cambios.',
      insertados:         nuevos.length,
      ya_existian:        [...yaExisten],
      info_series:        infoSeries,
      asignaciones_extra: asignacionesExtra,
      colisiones_extra:   colisionesExtra,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error: 'Número duplicado en el pool' });
    console.error('POST numeros:', err); res.status(500).json({ error: 'Error del servidor' });
  } finally { client.release(); }
});

/* ──────────────────────────────────────────────────────────────────
   DELETE /api/categorias-globales/:id/vendedores/:vendedorId/numeros
──────────────────────────────────────────────────────────────────*/
catRouter.delete('/:id/vendedores/:vendedorId/numeros', authMiddleware, soloDueno, async (req, res) => {
  const { numeros } = req.body;
  if (!Array.isArray(numeros) || !numeros.length)
    return res.status(400).json({ error: 'numeros[] es requerido' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `DELETE FROM cat_global_asignaciones WHERE categoria_id=$1 AND vendedor_id=$2 AND numero=ANY($3::char[])`,
      [req.params.id, req.params.vendedorId, numeros]
    );
    const r = await client.query(
      `DELETE FROM cat_vendedor_numeros WHERE categoria_id=$1 AND vendedor_id=$2 AND numero=ANY($3::char[]) RETURNING numero`,
      [req.params.id, req.params.vendedorId, numeros]
    );
    await client.query('COMMIT');
    res.json({ message: `${r.rows.length} número(s) removidos.`, removidos: r.rows.map(x => x.numero) });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('DELETE numeros:', err); res.status(500).json({ error: 'Error del servidor' });
  } finally { client.release(); }
});

/* ──────────────────────────────────────────────────────────────────
   POST /api/categorias-globales/:id/vendedores/:vendedorId/asignar
   v6: en simultánea también asigna serie B a números con solo A.
──────────────────────────────────────────────────────────────────*/
catRouter.post('/:id/vendedores/:vendedorId/asignar', authMiddleware, soloDueno, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const catR = await client.query('SELECT id,tipo FROM categorias_globales WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!catR.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Categoría no encontrada' }); }
    const { tipo } = catR.rows[0];

    const vendR = await client.query('SELECT id,nombre,activo FROM users WHERE id=$1 AND rol=$2', [req.params.vendedorId, 'vendedor']);
    if (!vendR.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Vendedor no encontrado' }); }
    if (!vendR.rows[0].activo) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'El vendedor está inactivo' }); }
    const vendedorNombre = vendR.rows[0].nombre;

    const { insertados, colisiones } = await asignarSeriesParaVendedor(client, req.params.id, req.params.vendedorId, tipo);

    if (!insertados.length && !colisiones.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `${vendedorNombre} no tiene números pendientes de asignar.` });
    }

    await client.query('COMMIT');

    const mensajes = [];
    if (insertados.length) mensajes.push(`✅ ${insertados.length} número(s) asignados`);
    if (colisiones.length) mensajes.push(`⚠️ ${colisiones.length} número(s) sin espacio disponible`);

    res.status(201).json({
      message:         mensajes.join('. '),
      vendedor_nombre: vendedorNombre,
      insertados,
      colisiones,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST asignar:', err); res.status(500).json({ error: 'Error del servidor' });
  } finally { client.release(); }
});

/* ──────────────────────────────────────────────────────────────────
   GET /api/categorias-globales/:id/preview/:vendedorId
   v6: usa la misma lógica de pendientes que asignarSeriesParaVendedor
──────────────────────────────────────────────────────────────────*/
catRouter.get('/:id/preview/:vendedorId', authMiddleware, soloDueno, async (req, res) => {
  const client = await pool.connect();
  try {
    const catR = await client.query('SELECT id,tipo FROM categorias_globales WHERE id=$1', [req.params.id]);
    if (!catR.rows[0]) return res.status(404).json({ error: 'Categoría no encontrada' });
    const { tipo } = catR.rows[0];

    const vendR = await client.query('SELECT id,nombre FROM users WHERE id=$1 AND rol=$2', [req.params.vendedorId, 'vendedor']);
    if (!vendR.rows[0]) return res.status(404).json({ error: 'Vendedor no encontrado' });

    const poolR = await client.query(
      `SELECT numero FROM cat_vendedor_numeros WHERE categoria_id=$1 AND vendedor_id=$2 ORDER BY numero`,
      [req.params.id, req.params.vendedorId]
    );
    if (!poolR.rows.length)
      return res.json({ tipo, libres:[], colisiones:[], puedeAgregar:false, sinNumeros:true, vendedor_nombre: vendR.rows[0].nombre });

    const asigR = await client.query(
      `SELECT numero, serie FROM cat_global_asignaciones WHERE categoria_id=$1 AND vendedor_id=$2`,
      [req.params.id, req.params.vendedorId]
    );

    const seriesMap = {};
    asigR.rows.forEach(row => {
      if (!seriesMap[row.numero]) seriesMap[row.numero] = [];
      seriesMap[row.numero].push(row.serie);
    });

    const pendientes = poolR.rows.map(r => r.numero).filter(n => {
      if (tipo === 'simultanea') return (seriesMap[n] || []).length < 2;
      else return !(seriesMap[n] && seriesMap[n].length > 0);
    });

    if (!pendientes.length)
      return res.json({ tipo, libres:[], colisiones:[], puedeAgregar:false, todoAsignado:true, vendedor_nombre: vendR.rows[0].nombre });

    const libres     = [];
    const colisiones = [];

    for (const numero of pendientes) {
      const r = await resolverSerie(client, req.params.id, numero, req.params.vendedorId, tipo);
      if (r.disponible) {
        libres.push({
          numero,
          serie:   r.serie,
          mensaje: r.mensaje,
          serie_a: { libre: !r.ocupadaA, dueno: r.ocupadaA?.nombre || null },
          ...(tipo === 'simultanea' ? { serie_b: { libre: !r.ocupadaB, dueno: r.ocupadaB?.nombre || null } } : {}),
        });
      } else {
        colisiones.push({
          numero,
          mensaje:  r.mensaje,
          dueno_a:  r.ocupadaA?.nombre || null,
          dueno_b:  r.ocupadaB?.nombre || null,
        });
      }
    }

    res.json({
      tipo,
      vendedor_nombre:  vendR.rows[0].nombre,
      total_numeros:    poolR.rows.length,
      total_pendientes: pendientes.length,
      libres,
      colisiones,
      puedeAgregar:     libres.length > 0,
    });
  } catch (err) { console.error('preview:', err); res.status(500).json({ error: 'Error del servidor' }); }
  finally { client.release(); }
});

/* ──────────────────────────────────────────────────────────────────
   POST /api/categorias-globales/:id/vendedores
──────────────────────────────────────────────────────────────────*/
catRouter.post('/:id/vendedores', authMiddleware, soloDueno, async (req, res) => {
  const { vendedor_id, nombre, cedula, usuario, password, numeros = [] } = req.body;
  if (!vendedor_id && !nombre?.trim())
    return res.status(400).json({ error: 'Indica vendedor_id o el nombre del nuevo vendedor' });

  const invalidos = numeros.filter(n => !/^\d{3}$/.test(n));
  if (invalidos.length) return res.status(400).json({ error: `Números inválidos: ${invalidos.join(', ')}` });

  const numerosUnicos = [...new Set(numeros)];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const catR = await client.query('SELECT id,tipo FROM categorias_globales WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!catR.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Categoría no encontrada' }); }
    const { tipo } = catR.rows[0];

    let vendedorFinal; let credencialesGeneradas = null;
    if (vendedor_id) {
      const vR = await client.query('SELECT id,nombre,usuario,cedula,activo FROM users WHERE id=$1 AND rol=$2', [vendedor_id, 'vendedor']);
      if (!vR.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Vendedor no encontrado' }); }
      if (!vR.rows[0].activo) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'El vendedor está inactivo' }); }
      vendedorFinal = vR.rows[0];
    } else {
      const nombreLimpio = nombre.trim();
      const creds = { usuario: usuario?.trim() || generarCredenciales(nombreLimpio).usuario, password: password || generarCredenciales(nombreLimpio).password };
      const existeR = await client.query('SELECT id FROM users WHERE usuario=$1', [creds.usuario]);
      if (existeR.rows[0]) { await client.query('ROLLBACK'); return res.status(409).json({ error: `Usuario "${creds.usuario}" ya existe` }); }
      const hash = await bcrypt.hash(creds.password, 10);
      const nR = await client.query(
        `INSERT INTO users (nombre,cedula,usuario,password,rol,activo) VALUES ($1,$2,$3,$4,'vendedor',true) RETURNING id,nombre,usuario,cedula`,
        [nombreLimpio, cedula||null, creds.usuario, hash]
      );
      vendedorFinal = nR.rows[0];
      credencialesGeneradas = { usuario: creds.usuario, password: creds.password };
    }

    let numerosAgregados = 0;
    for (const num of numerosUnicos) {
      const eR = await client.query(
        `SELECT id FROM cat_vendedor_numeros WHERE categoria_id=$1 AND vendedor_id=$2 AND numero=$3`,
        [req.params.id, vendedorFinal.id, num]
      );
      if (!eR.rows[0]) {
        await client.query(
          `INSERT INTO cat_vendedor_numeros (categoria_id,vendedor_id,numero) VALUES ($1,$2,$3)`,
          [req.params.id, vendedorFinal.id, num]
        );
        numerosAgregados++;
      }
    }

    const { insertados, colisiones } = await asignarSeriesParaVendedor(client, req.params.id, vendedorFinal.id, tipo);

    await client.query('COMMIT');

    const mensajes = [];
    if (insertados.length) mensajes.push(`✅ ${insertados.length} número(s) asignados`);
    if (colisiones.length) mensajes.push(`⚠️ ${colisiones.length} sin espacio disponible`);
    if (!mensajes.length)  mensajes.push('Vendedor vinculado sin números');

    res.status(201).json({
      vendedor:          { id: vendedorFinal.id, nombre: vendedorFinal.nombre, usuario: vendedorFinal.usuario, cedula: vendedorFinal.cedula },
      credenciales:      credencialesGeneradas,
      numeros_agregados: numerosAgregados,
      asignacion:        { insertados, colisiones, mensaje: mensajes.join('. ') },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error: 'Conflicto de datos únicos' });
    console.error('POST /vendedores:', err); res.status(500).json({ error: 'Error del servidor' });
  } finally { client.release(); }
});

/* ──────────────────────────────────────────────────────────────────
   DELETE /api/categorias-globales/:id/vendedores/:vendedorId
──────────────────────────────────────────────────────────────────*/
catRouter.delete('/:id/vendedores/:vendedorId', authMiddleware, soloDueno, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existeR = await client.query(
      `SELECT COUNT(*) FROM cat_vendedor_numeros WHERE categoria_id=$1 AND vendedor_id=$2`,
      [req.params.id, req.params.vendedorId]
    );
    if (parseInt(existeR.rows[0].count) === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'El vendedor no tiene números en esta categoría' });
    }
    const asigR = await client.query(
      `DELETE FROM cat_global_asignaciones WHERE categoria_id=$1 AND vendedor_id=$2 RETURNING numero,serie`,
      [req.params.id, req.params.vendedorId]
    );
    const poolR = await client.query(
      `DELETE FROM cat_vendedor_numeros WHERE categoria_id=$1 AND vendedor_id=$2 RETURNING numero`,
      [req.params.id, req.params.vendedorId]
    );
    await client.query('COMMIT');
    res.json({ message: `Vendedor removido. ${poolR.rows.length} número(s) eliminados.`, asignaciones_removidas: asigR.rows });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('DELETE vendedor de cat:', err); res.status(500).json({ error: 'Error del servidor' });
  } finally { client.release(); }
});

/* ──────────────────────────────────────────────────────────────────
   DELETE /api/categorias-globales/:id/asignaciones/:asigId
──────────────────────────────────────────────────────────────────*/
catRouter.delete('/:id/asignaciones/:asigId', authMiddleware, soloDueno, async (req, res) => {
  try {
    const r = await pool.query(
      `DELETE FROM cat_global_asignaciones WHERE id=$1 AND categoria_id=$2 RETURNING numero,serie,vendedor_id`,
      [req.params.asigId, req.params.id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Asignación no encontrada' });
    res.json({ message: `Número ${r.rows[0].numero} (Serie ${r.rows[0].serie}) liberado. Sigue en el pool.`, ...r.rows[0] });
  } catch (err) { console.error('DELETE asignacion:', err); res.status(500).json({ error: 'Error del servidor' }); }
});

module.exports = { vendedoresRouter: router, categoriasGlobalesRouter: catRouter };