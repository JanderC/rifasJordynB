// ============================================================
//   RIFAS JORDYN — Rutas de Vendedores
//   ✅ ACTUALIZADO: números globales en numeros_vendedor_global
//      GET /  → incluye numeros_asignados (array de números)
//      GET /:id → numeros_asignados desde tabla global
//      POST /numeros/asignar y DELETE usan tabla global
//      GET /:id/numeros-aleatorios usa tabla global
// ============================================================
const express = require('express');
const router  = express.Router();
const bcrypt  = require('bcryptjs');
const pool    = require('../config/db');
const { authMiddleware, soloDueno } = require('../middleware/auth');

// ── GET /api/vendedores ────────────────────────────────────
router.get('/', authMiddleware, soloDueno, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        u.id,
        u.nombre,
        u.usuario,
        u.cedula,
        u.rol,
        u.activo,
        u.created_at,
        COUNT(DISTINCT v.id)::int             AS total_ventas,
        COALESCE(SUM(v.precio_venta), 0)      AS total_ingresos,
        COUNT(DISTINCT ng.numero)::int        AS numeros_count,
        COALESCE(
          JSON_AGG(ng.numero ORDER BY ng.numero)
          FILTER (WHERE ng.numero IS NOT NULL),
          '[]'
        ) AS numeros_asignados
      FROM users u
      LEFT JOIN ventas v             ON v.vendedor_id = u.id
      LEFT JOIN numeros_vendedor_global ng ON ng.vendedor_id = u.id
      WHERE u.rol = 'vendedor'
      GROUP BY u.id, u.nombre, u.usuario, u.cedula, u.rol, u.activo, u.created_at
      ORDER BY u.nombre
    `);

    res.json(result.rows);
  } catch (err) {
    console.error('Error obteniendo vendedores:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ── GET /api/vendedores/:id ────────────────────────────────
router.get('/:id', authMiddleware, soloDueno, async (req, res) => {
  try {
    const userResult = await pool.query(
      'SELECT id, nombre, usuario, cedula, rol, activo, created_at FROM users WHERE id = $1',
      [req.params.id]
    );

    if (!userResult.rows[0]) {
      return res.status(404).json({ error: 'Vendedor no encontrado' });
    }

    // Números globales del vendedor
    const numerosResult = await pool.query(
      `SELECT numero FROM numeros_vendedor_global
       WHERE vendedor_id = $1
       ORDER BY numero`,
      [req.params.id]
    );

    // Rifas donde participa este vendedor (con cuántos números)
    const rifasResult = await pool.query(
      `SELECT
         nv.rifa_id,
         r.nombre   AS rifa_nombre,
         r.activa,
         COUNT(nv.numero)::int AS numeros_en_rifa,
         COUNT(v.id)::int      AS ventas_en_rifa
       FROM numeros_vendedor nv
       JOIN rifas r ON r.id = nv.rifa_id
       LEFT JOIN ventas v ON v.rifa_id = nv.rifa_id
         AND v.numero = nv.numero
         AND v.vendedor_id = nv.vendedor_id
       WHERE nv.vendedor_id = $1
       GROUP BY nv.rifa_id, r.nombre, r.activa
       ORDER BY r.activa DESC, nv.rifa_id DESC`,
      [req.params.id]
    );

    // Ventas recientes
    const ventasResult = await pool.query(
      `SELECT v.*, r.nombre AS rifa_nombre
       FROM ventas v
       JOIN rifas r ON r.id = v.rifa_id
       WHERE v.vendedor_id = $1
       ORDER BY v.created_at DESC LIMIT 20`,
      [req.params.id]
    );

    res.json({
      vendedor:         userResult.rows[0],
      numeros_asignados: numerosResult.rows.map(r => r.numero),
      rifas_participando: rifasResult.rows,
      ventas_recientes: ventasResult.rows,
    });
  } catch (err) {
    console.error('Error obteniendo vendedor:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ── PUT /api/vendedores/:id ────────────────────────────────
router.put('/:id', authMiddleware, soloDueno, async (req, res) => {
  const { nombre, password, activo, cedula } = req.body;

  try {
    let updateFields = [];
    let params       = [];
    let i            = 1;

    if (nombre)                     { updateFields.push(`nombre = $${i++}`);  params.push(nombre); }
    if (typeof activo === 'boolean') { updateFields.push(`activo = $${i++}`);  params.push(activo); }
    if (cedula !== undefined)        { updateFields.push(`cedula = $${i++}`);  params.push(cedula || null); }
    if (password) {
      if (password.length < 6)
        return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
      const hash = await bcrypt.hash(password, 10);
      updateFields.push(`password = $${i++}`);
      params.push(hash);
    }

    if (updateFields.length === 0)
      return res.status(400).json({ error: 'No hay campos para actualizar' });

    params.push(req.params.id);
    const result = await pool.query(
      `UPDATE users SET ${updateFields.join(', ')} WHERE id = $${i} RETURNING id, nombre, usuario, cedula, rol, activo`,
      params
    );

    if (!result.rows[0])
      return res.status(404).json({ error: 'Vendedor no encontrado' });

    res.json({ message: 'Vendedor actualizado', vendedor: result.rows[0] });
  } catch (err) {
    console.error('Error actualizando vendedor:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ── DELETE /api/vendedores/:id ─────────────────────────────
router.delete('/:id', authMiddleware, soloDueno, async (req, res) => {
  try {
    const ventas = await pool.query(
      'SELECT COUNT(*) FROM ventas WHERE vendedor_id = $1',
      [req.params.id]
    );
    if (parseInt(ventas.rows[0].count) > 0) {
      return res.status(400).json({
        error: 'No se puede eliminar un vendedor con ventas registradas. Desactívalo en su lugar.'
      });
    }

    // Limpiar números globales y asignaciones por rifa
    await pool.query('DELETE FROM numeros_vendedor_global WHERE vendedor_id = $1', [req.params.id]);
    await pool.query('DELETE FROM numeros_vendedor        WHERE vendedor_id = $1', [req.params.id]);
    await pool.query('DELETE FROM users                   WHERE id = $1',          [req.params.id]);

    res.json({ message: 'Vendedor eliminado exitosamente' });
  } catch (err) {
    console.error('Error eliminando vendedor:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ── GET /api/vendedores/:id/numeros-aleatorios ────────────
// Genera números aleatorios disponibles en el pool global
// (excluye los que ya tienen otros vendedores y los del mismo)
router.get('/:id/numeros-aleatorios', authMiddleware, soloDueno, async (req, res) => {
  const { cantidad = 10, excluir = '' } = req.query;

  // excluir puede venir como "001,002,003" desde el frontend
  const excluirArr = excluir ? excluir.split(',').map(n => n.trim()).filter(Boolean) : [];

  try {
    // Números ya asignados a cualquier vendedor en la tabla global
    const result = await pool.query(
      `SELECT LPAD(gs::text, 3, '0') AS numero
       FROM generate_series(0, 999) gs
       WHERE LPAD(gs::text, 3, '0') NOT IN (
         SELECT numero FROM numeros_vendedor_global
       )
       ${excluirArr.length > 0 ? `AND LPAD(gs::text, 3, '0') != ALL($2)` : ''}
       ORDER BY RANDOM()
       LIMIT $1`,
      excluirArr.length > 0
        ? [parseInt(cantidad), excluirArr]
        : [parseInt(cantidad)]
    );

    res.json({
      numeros_sugeridos: result.rows.map(r => r.numero),
      cantidad:          result.rows.length,
    });
  } catch (err) {
    console.error('Error generando números aleatorios:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});


// ══════════════════════════════════════════════════════════════
//  RUTAS DE CATEGORÍAS DE NÚMEROS (por vendedor)
// ══════════════════════════════════════════════════════════════

// ── GET /api/vendedores/:id/categorias ────────────────────────
// Devuelve todas las categorías del vendedor con sus números
router.get('/:id/categorias', authMiddleware, soloDueno, async (req, res) => {
  try {
    const cats = await pool.query(
      `SELECT
         cv.id,
         cv.nombre,
         cv.max_numeros,
         cv.created_at,
         COUNT(cn.numero)::int            AS numeros_count,
         COALESCE(
           JSON_AGG(cn.numero ORDER BY cn.numero)
           FILTER (WHERE cn.numero IS NOT NULL),
           '[]'
         )                                AS numeros
       FROM categorias_vendedor cv
       LEFT JOIN categoria_numeros cn ON cn.categoria_id = cv.id
       WHERE cv.vendedor_id = $1
       GROUP BY cv.id, cv.nombre, cv.max_numeros, cv.created_at
       ORDER BY cv.created_at ASC`,
      [req.params.id]
    );
    res.json(cats.rows);
  } catch (err) {
    console.error('Error obteniendo categorías:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ── POST /api/vendedores/:id/categorias ───────────────────────
// Crea una nueva categoría para el vendedor
router.post('/:id/categorias', authMiddleware, soloDueno, async (req, res) => {
  const { nombre, max_numeros } = req.body;
  if (!nombre || !nombre.trim())
    return res.status(400).json({ error: 'El nombre de la categoría es requerido' });
  if (!Number.isInteger(max_numeros) || max_numeros < 1)
    return res.status(400).json({ error: 'max_numeros debe ser un entero mayor a 0' });

  try {
    const result = await pool.query(
      `INSERT INTO categorias_vendedor (vendedor_id, nombre, max_numeros)
       VALUES ($1, $2, $3)
       RETURNING id, nombre, max_numeros, created_at`,
      [req.params.id, nombre.trim(), max_numeros]
    );
    res.status(201).json({ ...result.rows[0], numeros_count: 0, numeros: [] });
  } catch (err) {
    if (err.code === '23505')
      return res.status(409).json({ error: 'Ya existe una categoría con ese nombre para este vendedor' });
    console.error('Error creando categoría:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ── PUT /api/vendedores/:id/categorias/:catId ─────────────────
// Edita nombre o max_numeros de una categoría
router.put('/:id/categorias/:catId', authMiddleware, soloDueno, async (req, res) => {
  const { nombre, max_numeros } = req.body;
  try {
    const fields = []; const params = []; let i = 1;
    if (nombre !== undefined)      { fields.push(`nombre = $${i++}`);      params.push(nombre.trim()); }
    if (max_numeros !== undefined) { fields.push(`max_numeros = $${i++}`); params.push(max_numeros); }
    if (!fields.length) return res.status(400).json({ error: 'Nada que actualizar' });

    params.push(req.params.catId, req.params.id);
    const result = await pool.query(
      `UPDATE categorias_vendedor SET ${fields.join(', ')}
       WHERE id = $${i} AND vendedor_id = $${i + 1}
       RETURNING id, nombre, max_numeros`,
      params
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Categoría no encontrada' });
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505')
      return res.status(409).json({ error: 'Ya existe una categoría con ese nombre' });
    console.error('Error actualizando categoría:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ── DELETE /api/vendedores/:id/categorias/:catId ──────────────
// Elimina categoría y desvincula sus números (quedan libres)
router.delete('/:id/categorias/:catId', authMiddleware, soloDueno, async (req, res) => {
  try {
    // Verificar que la categoría no esté asignada a rifas activas
    const enRifas = await pool.query(
      `SELECT COUNT(*)::int AS total
       FROM rifa_categorias rc
       JOIN rifas r ON r.id = rc.rifa_id
       WHERE rc.categoria_id = $1 AND r.activa = true`,
      [req.params.catId]
    );
    if (enRifas.rows[0].total > 0)
      return res.status(400).json({ error: 'No se puede eliminar: la categoría está asignada a una rifa activa' });

    await pool.query(
      `DELETE FROM categorias_vendedor WHERE id = $1 AND vendedor_id = $2`,
      [req.params.catId, req.params.id]
    );
    res.json({ message: 'Categoría eliminada. Sus números quedaron libres.' });
  } catch (err) {
    console.error('Error eliminando categoría:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ── POST /api/vendedores/:id/categorias/:catId/numeros ────────
// Asigna números a una categoría (respeta max_numeros)
router.post('/:id/categorias/:catId/numeros', authMiddleware, soloDueno, async (req, res) => {
  const { numeros } = req.body; // array de strings '000'–'999'
  if (!Array.isArray(numeros) || !numeros.length)
    return res.status(400).json({ error: 'Envía un array de números' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Datos de la categoría
    const catRes = await client.query(
      `SELECT max_numeros,
              (SELECT COUNT(*) FROM categoria_numeros WHERE categoria_id = $1) AS actuales
       FROM categorias_vendedor WHERE id = $1 AND vendedor_id = $2`,
      [req.params.catId, req.params.id]
    );
    if (!catRes.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Categoría no encontrada' }); }

    const { max_numeros, actuales } = catRes.rows[0];
    const disponible = max_numeros - parseInt(actuales);
    if (numeros.length > disponible)
      return res.status(400).json({
        error: `La categoría solo admite ${disponible} número(s) más (límite: ${max_numeros})`
      });

    // Verificar que no estén ocupados globalmente
    const ocupados = await client.query(
      `SELECT numero FROM categoria_numeros WHERE numero = ANY($1)
       UNION
       SELECT numero FROM numeros_vendedor_global WHERE numero = ANY($1)`,
      [numeros]
    );
    if (ocupados.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: `Números ya ocupados: ${ocupados.rows.map(r => r.numero).join(', ')}`
      });
    }

    // Insertar
    for (const num of numeros) {
      await client.query(
        `INSERT INTO categoria_numeros (categoria_id, vendedor_id, numero)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [req.params.catId, req.params.id, num]
      );
    }

    await client.query('COMMIT');
    res.status(201).json({ message: `${numeros.length} número(s) asignados` });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error: 'Uno o más números ya están ocupados' });
    console.error('Error asignando números:', err);
    res.status(500).json({ error: 'Error del servidor' });
  } finally { client.release(); }
});

// ── DELETE /api/vendedores/:id/categorias/:catId/numeros ──────
// Quita números de una categoría
router.delete('/:id/categorias/:catId/numeros', authMiddleware, soloDueno, async (req, res) => {
  const { numeros } = req.body;
  if (!Array.isArray(numeros) || !numeros.length)
    return res.status(400).json({ error: 'Envía un array de números' });

  try {
    // Verificar que ningún número tenga venta activa en rifas donde esta categoría esté asignada
    const conVenta = await pool.query(
      `SELECT DISTINCT cn.numero
       FROM categoria_numeros cn
       JOIN rifa_categorias rc ON rc.categoria_id = cn.categoria_id
       JOIN ventas v ON v.rifa_id = rc.rifa_id AND v.numero = cn.numero AND v.vendedor_id = cn.vendedor_id
       WHERE cn.categoria_id = $1 AND cn.numero = ANY($2)`,
      [req.params.catId, numeros]
    );
    if (conVenta.rows.length > 0)
      return res.status(400).json({
        error: `No se pueden quitar — tienen ventas activas: ${conVenta.rows.map(r => r.numero).join(', ')}`
      });

    await pool.query(
      `DELETE FROM categoria_numeros WHERE categoria_id = $1 AND numero = ANY($2)`,
      [req.params.catId, numeros]
    );
    res.json({ message: `${numeros.length} número(s) removidos` });
  } catch (err) {
    console.error('Error removiendo números:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ── GET /api/vendedores/:id/categorias/numeros-disponibles ────
// Devuelve números libres del pool global para sugerir
router.get('/:id/categorias/numeros-disponibles', authMiddleware, soloDueno, async (req, res) => {
  const { cantidad = 10, excluir = '' } = req.query;
  const excluirArr = excluir ? excluir.split(',').map(n => n.trim()).filter(Boolean) : [];
  try {
    const result = await pool.query(
      `SELECT LPAD(gs::text, 3, '0') AS numero
       FROM generate_series(0, 999) gs
       WHERE LPAD(gs::text, 3, '0') NOT IN (
         SELECT numero FROM categoria_numeros
         UNION
         SELECT numero FROM numeros_vendedor_global
       )
       ${excluirArr.length > 0 ? `AND LPAD(gs::text, 3, '0') != ALL($2::char[])` : ''}
       ORDER BY RANDOM()
       LIMIT $1`,
      excluirArr.length > 0 ? [parseInt(cantidad), excluirArr] : [parseInt(cantidad)]
    );
    res.json({ numeros: result.rows.map(r => r.numero) });
  } catch (err) {
    console.error('Error obteniendo números disponibles:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

module.exports = router;