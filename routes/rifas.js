// ============================================================
//   RIFAS JORDYN — Rutas de Rifas
//   ✅ ACTUALIZADO: campo `ofertas` (jsonb) en crear/editar/leer
//   ✅ NUEVO: vendedores_ids — al crear/editar una rifa se
//      copian los números globales del vendedor a numeros_vendedor
//      con el rifa_id correspondiente (reserva automática).
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
   1. Borra las asignaciones en numeros_vendedor para esta rifa
      que ya NO están en la nueva lista de vendedores.
   2. Para cada vendedor nuevo, copia sus números globales
      (numeros_vendedor_global) a numeros_vendedor con rifa_id.
   3. NO toca números de vendedores que siguen en la lista
      (evita perder ventas ya registradas).
──────────────────────────────────────────────────────────── */
async function sincronizarVendedoresRifa(client, rifa_id, vendedores_ids) {
  // 1. Quitar asignaciones de vendedores removidos de la rifa
  //    (solo los que NO tienen ventas en esta rifa para no romper historial)
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
    // Sin vendedores → limpiar todos los que no tengan ventas
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

  // 2. Para cada vendedor seleccionado, insertar sus números globales
  //    en numeros_vendedor con este rifa_id (ON CONFLICT DO NOTHING
  //    para no duplicar si ya existían)
  await client.query(
    `INSERT INTO numeros_vendedor (vendedor_id, rifa_id, numero)
     SELECT ng.vendedor_id, $1 AS rifa_id, ng.numero
     FROM numeros_vendedor_global ng
     WHERE ng.vendedor_id = ANY($2::uuid[])
     ON CONFLICT (vendedor_id, rifa_id, numero) DO NOTHING`,
    [rifa_id, vendedores_ids]
  );
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
    tipo           = 'sencilla',
    imagen_url     = null,
    estado         = 'activa',
    ofertas        = [],
    vendedores_ids = [],          // ← NUEVO
  } = req.body;

  if (!nombre || !premio || !precio)
    return res.status(400).json({ error: 'Nombre, premio y precio son requeridos' });

  const errOfertas = validarOfertas(ofertas);
  if (errOfertas) return res.status(400).json({ error: errOfertas });

  const ofertasOrdenadas = [...ofertas].sort((a, b) => a.cantidad - b.cantidad);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Crear la rifa
    const result = await client.query(
      `INSERT INTO rifas
         (nombre, descripcion, premio, precio, fecha_sorteo, loteria_ref,
          tipo, imagen_url, estado, ofertas, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [
        nombre, descripcion || null, premio, precio,
        fecha_sorteo || null, loteria_ref || null,
        tipo, imagen_url, estado,
        JSON.stringify(ofertasOrdenadas),
        req.user.id,
      ]
    );

    const rifa = result.rows[0];

    // Reservar números de los vendedores seleccionados
    if (vendedores_ids.length > 0) {
      await sincronizarVendedoresRifa(client, rifa.id, vendedores_ids);
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
    vendedores_ids,               // ← NUEVO (puede ser undefined si no se envía)
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
        nombre       = COALESCE($1,  nombre),
        descripcion  = COALESCE($2,  descripcion),
        premio       = COALESCE($3,  premio),
        precio       = COALESCE($4,  precio),
        fecha_sorteo = COALESCE($5,  fecha_sorteo),
        loteria_ref  = COALESCE($6,  loteria_ref),
        activa       = COALESCE($7,  activa),
        tipo         = COALESCE($8,  tipo),
        imagen_url   = CASE WHEN $9::text  IS NOT NULL THEN $9::text  ELSE imagen_url END,
        estado       = COALESCE($10, estado),
        ofertas      = CASE WHEN $11::text IS NOT NULL THEN $11::jsonb ELSE ofertas END
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
      ]
    );

    if (!result.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Rifa no encontrada' });
    }

    // Si se enviaron vendedores_ids, sincronizar reservas
    if (Array.isArray(vendedores_ids)) {
      await sincronizarVendedoresRifa(client, req.params.id, vendedores_ids);
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
router.delete('/:id', authMiddleware, soloDueno, async (req, res) => {
  try {
    const ventas = await pool.query(
      'SELECT COUNT(*) FROM ventas WHERE rifa_id = $1',
      [req.params.id]
    );
    if (parseInt(ventas.rows[0].count) > 0)
      return res.status(400).json({ error: 'No se puede eliminar una rifa con ventas. Archívala en su lugar.' });

    // Limpiar asignaciones de números antes de borrar
    await pool.query('DELETE FROM numeros_vendedor WHERE rifa_id = $1', [req.params.id]);
    await pool.query('DELETE FROM rifas WHERE id = $1', [req.params.id]);
    res.json({ message: 'Rifa eliminada exitosamente' });
  } catch (err) {
    console.error('Error eliminando rifa:', err);
    res.status(500).json({ error: 'Error del servidor' });
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