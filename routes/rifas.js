// ============================================================
//   RIFAS JORDYN — Rutas de Rifas
//   ✅ ACTUALIZADO: campo `ofertas` (jsonb) en crear/editar/leer
//   ✅ ACTUALIZADO v3: flujo categorías globales
//      - POST/PUT reciben `categoria_id` y `vendedores_categorias`
//        [{vendedor_id, categoria_id}] desde el selector del frontend.
//      - `categoria_seleccionada_id` se guarda en la tabla rifas para
//        que caja.js pueda leer qué vendedores van en el lote.
//      - sincronizarVendedoresRifa usa cat_global_asignaciones para
//        copiar los números con sus series A/B a numeros_vendedor.
//      - Se mantiene compatibilidad con `vendedores_ids` legado.
// ============================================================
const express = require('express');
const router  = express.Router();
const pool    = require('../config/db');
const { authMiddleware, soloDueno } = require('../middleware/auth');

/* ── Helper: valida array de ofertas ─────────────────────── */
function validarOfertas(ofertas) {
  if (!Array.isArray(ofertas)) return 'ofertas debe ser un array';
  for (const o of ofertas) {
    if (!Number.isInteger(o.cantidad) || o.cantidad < 2)
      return 'Cada oferta debe tener cantidad (entero ≥ 2)';
    if (typeof o.precio_total !== 'number' || o.precio_total <= 0)
      return 'Cada oferta debe tener precio_total (número > 0)';
  }
  const cantidades = ofertas.map(o => o.cantidad);
  if (new Set(cantidades).size !== cantidades.length)
    return 'No puede haber dos ofertas con la misma cantidad';
  return null;
}

/* ── Helper: sincronizar vendedores de una rifa ─────────────
   Fuente de verdad: cat_global_asignaciones (series A/B).
   1. Elimina numeros_vendedor de vendedores que ya no están en
      la lista (respetando ventas registradas).
   2. Para cada vendedor seleccionado, copia sus asignaciones
      confirmadas de cat_global_asignaciones a numeros_vendedor
      con este rifa_id, incluyendo la serie (A o B).
   3. Si se reciben vendedores_ids legado (sin categoria_id) se
      usa numeros_vendedor_global como fallback.
──────────────────────────────────────────────────────────── */
async function sincronizarVendedoresRifa(client, rifa_id, vendedores_ids, vendedores_categorias = []) {
  // 1. Quitar asignaciones de vendedores removidos
  if (vendedores_ids.length > 0) {
    await client.query(
      `DELETE FROM numeros_vendedor
       WHERE rifa_id = $1
         AND vendedor_id NOT IN (SELECT UNNEST($2::uuid[]))
         AND numero NOT IN (
           SELECT numero FROM ventas WHERE rifa_id = $1
         )`,
      [rifa_id, vendedores_ids]
    );
  } else {
    await client.query(
      `DELETE FROM numeros_vendedor
       WHERE rifa_id = $1
         AND numero NOT IN (
           SELECT numero FROM ventas WHERE rifa_id = $1
         )`,
      [rifa_id]
    );
  }

  if (vendedores_ids.length === 0) return;

  if (vendedores_categorias.length > 0) {
    // Verificar si la columna serie existe ANTES de entrar al loop.
    // Un query fallido dentro de una TX de Postgres la deja abortada (25P02);
    // el .catch() de JS no puede recuperar eso, hay que decidir el path antes.
    const colCheck = await client.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_name = 'numeros_vendedor' AND column_name = 'serie'`
    );
    const tieneColumnasSerie = colCheck.rows.length > 0;

    // Agrupar por categoria_id para un solo query por categoría
    const porCategoria = {};
    for (const { vendedor_id, categoria_id } of vendedores_categorias) {
      if (!porCategoria[categoria_id]) porCategoria[categoria_id] = [];
      porCategoria[categoria_id].push(vendedor_id);
    }

    for (const [categoria_id, vids] of Object.entries(porCategoria)) {
      if (tieneColumnasSerie) {
        // Flujo completo: copiar con serie A/B
        await client.query(
          `INSERT INTO numeros_vendedor (vendedor_id, rifa_id, numero, serie)
           SELECT cga.vendedor_id, $1, cga.numero, cga.serie
           FROM cat_global_asignaciones cga
           WHERE cga.categoria_id = $2
             AND cga.vendedor_id = ANY($3::uuid[])
           ON CONFLICT (vendedor_id, rifa_id, numero, serie) DO NOTHING`,
          [rifa_id, categoria_id, vids]
        );
      } else {
        // Fallback: la columna serie no existe aun en la BD
        await client.query(
          `INSERT INTO numeros_vendedor (vendedor_id, rifa_id, numero)
           SELECT DISTINCT cga.vendedor_id, $1, cga.numero
           FROM cat_global_asignaciones cga
           WHERE cga.categoria_id = $2
             AND cga.vendedor_id = ANY($3::uuid[])
           ON CONFLICT (vendedor_id, rifa_id, numero) DO NOTHING`,
          [rifa_id, categoria_id, vids]
        );
      }
    }
  } else {
    // ── Flujo legado: numeros_vendedor_global
    await client.query(
      `INSERT INTO numeros_vendedor (vendedor_id, rifa_id, numero)
       SELECT ng.vendedor_id, $1 AS rifa_id, ng.numero
       FROM numeros_vendedor_global ng
       WHERE ng.vendedor_id = ANY($2::uuid[])
       ON CONFLICT (vendedor_id, rifa_id, numero) DO NOTHING`,
      [rifa_id, vendedores_ids]
    );
  }
}

// ── GET /api/rifas ─────────────────────────────────────────
router.get('/', authMiddleware, async (req, res) => {
  try {
    // Rifas con sus stats
    const result = await pool.query(`
      SELECT
        r.id, r.nombre, r.descripcion, r.premio, r.precio,
        r.fecha_sorteo, r.loteria_ref, r.activa,
        r.imagen_url,
        COALESCE(r.tipo,    'sencilla') AS tipo,
        COALESCE(r.estado,  'activa')   AS estado,
        COALESCE(r.ofertas, '[]'::jsonb) AS ofertas,
        COALESCE(COUNT(DISTINCT v.id), 0)::int AS total_ventas,
        COALESCE(SUM(v.precio_venta),  0)       AS ingresos_totales,
        r.created_at
      FROM rifas r
      LEFT JOIN ventas v ON v.rifa_id = r.id
      GROUP BY r.id
      ORDER BY r.created_at DESC
    `);

    const rifas = result.rows;

    // Vendedores por rifa (usando numeros_vendedor agrupados)
    const vendedoresResult = await pool.query(`
      SELECT
        nv.rifa_id,
        nv.vendedor_id        AS id,
        u.nombre,
        u.usuario,
        COUNT(nv.numero)::int AS numeros_count
      FROM numeros_vendedor nv
      JOIN users u ON u.id = nv.vendedor_id
      GROUP BY nv.rifa_id, nv.vendedor_id, u.nombre, u.usuario
      ORDER BY u.nombre
    `);

    // Agrupar vendedores por rifa_id
    const vendedoresPorRifa = {};
    vendedoresResult.rows.forEach(vr => {
      if (!vendedoresPorRifa[vr.rifa_id]) vendedoresPorRifa[vr.rifa_id] = [];
      vendedoresPorRifa[vr.rifa_id].push({
        id:           vr.id,
        nombre:       vr.nombre,
        usuario:      vr.usuario,
        numeros_count: vr.numeros_count,
      });
    });

    // Inyectar vendedores en cada rifa
    const rifasConVendedores = rifas.map(r => ({
      ...r,
      vendedores:     vendedoresPorRifa[r.id] || [],
      vendedores_ids: (vendedoresPorRifa[r.id] || []).map(v => v.id),
    }));

    res.json(rifasConVendedores);
  } catch (err) {
    console.error('Error obteniendo rifas:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ── GET /api/rifas/:id ─────────────────────────────────────
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        r.id, r.nombre, r.descripcion, r.premio, r.precio,
        r.fecha_sorteo, r.loteria_ref, r.activa,
        r.imagen_url,
        COALESCE(r.tipo,    'sencilla') AS tipo,
        COALESCE(r.estado,  'activa')   AS estado,
        COALESCE(r.ofertas, '[]'::jsonb) AS ofertas,
        COALESCE(COUNT(DISTINCT v.id), 0)::int AS total_ventas,
        COALESCE(SUM(v.precio_venta),  0)       AS ingresos_totales,
        r.created_at
      FROM rifas r
      LEFT JOIN ventas v ON v.rifa_id = r.id
      WHERE r.id = $1
      GROUP BY r.id
    `, [req.params.id]);

    if (!result.rows[0]) return res.status(404).json({ error: 'Rifa no encontrada' });

    // Vendedores de esta rifa
    const vRes = await pool.query(`
      SELECT
        nv.vendedor_id        AS id,
        u.nombre,
        u.usuario,
        COUNT(nv.numero)::int AS numeros_count
      FROM numeros_vendedor nv
      JOIN users u ON u.id = nv.vendedor_id
      WHERE nv.rifa_id = $1
      GROUP BY nv.vendedor_id, u.nombre, u.usuario
      ORDER BY u.nombre
    `, [req.params.id]);

    res.json({
      ...result.rows[0],
      vendedores:     vRes.rows,
      vendedores_ids: vRes.rows.map(v => v.id),
    });
  } catch (err) {
    console.error('Error obteniendo rifa:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ── POST /api/rifas ────────────────────────────────────────
router.post('/', authMiddleware, soloDueno, async (req, res) => {
  const {
    nombre, descripcion, premio, precio,
    fecha_sorteo, loteria_ref,
    tipo                  = 'sencilla',
    imagen_url            = null,
    estado                = 'activa',
    ofertas               = [],
    vendedores_ids        = [],
    vendedores_categorias = [],   // [{vendedor_id, categoria_id}] — desde SelectorCategoria
    categoria_id          = null, // categoría global seleccionada
  } = req.body;

  if (!nombre || !premio || !precio)
    return res.status(400).json({ error: 'Nombre, premio y precio son requeridos' });

  const errOfertas = validarOfertas(ofertas);
  if (errOfertas) return res.status(400).json({ error: errOfertas });

  const ofertasOrdenadas = [...ofertas].sort((a, b) => a.cantidad - b.cantidad);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Construir ids desde vendedores_categorias si no vienen como vendedores_ids
    const vids = vendedores_ids.length > 0
      ? vendedores_ids
      : vendedores_categorias.map(v => v.vendedor_id);

    // Crear la rifa guardando categoria_seleccionada_id para que caja pueda leerla
    const result = await client.query(
      `INSERT INTO rifas
         (nombre, descripcion, premio, precio, fecha_sorteo, loteria_ref,
          tipo, imagen_url, estado, ofertas, categoria_seleccionada_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [
        nombre, descripcion || null, premio, precio,
        fecha_sorteo || null, loteria_ref || null,
        tipo, imagen_url, estado,
        JSON.stringify(ofertasOrdenadas),
        categoria_id || null,
        req.user.id,
      ]
    );

    const rifa = result.rows[0];

    // Reservar números usando cat_global_asignaciones (series A/B)
    if (vids.length > 0) {
      await sincronizarVendedoresRifa(client, rifa.id, vids, vendedores_categorias);
    }

    await client.query('COMMIT');

    // Devolver rifa con vendedores
    const vRes = await pool.query(`
      SELECT nv.vendedor_id AS id, u.nombre, u.usuario, COUNT(nv.numero)::int AS numeros_count
      FROM numeros_vendedor nv
      JOIN users u ON u.id = nv.vendedor_id
      WHERE nv.rifa_id = $1
      GROUP BY nv.vendedor_id, u.nombre, u.usuario
    `, [rifa.id]);

    res.status(201).json({
      message: 'Rifa creada exitosamente',
      rifa: {
        ...rifa,
        vendedores:     vRes.rows,
        vendedores_ids: vRes.rows.map(v => v.id),
      },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error creando rifa:', err);
    res.status(500).json({ error: 'Error del servidor' });
  } finally {
    client.release();
  }
});

// ── PUT /api/rifas/:id ─────────────────────────────────────
router.put('/:id', authMiddleware, soloDueno, async (req, res) => {
  const {
    nombre, descripcion, premio, precio,
    fecha_sorteo, loteria_ref,
    activa, tipo, imagen_url, estado, ofertas,
    vendedores_ids,
    vendedores_categorias,        // [{vendedor_id, categoria_id}] — puede ser undefined
    categoria_id,                 // categoría global seleccionada — puede ser undefined
  } = req.body;

  if (ofertas !== undefined) {
    const errOfertas = validarOfertas(ofertas);
    if (errOfertas) return res.status(400).json({ error: errOfertas });
  }

  const ofertasOrdenadas = ofertas !== undefined
    ? JSON.stringify([...ofertas].sort((a, b) => a.cantidad - b.cantidad))
    : undefined;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const result = await client.query(
      `UPDATE rifas SET
        nombre                  = COALESCE($1,  nombre),
        descripcion             = COALESCE($2,  descripcion),
        premio                  = COALESCE($3,  premio),
        precio                  = COALESCE($4,  precio),
        fecha_sorteo            = COALESCE($5,  fecha_sorteo),
        loteria_ref             = COALESCE($6,  loteria_ref),
        activa                  = COALESCE($7,  activa),
        tipo                    = COALESCE($8,  tipo),
        imagen_url              = CASE WHEN $9::text  IS NOT NULL THEN $9::text  ELSE imagen_url END,
        estado                  = COALESCE($10, estado),
        ofertas                 = CASE WHEN $11::text IS NOT NULL THEN $11::jsonb ELSE ofertas END,
        categoria_seleccionada_id = COALESCE($13::uuid, categoria_seleccionada_id)
       WHERE id = $12
       RETURNING *`,
      [
        nombre       ?? null,
        descripcion  ?? null,
        premio       ?? null,
        precio       ?? null,
        fecha_sorteo ?? null,
        loteria_ref  ?? null,
        activa       ?? null,
        tipo         ?? null,
        imagen_url   !== undefined ? imagen_url : null,
        estado       ?? null,
        ofertasOrdenadas ?? null,
        req.params.id,
        categoria_id ?? null,
      ]
    );

    if (!result.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Rifa no encontrada' });
    }

    // Sincronizar reservas si vienen vendedores (ya sea formato nuevo o legado)
    const vids = Array.isArray(vendedores_ids) && vendedores_ids.length > 0
      ? vendedores_ids
      : Array.isArray(vendedores_categorias) && vendedores_categorias.length > 0
        ? vendedores_categorias.map(v => v.vendedor_id)
        : null;

    if (vids !== null) {
      await sincronizarVendedoresRifa(
        client,
        req.params.id,
        vids,
        Array.isArray(vendedores_categorias) ? vendedores_categorias : []
      );
    }

    await client.query('COMMIT');

    // Devolver rifa actualizada con vendedores
    const vRes = await pool.query(`
      SELECT nv.vendedor_id AS id, u.nombre, u.usuario, COUNT(nv.numero)::int AS numeros_count
      FROM numeros_vendedor nv
      JOIN users u ON u.id = nv.vendedor_id
      WHERE nv.rifa_id = $1
      GROUP BY nv.vendedor_id, u.nombre, u.usuario
    `, [req.params.id]);

    res.json({
      message: 'Rifa actualizada',
      rifa: {
        ...result.rows[0],
        vendedores:     vRes.rows,
        vendedores_ids: vRes.rows.map(v => v.id),
      },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error actualizando rifa:', err);
    res.status(500).json({ error: 'Error del servidor' });
  } finally {
    client.release();
  }
});

// ── DELETE /api/rifas/:id ──────────────────────────────────
// Query param: ?force=true  → borra también ventas y números
router.delete('/:id', authMiddleware, soloDueno, async (req, res) => {
  const force = req.query.force === 'true';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Verificar que la rifa existe
    const rifaR = await client.query(
      `SELECT r.id, r.nombre, r.activa,
              COUNT(DISTINCT v.id)::int  AS total_ventas,
              COUNT(DISTINCT nv.vendedor_id)::int AS total_vendedores,
              COALESCE(
                JSON_AGG(DISTINCT JSONB_BUILD_OBJECT('id', u.id, 'nombre', u.nombre))
                FILTER (WHERE u.id IS NOT NULL), '[]'
              ) AS vendedores
       FROM rifas r
       LEFT JOIN ventas v         ON v.rifa_id = r.id
       LEFT JOIN numeros_vendedor nv ON nv.rifa_id = r.id
       LEFT JOIN users u          ON u.id = nv.vendedor_id
       WHERE r.id = $1
       GROUP BY r.id`,
      [req.params.id]
    );

    if (!rifaR.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Rifa no encontrada' });
    }

    const rifa = rifaR.rows[0];

    // Si tiene ventas y no es force → devolver info para que el frontend muestre la advertencia
    if (rifa.total_ventas > 0 && !force) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error:            'La rifa tiene ventas registradas.',
        requiere_fuerza:  true,
        rifa_nombre:      rifa.nombre,
        activa:           rifa.activa,
        total_ventas:     rifa.total_ventas,
        total_vendedores: rifa.total_vendedores,
        vendedores:       rifa.vendedores,
      });
    }

    // Eliminar en orden: ventas → numeros_vendedor → rifa
    if (force) {
      await client.query('DELETE FROM ventas          WHERE rifa_id = $1', [req.params.id]);
    }
    await client.query('DELETE FROM numeros_vendedor WHERE rifa_id = $1', [req.params.id]);
    await client.query('DELETE FROM rifas            WHERE id      = $1', [req.params.id]);

    await client.query('COMMIT');
    res.json({
      message:      `Rifa "${rifa.nombre}" eliminada exitosamente.`,
      ventas_borradas: force ? rifa.total_ventas : 0,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error eliminando rifa:', err);
    res.status(500).json({ error: 'Error del servidor' });
  } finally {
    client.release();
  }
});

// ── GET /api/rifas/:id/ticket-design ──────────────────────
router.get('/:id/ticket-design', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT ticket_design FROM rifas WHERE id = $1',
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Rifa no encontrada' });
    res.json({ ticket_design: result.rows[0].ticket_design || null });
  } catch (err) {
    console.error('Error obteniendo ticket design:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ── PUT /api/rifas/:id/ticket-design ──────────────────────
router.put('/:id/ticket-design', authMiddleware, soloDueno, async (req, res) => {
  const { ticket_design } = req.body;
  if (!ticket_design || typeof ticket_design !== 'object')
    return res.status(400).json({ error: 'ticket_design debe ser un objeto JSON' });
  try {
    const result = await pool.query(
      `UPDATE rifas SET ticket_design = $1, updated_at = NOW()
       WHERE id = $2 RETURNING id, nombre, ticket_design`,
      [JSON.stringify(ticket_design), req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Rifa no encontrada' });
    res.json({
      message: 'Diseño de ticket guardado',
      rifa_id:      result.rows[0].id,
      rifa_nombre:  result.rows[0].nombre,
      ticket_design: result.rows[0].ticket_design,
    });
  } catch (err) {
    console.error('Error guardando ticket design:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});


// ── GET /api/rifas/:id/boleteria-vendedores ────────────────
// Devuelve vendedores asignados a esta rifa con sus números fijos,
// y los números disponibles por serie (A y B) para asignar más.

router.get('/:id/boleteria-vendedores', authMiddleware, soloDueno, async (req, res) => {
  try {
    const rifa_id = req.params.id;
 
    // 1. Info de la rifa
    const rifaR = await pool.query(
      `SELECT id, nombre, COALESCE(tipo, 'sencilla') AS tipo, categoria_seleccionada_id
       FROM rifas WHERE id = $1`,
      [rifa_id]
    );
    if (!rifaR.rows[0]) return res.status(404).json({ error: 'Rifa no encontrada' });
    const rifa         = rifaR.rows[0];
    const esSimultanea = rifa.tipo === 'simultanea';
 
    // 2. Vendedores con TODOS sus números en esta rifa (fijos + extras)
    //    Se etiqueta cada número con `origen` para el frontend.
    const vendR = await pool.query(`
      WITH numeros_unidos AS (
        SELECT vendedor_id, numero, COALESCE(serie, 'A') AS serie, 'fijo'::text AS origen
          FROM numeros_vendedor
         WHERE rifa_id = $1
        UNION ALL
        SELECT vendedor_id, numero, serie, 'extra'::text AS origen
          FROM boleteria_numeros_extra
         WHERE rifa_id = $1
      )
      SELECT
        u.id              AS vendedor_id,
        u.nombre          AS vendedor_nombre,
        u.cedula,
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
      FROM users u
      LEFT JOIN numeros_unidos nu ON nu.vendedor_id = u.id
      WHERE u.id IN (
        SELECT DISTINCT vendedor_id FROM numeros_vendedor       WHERE rifa_id = $1
        UNION
        SELECT DISTINCT vendedor_id FROM boleteria_numeros_extra WHERE rifa_id = $1
      )
      GROUP BY u.id, u.nombre, u.cedula
      ORDER BY u.nombre
    `, [rifa_id]);
 
    // 3. Disponibles por serie en la CATEGORÍA (lo que se puede repartir).
    //    Un número está disponible para serie X si:
    //      • está en el pool de la categoría (cat_vendedor_numeros), Y
    //      • esa (numero, serie) NO está ya en cat_global_asignaciones, Y
    //      • esa (numero, serie) NO está ya como extra en esta rifa.
    let disponiblesA = [];
    let disponiblesB = [];
 
    if (rifa.categoria_seleccionada_id) {
      const cat_id = rifa.categoria_seleccionada_id;
 
      // Ocupadas en la categoría global (fijos)
      const asigR = await pool.query(
        `SELECT numero, serie FROM cat_global_asignaciones WHERE categoria_id = $1`,
        [cat_id]
      );
      const ocupadasPorNum = {};
      asigR.rows.forEach(r => {
        if (!ocupadasPorNum[r.numero]) ocupadasPorNum[r.numero] = new Set();
        ocupadasPorNum[r.numero].add(r.serie);
      });
 
      // Ocupadas como EXTRA en esta rifa (también bloquean)
      const extraR = await pool.query(
        `SELECT numero, serie FROM boleteria_numeros_extra WHERE rifa_id = $1`,
        [rifa_id]
      );
      extraR.rows.forEach(r => {
        if (!ocupadasPorNum[r.numero]) ocupadasPorNum[r.numero] = new Set();
        ocupadasPorNum[r.numero].add(r.serie);
      });
 
      // Pool de números de la categoría
      const poolR = await pool.query(
        `SELECT DISTINCT numero FROM cat_vendedor_numeros
          WHERE categoria_id = $1 ORDER BY numero`,
        [cat_id]
      );
 
      for (const { numero } of poolR.rows) {
        const ocupadas = ocupadasPorNum[numero] || new Set();
        if (!ocupadas.has('A'))                disponiblesA.push(numero);
        if (esSimultanea && !ocupadas.has('B')) disponiblesB.push(numero);
      }
    }
 
    res.json({
      rifa_id,
      tipo:             rifa.tipo,
      es_simultanea:    esSimultanea,
      tiene_categoria:  !!rifa.categoria_seleccionada_id,
      vendedores:       vendR.rows,
      disponibles_a:    disponiblesA,
      disponibles_b:    esSimultanea ? disponiblesB : [],
    });
  } catch (err) {
    console.error('Error boleteria-vendedores:', err);
    res.status(500).json({ error: err.message });
  }
});
 
// ── POST /api/rifas/:id/boleteria-vendedores/:vendedorId ───
// Asigna números EXTRA a un vendedor SOLO para esta rifa.
// NO se escriben en cat_global_asignaciones ni cat_vendedor_numeros.
// Body: { numeros: ['001','002'], serie?: 'A'|'B' }
router.post('/:id/boleteria-vendedores/:vendedorId', authMiddleware, soloDueno, async (req, res) => {
  const { numeros, serie } = req.body;
  const rifa_id     = req.params.id;
  const vendedor_id = req.params.vendedorId;
 
  if (!Array.isArray(numeros) || numeros.length === 0)
    return res.status(400).json({ error: 'numeros[] es requerido' });
 
  const invalidos = numeros.filter(n => !/^\d{3}$/.test(n));
  if (invalidos.length > 0)
    return res.status(400).json({ error: `Números con formato inválido: ${invalidos.join(', ')}` });
 
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
 
    const rifaR = await client.query(
      `SELECT id, COALESCE(tipo,'sencilla') AS tipo, categoria_seleccionada_id
       FROM rifas WHERE id = $1`,
      [rifa_id]
    );
    if (!rifaR.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Rifa no encontrada' });
    }
    const { tipo, categoria_seleccionada_id } = rifaR.rows[0];
    const esSimultanea = tipo === 'simultanea';
 
    // Verificar que el vendedor exista
    const vR = await client.query(`SELECT id FROM users WHERE id = $1`, [vendedor_id]);
    if (!vR.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Vendedor no encontrado' });
    }
 
    const insertados = [];
    const colisiones = [];
 
    for (const numero of numeros) {
      // ── Resolver la serie a usar ───────────────────────────
      let serieDestino = serie || 'A';
 
      if (esSimultanea && !serie) {
        // Auto-resolver: ver qué series están libres
        // (en cat_global_asignaciones Y en boleteria_numeros_extra)
        const ocupadas = new Set();
 
        if (categoria_seleccionada_id) {
          const ocR = await client.query(
            `SELECT serie FROM cat_global_asignaciones
              WHERE categoria_id = $1 AND numero = $2`,
            [categoria_seleccionada_id, numero]
          );
          ocR.rows.forEach(r => ocupadas.add(r.serie));
        }
        const ocExtraR = await client.query(
          `SELECT serie FROM boleteria_numeros_extra
            WHERE rifa_id = $1 AND numero = $2`,
          [rifa_id, numero]
        );
        ocExtraR.rows.forEach(r => ocupadas.add(r.serie));
 
        if (!ocupadas.has('A'))      serieDestino = 'A';
        else if (!ocupadas.has('B')) serieDestino = 'B';
        else {
          colisiones.push({ numero, razon: 'Número sin series disponibles' });
          continue;
        }
      }
 
      // ── Verificar conflictos ───────────────────────────────
      // a) ¿Ya lo tiene fijo el mismo vendedor (numeros_vendedor)?
      const yaFijo = await client.query(
        `SELECT 1 FROM numeros_vendedor
          WHERE vendedor_id = $1 AND rifa_id = $2
            AND numero = $3 AND COALESCE(serie,'A') = $4`,
        [vendedor_id, rifa_id, numero, serieDestino]
      );
      if (yaFijo.rows[0]) {
        colisiones.push({ numero, razon: `Ya es número fijo del vendedor (Serie ${serieDestino})` });
        continue;
      }
 
      // b) ¿Ya lo tiene como extra el mismo vendedor?
      const yaExtraMismo = await client.query(
        `SELECT 1 FROM boleteria_numeros_extra
          WHERE vendedor_id = $1 AND rifa_id = $2
            AND numero = $3 AND serie = $4`,
        [vendedor_id, rifa_id, numero, serieDestino]
      );
      if (yaExtraMismo.rows[0]) {
        colisiones.push({ numero, razon: `Ya asignado como extra (Serie ${serieDestino})` });
        continue;
      }
 
      // c) ¿Otro vendedor ya lo tiene (fijo o extra) en esta rifa con esa serie?
      const ocupadoOtroR = await client.query(
        `SELECT u.nombre, src FROM (
           SELECT vendedor_id, 'fijo'  AS src FROM numeros_vendedor
            WHERE rifa_id = $1 AND numero = $2 AND COALESCE(serie,'A') = $3
              AND vendedor_id <> $4
           UNION ALL
           SELECT vendedor_id, 'extra' AS src FROM boleteria_numeros_extra
            WHERE rifa_id = $1 AND numero = $2 AND serie = $3
              AND vendedor_id <> $4
         ) ocup
         JOIN users u ON u.id = ocup.vendedor_id
         LIMIT 1`,
        [rifa_id, numero, serieDestino, vendedor_id]
      );
      if (ocupadoOtroR.rows[0]) {
        colisiones.push({
          numero,
          razon: `Ocupado (${ocupadoOtroR.rows[0].src}) por ${ocupadoOtroR.rows[0].nombre} en Serie ${serieDestino}`,
        });
        continue;
      }
 
      // ── Insertar SOLO en boleteria_numeros_extra ───────────
      //  (NO se toca cat_global_asignaciones ni cat_vendedor_numeros)
      await client.query(
        `INSERT INTO boleteria_numeros_extra
           (rifa_id, vendedor_id, numero, serie, created_by)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (rifa_id, numero, serie) DO NOTHING`,
        [rifa_id, vendedor_id, numero, serieDestino, req.user.id]
      );
 
      insertados.push({ numero, serie: serieDestino, origen: 'extra' });
    }
 
    await client.query('COMMIT');
    res.json({
      ok: true,
      insertados,
      colisiones,
      total_insertados: insertados.length,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error asignando numeros boleteria (extras):', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});
 
// ── DELETE /api/rifas/:id/boleteria-vendedores/:vendedorId/numero ──
// Quita un número del vendedor en esta rifa.
// Body: { numero: '001', serie?: 'A'|'B', origen?: 'fijo'|'extra' }
//
//   • Si origen === 'extra'  → solo borra de boleteria_numeros_extra.
//   • Si origen === 'fijo'   → borra de numeros_vendedor Y libera la
//                              asignación en cat_global_asignaciones
//                              (comportamiento legado).
//   • Si origen no viene     → intenta primero extra; si no existe, fijo.
//     (Esto permite que el frontend siga llamando sin saber el origen.)
router.delete('/:id/boleteria-vendedores/:vendedorId/numero', authMiddleware, soloDueno, async (req, res) => {
  const { numero, serie, origen } = req.body;
  const rifa_id     = req.params.id;
  const vendedor_id = req.params.vendedorId;
 
  if (!numero) return res.status(400).json({ error: 'numero es requerido' });
 
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
 
    // ── 1) Intentar borrar como EXTRA si aplica ────────────
    let borradoComo = null;
 
    if (origen === 'extra' || !origen) {
      const qExtra = serie
        ? `DELETE FROM boleteria_numeros_extra
            WHERE rifa_id = $1 AND vendedor_id = $2 AND numero = $3 AND serie = $4
            RETURNING serie`
        : `DELETE FROM boleteria_numeros_extra
            WHERE rifa_id = $1 AND vendedor_id = $2 AND numero = $3
            RETURNING serie`;
      const pExtra = serie ? [rifa_id, vendedor_id, numero, serie] : [rifa_id, vendedor_id, numero];
      const delExtra = await client.query(qExtra, pExtra);
      if (delExtra.rowCount > 0) borradoComo = 'extra';
    }
 
    // ── 2) Si no era extra (o el frontend pide fijo) → borrar fijo ──
    if (!borradoComo && (origen === 'fijo' || !origen)) {
      // Rifa para saber su categoría (para liberar también en cat_global_asignaciones)
      const rifaR = await client.query(
        `SELECT categoria_seleccionada_id FROM rifas WHERE id = $1`,
        [rifa_id]
      );
      const cat_id = rifaR.rows[0]?.categoria_seleccionada_id;
 
      const qFijo = serie
        ? `DELETE FROM numeros_vendedor
            WHERE vendedor_id = $1 AND rifa_id = $2 AND numero = $3
              AND COALESCE(serie,'A') = $4 RETURNING serie`
        : `DELETE FROM numeros_vendedor
            WHERE vendedor_id = $1 AND rifa_id = $2 AND numero = $3 RETURNING serie`;
      const pFijo = serie ? [vendedor_id, rifa_id, numero, serie] : [vendedor_id, rifa_id, numero];
      const delFijo = await client.query(qFijo, pFijo);
 
      if (delFijo.rowCount > 0) {
        borradoComo = 'fijo';
        // Liberar en cat_global_asignaciones (comportamiento legado del fijo)
        if (cat_id) {
          const q2 = serie
            ? `DELETE FROM cat_global_asignaciones
                WHERE categoria_id = $1 AND vendedor_id = $2 AND numero = $3 AND serie = $4`
            : `DELETE FROM cat_global_asignaciones
                WHERE categoria_id = $1 AND vendedor_id = $2 AND numero = $3`;
          const p2 = serie ? [cat_id, vendedor_id, numero, serie] : [cat_id, vendedor_id, numero];
          await client.query(q2, p2);
        }
      }
    }
 
    if (!borradoComo) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Ese número no estaba asignado al vendedor en esta rifa' });
    }
 
    await client.query('COMMIT');
    res.json({ ok: true, numero, serie, origen: borradoComo });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error quitando numero boleteria:', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});



module.exports = router;