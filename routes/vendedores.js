// vendedores.js — RIFAS JORDYN (v7)
// CAMBIOS v7:
// • POST /numeros: [125,125] en simultanea = pedir A y B. No lanza error duplicado.
// • POST /vendedores: igual, numeros=[125,125] asigna A y B.
// • GET /buscar-numero (NUEVO): sin vendedor_id, retorna estado global del numero
//   para que el modal "Crear vendedor" muestre quien ocupa A y B.
// • Pool UNIQUE(cat,vendedor,numero) se mantiene — es correcto. La logica
//   de "doble asignacion" vive en cat_global_asignaciones, no en el pool.

const express = require('express');
const router  = express.Router();
const bcrypt  = require('bcryptjs');
const pool    = require('../config/db');
const { authMiddleware, soloDueno } = require('../middleware/auth');

/* ══════════════════════════════════════════════════════════════
   resolverSerie — fuente de verdad para decidir serie destino
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

  if (tipo === 'parcial') {
    if (!ocupadaA)
      return { serie: 'A', disponible: true, ocupadaA: null, ocupadaB: null, mensaje: 'Libre. Se asignará en Serie A.' };
    if (String(ocupadaA.vendedor_id) === String(vendedorId))
      return { serie: null, disponible: false, ocupadaA, ocupadaB: null, mensaje: 'Ya tienes este número (Serie A).' };
    return { serie: null, disponible: false, ocupadaA, ocupadaB: null, mensaje: `Ocupado por ${ocupadaA.nombre} (Serie A).` };
  }

  // SIMULTÁNEA
  const selfA = ocupadaA && String(ocupadaA.vendedor_id) === String(vendedorId);
  const selfB = ocupadaB && String(ocupadaB.vendedor_id) === String(vendedorId);

  if (selfA && selfB)
    return { serie: null, disponible: false, ocupadaA, ocupadaB, mensaje: `Ya tienes ${numero} en Serie A y Serie B. Sin más espacio.` };
  if (selfA && !ocupadaB)
    return { serie: 'B', disponible: true, ocupadaA, ocupadaB: null, mensaje: `Ya tienes Serie A. Se asignará en Serie B.` };
  if (selfA && ocupadaB)
    return { serie: null, disponible: false, ocupadaA, ocupadaB, mensaje: `Ya tienes Serie A. Serie B ocupada por ${ocupadaB.nombre}.` };
  if (selfB && !ocupadaA)
    return { serie: 'A', disponible: true, ocupadaA: null, ocupadaB, mensaje: `Ya tienes Serie B. Se asignará en Serie A.` };
  if (selfB && ocupadaA)
    return { serie: null, disponible: false, ocupadaA, ocupadaB, mensaje: `Ya tienes Serie B. Serie A ocupada por ${ocupadaA.nombre}.` };
  if (!ocupadaA)
    return { serie: 'A', disponible: true, ocupadaA: null, ocupadaB, mensaje: 'Serie A libre.' };
  if (!ocupadaB)
    return { serie: 'B', disponible: true, ocupadaA, ocupadaB: null, mensaje: `Serie A: ${ocupadaA.nombre}. Se asignará en Serie B.` };

  return { serie: null, disponible: false, ocupadaA, ocupadaB, mensaje: `Sin espacio. A: ${ocupadaA.nombre} / B: ${ocupadaB.nombre}.` };
}

/* ══════════════════════════════════════════════════════════════
   asignarSeriesParaVendedor
   Procesa los numeros pendientes del pool.
   solicitudesMap: { '121': 1, '123': 2 } — cuantas series se
   pidieron por numero. Si es null se usa logica de /asignar
   (botón manual): simultanea=max 1 serie pendiente por numero.
══════════════════════════════════════════════════════════════ */
async function asignarSeriesParaVendedor(client, categoriaId, vendedorId, tipo, solicitudesMap = null) {
  const poolR = await client.query(
    `SELECT numero FROM cat_vendedor_numeros WHERE categoria_id=$1 AND vendedor_id=$2 ORDER BY numero`,
    [categoriaId, vendedorId]
  );
  if (!poolR.rows.length) return { insertados: [], colisiones: [] };

  const asigR = await client.query(
    `SELECT numero, serie FROM cat_global_asignaciones WHERE categoria_id=$1 AND vendedor_id=$2`,
    [categoriaId, vendedorId]
  );
  const seriesMap = {};
  asigR.rows.forEach(row => {
    if (!seriesMap[row.numero]) seriesMap[row.numero] = [];
    seriesMap[row.numero].push(row.serie);
  });

  const trabajos = [];
  for (const { numero } of poolR.rows) {
    const series = seriesMap[numero] || [];
    if (tipo === 'simultanea') {
      if (solicitudesMap) {
        // Cuantas series se pidieron explicitamente para este numero
        const pedidas = solicitudesMap[numero] || 1;
        // Cuantas ya tiene asignadas
        const yaAsignadas = series.length;
        // Solo agregar las que faltan hasta lo pedido (max 2)
        const necesita = Math.min(pedidas, 2) - yaAsignadas;
        for (let i = 0; i < necesita; i++) trabajos.push(numero);
      } else {
        // Modo /asignar manual: solo asignar UNA serie por numero pendiente
        if (series.length === 0) trabajos.push(numero);
      }
    } else {
      if (series.length === 0) trabajos.push(numero);
    }
  }

  if (!trabajos.length) return { insertados: [], colisiones: [] };

  const insertados = [];
  const colisiones = [];

  for (const numero of trabajos) {
    const res = await resolverSerie(client, categoriaId, numero, vendedorId, tipo);
    if (res.disponible) {
      const ins = await client.query(
        `INSERT INTO cat_global_asignaciones (categoria_id, vendedor_id, numero, serie)
         VALUES ($1,$2,$3,$4) ON CONFLICT (categoria_id, numero, serie) DO NOTHING
         RETURNING id, numero, serie`,
        [categoriaId, vendedorId, numero, res.serie]
      );
      if (ins.rows[0]) {
        insertados.push({ numero, serie: res.serie, mensaje: res.mensaje });
      } else {
        const res2 = await resolverSerie(client, categoriaId, numero, vendedorId, tipo);
        if (res2.disponible) {
          const ins2 = await client.query(
            `INSERT INTO cat_global_asignaciones (categoria_id, vendedor_id, numero, serie)
             VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id, numero, serie`,
            [categoriaId, vendedorId, numero, res2.serie]
          );
          if (ins2.rows[0]) insertados.push({ numero, serie: res2.serie, mensaje: res2.mensaje });
          else colisiones.push({ numero, ...res2 });
        } else {
          colisiones.push({ numero, ...res2 });
        }
      }
    } else {
      colisiones.push({ numero, ...res });
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
   RUTAS /api/vendedores
══════════════════════════════════════════════════════════════ */
router.get('/', authMiddleware, soloDueno, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT u.id, u.nombre, u.usuario, u.cedula, u.rol, u.activo, u.created_at,
        COUNT(DISTINCT v.id)::int AS total_ventas,
        COALESCE(SUM(v.precio_venta),0) AS total_ingresos,
        COUNT(DISTINCT cvn.numero||cvn.categoria_id::text)::int AS numeros_count,
        COUNT(DISTINCT cvn.categoria_id)::int AS categorias_count
      FROM users u
      LEFT JOIN ventas v ON v.vendedor_id=u.id
      LEFT JOIN cat_vendedor_numeros cvn ON cvn.vendedor_id=u.id
      WHERE u.rol='vendedor'
      GROUP BY u.id,u.nombre,u.usuario,u.cedula,u.rol,u.activo,u.created_at
      ORDER BY u.nombre`);
    res.json(r.rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Error del servidor' }); }
});

router.get('/:id', authMiddleware, soloDueno, async (req, res) => {
  try {
    const [userR, numerosR, rifasR, ventasR] = await Promise.all([
      pool.query('SELECT id,nombre,usuario,cedula,rol,activo,created_at FROM users WHERE id=$1', [req.params.id]),
      pool.query(`SELECT cvn.categoria_id, cg.nombre AS categoria_nombre, cg.tipo,
                  JSON_AGG(DISTINCT cvn.numero ORDER BY cvn.numero) AS numeros
                  FROM cat_vendedor_numeros cvn JOIN categorias_globales cg ON cg.id=cvn.categoria_id
                  WHERE cvn.vendedor_id=$1 GROUP BY cvn.categoria_id,cg.nombre,cg.tipo ORDER BY cg.nombre`, [req.params.id]),
      pool.query(`SELECT nv.rifa_id,r.nombre AS rifa_nombre,r.activa,
                  COUNT(nv.numero)::int AS numeros_en_rifa,COUNT(v.id)::int AS ventas_en_rifa
                  FROM numeros_vendedor nv JOIN rifas r ON r.id=nv.rifa_id
                  LEFT JOIN ventas v ON v.rifa_id=nv.rifa_id AND v.numero=nv.numero AND v.vendedor_id=nv.vendedor_id
                  WHERE nv.vendedor_id=$1 GROUP BY nv.rifa_id,r.nombre,r.activa ORDER BY r.activa DESC`, [req.params.id]),
      pool.query(`SELECT v.*,r.nombre AS rifa_nombre FROM ventas v JOIN rifas r ON r.id=v.rifa_id
                  WHERE v.vendedor_id=$1 ORDER BY v.created_at DESC LIMIT 20`, [req.params.id]),
    ]);
    if (!userR.rows[0]) return res.status(404).json({ error: 'Vendedor no encontrado' });
    res.json({ vendedor: userR.rows[0], numeros_por_cat: numerosR.rows, rifas_participando: rifasR.rows, ventas_recientes: ventasR.rows });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Error del servidor' }); }
});

router.put('/:id', authMiddleware, soloDueno, async (req, res) => {
  const { nombre, password, activo, cedula } = req.body;
  try {
    const fields=[]; const params=[]; let i=1;
    if (nombre)                     { fields.push(`nombre=$${i++}`);   params.push(nombre); }
    if (typeof activo==='boolean')  { fields.push(`activo=$${i++}`);   params.push(activo); }
    if (cedula!==undefined)         { fields.push(`cedula=$${i++}`);   params.push(cedula||null); }
    if (password) {
      if (password.length < 6) return res.status(400).json({ error: 'Contraseña mínimo 6 caracteres' });
      fields.push(`password=$${i++}`); params.push(await bcrypt.hash(password, 10));
    }
    if (!fields.length) return res.status(400).json({ error: 'Nada que actualizar' });
    params.push(req.params.id);
    const r = await pool.query(`UPDATE users SET ${fields.join(',')} WHERE id=$${i} RETURNING id,nombre,usuario,cedula,rol,activo`, params);
    if (!r.rows[0]) return res.status(404).json({ error: 'Vendedor no encontrado' });
    res.json({ message: 'Vendedor actualizado', vendedor: r.rows[0] });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Error del servidor' }); }
});

router.delete('/:id', authMiddleware, soloDueno, async (req, res) => {
  try {
    const v = await pool.query('SELECT COUNT(*) FROM ventas WHERE vendedor_id=$1', [req.params.id]);
    if (parseInt(v.rows[0].count) > 0)
      return res.status(400).json({ error: 'No se puede eliminar: tiene ventas. Desactívalo.' });
    await pool.query('DELETE FROM numeros_vendedor WHERE vendedor_id=$1', [req.params.id]);
    await pool.query('DELETE FROM users WHERE id=$1', [req.params.id]);
    res.json({ message: 'Vendedor eliminado' });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Error del servidor' }); }
});

/* ══════════════════════════════════════════════════════════════
   RUTAS /api/categorias-globales
══════════════════════════════════════════════════════════════ */
const catRouter = express.Router();

catRouter.get('/', authMiddleware, soloDueno, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT cg.id,cg.nombre,cg.tipo,cg.monto,cg.descripcion,cg.created_at,
        (SELECT COUNT(DISTINCT cga.vendedor_id) FROM cat_global_asignaciones cga WHERE cga.categoria_id=cg.id)::int AS total_vendedores,
        (SELECT COUNT(*) FROM cat_global_asignaciones cga WHERE cga.categoria_id=cg.id)::int AS total_asignaciones,
        (SELECT COUNT(*) FROM cat_global_asignaciones cga WHERE cga.categoria_id=cg.id AND cga.serie='A')::int AS numeros_serie_a,
        (SELECT COUNT(*) FROM cat_global_asignaciones cga WHERE cga.categoria_id=cg.id AND cga.serie='B')::int AS numeros_serie_b,
        (SELECT COUNT(DISTINCT cvn.numero) FROM cat_vendedor_numeros cvn WHERE cvn.categoria_id=cg.id)::int AS total_numeros_definidos
      FROM categorias_globales cg
      ORDER BY cg.nombre`);
    res.json(r.rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Error del servidor' }); }
});

catRouter.post('/', authMiddleware, soloDueno, async (req, res) => {
  const { nombre, tipo='parcial', monto, descripcion } = req.body;
  if (!nombre?.trim()) return res.status(400).json({ error: 'El nombre es requerido' });
  if (!['parcial','simultanea'].includes(tipo)) return res.status(400).json({ error: 'Tipo inválido' });
  try {
    const r = await pool.query(
      `INSERT INTO categorias_globales (nombre,tipo,monto,descripcion,created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING id,nombre,tipo,monto,descripcion,created_at`,
      [nombre.trim(), tipo, monto||null, descripcion||null, req.user?.id||null]
    );
    res.status(201).json({ ...r.rows[0], total_vendedores:0, total_asignaciones:0, numeros_serie_a:0, numeros_serie_b:0, total_numeros_definidos:0 });
  } catch (err) {
    if (err.code==='23505') return res.status(409).json({ error: 'Ya existe una categoría con ese nombre' });
    console.error(err); res.status(500).json({ error: 'Error del servidor' });
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
    if (err.code==='23505') return res.status(409).json({ error: 'Ya existe una categoría con ese nombre' });
    console.error(err); res.status(500).json({ error: 'Error del servidor' });
  }
});

catRouter.delete('/:id', authMiddleware, soloDueno, async (req, res) => {
  try {
    const r = await pool.query('DELETE FROM categorias_globales WHERE id=$1 RETURNING id', [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Categoría no encontrada' });
    res.json({ message: 'Categoría eliminada.' });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Error del servidor' }); }
});

/* ──────────────────────────────────────────────────────────────────
   GET /api/categorias-globales/:id/vendedores-resumen
──────────────────────────────────────────────────────────────────*/
catRouter.get('/:id/vendedores-resumen', authMiddleware, soloDueno, async (req, res) => {
  try {
    const catR = await pool.query('SELECT id,tipo FROM categorias_globales WHERE id=$1', [req.params.id]);
    if (!catR.rows[0]) return res.status(404).json({ error: 'Categoría no encontrada' });
    const r = await pool.query(`
      SELECT cvn.vendedor_id, u.nombre AS vendedor_nombre, u.cedula,
        COUNT(DISTINCT cvn.numero)::int AS total_numeros,
        COUNT(cga.id)::int AS total_asignados,
        COUNT(CASE WHEN cga.serie='A' THEN 1 END)::int AS serie_a,
        COUNT(CASE WHEN cga.serie='B' THEN 1 END)::int AS serie_b,
        JSON_AGG(JSON_BUILD_OBJECT(
          'numero', cvn.numero, 'serie', cga.serie, 'asignacion_id', cga.id
        ) ORDER BY cvn.numero, cga.serie NULLS LAST) AS numeros
      FROM cat_vendedor_numeros cvn
      JOIN users u ON u.id=cvn.vendedor_id
      LEFT JOIN cat_global_asignaciones cga
        ON cga.categoria_id=cvn.categoria_id AND cga.vendedor_id=cvn.vendedor_id AND cga.numero=cvn.numero
      WHERE cvn.categoria_id=$1
      GROUP BY cvn.vendedor_id,u.nombre,u.cedula
      ORDER BY u.nombre`, [req.params.id]);
    res.json({ tipo: catR.rows[0].tipo, vendedores: r.rows });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Error del servidor' }); }
});

/* ──────────────────────────────────────────────────────────────────
   GET /api/categorias-globales/:id/buscar-numero?numero=125
   NUEVO v7 — No requiere vendedor_id.
   Retorna el estado global del numero: quien tiene A, quien tiene B.
   Usado por el modal "Crear nuevo vendedor" en simultanea.
──────────────────────────────────────────────────────────────────*/
catRouter.get('/:id/buscar-numero', authMiddleware, soloDueno, async (req, res) => {
  const { numero } = req.query;
  if (!numero || !/^\d{3}$/.test(numero))
    return res.status(400).json({ error: 'numero debe ser 3 dígitos' });

  const client = await pool.connect();
  try {
    const catR = await client.query('SELECT id,tipo FROM categorias_globales WHERE id=$1', [req.params.id]);
    if (!catR.rows[0]) return res.status(404).json({ error: 'Categoría no encontrada' });
    const { tipo } = catR.rows[0];

    const r = await client.query(
      `SELECT cga.serie, cga.vendedor_id, u.nombre AS vendedor_nombre
       FROM cat_global_asignaciones cga
       JOIN users u ON u.id=cga.vendedor_id
       WHERE cga.categoria_id=$1 AND cga.numero=$2
       ORDER BY cga.serie`,
      [req.params.id, numero]
    );

    const serieA = r.rows.find(x => x.serie==='A') || null;
    const serieB = r.rows.find(x => x.serie==='B') || null;

    let disponible_a = !serieA;
    let disponible_b = tipo==='simultanea' ? !serieB : null;

    // Mensaje descriptivo
    let mensaje = '';
    if (tipo === 'parcial') {
      mensaje = serieA
        ? `Ocupado por ${serieA.vendedor_nombre}`
        : 'Número libre — se asignará en Serie A';
    } else {
      if (!serieA && !serieB)   mensaje = 'Libre en Serie A y Serie B';
      else if (!serieA)          mensaje = `Serie A libre — Serie B: ${serieB.vendedor_nombre}`;
      else if (!serieB)          mensaje = `Serie A: ${serieA.vendedor_nombre} — Serie B libre`;
      else                       mensaje = `Serie A: ${serieA.vendedor_nombre} — Serie B: ${serieB.vendedor_nombre} — Sin espacio`;
    }

    res.json({
      numero,
      tipo,
      mensaje,
      serie_a: { ocupada: !!serieA, vendedor_nombre: serieA?.vendedor_nombre || null, vendedor_id: serieA?.vendedor_id || null },
      serie_b: tipo==='simultanea' ? { ocupada: !!serieB, vendedor_nombre: serieB?.vendedor_nombre || null, vendedor_id: serieB?.vendedor_id || null } : null,
      disponible_a,
      disponible_b,
      hay_espacio: tipo==='parcial' ? disponible_a : (disponible_a || disponible_b),
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Error del servidor' }); }
  finally { client.release(); }
});

/* ──────────────────────────────────────────────────────────────────
   GET /api/categorias-globales/:id/validar-numero?numero=125&vendedor_id=X
   Para vendedor YA EXISTENTE. Retorna serie destino y flags ya_tiene_a/b.
──────────────────────────────────────────────────────────────────*/
catRouter.get('/:id/validar-numero', authMiddleware, soloDueno, async (req, res) => {
  const { numero, vendedor_id } = req.query;
  if (!numero || !/^\d{3}$/.test(numero)) return res.status(400).json({ error: 'numero debe ser 3 dígitos' });
  if (!vendedor_id) return res.status(400).json({ error: 'vendedor_id es requerido' });

  const client = await pool.connect();
  try {
    const catR = await client.query('SELECT id,tipo FROM categorias_globales WHERE id=$1', [req.params.id]);
    if (!catR.rows[0]) return res.status(404).json({ error: 'Categoría no encontrada' });
    const { tipo } = catR.rows[0];

    const enPoolR = await client.query(
      `SELECT id FROM cat_vendedor_numeros WHERE categoria_id=$1 AND vendedor_id=$2 AND numero=$3`,
      [req.params.id, vendedor_id, numero]
    );
    const misSeriesR = await client.query(
      `SELECT serie FROM cat_global_asignaciones WHERE categoria_id=$1 AND vendedor_id=$2 AND numero=$3`,
      [req.params.id, vendedor_id, numero]
    );
    const mySeries = misSeriesR.rows.map(r => r.serie);
    const resolucion = await resolverSerie(client, req.params.id, numero, vendedor_id, tipo);

    res.json({
      numero, tipo,
      disponible:    resolucion.disponible,
      serie_destino: resolucion.serie,
      serie_a: { libre: !resolucion.ocupadaA, dueno: resolucion.ocupadaA?.nombre||null },
      serie_b: tipo==='simultanea' ? { libre: !resolucion.ocupadaB, dueno: resolucion.ocupadaB?.nombre||null } : undefined,
      ya_en_pool: enPoolR.rows.length > 0,
      ya_tiene_a: mySeries.includes('A'),
      ya_tiene_b: mySeries.includes('B'),
      mensaje: resolucion.mensaje,
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Error del servidor' }); }
  finally { client.release(); }
});

/* ──────────────────────────────────────────────────────────────────
   POST /api/categorias-globales/:id/vendedores/:vendedorId/numeros
   v7: El array puede traer numeros repetidos. [125,125] = pedir A y B.
   Proceso:
   1. Para cada numero (con repetidos):
      - Si no está en pool → insertar en pool + resolver serie
      - Si ya está en pool → resolver serie directamente (no insertar)
   Nunca lanza error por duplicado en pool.
──────────────────────────────────────────────────────────────────*/
catRouter.post('/:id/vendedores/:vendedorId/numeros', authMiddleware, soloDueno, async (req, res) => {
  const { numeros } = req.body;
  if (!Array.isArray(numeros) || !numeros.length)
    return res.status(400).json({ error: 'numeros[] es requerido' });

  const invalidos = numeros.filter(n => !/^\d{3}$/.test(n));
  if (invalidos.length) return res.status(400).json({ error: `Números inválidos: ${invalidos.join(', ')}` });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const catR = await client.query('SELECT id,tipo FROM categorias_globales WHERE id=$1', [req.params.id]);
    if (!catR.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Categoría no encontrada' }); }
    const { tipo } = catR.rows[0];

    const vendR = await client.query('SELECT id,nombre,activo FROM users WHERE id=$1 AND rol=$2', [req.params.vendedorId, 'vendedor']);
    if (!vendR.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Vendedor no encontrado' }); }
    if (!vendR.rows[0].activo) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'El vendedor está inactivo' }); }

    // Cuales ya estan en el pool
    const numerosUnicos = [...new Set(numeros)];
    const existR = await client.query(
      `SELECT numero FROM cat_vendedor_numeros WHERE categoria_id=$1 AND vendedor_id=$2 AND numero=ANY($3::char[])`,
      [req.params.id, req.params.vendedorId, numerosUnicos]
    );
    const yaEnPool = new Set(existR.rows.map(r => r.numero));

    // Insertar al pool los que no estan (una sola vez cada uno)
    let numerosAgregadosAlPool = 0;
    for (const num of numerosUnicos) {
      if (!yaEnPool.has(num)) {
        await client.query(
          `INSERT INTO cat_vendedor_numeros (categoria_id,vendedor_id,numero) VALUES ($1,$2,$3)`,
          [req.params.id, req.params.vendedorId, num]
        );
        numerosAgregadosAlPool++;
      }
    }

    // Ahora procesar cada solicitud de serie (incluyendo repetidos del array original)
    // Contar cuantas veces aparece cada numero en el array de entrada
    const conteo = {};
    for (const n of numeros) conteo[n] = (conteo[n]||0) + 1;

    const insertados = [];
    const colisiones = [];
    const infoSeries = [];

    for (const [num, veces] of Object.entries(conteo)) {
      // Procesar tantas veces como se pidio (max 2 en simultanea, 1 en parcial)
      const maxVeces = tipo === 'simultanea' ? Math.min(veces, 2) : 1;
      for (let i = 0; i < maxVeces; i++) {
        const res = await resolverSerie(client, req.params.id, num, req.params.vendedorId, tipo);
        if (res.disponible) {
          const ins = await client.query(
            `INSERT INTO cat_global_asignaciones (categoria_id,vendedor_id,numero,serie)
             VALUES ($1,$2,$3,$4) ON CONFLICT (categoria_id,numero,serie) DO NOTHING
             RETURNING id,numero,serie`,
            [req.params.id, req.params.vendedorId, num, res.serie]
          );
          if (ins.rows[0]) {
            insertados.push({ numero: num, serie: res.serie, mensaje: res.mensaje });
            infoSeries.push({ numero: num, disponible: true, serie_destino: res.serie, mensaje: res.mensaje });
          } else {
            // Concurrencia: re-resolver
            const res2 = await resolverSerie(client, req.params.id, num, req.params.vendedorId, tipo);
            if (res2.disponible) {
              const ins2 = await client.query(
                `INSERT INTO cat_global_asignaciones (categoria_id,vendedor_id,numero,serie)
                 VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id,numero,serie`,
                [req.params.id, req.params.vendedorId, num, res2.serie]
              );
              if (ins2.rows[0]) {
                insertados.push({ numero: num, serie: res2.serie, mensaje: res2.mensaje });
                infoSeries.push({ numero: num, disponible: true, serie_destino: res2.serie, mensaje: res2.mensaje });
              } else {
                colisiones.push({ numero: num, mensaje: res2.mensaje, dueno_a: res2.ocupadaA?.nombre||null, dueno_b: res2.ocupadaB?.nombre||null });
                infoSeries.push({ numero: num, disponible: false, mensaje: res2.mensaje });
              }
            } else {
              colisiones.push({ numero: num, mensaje: res2.mensaje, dueno_a: res2.ocupadaA?.nombre||null, dueno_b: res2.ocupadaB?.nombre||null });
              infoSeries.push({ numero: num, disponible: false, mensaje: res2.mensaje });
            }
          }
        } else {
          colisiones.push({ numero: num, mensaje: res.mensaje, dueno_a: res.ocupadaA?.nombre||null, dueno_b: res.ocupadaB?.nombre||null });
          infoSeries.push({ numero: num, disponible: false, mensaje: res.mensaje });
        }
      }
    }

    await client.query('COMMIT');

    const mensajes = [];
    if (numerosAgregadosAlPool) mensajes.push(`${numerosAgregadosAlPool} número(s) al pool`);
    if (insertados.length)      mensajes.push(`${insertados.length} serie(s) asignada(s)`);
    if (colisiones.length)      mensajes.push(`${colisiones.length} sin espacio`);

    res.status(201).json({
      message:      mensajes.join('. ') || 'Sin cambios.',
      insertados,
      colisiones,
      info_series:  infoSeries,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST numeros:', err); res.status(500).json({ error: 'Error del servidor' });
  } finally { client.release(); }
});

/* ──────────────────────────────────────────────────────────────────
   DELETE /api/categorias-globales/:id/vendedores/:vendedorId/numeros
──────────────────────────────────────────────────────────────────*/
catRouter.delete('/:id/vendedores/:vendedorId/numeros', authMiddleware, soloDueno, async (req, res) => {
  const { numeros } = req.body;
  if (!Array.isArray(numeros)||!numeros.length) return res.status(400).json({ error: 'numeros[] es requerido' });
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
    res.json({ message: `${r.rows.length} número(s) removidos.`, removidos: r.rows.map(x=>x.numero) });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err); res.status(500).json({ error: 'Error del servidor' });
  } finally { client.release(); }
});

/* ──────────────────────────────────────────────────────────────────
   POST /api/categorias-globales/:id/vendedores/:vendedorId/asignar
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
    const { insertados, colisiones } = await asignarSeriesParaVendedor(client, req.params.id, req.params.vendedorId, tipo);
    if (!insertados.length && !colisiones.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `${vendR.rows[0].nombre} no tiene números pendientes.` });
    }
    await client.query('COMMIT');
    const mensajes = [];
    if (insertados.length) mensajes.push(`✅ ${insertados.length} número(s) asignados`);
    if (colisiones.length) mensajes.push(`⚠️ ${colisiones.length} sin espacio`);
    res.status(201).json({ message: mensajes.join('. '), vendedor_nombre: vendR.rows[0].nombre, insertados, colisiones });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err); res.status(500).json({ error: 'Error del servidor' });
  } finally { client.release(); }
});

/* ──────────────────────────────────────────────────────────────────
   GET /api/categorias-globales/:id/preview/:vendedorId
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
      `SELECT numero,serie FROM cat_global_asignaciones WHERE categoria_id=$1 AND vendedor_id=$2`,
      [req.params.id, req.params.vendedorId]
    );
    const seriesMap = {};
    asigR.rows.forEach(row => {
      if (!seriesMap[row.numero]) seriesMap[row.numero] = [];
      seriesMap[row.numero].push(row.serie);
    });

    // Pendiente = sin ninguna serie asignada aun (el boton /asignar asigna 1 por numero)
    const pendientes = poolR.rows.map(r=>r.numero).filter(n => !(seriesMap[n]?.length));

    if (!pendientes.length)
      return res.json({ tipo, libres:[], colisiones:[], puedeAgregar:false, todoAsignado:true, vendedor_nombre: vendR.rows[0].nombre });

    const libres=[]; const colisiones=[];
    for (const numero of pendientes) {
      const r = await resolverSerie(client, req.params.id, numero, req.params.vendedorId, tipo);
      if (r.disponible) {
        libres.push({ numero, serie: r.serie, mensaje: r.mensaje,
          serie_a: { libre: !r.ocupadaA, dueno: r.ocupadaA?.nombre||null },
          ...(tipo==='simultanea' ? { serie_b: { libre: !r.ocupadaB, dueno: r.ocupadaB?.nombre||null } } : {}) });
      } else {
        colisiones.push({ numero, mensaje: r.mensaje, dueno_a: r.ocupadaA?.nombre||null, dueno_b: r.ocupadaB?.nombre||null });
      }
    }
    res.json({ tipo, vendedor_nombre: vendR.rows[0].nombre, total_numeros: poolR.rows.length, total_pendientes: pendientes.length, libres, colisiones, puedeAgregar: libres.length>0 });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Error del servidor' }); }
  finally { client.release(); }
});

/* ──────────────────────────────────────────────────────────────────
   POST /api/categorias-globales/:id/vendedores
   v7: numeros=[125,125] = asignar A y B para ese vendedor nuevo.
──────────────────────────────────────────────────────────────────*/
catRouter.post('/:id/vendedores', authMiddleware, soloDueno, async (req, res) => {
  const { vendedor_id, nombre, cedula, usuario, password, numeros=[] } = req.body;
  if (!vendedor_id && !nombre?.trim())
    return res.status(400).json({ error: 'Indica vendedor_id o nombre del nuevo vendedor' });

  const invalidos = numeros.filter(n => !/^\d{3}$/.test(n));
  if (invalidos.length) return res.status(400).json({ error: `Números inválidos: ${invalidos.join(', ')}` });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const catR = await client.query('SELECT id,tipo FROM categorias_globales WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!catR.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Categoría no encontrada' }); }
    const { tipo } = catR.rows[0];

    let vendedorFinal; let credencialesGeneradas=null;
    if (vendedor_id) {
      const vR = await client.query('SELECT id,nombre,usuario,cedula,activo FROM users WHERE id=$1 AND rol=$2', [vendedor_id,'vendedor']);
      if (!vR.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Vendedor no encontrado' }); }
      if (!vR.rows[0].activo) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'El vendedor está inactivo' }); }
      vendedorFinal = vR.rows[0];
    } else {
      const nombreLimpio = nombre.trim();
      const creds = { usuario: usuario?.trim()||generarCredenciales(nombreLimpio).usuario, password: password||generarCredenciales(nombreLimpio).password };
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

    // Contar cuantas veces se pidio cada numero: [121,123,123] => {121:1, 123:2}
    const solicitudesMap = {};
    for (const num of numeros) solicitudesMap[num] = (solicitudesMap[num]||0) + 1;

    // Insertar al pool solo los unicos (una entrada por numero)
    const numerosUnicos = [...new Set(numeros)];
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
      }
    }

    // Pasar solicitudesMap: asigna exactamente las series pedidas (121->A, 123->A+B)
    const { insertados, colisiones } = await asignarSeriesParaVendedor(client, req.params.id, vendedorFinal.id, tipo, solicitudesMap);

    await client.query('COMMIT');

    const mensajes=[];
    if (insertados.length) mensajes.push(`✅ ${insertados.length} número(s) asignados`);
    if (colisiones.length) mensajes.push(`⚠️ ${colisiones.length} sin espacio`);
    if (!mensajes.length) mensajes.push('Vendedor vinculado sin números');

    res.status(201).json({
      vendedor: { id: vendedorFinal.id, nombre: vendedorFinal.nombre, usuario: vendedorFinal.usuario, cedula: vendedorFinal.cedula },
      credenciales: credencialesGeneradas,
      numeros_agregados: numerosUnicos.length,
      asignacion: { insertados, colisiones, mensaje: mensajes.join('. ') },
    });
  } catch (err) {
    await client.query('ROLLBACK');
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
    if (parseInt(existeR.rows[0].count)===0) {
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
    console.error(err); res.status(500).json({ error: 'Error del servidor' });
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
    res.json({ message: `Número ${r.rows[0].numero} (Serie ${r.rows[0].serie}) liberado.`, ...r.rows[0] });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Error del servidor' }); }
});

module.exports = { vendedoresRouter: router, categoriasGlobalesRouter: catRouter };