// ============================================================
//   RIFAS JORDYN — Rutas de Vendedores + Categorías Globales
//
//   NUEVA ARQUITECTURA (v2):
//   ─────────────────────────────────────────────────────────
//   • Los vendedores son usuarios globales del sistema (rol='vendedor').
//   • Los NÚMEROS ya NO son globales. Cada vendedor tiene sus números
//     definidos DENTRO de cada categoría en la que participa.
//   • Se elimina la tabla numeros_vendedor_global.
//   • Nueva tabla: cat_vendedor_numeros
//       (categoria_id, vendedor_id, numero)
//     → define qué números "pertenecen" a ese vendedor en esa categoría.
//   • Nueva tabla (o se reutiliza cat_global_asignaciones):
//     cat_global_asignaciones
//       (categoria_id, vendedor_id, numero, serie)
//     → registra qué número+serie está "ocupado" por ese vendedor.
//
//   FLUJO POR TIPO DE CATEGORÍA:
//   ─────────────────────────────────────────────────────────
//   PARCIAL (serie única):
//     - El vendedor tiene N números asignados en la categoría.
//     - Si el número ya lo tiene otro vendedor → conflicto, no se asigna.
//     - serie siempre = 'A' (parcial solo usa serie A).
//
//   SIMULTÁNEA (series A y B, 000–999 cada una):
//     - Se intenta Serie A primero.
//     - Si Serie A ocupada → avisa quién la tiene → pasa a Serie B.
//     - Si Serie B también ocupada → muestra ambos dueños → no se asigna.
//
//   CAMBIOS EN BASE DE DATOS REQUERIDOS:
//   ─────────────────────────────────────────────────────────
//   1. DROP TABLE numeros_vendedor_global;  (ya no se usa)
//   2. CREATE TABLE cat_vendedor_numeros (
//        id           SERIAL PRIMARY KEY,
//        categoria_id INTEGER NOT NULL REFERENCES categorias_globales(id) ON DELETE CASCADE,
//        vendedor_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
//        numero       CHAR(3) NOT NULL CHECK (numero ~ '^\d{3}$'),
//        created_at   TIMESTAMPTZ DEFAULT now(),
//        UNIQUE (categoria_id, vendedor_id, numero)
//      );
//   3. La tabla cat_global_asignaciones ya existe y se mantiene igual:
//        (id, categoria_id, vendedor_id, numero CHAR(3), serie CHAR(1))
//        UNIQUE (categoria_id, numero, serie)
//
//   RUTAS:
//   /api/vendedores                          → CRUD vendedores
//   /api/categorias-globales                 → CRUD categorías
//   /api/categorias-globales/:id/vendedores  → gestión vendedores+números en categoría
// ============================================================

const express = require('express');
const router  = express.Router();
const bcrypt  = require('bcryptjs');
const pool    = require('../config/db');
const { authMiddleware, soloDueno } = require('../middleware/auth');

/* ════════════════════════════════════════════════════════════
   RUTAS DE VENDEDORES  —  /api/vendedores
   Sin cambios estructurales respecto a v1, solo se eliminan
   referencias a numeros_vendedor_global.
════════════════════════════════════════════════════════════ */

// GET /api/vendedores
// CAMBIO: Se eliminó el LEFT JOIN a numeros_vendedor_global.
//         numeros_count ahora cuenta números distintos en cat_vendedor_numeros.
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
        COUNT(DISTINCT v.id)::int                          AS total_ventas,
        COALESCE(SUM(v.precio_venta), 0)                   AS total_ingresos,
        COUNT(DISTINCT cvn.id)::int                        AS numeros_count,
        COUNT(DISTINCT cvn.categoria_id)::int              AS categorias_count
      FROM users u
      LEFT JOIN ventas v             ON v.vendedor_id = u.id
      LEFT JOIN cat_vendedor_numeros cvn ON cvn.vendedor_id = u.id
      WHERE u.rol = 'vendedor'
      GROUP BY u.id, u.nombre, u.usuario, u.cedula, u.rol, u.activo, u.created_at
      ORDER BY u.nombre
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('GET /vendedores:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// GET /api/vendedores/:id
// CAMBIO: numeros_asignados ahora viene de cat_vendedor_numeros agrupados por categoría.
router.get('/:id', authMiddleware, soloDueno, async (req, res) => {
  try {
    const [userR, numerosR, rifasR, ventasR] = await Promise.all([
      pool.query(
        'SELECT id, nombre, usuario, cedula, rol, activo, created_at FROM users WHERE id = $1',
        [req.params.id]
      ),
      // NUEVO: números agrupados por categoría
      pool.query(
        `SELECT
           cvn.categoria_id,
           cg.nombre AS categoria_nombre,
           cg.tipo   AS categoria_tipo,
           JSON_AGG(cvn.numero ORDER BY cvn.numero) AS numeros
         FROM cat_vendedor_numeros cvn
         JOIN categorias_globales cg ON cg.id = cvn.categoria_id
         WHERE cvn.vendedor_id = $1
         GROUP BY cvn.categoria_id, cg.nombre, cg.tipo
         ORDER BY cg.nombre`,
        [req.params.id]
      ),
      pool.query(
        `SELECT nv.rifa_id, r.nombre AS rifa_nombre, r.activa,
                COUNT(nv.numero)::int AS numeros_en_rifa,
                COUNT(v.id)::int      AS ventas_en_rifa
         FROM numeros_vendedor nv
         JOIN rifas r ON r.id = nv.rifa_id
         LEFT JOIN ventas v ON v.rifa_id = nv.rifa_id
           AND v.numero = nv.numero AND v.vendedor_id = nv.vendedor_id
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
      vendedor:            userR.rows[0],
      numeros_por_cat:     numerosR.rows,   // NUEVO: números por categoría
      rifas_participando:  rifasR.rows,
      ventas_recientes:    ventasR.rows,
    });
  } catch (err) {
    console.error('GET /vendedores/:id:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// PUT /api/vendedores/:id  (sin cambios)
router.put('/:id', authMiddleware, soloDueno, async (req, res) => {
  const { nombre, password, activo, cedula } = req.body;
  try {
    const fields = []; const params = []; let i = 1;
    if (nombre)                      { fields.push(`nombre = $${i++}`); params.push(nombre); }
    if (typeof activo === 'boolean')  { fields.push(`activo = $${i++}`); params.push(activo); }
    if (cedula !== undefined)         { fields.push(`cedula = $${i++}`); params.push(cedula || null); }
    if (password) {
      if (password.length < 6) return res.status(400).json({ error: 'Contraseña mínimo 6 caracteres' });
      const hash = await bcrypt.hash(password, 10);
      fields.push(`password = $${i++}`); params.push(hash);
    }
    if (!fields.length) return res.status(400).json({ error: 'Nada que actualizar' });
    params.push(req.params.id);
    const result = await pool.query(
      `UPDATE users SET ${fields.join(', ')} WHERE id = $${i}
       RETURNING id, nombre, usuario, cedula, rol, activo`,
      params
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Vendedor no encontrado' });
    res.json({ message: 'Vendedor actualizado', vendedor: result.rows[0] });
  } catch (err) {
    console.error('PUT /vendedores/:id:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// DELETE /api/vendedores/:id
// CAMBIO: Se eliminó DELETE FROM numeros_vendedor_global.
//         cat_vendedor_numeros y cat_global_asignaciones se limpian por CASCADE.
router.delete('/:id', authMiddleware, soloDueno, async (req, res) => {
  try {
    const ventas = await pool.query(
      'SELECT COUNT(*) FROM ventas WHERE vendedor_id = $1', [req.params.id]
    );
    if (parseInt(ventas.rows[0].count) > 0)
      return res.status(400).json({
        error: 'No se puede eliminar un vendedor con ventas registradas. Desactívalo en su lugar.'
      });
    // cat_vendedor_numeros y cat_global_asignaciones se eliminan por ON DELETE CASCADE
    await pool.query('DELETE FROM numeros_vendedor WHERE vendedor_id = $1', [req.params.id]);
    await pool.query('DELETE FROM users            WHERE id = $1',          [req.params.id]);
    res.json({ message: 'Vendedor eliminado exitosamente' });
  } catch (err) {
    console.error('DELETE /vendedores/:id:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

/* ════════════════════════════════════════════════════════════
   RUTAS DE CATEGORÍAS GLOBALES  —  /api/categorias-globales
════════════════════════════════════════════════════════════ */
const catRouter = express.Router();

// GET /api/categorias-globales
// Sin cambios — ya cuenta desde cat_global_asignaciones.
catRouter.get('/', authMiddleware, soloDueno, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        cg.id,
        cg.nombre,
        cg.tipo,
        cg.monto,
        cg.descripcion,
        cg.created_at,
        COUNT(DISTINCT cga.vendedor_id)::int                          AS total_vendedores,
        COUNT(DISTINCT cga.id)::int                                   AS total_asignaciones,
        COUNT(CASE WHEN cga.serie = 'A' THEN 1 END)::int             AS numeros_serie_a,
        COUNT(CASE WHEN cga.serie = 'B' THEN 1 END)::int             AS numeros_serie_b,
        COUNT(DISTINCT cvn.id)::int                                   AS total_numeros_definidos
      FROM categorias_globales cg
      LEFT JOIN cat_global_asignaciones cga ON cga.categoria_id = cg.id
      LEFT JOIN cat_vendedor_numeros    cvn ON cvn.categoria_id = cg.id
      GROUP BY cg.id, cg.nombre, cg.tipo, cg.monto, cg.descripcion, cg.created_at
      ORDER BY cg.nombre
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('GET /categorias-globales:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// POST /api/categorias-globales  (sin cambios)
catRouter.post('/', authMiddleware, soloDueno, async (req, res) => {
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
    res.status(201).json({
      ...result.rows[0],
      total_vendedores: 0, total_asignaciones: 0,
      numeros_serie_a: 0, numeros_serie_b: 0, total_numeros_definidos: 0,
    });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Ya existe una categoría con ese nombre' });
    console.error('POST /categorias-globales:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// PUT /api/categorias-globales/:id  (sin cambios)
catRouter.put('/:id', authMiddleware, soloDueno, async (req, res) => {
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
    console.error('PUT /categorias-globales/:id:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// DELETE /api/categorias-globales/:id
// cat_vendedor_numeros y cat_global_asignaciones se eliminan por CASCADE.
catRouter.delete('/:id', authMiddleware, soloDueno, async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM categorias_globales WHERE id = $1 RETURNING id', [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Categoría no encontrada' });
    res.json({ message: 'Categoría eliminada. Vendedores y números de la categoría removidos automáticamente.' });
  } catch (err) {
    console.error('DELETE /categorias-globales/:id:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

/* ──────────────────────────────────────────────────────────────────
   GET /api/categorias-globales/:id/vendedores
   Lista vendedores que tienen números definidos en esta categoría,
   con sus números y el estado de asignación (serie / conflicto).
   NUEVO: ahora la fuente es cat_vendedor_numeros + cat_global_asignaciones.
────────────────────────────────────────────────────────────────── */
catRouter.get('/:id/vendedores', authMiddleware, soloDueno, async (req, res) => {
  try {
    const catR = await pool.query(
      'SELECT id, tipo FROM categorias_globales WHERE id = $1', [req.params.id]
    );
    if (!catR.rows[0]) return res.status(404).json({ error: 'Categoría no encontrada' });

    // Todos los números definidos para vendedores en esta categoría
    const numerosR = await pool.query(
      `SELECT
         cvn.id,
         cvn.vendedor_id,
         u.nombre  AS vendedor_nombre,
         cvn.numero,
         cga.serie,       -- NULL si no está asignado en ninguna serie aún
         cga.id    AS asignacion_id,
         cga.created_at
       FROM cat_vendedor_numeros cvn
       JOIN users u ON u.id = cvn.vendedor_id
       LEFT JOIN cat_global_asignaciones cga
         ON  cga.categoria_id = cvn.categoria_id
         AND cga.vendedor_id  = cvn.vendedor_id
         AND cga.numero       = cvn.numero
       WHERE cvn.categoria_id = $1
       ORDER BY u.nombre, cvn.numero`,
      [req.params.id]
    );
    res.json(numerosR.rows);
  } catch (err) {
    console.error('GET /categorias-globales/:id/vendedores:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

/* ──────────────────────────────────────────────────────────────────
   GET /api/categorias-globales/:id/vendedores-resumen
   NUEVO: Devuelve un resumen por vendedor con sus números y estado.
   Útil para el frontend al renderizar las cards de vendedores.
────────────────────────────────────────────────────────────────── */
catRouter.get('/:id/vendedores-resumen', authMiddleware, soloDueno, async (req, res) => {
  try {
    const catR = await pool.query(
      'SELECT id, tipo FROM categorias_globales WHERE id = $1', [req.params.id]
    );
    if (!catR.rows[0]) return res.status(404).json({ error: 'Categoría no encontrada' });
    const { tipo } = catR.rows[0];

    const result = await pool.query(
      `SELECT
         cvn.vendedor_id,
         u.nombre  AS vendedor_nombre,
         COUNT(cvn.numero)::int                                    AS total_numeros,
         COUNT(cga.id)::int                                        AS total_asignados,
         COUNT(CASE WHEN cga.serie = 'A' THEN 1 END)::int         AS serie_a,
         COUNT(CASE WHEN cga.serie = 'B' THEN 1 END)::int         AS serie_b,
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
         ON  cga.categoria_id = cvn.categoria_id
         AND cga.vendedor_id  = cvn.vendedor_id
         AND cga.numero       = cvn.numero
       WHERE cvn.categoria_id = $1
       GROUP BY cvn.vendedor_id, u.nombre
       ORDER BY u.nombre`,
      [req.params.id]
    );
    res.json({ tipo, vendedores: result.rows });
  } catch (err) {
    console.error('GET /categorias-globales/:id/vendedores-resumen:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

/* ──────────────────────────────────────────────────────────────────
   POST /api/categorias-globales/:id/vendedores/:vendedorId/numeros
   NUEVO: Agrega números al pool del vendedor dentro de esta categoría.
   Body: { numeros: ['000','001',...] }
   No genera asignación de serie todavía — eso ocurre en /asignar.
────────────────────────────────────────────────────────────────── */
catRouter.post('/:id/vendedores/:vendedorId/numeros', authMiddleware, soloDueno, async (req, res) => {
  const { numeros } = req.body;
  if (!Array.isArray(numeros) || !numeros.length)
    return res.status(400).json({ error: 'numeros[] es requerido' });

  const invalidos = numeros.filter(n => !/^\d{3}$/.test(n));
  if (invalidos.length)
    return res.status(400).json({ error: `Números inválidos: ${invalidos.join(', ')}` });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const catR = await client.query(
      'SELECT id, tipo FROM categorias_globales WHERE id = $1', [req.params.id]
    );
    if (!catR.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Categoría no encontrada' }); }

    const vendR = await client.query(
      'SELECT id, nombre, activo FROM users WHERE id = $1 AND rol = $2',
      [req.params.vendedorId, 'vendedor']
    );
    if (!vendR.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Vendedor no encontrado' }); }
    if (!vendR.rows[0].activo) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'El vendedor está inactivo' }); }

    // Insertar números — ON CONFLICT DO NOTHING (idempotente)
    let insertados = 0;
    const yaExistenR = await client.query(
      `SELECT numero FROM cat_vendedor_numeros
       WHERE categoria_id = $1 AND vendedor_id = $2 AND numero = ANY($3::char[])`,
      [req.params.id, req.params.vendedorId, numeros]
    );
    const yaExisten = yaExistenR.rows.map(r => r.numero);
    const nuevos    = numeros.filter(n => !yaExisten.includes(n));

    for (const num of nuevos) {
      await client.query(
        `INSERT INTO cat_vendedor_numeros (categoria_id, vendedor_id, numero)
         VALUES ($1, $2, $3)`,
        [req.params.id, req.params.vendedorId, num]
      );
      insertados++;
    }

    await client.query('COMMIT');
    res.status(201).json({
      message: `${insertados} número(s) agregados al pool de ${vendR.rows[0].nombre} en esta categoría.`,
      insertados,
      ya_existian: yaExisten,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /categorias-globales/:id/vendedores/:vendedorId/numeros:', err);
    res.status(500).json({ error: 'Error del servidor' });
  } finally { client.release(); }
});

/* ──────────────────────────────────────────────────────────────────
   DELETE /api/categorias-globales/:id/vendedores/:vendedorId/numeros
   NUEVO: Quita números del pool del vendedor en esta categoría.
   Body: { numeros: ['000','001',...] }
   También elimina las asignaciones de serie si existían.
────────────────────────────────────────────────────────────────── */
catRouter.delete('/:id/vendedores/:vendedorId/numeros', authMiddleware, soloDueno, async (req, res) => {
  const { numeros } = req.body;
  if (!Array.isArray(numeros) || !numeros.length)
    return res.status(400).json({ error: 'numeros[] es requerido' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Eliminar asignaciones de serie primero
    await client.query(
      `DELETE FROM cat_global_asignaciones
       WHERE categoria_id = $1 AND vendedor_id = $2 AND numero = ANY($3::char[])`,
      [req.params.id, req.params.vendedorId, numeros]
    );
    // Eliminar del pool
    const result = await client.query(
      `DELETE FROM cat_vendedor_numeros
       WHERE categoria_id = $1 AND vendedor_id = $2 AND numero = ANY($3::char[])
       RETURNING numero`,
      [req.params.id, req.params.vendedorId, numeros]
    );
    await client.query('COMMIT');
    res.json({
      message: `${result.rows.length} número(s) removidos.`,
      removidos: result.rows.map(r => r.numero),
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('DELETE /categorias-globales/:id/vendedores/:vendedorId/numeros:', err);
    res.status(500).json({ error: 'Error del servidor' });
  } finally { client.release(); }
});

/* ──────────────────────────────────────────────────────────────────
   POST /api/categorias-globales/:id/vendedores/:vendedorId/asignar
   NUEVO: Intenta asignar (en serie) los números que el vendedor tiene
   en su pool para esta categoría que AÚN NO están asignados.

   PARCIAL:
     - número libre → asigna en serie A.
     - número ocupado por otro → colisión (reporta quién lo tiene).

   SIMULTÁNEA:
     - número libre en A → asigna en A.
     - número ocupado en A → informa quién lo tiene → intenta B.
     - número libre en B → asigna en B.
     - número ocupado en A y B → colisión total (reporta ambos dueños).

   Respuesta:
   {
     message, insertados: [{numero, serie}],
     colisiones: [{numero, serie_intentada, dueno, segunda_serie?, segundo_dueno?}],
     info_adicional: [{numero, serie_a_dueno, serie_b_dueno, accion}]
   }
────────────────────────────────────────────────────────────────── */
catRouter.post('/:id/vendedores/:vendedorId/asignar', authMiddleware, soloDueno, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const catR = await client.query(
      'SELECT id, tipo FROM categorias_globales WHERE id = $1 FOR UPDATE',
      [req.params.id]
    );
    if (!catR.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Categoría no encontrada' }); }
    const { tipo } = catR.rows[0];

    const vendR = await client.query(
      'SELECT id, nombre, activo FROM users WHERE id = $1 AND rol = $2',
      [req.params.vendedorId, 'vendedor']
    );
    if (!vendR.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Vendedor no encontrado' }); }
    if (!vendR.rows[0].activo) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'El vendedor está inactivo' }); }
    const vendedorNombre = vendR.rows[0].nombre;

    // Pool de números del vendedor en esta categoría
    const poolR = await client.query(
      `SELECT numero FROM cat_vendedor_numeros
       WHERE categoria_id = $1 AND vendedor_id = $2 ORDER BY numero`,
      [req.params.id, req.params.vendedorId]
    );
    const poolNumeros = poolR.rows.map(r => r.numero);
    if (!poolNumeros.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: `${vendedorNombre} no tiene números en esta categoría. Agrégalos primero.`
      });
    }

    // Números que este vendedor YA tiene asignados (con serie)
    const propiosR = await client.query(
      `SELECT numero, serie FROM cat_global_asignaciones
       WHERE categoria_id = $1 AND vendedor_id = $2`,
      [req.params.id, req.params.vendedorId]
    );
    const propiosSet = new Set(propiosR.rows.map(r => r.numero));

    // Números pendientes (en pool pero sin asignación de serie)
    const pendientes = poolNumeros.filter(n => !propiosSet.has(n));
    if (!pendientes.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: `Todos los números de ${vendedorNombre} ya están asignados en esta categoría.`
      });
    }

    // Ocupación actual de los números pendientes en la categoría (por OTROS vendedores)
    const ocupadosR = await client.query(
      `SELECT cga.numero, cga.serie, u.nombre AS dueno_nombre
       FROM cat_global_asignaciones cga
       JOIN users u ON u.id = cga.vendedor_id
       WHERE cga.categoria_id = $1
         AND cga.numero = ANY($2::char[])
         AND cga.vendedor_id != $3
       ORDER BY cga.numero, cga.serie`,
      [req.params.id, pendientes, req.params.vendedorId]
    );
    // Mapa: numero -> { A: nombre_dueno, B: nombre_dueno }
    const ocupadosMap = {};
    for (const row of ocupadosR.rows) {
      if (!ocupadosMap[row.numero]) ocupadosMap[row.numero] = {};
      ocupadosMap[row.numero][row.serie] = row.dueno_nombre;
    }

    const aInsertar    = []; // { numero, serie }
    const colisiones   = []; // { numero, dueno_a, dueno_b }
    const infoAdicional = []; // { numero, accion, serie_a_dueno?, ... }

    for (const num of pendientes) {
      const ocupA = ocupadosMap[num]?.['A'] || null;
      const ocupB = ocupadosMap[num]?.['B'] || null;

      if (tipo === 'parcial') {
        // PARCIAL: solo Serie A, un vendedor por número
        if (!ocupA) {
          aInsertar.push({ numero: num, serie: 'A' });
        } else {
          colisiones.push({
            numero:   num,
            dueno_a:  ocupA,
            dueno_b:  null,
          });
        }

      } else {
        // SIMULTÁNEA: Serie A primero, luego B
        if (!ocupA) {
          // Serie A libre → asignar en A
          aInsertar.push({ numero: num, serie: 'A' });
        } else if (!ocupB) {
          // Serie A ocupada → informar + asignar en B
          aInsertar.push({ numero: num, serie: 'B' });
          infoAdicional.push({
            numero:      num,
            accion:      'serie_b_por_conflicto_a',
            serie_a_dueno: ocupA,
            mensaje: `Serie A ocupada por ${ocupA} → asignado en Serie B`,
          });
        } else {
          // Ambas series ocupadas → colisión total
          colisiones.push({
            numero:  num,
            dueno_a: ocupA,
            dueno_b: ocupB,
          });
        }
      }
    }

    // Insertar los asignables
    let totalInsertados = 0;
    for (const { numero, serie } of aInsertar) {
      const r = await client.query(
        `INSERT INTO cat_global_asignaciones (categoria_id, vendedor_id, numero, serie)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (categoria_id, numero, serie) DO NOTHING
         RETURNING id`,
        [req.params.id, req.params.vendedorId, numero, serie]
      );
      if (r.rows[0]) totalInsertados++;
    }

    await client.query('COMMIT');

    if (totalInsertados === 0 && colisiones.length > 0) {
      return res.status(409).json({
        error: `Todos los números de ${vendedorNombre} tienen conflictos en esta categoría.`,
        insertados:    [],
        colisiones,
        info_adicional: [],
        vendedor_nombre: vendedorNombre,
      });
    }

    const mensajes = [];
    if (totalInsertados > 0)  mensajes.push(`✅ ${totalInsertados} número(s) asignados`);
    if (infoAdicional.length) mensajes.push(`ℹ️ ${infoAdicional.length} número(s) redirigidos a Serie B`);
    if (colisiones.length)    mensajes.push(`⚠️ ${colisiones.length} número(s) con conflicto total`);

    res.status(201).json({
      message:         mensajes.join('. '),
      vendedor_nombre: vendedorNombre,
      insertados:      aInsertar.slice(0, totalInsertados),
      colisiones,
      info_adicional:  infoAdicional,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /categorias-globales/:id/vendedores/:vendedorId/asignar:', err);
    res.status(500).json({ error: 'Error del servidor' });
  } finally { client.release(); }
});

/* ──────────────────────────────────────────────────────────────────
   GET /api/categorias-globales/:id/preview/:vendedorId
   Previsualiza qué pasaría si se asignan los números pendientes
   del vendedor en esta categoría. No modifica nada.
   Respuesta: { tipo, libres, colisiones, info_adicional, puedeAgregar }
────────────────────────────────────────────────────────────────── */
catRouter.get('/:id/preview/:vendedorId', authMiddleware, soloDueno, async (req, res) => {
  try {
    const catR = await pool.query(
      'SELECT id, tipo FROM categorias_globales WHERE id = $1', [req.params.id]
    );
    if (!catR.rows[0]) return res.status(404).json({ error: 'Categoría no encontrada' });
    const { tipo } = catR.rows[0];

    const vendR = await pool.query(
      'SELECT id, nombre FROM users WHERE id = $1 AND rol = $2',
      [req.params.vendedorId, 'vendedor']
    );
    if (!vendR.rows[0]) return res.status(404).json({ error: 'Vendedor no encontrado' });

    const poolR = await pool.query(
      `SELECT numero FROM cat_vendedor_numeros
       WHERE categoria_id = $1 AND vendedor_id = $2 ORDER BY numero`,
      [req.params.id, req.params.vendedorId]
    );
    const poolNumeros = poolR.rows.map(r => r.numero);

    if (!poolNumeros.length)
      return res.json({
        tipo, libres: [], colisiones: [], info_adicional: [],
        puedeAgregar: false, sinNumeros: true,
        vendedor_nombre: vendR.rows[0].nombre,
      });

    // Ya asignados (propios)
    const propiosR = await pool.query(
      `SELECT numero FROM cat_global_asignaciones
       WHERE categoria_id = $1 AND vendedor_id = $2`,
      [req.params.id, req.params.vendedorId]
    );
    const propiosSet = new Set(propiosR.rows.map(r => r.numero));
    const pendientes = poolNumeros.filter(n => !propiosSet.has(n));

    if (!pendientes.length)
      return res.json({
        tipo, libres: [], colisiones: [], info_adicional: [],
        puedeAgregar: false, todoAsignado: true,
        vendedor_nombre: vendR.rows[0].nombre,
        total_numeros: poolNumeros.length,
      });

    // Ocupación por OTROS
    const ocupadosR = await pool.query(
      `SELECT cga.numero, cga.serie, u.nombre AS dueno_nombre
       FROM cat_global_asignaciones cga
       JOIN users u ON u.id = cga.vendedor_id
       WHERE cga.categoria_id = $1
         AND cga.numero = ANY($2::char[])
         AND cga.vendedor_id != $3`,
      [req.params.id, pendientes, req.params.vendedorId]
    );
    const ocupadosMap = {};
    for (const row of ocupadosR.rows) {
      if (!ocupadosMap[row.numero]) ocupadosMap[row.numero] = {};
      ocupadosMap[row.numero][row.serie] = row.dueno_nombre;
    }

    const libres        = [];
    const colisiones    = [];
    const infoAdicional = [];

    for (const num of pendientes) {
      const ocupA = ocupadosMap[num]?.['A'] || null;
      const ocupB = ocupadosMap[num]?.['B'] || null;

      if (tipo === 'parcial') {
        if (!ocupA) libres.push({ numero: num, serie: 'A' });
        else        colisiones.push({ numero: num, dueno_a: ocupA, dueno_b: null });
      } else {
        if (!ocupA) {
          libres.push({ numero: num, serie: 'A' });
        } else if (!ocupB) {
          libres.push({ numero: num, serie: 'B' });
          infoAdicional.push({
            numero: num, accion: 'serie_b_por_conflicto_a',
            serie_a_dueno: ocupA,
            mensaje: `Serie A ocupada por ${ocupA} → irá a Serie B`,
          });
        } else {
          colisiones.push({ numero: num, dueno_a: ocupA, dueno_b: ocupB });
        }
      }
    }

    res.json({
      tipo,
      vendedor_nombre:  vendR.rows[0].nombre,
      total_numeros:    poolNumeros.length,
      total_pendientes: pendientes.length,
      libres,
      colisiones,
      info_adicional:   infoAdicional,
      puedeAgregar:     libres.length > 0,
    });
  } catch (err) {
    console.error('GET /categorias-globales/:id/preview/:vendedorId:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

/* ──────────────────────────────────────────────────────────────────
   DELETE /api/categorias-globales/:id/vendedores/:vendedorId
   Quita AL VENDEDOR COMPLETO de la categoría:
   elimina su pool de números (cat_vendedor_numeros) y
   sus asignaciones de serie (cat_global_asignaciones).
────────────────────────────────────────────────────────────────── */
catRouter.delete('/:id/vendedores/:vendedorId', authMiddleware, soloDueno, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Verificar que existe
    const existeR = await client.query(
      `SELECT COUNT(*) FROM cat_vendedor_numeros
       WHERE categoria_id = $1 AND vendedor_id = $2`,
      [req.params.id, req.params.vendedorId]
    );
    if (parseInt(existeR.rows[0].count) === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Este vendedor no tiene números en la categoría' });
    }

    // Eliminar asignaciones de serie
    const asigR = await client.query(
      `DELETE FROM cat_global_asignaciones
       WHERE categoria_id = $1 AND vendedor_id = $2
       RETURNING numero, serie`,
      [req.params.id, req.params.vendedorId]
    );

    // Eliminar pool de números
    const poolR = await client.query(
      `DELETE FROM cat_vendedor_numeros
       WHERE categoria_id = $1 AND vendedor_id = $2
       RETURNING numero`,
      [req.params.id, req.params.vendedorId]
    );

    await client.query('COMMIT');
    res.json({
      message: `Vendedor removido de la categoría. ${poolR.rows.length} número(s) eliminados.`,
      numeros_eliminados:    poolR.rows.map(r => r.numero),
      asignaciones_removidas: asigR.rows,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('DELETE /categorias-globales/:id/vendedores/:vendedorId:', err);
    res.status(500).json({ error: 'Error del servidor' });
  } finally { client.release(); }
});

/* ──────────────────────────────────────────────────────────────────
   DELETE /api/categorias-globales/:id/asignaciones/:asigId
   Quita una asignación de serie específica (libera el número en esa
   serie) pero mantiene el número en el pool del vendedor.
────────────────────────────────────────────────────────────────── */
catRouter.delete('/:id/asignaciones/:asigId', authMiddleware, soloDueno, async (req, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM cat_global_asignaciones
       WHERE id = $1 AND categoria_id = $2
       RETURNING numero, serie, vendedor_id`,
      [req.params.asigId, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Asignación no encontrada' });
    res.json({
      message: `Número ${result.rows[0].numero} (Serie ${result.rows[0].serie || 'A'}) liberado. Sigue en el pool del vendedor.`,
      ...result.rows[0],
    });
  } catch (err) {
    console.error('DELETE /categorias-globales/:id/asignaciones/:asigId:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

/* ──────────────────────────────────────────────────────────────────
   GET /api/categorias-globales/:id/numeros-disponibles
   NUEVO: Devuelve los números del 000–999 que AÚN no están en ningún
   pool de vendedor de esta categoría. Útil para el frontend al
   agregar números a un vendedor nuevo.
────────────────────────────────────────────────────────────────── */
catRouter.get('/:id/numeros-disponibles', authMiddleware, soloDueno, async (req, res) => {
  const { vendedor_id } = req.query; // opcional: excluir números ya del vendedor
  try {
    const catR = await pool.query(
      'SELECT id, tipo FROM categorias_globales WHERE id = $1', [req.params.id]
    );
    if (!catR.rows[0]) return res.status(404).json({ error: 'Categoría no encontrada' });
    const { tipo } = catR.rows[0];

    // Para PARCIAL: libre = no está en cat_global_asignaciones (serie A)
    // Para SIMULTÁNEA: libre = no tiene AMBAS series ocupadas
    let query, params;

    if (tipo === 'parcial') {
      query = `
        SELECT LPAD(gs::text, 3, '0') AS numero, 'libre' AS estado, NULL AS dueno_a, NULL AS dueno_b
        FROM generate_series(0, 999) gs
        WHERE LPAD(gs::text, 3, '0') NOT IN (
          SELECT numero FROM cat_global_asignaciones
          WHERE categoria_id = $1 AND serie = 'A'
          ${vendedor_id ? 'AND vendedor_id != $2' : ''}
        )
        ORDER BY numero`;
      params = vendedor_id ? [req.params.id, vendedor_id] : [req.params.id];

    } else {
      // Simultánea: mostrar estado de cada número
      query = `
        SELECT
          n.numero,
          CASE
            WHEN a.dueno_a IS NULL AND a.dueno_b IS NULL THEN 'libre'
            WHEN a.dueno_a IS NOT NULL AND a.dueno_b IS NULL THEN 'semi_ocupado'
            ELSE 'ocupado'
          END AS estado,
          a.dueno_a,
          a.dueno_b
        FROM (SELECT LPAD(gs::text, 3, '0') AS numero FROM generate_series(0, 999) gs) n
        LEFT JOIN (
          SELECT
            cga.numero,
            MAX(CASE WHEN cga.serie = 'A' THEN u.nombre END) AS dueno_a,
            MAX(CASE WHEN cga.serie = 'B' THEN u.nombre END) AS dueno_b
          FROM cat_global_asignaciones cga
          JOIN users u ON u.id = cga.vendedor_id
          WHERE cga.categoria_id = $1
          GROUP BY cga.numero
        ) a ON a.numero = n.numero
        WHERE (a.dueno_a IS NULL OR a.dueno_b IS NULL)
        ORDER BY n.numero`;
      params = [req.params.id];
    }

    const result = await pool.query(query, params);
    res.json({ tipo, numeros: result.rows, total: result.rows.length });
  } catch (err) {
    console.error('GET /categorias-globales/:id/numeros-disponibles:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

/* ──────────────────────────────────────────────────────────────────
   GET /api/categorias-globales/:id/numero/:numero/estado
   NUEVO: Consulta el estado de un número específico en la categoría.
   Devuelve quién lo tiene en cada serie (si aplica).
────────────────────────────────────────────────────────────────── */
catRouter.get('/:id/numero/:numero/estado', authMiddleware, soloDueno, async (req, res) => {
  try {
    const catR = await pool.query(
      'SELECT id, tipo FROM categorias_globales WHERE id = $1', [req.params.id]
    );
    if (!catR.rows[0]) return res.status(404).json({ error: 'Categoría no encontrada' });
    const { tipo } = catR.rows[0];

    const result = await pool.query(
      `SELECT cga.serie, u.nombre AS vendedor_nombre, cga.vendedor_id
       FROM cat_global_asignaciones cga
       JOIN users u ON u.id = cga.vendedor_id
       WHERE cga.categoria_id = $1 AND cga.numero = $2
       ORDER BY cga.serie`,
      [req.params.id, req.params.numero]
    );

    const series = {};
    for (const row of result.rows) series[row.serie] = { nombre: row.vendedor_nombre, id: row.vendedor_id };

    const libre   = tipo === 'parcial' ? !series['A'] : (!series['A'] || !series['B']);
    const estado  = !series['A'] && !series['B'] ? 'libre'
                  : tipo === 'parcial'            ? 'ocupado'
                  : !series['A'] || !series['B']  ? 'semi_ocupado'
                  : 'ocupado';

    res.json({
      numero:  req.params.numero,
      tipo,
      estado,
      serie_a: series['A'] || null,
      serie_b: series['B'] || null,
      libre,
    });
  } catch (err) {
    console.error('GET /categorias-globales/:id/numero/:numero/estado:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

module.exports = {
  vendedoresRouter:         router,
  categoriasGlobalesRouter: catRouter,
};

