// ============================================================
//   RIFAS JORDYN — Vendedores + Categorías Globales  (v5 FINAL)
//
//   ARQUITECTURA DEFINITIVA — Se elimina el concepto de "slots".
//
//   TABLAS (sin cambios de schema respecto a v2):
//   ─────────────────────────────────────────────
//   cat_vendedor_numeros
//     (categoria_id, vendedor_id, numero)
//     UNIQUE (categoria_id, vendedor_id, numero)   ← UN registro por número/vendedor
//
//   cat_global_asignaciones
//     (categoria_id, vendedor_id, numero, serie)
//     UNIQUE (categoria_id, numero, serie)          ← garantiza 1 dueño por serie
//
//   REGLAS DE NEGOCIO (implementadas en resolverSerie):
//   ────────────────────────────────────────────────────
//   PARCIAL:
//     • Serie A libre para ese número → asignar.
//     • Serie A ocupada → conflicto, no se asigna.
//
//   SIMULTÁNEA:
//     • Serie A libre → asignar en A.
//     • Serie A ocupada, Serie B libre → asignar en B (automático).
//     • Serie A y B ocupadas → conflicto, informar quién tiene cada una.
//
//   El vendedor NO puede tener el mismo número dos veces.
//   Lo que sí puede ocurrir: Juan tiene 123 en Serie A,
//   Pedro también tiene 123 en Serie B — son dos vendedores distintos.
// ============================================================

const express = require('express');
const router  = express.Router();
const bcrypt  = require('bcryptjs');
const pool    = require('../config/db');
const { authMiddleware, soloDueno } = require('../middleware/auth');

/* ══════════════════════════════════════════════════════════════
   FUNCIÓN CENTRAL: resolverSerie
   ──────────────────────────────────────────────────────────────
   Recibe:
     client        — conexión pg (dentro de transacción)
     categoriaId   — id de la categoría
     numero        — string '000'-'999'
     vendedorId    — id del vendedor que quiere el número
     tipo          — 'parcial' | 'simultanea'

   Retorna:
   {
     serie:      'A' | 'B' | null,   // null = sin espacio
     disponible: boolean,
     ocupadaA:   { vendedor_id, nombre } | null,
     ocupadaB:   { vendedor_id, nombre } | null,
     mensaje:    string,
   }

   Esta función es la ÚNICA fuente de verdad para decidir
   en qué serie entra un número. Se usa en /asignar, en
   /validar-numero y en el helper de asignación masiva.
══════════════════════════════════════════════════════════════ */
async function resolverSerie(client, categoriaId, numero, vendedorId, tipo) {
  // Quién ocupa cada serie de este número (puede ser el propio vendedor u otro)
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
        mensaje: `Número libre. Se asignará en Serie A.` };
    }
    // Ocupado: ¿es el propio vendedor?
    if (String(ocupadaA.vendedor_id) === String(vendedorId)) {
      return { serie: null, disponible: false, ocupadaA, ocupadaB: null,
        mensaje: `Ya tienes este número asignado (Serie A).` };
    }
    return { serie: null, disponible: false, ocupadaA, ocupadaB: null,
      mensaje: `Número ocupado por ${ocupadaA.nombre} (Serie A).` };
  }

  // ── SIMULTÁNEA ────────────────────────────────────────────
  // Verificar si el propio vendedor ya tiene este número
  if (ocupadaA && String(ocupadaA.vendedor_id) === String(vendedorId)) {
    return { serie: null, disponible: false, ocupadaA, ocupadaB,
      mensaje: `Ya tienes este número en Serie A.` };
  }
  if (ocupadaB && String(ocupadaB.vendedor_id) === String(vendedorId)) {
    return { serie: null, disponible: false, ocupadaA, ocupadaB,
      mensaje: `Ya tienes este número en Serie B.` };
  }

  // Paso 1-2: Serie A libre → asignar en A
  if (!ocupadaA) {
    return { serie: 'A', disponible: true, ocupadaA: null, ocupadaB,
      mensaje: `Serie A libre. Se asignará en Serie A.` };
  }

  // Paso 3: Serie A ocupada → intentar Serie B
  if (!ocupadaB) {
    return { serie: 'B', disponible: true, ocupadaA, ocupadaB: null,
      mensaje: `Serie A ocupada por ${ocupadaA.nombre}. Se asignará en Serie B.` };
  }

  // Paso 4: Ambas series ocupadas → conflicto
  return { serie: null, disponible: false, ocupadaA, ocupadaB,
    mensaje: `Número sin espacio. Serie A: ${ocupadaA.nombre} / Serie B: ${ocupadaB.nombre}.` };
}

/* ══════════════════════════════════════════════════════════════
   HELPER: asignarSeriesParaVendedor
   Procesa TODOS los números pendientes de un vendedor en la
   categoría usando resolverSerie como única fuente de verdad.
══════════════════════════════════════════════════════════════ */
async function asignarSeriesParaVendedor(client, categoriaId, vendedorId, tipo) {
  // Números del vendedor en el pool
  const poolR = await client.query(
    `SELECT numero FROM cat_vendedor_numeros
     WHERE categoria_id = $1 AND vendedor_id = $2
     ORDER BY numero`,
    [categoriaId, vendedorId]
  );
  if (!poolR.rows.length) return { insertados: [], colisiones: [] };

  // Filtrar los que YA tienen asignación (de cualquier serie para este vendedor)
  const asigR = await client.query(
    `SELECT numero FROM cat_global_asignaciones
     WHERE categoria_id = $1 AND vendedor_id = $2`,
    [categoriaId, vendedorId]
  );
  const yaAsignados = new Set(asigR.rows.map(r => r.numero));
  const pendientes  = poolR.rows.map(r => r.numero).filter(n => !yaAsignados.has(n));

  if (!pendientes.length) return { insertados: [], colisiones: [] };

  const insertados  = [];
  const colisiones  = [];

  for (const numero of pendientes) {
    const resolucion = await resolverSerie(client, categoriaId, numero, vendedorId, tipo);

    if (resolucion.disponible) {
      // Insertar la asignación con ON CONFLICT por si acaso hay concurrencia
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
        // Raro: conflicto de concurrencia — re-resolver
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
   GET /api/categorias-globales/:id/vendedores-resumen
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
         COUNT(cvn.numero)::int                            AS total_numeros,
         COUNT(cga.id)::int                                AS total_asignados,
         COUNT(CASE WHEN cga.serie='A' THEN 1 END)::int   AS serie_a,
         COUNT(CASE WHEN cga.serie='B' THEN 1 END)::int   AS serie_b,
         JSON_AGG(
           JSON_BUILD_OBJECT(
             'numero',        cvn.numero,
             'serie',         cga.serie,
             'asignacion_id', cga.id
           ) ORDER BY cvn.numero
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
   GET /api/categorias-globales/:id/validar-numero
   ?numero=012&vendedor_id=5

   Usa resolverSerie directamente — misma lógica que la asignación real.
   No modifica nada. Respuesta inmediata para el frontend.
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

    // ¿El vendedor ya tiene este número en su pool?
    const enPoolR = await client.query(
      `SELECT id FROM cat_vendedor_numeros WHERE categoria_id=$1 AND vendedor_id=$2 AND numero=$3`,
      [req.params.id, vendedor_id, numero]
    );
    const yaEnPool = enPoolR.rows.length > 0;

    // Resolver usando la función central
    const resolucion = await resolverSerie(client, req.params.id, numero, vendedor_id, tipo);

    res.json({
      numero,
      tipo,
      disponible:    resolucion.disponible,
      serie_destino: resolucion.serie,         // 'A', 'B' o null
      serie_a: {
        libre: !resolucion.ocupadaA,
        dueno: resolucion.ocupadaA?.nombre || null,
      },
      serie_b: tipo === 'simultanea' ? {
        libre: !resolucion.ocupadaB,
        dueno: resolucion.ocupadaB?.nombre || null,
      } : undefined,
      ya_en_pool: yaEnPool,
      mensaje:    resolucion.mensaje,
    });
  } catch (err) {
    console.error('GET /validar-numero:', err);
    res.status(500).json({ error: 'Error del servidor' });
  } finally { client.release(); }
});

/* ──────────────────────────────────────────────────────────────────
   POST /api/categorias-globales/:id/vendedores/:vendedorId/numeros
   Agrega números al pool. No asigna series todavía.
   Body: { numeros: ['001','050','123'] }
──────────────────────────────────────────────────────────────────*/
catRouter.post('/:id/vendedores/:vendedorId/numeros', authMiddleware, soloDueno, async (req, res) => {
  const { numeros } = req.body;
  if (!Array.isArray(numeros) || !numeros.length)
    return res.status(400).json({ error: 'numeros[] es requerido' });

  const invalidos = numeros.filter(n => !/^\d{3}$/.test(n));
  if (invalidos.length)
    return res.status(400).json({ error: `Números inválidos: ${invalidos.join(', ')}` });

  // Deduplicar — un vendedor tiene un número una sola vez en el pool
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

    // Cuáles ya están en el pool del vendedor
    const existR = await client.query(
      `SELECT numero FROM cat_vendedor_numeros WHERE categoria_id=$1 AND vendedor_id=$2 AND numero=ANY($3::char[])`,
      [req.params.id, req.params.vendedorId, numerosUnicos]
    );
    const yaExisten = new Set(existR.rows.map(r => r.numero));
    const nuevos    = numerosUnicos.filter(n => !yaExisten.has(n));

    // Insertar los nuevos al pool
    for (const num of nuevos) {
      await client.query(
        `INSERT INTO cat_vendedor_numeros (categoria_id, vendedor_id, numero) VALUES ($1,$2,$3)`,
        [req.params.id, req.params.vendedorId, num]
      );
    }

    // Calcular previsualización de series para los recién insertados
    const infoSeries = [];
    for (const num of nuevos) {
      const res = await resolverSerie(client, req.params.id, num, req.params.vendedorId, tipo);
      infoSeries.push({
        numero:        num,
        disponible:    res.disponible,
        serie_destino: res.serie,
        serie_a:       { libre: !res.ocupadaA, dueno: res.ocupadaA?.nombre || null },
        ...(tipo === 'simultanea' ? { serie_b: { libre: !res.ocupadaB, dueno: res.ocupadaB?.nombre || null } } : {}),
        mensaje:       res.mensaje,
      });
    }

    await client.query('COMMIT');
    res.status(201).json({
      message:     `${nuevos.length} número(s) agregados al pool de ${vendR.rows[0].nombre}.`,
      insertados:  nuevos.length,
      ya_existian: [...yaExisten],
      info_series: infoSeries,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error: 'Número duplicado en el pool' });
    console.error('POST numeros:', err); res.status(500).json({ error: 'Error del servidor' });
  } finally { client.release(); }
});

/* ──────────────────────────────────────────────────────────────────
   DELETE /api/categorias-globales/:id/vendedores/:vendedorId/numeros
   Body: { numeros: ['001','050'] }
──────────────────────────────────────────────────────────────────*/
catRouter.delete('/:id/vendedores/:vendedorId/numeros', authMiddleware, soloDueno, async (req, res) => {
  const { numeros } = req.body;
  if (!Array.isArray(numeros) || !numeros.length)
    return res.status(400).json({ error: 'numeros[] es requerido' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Eliminar asignaciones primero
    await client.query(
      `DELETE FROM cat_global_asignaciones WHERE categoria_id=$1 AND vendedor_id=$2 AND numero=ANY($3::char[])`,
      [req.params.id, req.params.vendedorId, numeros]
    );
    // Eliminar del pool
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
   Asigna series a todos los números pendientes del vendedor.
   Usa resolverSerie → sin números huérfanos, sin duplicados en serie.
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
   Previsualiza la asignación sin modificar nada.
   Usa resolverSerie → 100% fiel a lo que haría /asignar.
──────────────────────────────────────────────────────────────────*/
catRouter.get('/:id/preview/:vendedorId', authMiddleware, soloDueno, async (req, res) => {
  const client = await pool.connect();
  try {
    const catR = await client.query('SELECT id,tipo FROM categorias_globales WHERE id=$1', [req.params.id]);
    if (!catR.rows[0]) return res.status(404).json({ error: 'Categoría no encontrada' });
    const { tipo } = catR.rows[0];

    const vendR = await client.query('SELECT id,nombre FROM users WHERE id=$1 AND rol=$2', [req.params.vendedorId, 'vendedor']);
    if (!vendR.rows[0]) return res.status(404).json({ error: 'Vendedor no encontrado' });

    // Números del vendedor en el pool
    const poolR = await client.query(
      `SELECT numero FROM cat_vendedor_numeros WHERE categoria_id=$1 AND vendedor_id=$2 ORDER BY numero`,
      [req.params.id, req.params.vendedorId]
    );
    if (!poolR.rows.length)
      return res.json({ tipo, libres:[], colisiones:[], puedeAgregar:false, sinNumeros:true, vendedor_nombre: vendR.rows[0].nombre });

    // Ya asignados para este vendedor
    const asigR = await client.query(
      `SELECT numero FROM cat_global_asignaciones WHERE categoria_id=$1 AND vendedor_id=$2`,
      [req.params.id, req.params.vendedorId]
    );
    const yaAsignados = new Set(asigR.rows.map(r => r.numero));
    const pendientes  = poolR.rows.map(r => r.numero).filter(n => !yaAsignados.has(n));

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
          mensaje: r.mensaje,
          dueno_a: r.ocupadaA?.nombre || null,
          dueno_b: r.ocupadaB?.nombre || null,
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
   Crea o vincula un vendedor y asigna sus números en un solo paso.
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

    // Obtener o crear el vendedor
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

    // Insertar números al pool (ignorar los que ya existen)
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

    // Asignar series automáticamente
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
   Libera la serie de un número (lo deja en el pool sin serie).
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