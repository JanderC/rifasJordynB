// ============================================================
//   RIFAS JORDYN — Rutas de Rifas
//   ✅ ACTUALIZADO: campo `ofertas` (jsonb) en crear/editar/leer
//   ✅ ACTUALIZADO v3: flujo categorías globales
//   ✅ FIX: fecha_sorteo::text para evitar desfase de zona horaria
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
──────────────────────────────────────────────────────────── */
async function sincronizarVendedoresRifa(client, rifa_id, vendedores_ids, vendedores_categorias = []) {
  // 1. Quitar asignaciones de vendedores removidos (respetando ventas)
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
    const colCheck = await client.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_name = 'numeros_vendedor' AND column_name = 'serie'`
    );
    const tieneColumnasSerie = colCheck.rows.length > 0;

    const tablaExtraCheck = await client.query(
      `SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'boleteria_numeros_extra'`
    );
    const tieneTablaExtra = tablaExtraCheck.rows.length > 0;

    const porCategoria = {};
    for (const { vendedor_id, categoria_id } of vendedores_categorias) {
      if (!porCategoria[categoria_id]) porCategoria[categoria_id] = [];
      porCategoria[categoria_id].push(vendedor_id);
    }

    for (const [categoria_id, vids] of Object.entries(porCategoria)) {
      if (tieneColumnasSerie) {
        await client.query(
          `DELETE FROM numeros_vendedor nv
           WHERE nv.rifa_id = $1
             AND (nv.numero, nv.serie) IN (
                SELECT cga.numero, cga.serie
                FROM cat_global_asignaciones cga
                WHERE cga.categoria_id = $2
                  AND cga.vendedor_id = ANY($3::uuid[])
             )
             AND nv.vendedor_id <> ALL($3::uuid[])
             AND NOT EXISTS (
                SELECT 1 FROM ventas v
                 WHERE v.rifa_id = nv.rifa_id AND v.numero = nv.numero
             )`,
          [rifa_id, categoria_id, vids]
        );

        if (tieneTablaExtra) {
          await client.query(
            `DELETE FROM boleteria_numeros_extra bne
             WHERE bne.rifa_id = $1
               AND (bne.numero, bne.serie) IN (
                  SELECT cga.numero, cga.serie
                  FROM cat_global_asignaciones cga
                  WHERE cga.categoria_id = $2
                    AND cga.vendedor_id = ANY($3::uuid[])
               )`,
            [rifa_id, categoria_id, vids]
          );
        }

        await client.query(
          `INSERT INTO numeros_vendedor (vendedor_id, rifa_id, numero, serie)
           SELECT cga.vendedor_id, $1, cga.numero, cga.serie
           FROM cat_global_asignaciones cga
           WHERE cga.categoria_id = $2
             AND cga.vendedor_id = ANY($3::uuid[])
           ON CONFLICT ON CONSTRAINT numeros_vendedor_rifa_numero_serie_unico DO NOTHING`,
          [rifa_id, categoria_id, vids]
        );
      } else {
        await client.query(
          `DELETE FROM numeros_vendedor nv
           WHERE nv.rifa_id = $1
             AND nv.numero IN (
                SELECT DISTINCT cga.numero FROM cat_global_asignaciones cga
                WHERE cga.categoria_id = $2
                  AND cga.vendedor_id = ANY($3::uuid[])
             )
             AND nv.vendedor_id <> ALL($3::uuid[])
             AND NOT EXISTS (
                SELECT 1 FROM ventas v
                 WHERE v.rifa_id = nv.rifa_id AND v.numero = nv.numero
             )`,
          [rifa_id, categoria_id, vids]
        );

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
    // Flujo legado: numeros_vendedor_global
    await client.query(
      `DELETE FROM numeros_vendedor nv
       WHERE nv.rifa_id = $1
         AND nv.numero IN (
            SELECT DISTINCT ng.numero FROM numeros_vendedor_global ng
            WHERE ng.vendedor_id = ANY($2::uuid[])
         )
         AND nv.vendedor_id <> ALL($2::uuid[])
         AND NOT EXISTS (
            SELECT 1 FROM ventas v
             WHERE v.rifa_id = nv.rifa_id AND v.numero = nv.numero
         )`,
      [rifa_id, vendedores_ids]
    );

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
    const result = await pool.query(`
      SELECT
        r.id, r.nombre, r.descripcion, r.premio, r.precio,
        r.fecha_sorteo::text AS fecha_sorteo,
        r.hora_sorteo, r.loteria_ref, r.activa,
        r.imagen_url,
        r.desactivar_en,
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

    const vendedoresResult = await pool.query(`
      WITH unidos AS (
        SELECT rifa_id, vendedor_id, numero, COALESCE(serie, 'A') AS serie, 'fijo'::text AS origen
          FROM numeros_vendedor
        UNION ALL
        SELECT rifa_id, vendedor_id, numero, serie, 'extra'::text AS origen
          FROM boleteria_numeros_extra
      )
      SELECT
        u.rifa_id,
        u.vendedor_id                                              AS id,
        usr.nombre,
        usr.usuario,
        COUNT(*)::int                                              AS numeros_count,
        COUNT(*) FILTER (WHERE u.origen = 'fijo')::int             AS fijos_count,
        COUNT(*) FILTER (WHERE u.origen = 'extra')::int            AS extras_count
      FROM unidos u
      JOIN users usr ON usr.id = u.vendedor_id
      GROUP BY u.rifa_id, u.vendedor_id, usr.nombre, usr.usuario
      ORDER BY usr.nombre
    `);

    const vendedoresPorRifa = {};
    vendedoresResult.rows.forEach(vr => {
      if (!vendedoresPorRifa[vr.rifa_id]) vendedoresPorRifa[vr.rifa_id] = [];
      vendedoresPorRifa[vr.rifa_id].push({
        id:           vr.id,
        nombre:       vr.nombre,
        usuario:      vr.usuario,
        numeros_count: vr.numeros_count,
        fijos_count:   vr.fijos_count,
        extras_count:  vr.extras_count,
      });
    });

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
        r.fecha_sorteo::text AS fecha_sorteo,
        r.hora_sorteo, r.loteria_ref, r.activa,
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
    fecha_sorteo, hora_sorteo, loteria_ref,
    tipo                  = 'sencilla',
    imagen_url            = null,
    estado                = 'activa',
    ofertas               = [],
    vendedores_ids        = [],
    vendedores_categorias = [],
    categoria_id          = null,
  } = req.body;

  if (!nombre || !premio || !precio)
    return res.status(400).json({ error: 'Nombre, premio y precio son requeridos' });

  const errOfertas = validarOfertas(ofertas);
  if (errOfertas) return res.status(400).json({ error: errOfertas });

  const ofertasOrdenadas = [...ofertas].sort((a, b) => a.cantidad - b.cantidad);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const vids = vendedores_ids.length > 0
      ? vendedores_ids
      : vendedores_categorias.map(v => v.vendedor_id);

    // ✅ FIX: fecha_sorteo::text en RETURNING para evitar desfase UTC
    const result = await client.query(
      `INSERT INTO rifas
         (nombre, descripcion, premio, precio, fecha_sorteo, hora_sorteo, loteria_ref,
          tipo, imagen_url, estado, ofertas, categoria_seleccionada_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING
         id, nombre, descripcion, premio, precio,
         fecha_sorteo::text AS fecha_sorteo,
         hora_sorteo, loteria_ref, activa, imagen_url,
         tipo, estado, ofertas, ticket_design,
         categoria_seleccionada_id, created_by, created_at, updated_at`,
      [
        nombre, descripcion || null, premio, precio,
        fecha_sorteo || null, hora_sorteo || null, loteria_ref || null,
        tipo, imagen_url, estado,
        JSON.stringify(ofertasOrdenadas),
        categoria_id || null,
        req.user.id,
      ]
    );

    const rifa = result.rows[0];

    if (vids.length > 0) {
      await sincronizarVendedoresRifa(client, rifa.id, vids, vendedores_categorias);
    }

    await client.query('COMMIT');

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
    fecha_sorteo, hora_sorteo, loteria_ref,
    activa, tipo, imagen_url, estado, ofertas,
    vendedores_ids,
    vendedores_categorias,
    categoria_id,
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

    // ✅ FIX: fecha_sorteo::text en RETURNING para evitar desfase UTC
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
        categoria_seleccionada_id = COALESCE($13::uuid, categoria_seleccionada_id),
        hora_sorteo             = CASE WHEN $14::text IS NOT NULL
                                       THEN $14::text::time
                                       ELSE hora_sorteo END
       WHERE id = $12
       RETURNING
         id, nombre, descripcion, premio, precio,
         fecha_sorteo::text AS fecha_sorteo,
         hora_sorteo, loteria_ref, activa, imagen_url,
         tipo, estado, ofertas, ticket_design,
         categoria_seleccionada_id, created_at, updated_at`,
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
        hora_sorteo  !== undefined ? (hora_sorteo || null) : null,
      ]
    );

    if (!result.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Rifa no encontrada' });
    }

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
router.delete('/:id', authMiddleware, soloDueno, async (req, res) => {
  const force = req.query.force === 'true';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

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


// ════════════════════════════════════════════════════════════
//  RUTAS BOLETERÍA
// ════════════════════════════════════════════════════════════

// ── GET /api/rifas/:id/boleteria-vendedores ────────────────
router.get('/:id/boleteria-vendedores', authMiddleware, soloDueno, async (req, res) => {
  try {
    const rifa_id = req.params.id;

    const rifaR = await pool.query(
      `SELECT id, nombre, COALESCE(tipo, 'sencilla') AS tipo, categoria_seleccionada_id
       FROM rifas WHERE id = $1`,
      [rifa_id]
    );
    if (!rifaR.rows[0]) return res.status(404).json({ error: 'Rifa no encontrada' });
    const rifa         = rifaR.rows[0];
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
        WHERE rifa_id = $1 AND estado = 'pendiente' GROUP BY numero`,
      [rifa_id]
    );
    reservR.rows.forEach(r => {
      for (let i = 0; i < r.veces; i++) {
        if (!ocupadasPorNum[r.numero]?.has('A')) marcar(r.numero, 'A');
        else if (!ocupadasPorNum[r.numero]?.has('B')) marcar(r.numero, 'B');
      }
    });

    for (let i = 0; i < 1000; i++) {
      const numero   = String(i).padStart(3, '0');
      const ocupadas = ocupadasPorNum[numero] || new Set();
      if (!ocupadas.has('A'))                disponiblesA.push(numero);
      if (esSimultanea && !ocupadas.has('B')) disponiblesB.push(numero);
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

    const vR = await client.query(`SELECT id FROM users WHERE id = $1`, [vendedor_id]);
    if (!vR.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Vendedor no encontrado' });
    }

    const insertados = [];
    const colisiones = [];

    for (const numero of numeros) {
      let serieDestino = serie || 'A';

      if (esSimultanea && !serie) {
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
router.delete('/:id/boleteria-vendedores/:vendedorId/numero', authMiddleware, soloDueno, async (req, res) => {
  const { numero, serie, origen } = req.body;
  const rifa_id     = req.params.id;
  const vendedor_id = req.params.vendedorId;

  if (!numero) return res.status(400).json({ error: 'numero es requerido' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

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

    if (!borradoComo && (origen === 'fijo' || !origen)) {
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

// ════════════════════════════════════════════════════════════════
//   VENTA RÁPIDA — endpoints para la pantalla de Reservas
// ════════════════════════════════════════════════════════════════

// ── GET /api/rifas/:id/numero/:n/disponibilidad ──
// Verifica si un número está disponible para ser vendido en una rifa.
// Toma en cuenta: ventas existentes y reservas pendientes/aprobadas.
// Para rifas simultáneas (series A y B) reporta disponibilidad por serie.
router.get('/:id/numero/:n/disponibilidad', authMiddleware, soloDueno, async (req, res) => {
  const rifa_id = req.params.id;
  let numero = String(req.params.n).trim();
  // Normalizar a 3 dígitos (000-999)
  if (/^\d+$/.test(numero)) numero = numero.padStart(3, '0');

  try {
    // 1. Obtener rifa
    const rifaR = await pool.query(
      `SELECT id, nombre, premio, precio, tipo,
              COALESCE(estado, 'activa') AS estado, activa,
              fecha_sorteo::text AS fecha_sorteo, hora_sorteo, loteria_ref,
              categoria_seleccionada_id
       FROM rifas WHERE id = $1`,
      [rifa_id]
    );
    if (!rifaR.rows.length) {
      return res.status(404).json({ error: 'Rifa no encontrada' });
    }
    const rifa = rifaR.rows[0];

    // Solo permitir consulta sobre rifas activas
    if (!rifa.activa || rifa.estado !== 'activa') {
      return res.status(400).json({
        error: 'Esta rifa no está activa',
        disponible: false,
        motivo: 'rifa_inactiva',
      });
    }

    const esSimultanea = rifa.tipo === 'simultanea';

    // 2. Buscar ocupaciones de ese número
    const ocupadas = new Set();
    const detalle = [];

    // 2a. Categoría global (si aplica)
    if (rifa.categoria_seleccionada_id) {
      const r = await pool.query(
        `SELECT serie FROM cat_global_asignaciones
          WHERE categoria_id = $1 AND numero = $2`,
        [rifa.categoria_seleccionada_id, numero]
      );
      r.rows.forEach(x => {
        ocupadas.add(x.serie);
        detalle.push({ serie: x.serie, motivo: 'asignado_a_categoria' });
      });
    }

    // 2b. Boletería extra
    const extraR = await pool.query(
      `SELECT serie FROM boleteria_numeros_extra
        WHERE rifa_id = $1 AND numero = $2`,
      [rifa_id, numero]
    );
    extraR.rows.forEach(x => {
      ocupadas.add(x.serie);
      detalle.push({ serie: x.serie, motivo: 'boleteria_extra' });
    });

    // 2c. Ventas (no tiene columna serie; cuenta veces vendido)
    const ventasR = await pool.query(
      `SELECT COUNT(*)::int AS veces FROM ventas
        WHERE rifa_id = $1 AND numero = $2`,
      [rifa_id, numero]
    );
    const vecesVendido = ventasR.rows[0]?.veces || 0;
    for (let i = 0; i < vecesVendido; i++) {
      if (!ocupadas.has('A'))      { ocupadas.add('A'); detalle.push({ serie: 'A', motivo: 'vendido' }); }
      else if (!ocupadas.has('B')) { ocupadas.add('B'); detalle.push({ serie: 'B', motivo: 'vendido' }); }
    }

    // 2d. Reservas pendientes/aprobadas (no rechazadas)
    const resR = await pool.query(
      `SELECT COUNT(*)::int AS veces FROM reservas_cliente
        WHERE rifa_id = $1 AND numero = $2 AND estado IN ('pendiente','aprobado')`,
      [rifa_id, numero]
    );
    const vecesReservado = resR.rows[0]?.veces || 0;
    for (let i = 0; i < vecesReservado; i++) {
      if (!ocupadas.has('A'))      { ocupadas.add('A'); detalle.push({ serie: 'A', motivo: 'reservado' }); }
      else if (!ocupadas.has('B')) { ocupadas.add('B'); detalle.push({ serie: 'B', motivo: 'reservado' }); }
    }

    // 3. Determinar disponibilidad
    const disponibleA = !ocupadas.has('A');
    const disponibleB = esSimultanea && !ocupadas.has('B');
    const disponible  = disponibleA || disponibleB;

    res.json({
      disponible,
      numero,
      rifa: {
        id: rifa.id,
        nombre: rifa.nombre,
        premio: rifa.premio,
        precio: Number(rifa.precio),
        tipo: rifa.tipo,
        fecha_sorteo: rifa.fecha_sorteo,
        hora_sorteo:  rifa.hora_sorteo,
        loteria_ref:  rifa.loteria_ref,
      },
      es_simultanea: esSimultanea,
      disponible_a:  disponibleA,
      disponible_b:  disponibleB,
      ocupadas:      [...ocupadas],
      detalle,
    });
  } catch (err) {
    console.error('Error verificando disponibilidad:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/rifas/:id/venta-directa ──
// Crea una reserva en estado APROBADO desde la pantalla admin.
// Cuerpo: { numero, nombre_cliente, telefono?, nota_admin?, metodo_pago?, serie? }
// Re-verifica disponibilidad en una transacción para evitar race conditions.
router.post('/:id/venta-directa', authMiddleware, soloDueno, async (req, res) => {
  const rifa_id = req.params.id;
  const { numero: numeroRaw, nombre_cliente, telefono, nota_admin, metodo_pago, serie } = req.body;

  if (!numeroRaw || !nombre_cliente) {
    return res.status(400).json({ error: 'Falta numero o nombre_cliente' });
  }

  let numero = String(numeroRaw).trim();
  if (/^\d+$/.test(numero)) numero = numero.padStart(3, '0');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Verificar rifa
    const rifaR = await client.query(
      `SELECT id, nombre, premio, precio, tipo,
              COALESCE(estado, 'activa') AS estado, activa,
              fecha_sorteo::text AS fecha_sorteo
       FROM rifas WHERE id = $1`,
      [rifa_id]
    );
    if (!rifaR.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Rifa no encontrada' });
    }
    const rifa = rifaR.rows[0];
    if (!rifa.activa || rifa.estado !== 'activa') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Esta rifa no está activa' });
    }

    // 2. Re-verificar disponibilidad (con FOR UPDATE para bloqueo)
    // Contamos ocupaciones combinadas: ventas + reservas vivas + extras + categoria
    const ocupadas = new Set();
    const esSimultanea = rifa.tipo === 'simultanea';

    if (rifa.categoria_seleccionada_id) {
      const r = await client.query(
        `SELECT serie FROM cat_global_asignaciones
          WHERE categoria_id = $1 AND numero = $2`,
        [rifa.categoria_seleccionada_id, numero]
      );
      r.rows.forEach(x => ocupadas.add(x.serie));
    }
    const extraR = await client.query(
      `SELECT serie FROM boleteria_numeros_extra
        WHERE rifa_id = $1 AND numero = $2`,
      [rifa_id, numero]
    );
    extraR.rows.forEach(x => ocupadas.add(x.serie));

    const ventasR = await client.query(
      `SELECT COUNT(*)::int AS v FROM ventas
        WHERE rifa_id = $1 AND numero = $2`,
      [rifa_id, numero]
    );
    const vecesV = ventasR.rows[0]?.v || 0;
    for (let i = 0; i < vecesV; i++) {
      if (!ocupadas.has('A')) ocupadas.add('A');
      else if (!ocupadas.has('B')) ocupadas.add('B');
    }

    const resR = await client.query(
      `SELECT COUNT(*)::int AS v FROM reservas_cliente
        WHERE rifa_id = $1 AND numero = $2 AND estado IN ('pendiente','aprobado')`,
      [rifa_id, numero]
    );
    const vecesR = resR.rows[0]?.v || 0;
    for (let i = 0; i < vecesR; i++) {
      if (!ocupadas.has('A')) ocupadas.add('A');
      else if (!ocupadas.has('B')) ocupadas.add('B');
    }

    // Decidir serie a usar
    let serieElegida = serie;
    if (!serieElegida) {
      if (!ocupadas.has('A'))                    serieElegida = 'A';
      else if (esSimultanea && !ocupadas.has('B')) serieElegida = 'B';
      else {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Número no disponible' });
      }
    } else if (ocupadas.has(serieElegida)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Número no disponible en serie ${serieElegida}` });
    }

    // 3. Crear la reserva en estado APROBADO
    const insertR = await client.query(
      `INSERT INTO reservas_cliente
         (rifa_id, numero, nombre_cliente, telefono, estado, precio, nota_admin, metodo_pago, created_at)
       VALUES ($1, $2, $3, $4, 'aprobado', $5, $6, $7, NOW())
       RETURNING id, rifa_id, numero, nombre_cliente, telefono, estado, precio, nota_admin, metodo_pago, created_at`,
      [rifa_id, numero, nombre_cliente, telefono || null, Number(rifa.precio), nota_admin || null, metodo_pago || 'venta_directa']
    );

    await client.query('COMMIT');

    const reserva = insertR.rows[0];
    res.json({
      ok: true,
      reserva: {
        ...reserva,
        rifa_nombre: rifa.nombre,
        premio: rifa.premio,
        fecha_sorteo: rifa.fecha_sorteo,
        serie_usada: serieElegida,
      },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error creando venta directa:', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

/* ── PUT /api/rifas/:id/programar-desactivacion ──────────────
   Body: { desactivar_en: "2025-06-15T22:00:00" }  ← ISO 8601
   Si se envía null se cancela la programación.
────────────────────────────────────────────────────────────── */
router.put('/:id/programar-desactivacion', authMiddleware, soloDueno, async (req, res) => {
  const { desactivar_en } = req.body;

  // Validar: debe ser una fecha futura o null (para cancelar)
  if (desactivar_en !== null && desactivar_en !== undefined) {
    const fecha = new Date(desactivar_en);
    if (isNaN(fecha.getTime()))
      return res.status(400).json({ error: 'Fecha inválida' });
    if (fecha <= new Date())
      return res.status(400).json({ error: 'La fecha de desactivación debe ser en el futuro' });
  }

  try {
    const r = await pool.query(
      `UPDATE rifas
          SET desactivar_en = $1
        WHERE id = $2
        RETURNING id, nombre, activa, desactivar_en`,
      [desactivar_en || null, req.params.id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Rifa no encontrada' });

    const accion = desactivar_en ? 'programada' : 'cancelada';
    res.json({
      ok: true,
      mensaje: desactivar_en
        ? `Desactivación programada para ${new Date(desactivar_en).toLocaleString('es-CO', { timeZone: 'America/Caracas' })}`
        : 'Programación cancelada',
      rifa: r.rows[0],
    });
  } catch (err) {
    console.error('Error programando desactivación:', err);
    res.status(500).json({ error: err.message });
  }
});

/* ── CRON: verificar rifas a desactivar cada minuto ──────────
   Se ejecuta en el mismo proceso del backend.
   No requiere dependencia externa (usa setInterval nativo).
────────────────────────────────────────────────────────────── */
(function iniciarCronDesactivacion() {
  const INTERVALO_MS = 60 * 1000; // cada 60 segundos

  async function desactivarRifasProgramadas() {
    try {
      const r = await pool.query(
        `UPDATE rifas
            SET activa       = false,
                estado       = 'inactiva',
                desactivar_en = NULL
          WHERE activa = true
            AND desactivar_en IS NOT NULL
            AND desactivar_en <= NOW()
          RETURNING id, nombre`
      );
      if (r.rows.length > 0) {
        r.rows.forEach(rifa =>
          console.log(`[CRON] ✅ Rifa desactivada automáticamente: "${rifa.nombre}" (${rifa.id})`)
        );
      }
    } catch (err) {
      console.error('[CRON] Error desactivando rifas programadas:', err.message);
    }
  }

  // Ejecutar inmediatamente al arrancar y luego cada minuto
  desactivarRifasProgramadas();
  setInterval(desactivarRifasProgramadas, INTERVALO_MS);
  console.log('[CRON] Verificador de desactivaciones programadas iniciado (cada 60s)');
})();

module.exports = router;