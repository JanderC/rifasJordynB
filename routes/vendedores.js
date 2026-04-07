const express = require('express');
const bcrypt  = require('bcryptjs');
const pool    = require('../config/db');
const { authMiddleware, soloDueno } = require('../middleware/auth');

/* ════════════════════════════════════════════════════════════
   ROUTER 1 — VENDEDORES  →  /api/vendedores
════════════════════════════════════════════════════════════ */
const vendedoresRouter = express.Router();

// ── GET /api/vendedores ──────────────────────────────────────
vendedoresRouter.get('/', authMiddleware, soloDueno, async (req, res) => {
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
        COUNT(DISTINCT v.id)::int              AS total_ventas,
        COALESCE(SUM(v.precio_venta), 0)       AS total_ingresos,
        COUNT(DISTINCT ng.numero)::int         AS numeros_count,
        COALESCE(
          JSON_AGG(ng.numero ORDER BY ng.numero)
          FILTER (WHERE ng.numero IS NOT NULL),
          '[]'
        ) AS numeros_asignados
      FROM users u
      LEFT JOIN ventas v                  ON v.vendedor_id = u.id
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

// ── GET /api/vendedores/:id ──────────────────────────────────
vendedoresRouter.get('/:id', authMiddleware, soloDueno, async (req, res) => {
  try {
    const [userR, numerosR, rifasR, ventasR] = await Promise.all([
      pool.query(
        'SELECT id, nombre, usuario, cedula, rol, activo, created_at FROM users WHERE id = $1',
        [req.params.id]
      ),
      pool.query(
        'SELECT numero FROM numeros_vendedor_global WHERE vendedor_id = $1 ORDER BY numero',
        [req.params.id]
      ),
      pool.query(
        `SELECT nv.rifa_id, r.nombre AS rifa_nombre, r.activa,
                COUNT(nv.numero)::int AS numeros_en_rifa,
                COUNT(v.id)::int      AS ventas_en_rifa
         FROM numeros_vendedor nv
         JOIN rifas r ON r.id = nv.rifa_id
         LEFT JOIN ventas v ON v.rifa_id = nv.rifa_id AND v.numero = nv.numero AND v.vendedor_id = nv.vendedor_id
         WHERE nv.vendedor_id = $1
         GROUP BY nv.rifa_id, r.nombre, r.activa
         ORDER BY r.activa DESC, nv.rifa_id DESC`,
        [req.params.id]
      ),
      pool.query(
        `SELECT v.*, r.nombre AS rifa_nombre FROM ventas v
         JOIN rifas r ON r.id = v.rifa_id
         WHERE v.vendedor_id = $1 ORDER BY v.created_at DESC LIMIT 20`,
        [req.params.id]
      ),
    ]);

    if (!userR.rows[0]) return res.status(404).json({ error: 'Vendedor no encontrado' });

    res.json({
      vendedor:           userR.rows[0],
      numeros_asignados:  numerosR.rows.map(r => r.numero),
      rifas_participando: rifasR.rows,
      ventas_recientes:   ventasR.rows,
    });
  } catch (err) {
    console.error('Error obteniendo vendedor:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ── PUT /api/vendedores/:id ──────────────────────────────────
vendedoresRouter.put('/:id', authMiddleware, soloDueno, async (req, res) => {
  const { nombre, password, activo, cedula } = req.body;
  try {
    const fields = []; const params = []; let i = 1;
    if (nombre)                      { fields.push(`nombre = $${i++}`);  params.push(nombre); }
    if (typeof activo === 'boolean')  { fields.push(`activo = $${i++}`);  params.push(activo); }
    if (cedula !== undefined)         { fields.push(`cedula = $${i++}`);  params.push(cedula || null); }
    if (password) {
      if (password.length < 6) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
      const hash = await bcrypt.hash(password, 10);
      fields.push(`password = $${i++}`); params.push(hash);
    }
    if (!fields.length) return res.status(400).json({ error: 'Nada que actualizar' });
    params.push(req.params.id);
    const result = await pool.query(
      `UPDATE users SET ${fields.join(', ')} WHERE id = $${i} RETURNING id, nombre, usuario, cedula, rol, activo`,
      params
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Vendedor no encontrado' });
    res.json({ message: 'Vendedor actualizado', vendedor: result.rows[0] });
  } catch (err) {
    console.error('Error actualizando vendedor:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ── DELETE /api/vendedores/:id ───────────────────────────────
vendedoresRouter.delete('/:id', authMiddleware, soloDueno, async (req, res) => {
  try {
    const ventas = await pool.query('SELECT COUNT(*) FROM ventas WHERE vendedor_id = $1', [req.params.id]);
    if (parseInt(ventas.rows[0].count) > 0)
      return res.status(400).json({ error: 'No se puede eliminar un vendedor con ventas registradas. Desactívalo en su lugar.' });

    await pool.query('DELETE FROM numeros_vendedor_global WHERE vendedor_id = $1', [req.params.id]);
    await pool.query('DELETE FROM numeros_vendedor        WHERE vendedor_id = $1', [req.params.id]);
    await pool.query('DELETE FROM users                   WHERE id = $1',          [req.params.id]);
    res.json({ message: 'Vendedor eliminado exitosamente' });
  } catch (err) {
    console.error('Error eliminando vendedor:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ── GET /api/vendedores/:id/numeros-aleatorios ───────────────
vendedoresRouter.get('/:id/numeros-aleatorios', authMiddleware, soloDueno, async (req, res) => {
  const { cantidad = 10, excluir = '' } = req.query;
  const excluirArr = excluir ? excluir.split(',').map(n => n.trim()).filter(Boolean) : [];
  try {
    const result = await pool.query(
      `SELECT LPAD(gs::text, 3, '0') AS numero
       FROM generate_series(0, 999) gs
       WHERE LPAD(gs::text, 3, '0') NOT IN (SELECT numero FROM numeros_vendedor_global)
       ${excluirArr.length > 0 ? `AND LPAD(gs::text, 3, '0') != ALL($2)` : ''}
       ORDER BY RANDOM() LIMIT $1`,
      excluirArr.length > 0 ? [parseInt(cantidad), excluirArr] : [parseInt(cantidad)]
    );
    res.json({ numeros_sugeridos: result.rows.map(r => r.numero) });
  } catch (err) {
    console.error('Error generando aleatorios:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});


/* ════════════════════════════════════════════════════════════
   ROUTER 2 — CATEGORÍAS GLOBALES  →  /api/categorias-globales
════════════════════════════════════════════════════════════ */
const categoriasGlobalesRouter = express.Router();

// ── GET /api/categorias-globales ────────────────────────────
categoriasGlobalesRouter.get('/', authMiddleware, soloDueno, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        cg.id,
        cg.nombre,
        cg.tipo,
        cg.monto,
        cg.descripcion,
        cg.created_at,
        COUNT(DISTINCT cga.vendedor_id)::int                             AS total_vendedores,
        COUNT(cga.id)::int                                               AS total_numeros,
        COUNT(CASE WHEN cga.serie = 'A' THEN 1 END)::int                AS numeros_serie_a,
        COUNT(CASE WHEN cga.serie = 'B' THEN 1 END)::int                AS numeros_serie_b
      FROM categorias_globales cg
      LEFT JOIN cat_global_asignaciones cga ON cga.categoria_id = cg.id
      GROUP BY cg.id, cg.nombre, cg.tipo, cg.monto, cg.descripcion, cg.created_at
      ORDER BY cg.nombre
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('Error obteniendo categorías:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ── POST /api/categorias-globales ───────────────────────────
categoriasGlobalesRouter.post('/', authMiddleware, soloDueno, async (req, res) => {
  const { nombre, tipo = 'parcial', monto, descripcion } = req.body;
  if (!nombre?.trim()) return res.status(400).json({ error: 'El nombre es requerido' });
  if (!['parcial', 'simultanea'].includes(tipo))
    return res.status(400).json({ error: 'Tipo debe ser "parcial" o "simultanea"' });

  try {
    const result = await pool.query(
      `INSERT INTO categorias_globales (nombre, tipo, monto, descripcion, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, nombre, tipo, monto, descripcion, created_at`,
      [nombre.trim(), tipo, monto || null, descripcion || null, req.user?.id || null]
    );
    res.status(201).json({ ...result.rows[0], total_vendedores: 0, total_numeros: 0, numeros_serie_a: 0, numeros_serie_b: 0 });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Ya existe una categoría con ese nombre' });
    console.error('Error creando categoría:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ── PUT /api/categorias-globales/:id ────────────────────────
categoriasGlobalesRouter.put('/:id', authMiddleware, soloDueno, async (req, res) => {
  const { nombre, monto, descripcion } = req.body;
  try {
    const fields = []; const params = []; let i = 1;
    if (nombre      !== undefined) { fields.push(`nombre = $${i++}`);      params.push(nombre.trim()); }
    if (monto       !== undefined) { fields.push(`monto = $${i++}`);       params.push(monto || null); }
    if (descripcion !== undefined) { fields.push(`descripcion = $${i++}`); params.push(descripcion || null); }
    if (!fields.length) return res.status(400).json({ error: 'Nada que actualizar' });

    params.push(req.params.id);
    const result = await pool.query(
      `UPDATE categorias_globales SET ${fields.join(', ')}, updated_at = now()
       WHERE id = $${i} RETURNING id, nombre, tipo, monto, descripcion`,
      params
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Categoría no encontrada' });
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Ya existe una categoría con ese nombre' });
    console.error('Error actualizando categoría:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ── DELETE /api/categorias-globales/:id ─────────────────────
categoriasGlobalesRouter.delete('/:id', authMiddleware, soloDueno, async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM categorias_globales WHERE id = $1 RETURNING id',
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Categoría no encontrada' });
    res.json({ message: 'Categoría eliminada. Las asignaciones se removieron automáticamente.' });
  } catch (err) {
    console.error('Error eliminando categoría:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ── GET /api/categorias-globales/:id/vendedores ──────────────
categoriasGlobalesRouter.get('/:id/vendedores', authMiddleware, soloDueno, async (req, res) => {
  try {
    const catR = await pool.query('SELECT id, tipo FROM categorias_globales WHERE id = $1', [req.params.id]);
    if (!catR.rows[0]) return res.status(404).json({ error: 'Categoría no encontrada' });

    const result = await pool.query(
      `SELECT
         cga.id,
         cga.vendedor_id,
         u.nombre    AS vendedor_nombre,
         cga.numero,
         cga.serie,
         cga.created_at
       FROM cat_global_asignaciones cga
       JOIN users u ON u.id = cga.vendedor_id
       WHERE cga.categoria_id = $1
       ORDER BY u.nombre, cga.serie, cga.numero`,
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error obteniendo vendedores de categoría:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ── POST /api/categorias-globales/:id/vendedores ─────────────
categoriasGlobalesRouter.post('/:id/vendedores', authMiddleware, soloDueno, async (req, res) => {
  let { vendedor_id, numero, serie = 'A' } = req.body;

  if (!vendedor_id) return res.status(400).json({ error: 'vendedor_id es requerido' });
  if (!numero || !/^\d{1,3}$/.test(String(numero)))
    return res.status(400).json({ error: 'Número inválido. Debe ser 000–999' });

  numero = String(parseInt(numero)).padStart(3, '0');
  serie  = String(serie).toUpperCase();
  if (!['A', 'B'].includes(serie))
    return res.status(400).json({ error: 'Serie debe ser A o B' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const catR = await client.query(
      'SELECT id, tipo FROM categorias_globales WHERE id = $1 FOR UPDATE',
      [req.params.id]
    );
    if (!catR.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Categoría no encontrada' });
    }
    const { tipo } = catR.rows[0];

    if (tipo === 'parcial') serie = 'A';

    const vendR = await client.query(
      'SELECT id, nombre, activo FROM users WHERE id = $1 AND rol = $2',
      [vendedor_id, 'vendedor']
    );
    if (!vendR.rows[0])
      return res.status(404).json({ error: 'Vendedor no encontrado' });
    if (!vendR.rows[0].activo)
      return res.status(400).json({ error: 'El vendedor está inactivo' });

    const vendedorNombre = vendR.rows[0].nombre;

    const colR = await client.query(
      `SELECT cga.id, u.nombre AS dueno_nombre
       FROM cat_global_asignaciones cga
       JOIN users u ON u.id = cga.vendedor_id
       WHERE cga.categoria_id = $1 AND cga.numero = $2 AND cga.serie = $3`,
      [req.params.id, numero, serie]
    );

    if (colR.rows[0]) {
      await client.query('ROLLBACK');
      const dueno = colR.rows[0].dueno_nombre;
      if (tipo === 'parcial') {
        return res.status(409).json({
          error: `El número ${numero} ya está asignado a ${dueno} en esta categoría (parcial).`
        });
      } else {
        const otraSerie = serie === 'A' ? 'B' : 'A';
        const otraR = await client.query(
          `SELECT id FROM cat_global_asignaciones
           WHERE categoria_id = $1 AND numero = $2 AND serie = $3`,
          [req.params.id, numero, otraSerie]
        );
        const mensajeSugerencia = otraR.rows.length === 0
          ? ` Sin embargo, el número ${numero} en Serie ${otraSerie} está disponible.`
          : ` Tampoco está disponible en Serie ${otraSerie}.`;
        return res.status(409).json({
          error: `El número ${numero} en Serie ${serie} ya lo tiene ${dueno}.${mensajeSugerencia}`,
          serie_alternativa: otraR.rows.length === 0 ? otraSerie : null,
        });
      }
    }

    const insR = await client.query(
      `INSERT INTO cat_global_asignaciones (categoria_id, vendedor_id, numero, serie)
       VALUES ($1, $2, $3, $4)
       RETURNING id, categoria_id, vendedor_id, numero, serie, created_at`,
      [req.params.id, vendedor_id, numero, serie]
    );

    await client.query('COMMIT');

    res.status(201).json({
      ...insR.rows[0],
      vendedor_nombre: vendedorNombre,
      message: `✅ ${vendedorNombre} asignado con el número ${numero}${tipo === 'simultanea' ? ` (Serie ${serie})` : ''}`
    });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505')
      return res.status(409).json({ error: 'Ese número ya está asignado en esa serie para esta categoría' });
    console.error('Error asignando vendedor a categoría:', err);
    res.status(500).json({ error: 'Error del servidor' });
  } finally {
    client.release();
  }
});

// ── DELETE /api/categorias-globales/:id/vendedores/:asigId ───
categoriasGlobalesRouter.delete('/:id/vendedores/:asigId', authMiddleware, soloDueno, async (req, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM cat_global_asignaciones
       WHERE id = $1 AND categoria_id = $2
       RETURNING id, numero, vendedor_id`,
      [req.params.asigId, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Asignación no encontrada' });
    res.json({ message: 'Asignación removida', numero: result.rows[0].numero });
  } catch (err) {
    console.error('Error eliminando asignación:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ── GET /api/categorias-globales/:id/numeros-disponibles ─────
categoriasGlobalesRouter.get('/:id/numeros-disponibles', authMiddleware, soloDueno, async (req, res) => {
  const { serie = 'A', cantidad = 100 } = req.query;
  try {
    const catR = await pool.query('SELECT tipo FROM categorias_globales WHERE id = $1', [req.params.id]);
    if (!catR.rows[0]) return res.status(404).json({ error: 'Categoría no encontrada' });

    const serieQ = catR.rows[0].tipo === 'parcial' ? 'A' : serie.toUpperCase();

    const result = await pool.query(
      `SELECT LPAD(gs::text, 3, '0') AS numero
       FROM generate_series(0, 999) gs
       WHERE LPAD(gs::text, 3, '0') NOT IN (
         SELECT numero FROM cat_global_asignaciones
         WHERE categoria_id = $1 AND serie = $2
       )
       ORDER BY gs
       LIMIT $3`,
      [req.params.id, serieQ, parseInt(cantidad)]
    );
    res.json({ numeros: result.rows.map(r => r.numero), serie: serieQ });
  } catch (err) {
    console.error('Error obteniendo números disponibles:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});


/* ════════════════════════════════════════════════════════════
   ROUTER 3 — NÚMEROS GLOBALES  →  /api/numeros
════════════════════════════════════════════════════════════ */
const numerosRouter = express.Router();

// ── POST /api/numeros/asignar ────────────────────────────────
numerosRouter.post('/asignar', authMiddleware, soloDueno, async (req, res) => {
  const { vendedor_id, numeros } = req.body;
  if (!vendedor_id || !Array.isArray(numeros) || !numeros.length)
    return res.status(400).json({ error: 'vendedor_id y numeros[] son requeridos' });

  const invalidos = numeros.filter(n => !/^\d{3}$/.test(n));
  if (invalidos.length) return res.status(400).json({ error: `Números inválidos: ${invalidos.join(', ')}` });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const yaDelVendedor = await client.query(
      `SELECT numero FROM numeros_vendedor_global
       WHERE vendedor_id = $1 AND numero = ANY($2)`,
      [vendedor_id, numeros]
    );
    if (yaDelVendedor.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: `Este vendedor ya tiene asignados: ${yaDelVendedor.rows.map(r => r.numero).join(', ')}`
      });
    }

    for (const num of numeros) {
      await client.query(
        `INSERT INTO numeros_vendedor_global (vendedor_id, numero)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [vendedor_id, num]
      );
    }
    await client.query('COMMIT');
    res.status(201).json({ message: `${numeros.length} número(s) asignados al vendedor` });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error asignando números:', err);
    res.status(500).json({ error: 'Error del servidor' });
  } finally { client.release(); }
});

// ── DELETE /api/numeros/asignar ──────────────────────────────
numerosRouter.delete('/asignar', authMiddleware, soloDueno, async (req, res) => {
  const { vendedor_id, numeros } = req.body;
  if (!vendedor_id || !Array.isArray(numeros) || !numeros.length)
    return res.status(400).json({ error: 'vendedor_id y numeros[] son requeridos' });

  try {
    const conVenta = await pool.query(
      `SELECT DISTINCT ng.numero
       FROM numeros_vendedor_global ng
       JOIN ventas v ON v.vendedor_id = ng.vendedor_id AND v.numero = ng.numero
       JOIN rifas r  ON r.id = v.rifa_id AND r.activa = true
       WHERE ng.vendedor_id = $1 AND ng.numero = ANY($2)`,
      [vendedor_id, numeros]
    );
    if (conVenta.rows.length > 0)
      return res.status(400).json({
        error: `No se pueden quitar — tienen ventas activas: ${conVenta.rows.map(r => r.numero).join(', ')}`
      });

    await pool.query(
      'DELETE FROM numeros_vendedor_global WHERE vendedor_id = $1 AND numero = ANY($2)',
      [vendedor_id, numeros]
    );
    res.json({ message: `${numeros.length} número(s) removidos` });
  } catch (err) {
    console.error('Error removiendo números:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});


/* ════════════════════════════════════════════════════════════
   EXPORTS
════════════════════════════════════════════════════════════ */
module.exports = { vendedoresRouter, categoriasGlobalesRouter, numerosRouter };