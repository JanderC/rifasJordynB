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
    // ── Flujo nuevo: usar cat_global_asignaciones (series A/B)
    // Agrupar por categoria_id para un solo query por categoría
    const porCategoria = {};
    for (const { vendedor_id, categoria_id } of vendedores_categorias) {
      if (!porCategoria[categoria_id]) porCategoria[categoria_id] = [];
      porCategoria[categoria_id].push(vendedor_id);
    }

    for (const [categoria_id, vids] of Object.entries(porCategoria)) {
      // Copiar las asignaciones confirmadas (A y/o B) como numeros_vendedor
      // La columna `serie` debe existir en numeros_vendedor; si no existe
      // se inserta solo el número (ON CONFLICT DO NOTHING en ambos casos).
      await client.query(
        `INSERT INTO numeros_vendedor (vendedor_id, rifa_id, numero, serie)
         SELECT cga.vendedor_id, $1, cga.numero, cga.serie
         FROM cat_global_asignaciones cga
         WHERE cga.categoria_id = $2
           AND cga.vendedor_id = ANY($3::uuid[])
         ON CONFLICT (vendedor_id, rifa_id, numero, serie) DO NOTHING`,
        [rifa_id, categoria_id, vids]
      ).catch(async () => {
        // Fallback si la columna serie no existe aún en numeros_vendedor
        await client.query(
          `INSERT INTO numeros_vendedor (vendedor_id, rifa_id, numero)
           SELECT DISTINCT cga.vendedor_id, $1, cga.numero
           FROM cat_global_asignaciones cga
           WHERE cga.categoria_id = $2
             AND cga.vendedor_id = ANY($3::uuid[])
           ON CONFLICT (vendedor_id, rifa_id, numero) DO NOTHING`,
          [rifa_id, categoria_id, vids]
        );
      });
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

module.exports = router;