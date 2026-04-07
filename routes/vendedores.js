// ============================================================
//   RIFAS JORDYN — Rutas de Vendedores + Categorías Globales
//
//   FLUJO CORRECTO:
//   1. Los vendedores tienen números fijos en numeros_vendedor_global.
//      Estos números SÍ pueden repetirse entre vendedores (sin restricción global).
//   2. Al asignar un vendedor a una categoría, sus números se importan
//      automáticamente. NO se pide número en el body.
//   3. PARCIAL: cada número solo puede pertenecer a 1 vendedor en la categoría.
//      Si hay colisión en algún número → se reportan cuáles chocan.
//      Los números sin colisión SÍ se insertan; los colisionados NO.
//   4. SIMULTÁNEA: Serie A para el 1er vendedor con ese número, Serie B para el 2do.
//      Si A y B ya están ocupadas → ese número colisiona (no se inserta).
//      Los demás números sin colisión sí se insertan.
//
//   RUTAS:
//   /api/vendedores              → CRUD vendedores
//   /api/categorias-globales     → CRUD categorías + asignación de vendedores
//   /api/numeros                 → Asignación de números globales al vendedor
// ============================================================

const express = require('express');
const router  = express.Router();
const bcrypt  = require('bcryptjs');
const pool    = require('../config/db');
const { authMiddleware, soloDueno } = require('../middleware/auth');

/* ════════════════════════════════════════════════════════════
   RUTAS DE VENDEDORES  —  /api/vendedores
════════════════════════════════════════════════════════════ */

// GET /api/vendedores
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
        COUNT(DISTINCT v.id)::int              AS total_ventas,
        COALESCE(SUM(v.precio_venta), 0)       AS total_ingresos,
        COUNT(DISTINCT ng.numero)::int         AS numeros_count,
        COALESCE(
          JSON_AGG(ng.numero ORDER BY ng.numero)
          FILTER (WHERE ng.numero IS NOT NULL),
          '[]'
        ) AS numeros_asignados
      FROM users u
      LEFT JOIN ventas v                   ON v.vendedor_id = u.id
      LEFT JOIN numeros_vendedor_global ng  ON ng.vendedor_id = u.id
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
router.get('/:id', authMiddleware, soloDueno, async (req, res) => {
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
      vendedor:           userR.rows[0],
      numeros_asignados:  numerosR.rows.map(r => r.numero),
      rifas_participando: rifasR.rows,
      ventas_recientes:   ventasR.rows,
    });
  } catch (err) {
    console.error('GET /vendedores/:id:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// PUT /api/vendedores/:id
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
router.delete('/:id', authMiddleware, soloDueno, async (req, res) => {
  try {
    const ventas = await pool.query(
      'SELECT COUNT(*) FROM ventas WHERE vendedor_id = $1', [req.params.id]
    );
    if (parseInt(ventas.rows[0].count) > 0)
      return res.status(400).json({
        error: 'No se puede eliminar un vendedor con ventas registradas. Desactívalo en su lugar.'
      });
    await pool.query('DELETE FROM numeros_vendedor_global WHERE vendedor_id = $1', [req.params.id]);
    await pool.query('DELETE FROM numeros_vendedor        WHERE vendedor_id = $1', [req.params.id]);
    await pool.query('DELETE FROM users                   WHERE id = $1',          [req.params.id]);
    res.json({ message: 'Vendedor eliminado exitosamente' });
  } catch (err) {
    console.error('DELETE /vendedores/:id:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// GET /api/vendedores/:id/numeros-aleatorios
// Solo excluye los números que EL MISMO vendedor ya tiene (no los de otros)
router.get('/:id/numeros-aleatorios', authMiddleware, soloDueno, async (req, res) => {
  const { cantidad = 10, excluir = '' } = req.query;
  const excluirExtra = excluir ? excluir.split(',').map(n => n.trim()).filter(Boolean) : [];
  try {
    const propiosR = await pool.query(
      'SELECT numero FROM numeros_vendedor_global WHERE vendedor_id = $1',
      [req.params.id]
    );
    const excluirFinal = [...new Set([...propiosR.rows.map(r => r.numero), ...excluirExtra])];

    const result = await pool.query(
      `SELECT LPAD(gs::text, 3, '0') AS numero
       FROM generate_series(0, 999) gs
       ${excluirFinal.length > 0 ? `WHERE LPAD(gs::text, 3, '0') != ALL($2::char[])` : ''}
       ORDER BY RANDOM() LIMIT $1`,
      excluirFinal.length > 0 ? [parseInt(cantidad), excluirFinal] : [parseInt(cantidad)]
    );
    res.json({ numeros_sugeridos: result.rows.map(r => r.numero) });
  } catch (err) {
    console.error('GET numeros-aleatorios:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

/* ════════════════════════════════════════════════════════════
   RUTAS DE NÚMEROS GLOBALES  —  /api/numeros
   Cualquier vendedor puede tener cualquier número.
   Solo se bloquea si ESE MISMO VENDEDOR ya tiene ese número.
════════════════════════════════════════════════════════════ */
const numRouter = express.Router();

// POST /api/numeros/asignar
numRouter.post('/asignar', authMiddleware, soloDueno, async (req, res) => {
  const { vendedor_id, numeros } = req.body;
  if (!vendedor_id || !Array.isArray(numeros) || !numeros.length)
    return res.status(400).json({ error: 'vendedor_id y numeros[] son requeridos' });

  const invalidos = numeros.filter(n => !/^\d{3}$/.test(n));
  if (invalidos.length)
    return res.status(400).json({ error: `Números inválidos: ${invalidos.join(', ')}` });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Solo rechazar si el MISMO vendedor ya tiene ese número
    const yaDelVendedor = await client.query(
      `SELECT numero FROM numeros_vendedor_global
       WHERE vendedor_id = $1 AND numero = ANY($2::char[])`,
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
         VALUES ($1, $2) ON CONFLICT (vendedor_id, numero) DO NOTHING`,
        [vendedor_id, num]
      );
    }
    await client.query('COMMIT');
    res.status(201).json({ message: `${numeros.length} número(s) asignados` });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /numeros/asignar:', err);
    res.status(500).json({ error: 'Error del servidor' });
  } finally { client.release(); }
});

// DELETE /api/numeros/asignar
numRouter.delete('/asignar', authMiddleware, soloDueno, async (req, res) => {
  const { vendedor_id, numeros } = req.body;
  if (!vendedor_id || !Array.isArray(numeros) || !numeros.length)
    return res.status(400).json({ error: 'vendedor_id y numeros[] son requeridos' });

  try {
    const conVenta = await pool.query(
      `SELECT DISTINCT ng.numero
       FROM numeros_vendedor_global ng
       JOIN ventas v ON v.vendedor_id = ng.vendedor_id AND v.numero = ng.numero
       JOIN rifas r  ON r.id = v.rifa_id AND r.activa = true
       WHERE ng.vendedor_id = $1 AND ng.numero = ANY($2::char[])`,
      [vendedor_id, numeros]
    );
    if (conVenta.rows.length > 0)
      return res.status(400).json({
        error: `No se pueden quitar — tienen ventas activas: ${conVenta.rows.map(r => r.numero).join(', ')}`
      });

    await pool.query(
      'DELETE FROM numeros_vendedor_global WHERE vendedor_id = $1 AND numero = ANY($2::char[])',
      [vendedor_id, numeros]
    );
    res.json({ message: `${numeros.length} número(s) removidos` });
  } catch (err) {
    console.error('DELETE /numeros/asignar:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

/* ════════════════════════════════════════════════════════════
   RUTAS DE CATEGORÍAS GLOBALES  —  /api/categorias-globales
════════════════════════════════════════════════════════════ */
const catRouter = express.Router();

// GET /api/categorias-globales
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
        COUNT(cga.id)::int                                            AS total_numeros,
        COUNT(CASE WHEN cga.serie = 'A' THEN 1 END)::int             AS numeros_serie_a,
        COUNT(CASE WHEN cga.serie = 'B' THEN 1 END)::int             AS numeros_serie_b
      FROM categorias_globales cg
      LEFT JOIN cat_global_asignaciones cga ON cga.categoria_id = cg.id
      GROUP BY cg.id, cg.nombre, cg.tipo, cg.monto, cg.descripcion, cg.created_at
      ORDER BY cg.nombre
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('GET /categorias-globales:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// POST /api/categorias-globales
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
      total_vendedores: 0, total_numeros: 0, numeros_serie_a: 0, numeros_serie_b: 0
    });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Ya existe una categoría con ese nombre' });
    console.error('POST /categorias-globales:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// PUT /api/categorias-globales/:id  (tipo no se puede cambiar)
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
catRouter.delete('/:id', authMiddleware, soloDueno, async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM categorias_globales WHERE id = $1 RETURNING id', [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Categoría no encontrada' });
    res.json({ message: 'Categoría eliminada. Las asignaciones se removieron automáticamente.' });
  } catch (err) {
    console.error('DELETE /categorias-globales/:id:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

/* ──────────────────────────────────────────────────────────
   GET /api/categorias-globales/:id/vendedores
   Lista todas las asignaciones con vendedor + número + serie
────────────────────────────────────────────────────────── */
catRouter.get('/:id/vendedores', authMiddleware, soloDueno, async (req, res) => {
  try {
    const catR = await pool.query(
      'SELECT id, tipo FROM categorias_globales WHERE id = $1', [req.params.id]
    );
    if (!catR.rows[0]) return res.status(404).json({ error: 'Categoría no encontrada' });

    const result = await pool.query(
      `SELECT
         cga.id,
         cga.vendedor_id,
         u.nombre  AS vendedor_nombre,
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
    console.error('GET /categorias-globales/:id/vendedores:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

/* ──────────────────────────────────────────────────────────
   GET /api/categorias-globales/:id/preview/:vendedorId
   Previsualiza qué pasaría si se agrega este vendedor.
   Retorna: { libres, colisiones, puedeAgregar, tipo }
   El frontend usa esto para mostrar el resumen antes de confirmar.
────────────────────────────────────────────────────────── */
catRouter.get('/:id/preview/:vendedorId', authMiddleware, soloDueno, async (req, res) => {
  try {
    const catR = await pool.query(
      'SELECT id, tipo FROM categorias_globales WHERE id = $1', [req.params.id]
    );
    if (!catR.rows[0]) return res.status(404).json({ error: 'Categoría no encontrada' });
    const { tipo } = catR.rows[0];

    const vendR = await pool.query(
      'SELECT id, nombre FROM users WHERE id = $1 AND rol = $2', [req.params.vendedorId, 'vendedor']
    );
    if (!vendR.rows[0]) return res.status(404).json({ error: 'Vendedor no encontrado' });

    const numR = await pool.query(
      'SELECT numero FROM numeros_vendedor_global WHERE vendedor_id = $1 ORDER BY numero',
      [req.params.vendedorId]
    );
    const numerosVendedor = numR.rows.map(r => r.numero);

    if (!numerosVendedor.length)
      return res.json({
        tipo, libres: [], colisiones: [], puedeAgregar: false,
        sinNumeros: true, vendedor_nombre: vendR.rows[0].nombre
      });

    // Series ya usadas por este vendedor en la categoría
    const seriesR = await pool.query(
      `SELECT DISTINCT serie FROM cat_global_asignaciones
       WHERE categoria_id = $1 AND vendedor_id = $2`,
      [req.params.id, req.params.vendedorId]
    );
    const seriesYaUsadas = seriesR.rows.map(r => r.serie);

    // Ocupación actual de los números del vendedor en la categoría
    const ocupadosR = await pool.query(
      `SELECT cga.numero, cga.serie, u.nombre AS dueno_nombre
       FROM cat_global_asignaciones cga
       JOIN users u ON u.id = cga.vendedor_id
       WHERE cga.categoria_id = $1 AND cga.numero = ANY($2::char[])
       ORDER BY cga.numero, cga.serie`,
      [req.params.id, numerosVendedor]
    );
    const ocupadosMap = {};
    for (const row of ocupadosR.rows) {
      if (!ocupadosMap[row.numero]) ocupadosMap[row.numero] = {};
      ocupadosMap[row.numero][row.serie] = row.dueno_nombre;
    }

    const libres     = [];
    const colisiones = [];

    for (const num of numerosVendedor) {
      if (tipo === 'parcial') {
        const ocupA = ocupadosMap[num]?.['A'];
        if (ocupA) colisiones.push({ numero: num, dueno: ocupA });
        else       libres.push({ numero: num, serie: 'A' });
      } else {
        const ocupA = ocupadosMap[num]?.['A'];
        const ocupB = ocupadosMap[num]?.['B'];
        // Determinar serie destino
        if (!ocupA && !seriesYaUsadas.includes('A')) {
          libres.push({ numero: num, serie: 'A' });
        } else if (!ocupB && !seriesYaUsadas.includes('B')) {
          libres.push({ numero: num, serie: 'B' });
        } else if (!ocupA) {
          libres.push({ numero: num, serie: 'A' });
        } else if (!ocupB) {
          libres.push({ numero: num, serie: 'B' });
        } else {
          colisiones.push({
            numero: num,
            dueno: `${ocupA || '?'} (Serie A) / ${ocupB || '?'} (Serie B)`
          });
        }
      }
    }

    res.json({
      tipo,
      vendedor_nombre:  vendR.rows[0].nombre,
      total_numeros:    numerosVendedor.length,
      libres,
      colisiones,
      seriesYaUsadas,
      puedeAgregar:     libres.length > 0,
      yaEnAmbas:        seriesYaUsadas.includes('A') && seriesYaUsadas.includes('B'),
    });
  } catch (err) {
    console.error('GET /categorias-globales/:id/preview/:vendedorId:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

/* ──────────────────────────────────────────────────────────
   POST /api/categorias-globales/:id/vendedores
   Asigna un vendedor a la categoría con TODOS sus números
   automáticamente. Body: { vendedor_id }

   Respuesta:
   {
     message, vendedor_nombre,
     insertados:  [ { numero, serie } ],
     colisiones:  [ { numero, dueno } ],
   }
────────────────────────────────────────────────────────── */
catRouter.post('/:id/vendedores', authMiddleware, soloDueno, async (req, res) => {
  const { vendedor_id } = req.body;
  if (!vendedor_id) return res.status(400).json({ error: 'vendedor_id es requerido' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Categoría (con lock para concurrencia)
    const catR = await client.query(
      'SELECT id, tipo FROM categorias_globales WHERE id = $1 FOR UPDATE',
      [req.params.id]
    );
    if (!catR.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Categoría no encontrada' });
    }
    const { tipo } = catR.rows[0];

    // 2. Vendedor activo
    const vendR = await client.query(
      'SELECT id, nombre, activo FROM users WHERE id = $1 AND rol = $2',
      [vendedor_id, 'vendedor']
    );
    if (!vendR.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Vendedor no encontrado' });
    }
    if (!vendR.rows[0].activo) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'El vendedor está inactivo' });
    }
    const vendedorNombre = vendR.rows[0].nombre;

    // 3. Verificar si ya está en la categoría
    const seriesActualesR = await client.query(
      `SELECT DISTINCT serie FROM cat_global_asignaciones
       WHERE categoria_id = $1 AND vendedor_id = $2`,
      [req.params.id, vendedor_id]
    );
    const seriesActuales = seriesActualesR.rows.map(r => r.serie);

    if (tipo === 'parcial' && seriesActuales.includes('A')) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: `${vendedorNombre} ya está asignado en esta categoría (parcial).`
      });
    }
    if (tipo === 'simultanea' && seriesActuales.includes('A') && seriesActuales.includes('B')) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: `${vendedorNombre} ya ocupa Serie A y Serie B. No puede agregarse más en esta categoría.`
      });
    }

    // 4. Números del vendedor
    const numR = await client.query(
      'SELECT numero FROM numeros_vendedor_global WHERE vendedor_id = $1 ORDER BY numero',
      [vendedor_id]
    );
    const numerosVendedor = numR.rows.map(r => r.numero);

    if (!numerosVendedor.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: `${vendedorNombre} no tiene números asignados. Asígnale números desde la sección de vendedores primero.`
      });
    }

    // 5. Ocupación actual de los números del vendedor en la categoría
    const ocupadosR = await client.query(
      `SELECT cga.numero, cga.serie, u.nombre AS dueno_nombre
       FROM cat_global_asignaciones cga
       JOIN users u ON u.id = cga.vendedor_id
       WHERE cga.categoria_id = $1 AND cga.numero = ANY($2::char[])
       ORDER BY cga.numero, cga.serie`,
      [req.params.id, numerosVendedor]
    );
    const ocupadosMap = {};
    for (const row of ocupadosR.rows) {
      if (!ocupadosMap[row.numero]) ocupadosMap[row.numero] = {};
      ocupadosMap[row.numero][row.serie] = row.dueno_nombre;
    }

    // 6. Clasificar cada número
    const aInsertar  = []; // { numero, serie }
    const colisiones = []; // { numero, dueno }

    for (const num of numerosVendedor) {
      if (tipo === 'parcial') {
        const ocupA = ocupadosMap[num]?.['A'];
        if (ocupA) {
          colisiones.push({ numero: num, dueno: ocupA });
        } else {
          aInsertar.push({ numero: num, serie: 'A' });
        }
      } else {
        // Simultánea: asignar a la primera serie libre que el vendedor aún no use
        const ocupA = ocupadosMap[num]?.['A'];
        const ocupB = ocupadosMap[num]?.['B'];

        let serieTarget = null;
        if (!ocupA && !seriesActuales.includes('A')) {
          serieTarget = 'A';
        } else if (!ocupB && !seriesActuales.includes('B')) {
          serieTarget = 'B';
        } else if (!ocupA) {
          serieTarget = 'A';
        } else if (!ocupB) {
          serieTarget = 'B';
        }

        if (serieTarget) {
          aInsertar.push({ numero: num, serie: serieTarget });
        } else {
          colisiones.push({
            numero: num,
            dueno: `${ocupadosMap[num]?.['A'] || '?'} (Serie A) y ${ocupadosMap[num]?.['B'] || '?'} (Serie B)`
          });
        }
      }
    }

    // 7. Insertar
    let totalInsertados = 0;
    for (const { numero, serie } of aInsertar) {
      const r = await client.query(
        `INSERT INTO cat_global_asignaciones (categoria_id, vendedor_id, numero, serie)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (categoria_id, numero, serie) DO NOTHING
         RETURNING id`,
        [req.params.id, vendedor_id, numero, serie]
      );
      if (r.rows[0]) totalInsertados++;
    }

    await client.query('COMMIT');

    if (totalInsertados === 0 && colisiones.length > 0) {
      return res.status(409).json({
        error: `Todos los números de ${vendedorNombre} tienen conflictos en esta categoría.`,
        colisiones,
        insertados: [],
        vendedor_nombre: vendedorNombre,
      });
    }

    res.status(201).json({
      message: [
        totalInsertados > 0 ? `✅ ${totalInsertados} número(s) asignados a ${vendedorNombre}` : null,
        colisiones.length   ? `⚠️ ${colisiones.length} número(s) con conflicto no se asignaron` : null,
      ].filter(Boolean).join('. '),
      vendedor_nombre: vendedorNombre,
      insertados:  aInsertar.slice(0, totalInsertados), // los que realmente entraron
      colisiones,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /categorias-globales/:id/vendedores:', err);
    res.status(500).json({ error: 'Error del servidor' });
  } finally {
    client.release();
  }
});

/* ──────────────────────────────────────────────────────────
   DELETE /api/categorias-globales/:id/vendedores/:vendedorId
   Quita TODAS las asignaciones de un vendedor en la categoría
────────────────────────────────────────────────────────── */
catRouter.delete('/:id/vendedores/:vendedorId', authMiddleware, soloDueno, async (req, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM cat_global_asignaciones
       WHERE categoria_id = $1 AND vendedor_id = $2
       RETURNING numero, serie`,
      [req.params.id, req.params.vendedorId]
    );
    if (!result.rows.length)
      return res.status(404).json({ error: 'Este vendedor no está en la categoría' });
    res.json({
      message: `Vendedor removido. ${result.rows.length} número(s) eliminados de la categoría.`,
      removidos: result.rows,
    });
  } catch (err) {
    console.error('DELETE /categorias-globales/:id/vendedores/:vendedorId:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

/* ──────────────────────────────────────────────────────────
   DELETE /api/categorias-globales/:id/asignaciones/:asigId
   Quita un número puntual de la categoría
────────────────────────────────────────────────────────── */
catRouter.delete('/:id/asignaciones/:asigId', authMiddleware, soloDueno, async (req, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM cat_global_asignaciones
       WHERE id = $1 AND categoria_id = $2
       RETURNING numero, serie, vendedor_id`,
      [req.params.asigId, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Asignación no encontrada' });
    res.json({ message: 'Número removido', ...result.rows[0] });
  } catch (err) {
    console.error('DELETE /categorias-globales/:id/asignaciones/:asigId:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

module.exports = {
  vendedoresRouter:         router,
  categoriasGlobalesRouter: catRouter,
  numerosRouter:            numRouter,
};
