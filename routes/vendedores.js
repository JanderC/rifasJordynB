// ============================================================
//   RIFAS JORDYN — Rutas de Vendedores + Categorías Globales  (v4)
//
//   CAMBIO CLAVE v4 — Números duplicados en SIMULTÁNEAS:
//   ──────────────────────────────────────────────────────────
//   En categorías SIMULTÁNEAS un vendedor PUEDE tener el mismo
//   número DOS veces:
//     - 1ª entrada del número → se asigna en Serie A
//     - 2ª entrada del mismo número → se asigna en Serie B
//   Si ambas series ya están ocupadas (por otros vendedores),
//   muestra quién las tiene y no permite agregar.
//
//   Para soportar esto, la tabla cat_vendedor_numeros debe
//   permitir (categoria_id, vendedor_id, numero) duplicados
//   en categorías simultáneas. Se agrega una columna "slot"
//   que diferencia las dos entradas:
//
//   ALTER TABLE cat_vendedor_numeros
//     DROP CONSTRAINT cat_vendedor_numeros_categoria_id_vendedor_id_numero_key,
//     ADD COLUMN slot SMALLINT NOT NULL DEFAULT 1 CHECK (slot IN (1,2)),
//     ADD CONSTRAINT cat_vendedor_numeros_unique
//       UNIQUE (categoria_id, vendedor_id, numero, slot);
//
//   slot=1 → apunta a Serie A (o la única en parcial)
//   slot=2 → apunta a Serie B (solo en simultáneas)
//
//   cat_global_asignaciones NO cambia; su UNIQUE ya es
//   (categoria_id, numero, serie) que garantiza un dueño por serie.
// ============================================================

const express = require('express');
const router  = express.Router();
const bcrypt  = require('bcryptjs');
const pool    = require('../config/db');
const { authMiddleware, soloDueno } = require('../middleware/auth');

/* ══════════════════════════════════════════════════════════════
   HELPERS
══════════════════════════════════════════════════════════════ */

function generarCredenciales(nombre) {
  const base = nombre
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, '').trim()
    .split(/\s+/).join('_').slice(0, 20);
  const sufijo = Math.floor(1000 + Math.random() * 9000);
  return { usuario: `${base}_${sufijo}`, password: `${base}${sufijo}` };
}

/**
 * Devuelve { A: nombre|null, B: nombre|null } para una lista de números
 * en la categoría, excluyendo al vendedor indicado.
 */
async function getOcupacionMap(client, categoriaId, numeros, excluirVendedorId) {
  if (!numeros.length) return {};
  const r = await client.query(
    `SELECT cga.numero, cga.serie, u.nombre AS dueno_nombre
     FROM cat_global_asignaciones cga
     JOIN users u ON u.id = cga.vendedor_id
     WHERE cga.categoria_id = $1
       AND cga.numero        = ANY($2::char[])
       AND cga.vendedor_id  != $3
     ORDER BY cga.numero, cga.serie`,
    [categoriaId, numeros, excluirVendedorId]
  );
  const map = {};
  for (const row of r.rows) {
    if (!map[row.numero]) map[row.numero] = { A: null, B: null };
    map[row.numero][row.serie] = row.dueno_nombre;
  }
  return map;
}

/**
 * Ejecuta asignación de series para los slots pendientes del vendedor.
 * Un "slot" = una fila en cat_vendedor_numeros.
 * slot=1 intenta Serie A, slot=2 intenta Serie B directamente.
 * En parcial solo existe slot=1 y solo usa Serie A.
 */
async function asignarSeriesParaVendedor(client, categoriaId, vendedorId, tipo) {
  // Todos los slots del vendedor en el pool
  const poolR = await client.query(
    `SELECT id AS slot_id, numero, slot FROM cat_vendedor_numeros
     WHERE categoria_id = $1 AND vendedor_id = $2
     ORDER BY numero, slot`,
    [categoriaId, vendedorId]
  );
  if (!poolR.rows.length) return { insertados: [], colisiones: [], infoAdicional: [] };

  // Slots que YA tienen asignación de serie
  const asigR = await client.query(
    `SELECT numero, serie FROM cat_global_asignaciones
     WHERE categoria_id = $1 AND vendedor_id = $2`,
    [categoriaId, vendedorId]
  );
  // Cuántas asignaciones tiene el vendedor por número: { '123': ['A','B'] }
  const propiosMap = {};
  for (const row of asigR.rows) {
    if (!propiosMap[row.numero]) propiosMap[row.numero] = [];
    propiosMap[row.numero].push(row.serie);
  }

  // Para simultáneas, un vendedor puede tener serie A Y serie B del mismo número.
  // Un slot está "pendiente" si el vendedor no tiene aún esa serie asignada.
  // slot=1 → quiere Serie A, slot=2 → quiere Serie B
  const pendientes = poolR.rows.filter(row => {
    const serieDeseada = tipo === 'parcial' ? 'A' : (row.slot === 1 ? 'A' : 'B');
    return !(propiosMap[row.numero] || []).includes(serieDeseada);
  });

  if (!pendientes.length) return { insertados: [], colisiones: [], infoAdicional: [] };

  const todosNumeros = [...new Set(pendientes.map(r => r.numero))];
  const ocupadosMap  = await getOcupacionMap(client, categoriaId, todosNumeros, vendedorId);

  const aInsertar    = [];
  const colisiones   = [];
  const infoAdicional = [];

  for (const row of pendientes) {
    const num  = row.numero;
    const ocupA = ocupadosMap[num]?.A || null;
    const ocupB = ocupadosMap[num]?.B || null;

    if (tipo === 'parcial') {
      // Solo Serie A
      if (!ocupA) aInsertar.push({ numero: num, serie: 'A' });
      else        colisiones.push({ numero: num, dueno_a: ocupA, dueno_b: null });

    } else {
      // SIMULTÁNEA: slot=1 quiere A, slot=2 quiere B
      if (row.slot === 1) {
        if (!ocupA) {
          aInsertar.push({ numero: num, serie: 'A' });
        } else {
          // A ocupada por otro → informar pero NO redirigir automáticamente a B;
          // el vendedor tiene (o tendrá) el slot=2 para la Serie B.
          colisiones.push({ numero: num, slot: 1, dueno_a: ocupA, dueno_b: null,
            mensaje: `Serie A ocupada por ${ocupA}` });
        }
      } else {
        // slot=2 → quiere Serie B
        if (!ocupB) {
          aInsertar.push({ numero: num, serie: 'B' });
        } else {
          colisiones.push({ numero: num, slot: 2, dueno_a: ocupA, dueno_b: ocupB,
            mensaje: `Serie B ocupada por ${ocupB}` });
        }
      }
    }
  }

  let totalInsertados = 0;
  const insertados = [];
  for (const { numero, serie } of aInsertar) {
    const r = await client.query(
      `INSERT INTO cat_global_asignaciones (categoria_id, vendedor_id, numero, serie)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (categoria_id, numero, serie) DO NOTHING
       RETURNING id, numero, serie`,
      [categoriaId, vendedorId, numero, serie]
    );
    if (r.rows[0]) { insertados.push(r.rows[0]); totalInsertados++; }
  }

  return { insertados, colisiones, infoAdicional };
}

/* ══════════════════════════════════════════════════════════════
   RUTAS DE VENDEDORES  —  /api/vendedores
══════════════════════════════════════════════════════════════ */

router.get('/', authMiddleware, soloDueno, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        u.id, u.nombre, u.usuario, u.cedula, u.rol, u.activo, u.created_at,
        COUNT(DISTINCT v.id)::int              AS total_ventas,
        COALESCE(SUM(v.precio_venta), 0)       AS total_ingresos,
        COUNT(DISTINCT cvn.numero || '-' || cvn.categoria_id::text)::int AS numeros_count,
        COUNT(DISTINCT cvn.categoria_id)::int  AS categorias_count
      FROM users u
      LEFT JOIN ventas v              ON v.vendedor_id = u.id
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

router.get('/:id', authMiddleware, soloDueno, async (req, res) => {
  try {
    const [userR, numerosR, rifasR, ventasR] = await Promise.all([
      pool.query('SELECT id, nombre, usuario, cedula, rol, activo, created_at FROM users WHERE id = $1', [req.params.id]),
      pool.query(
        `SELECT cvn.categoria_id, cg.nombre AS categoria_nombre, cg.tipo AS categoria_tipo,
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
         LEFT JOIN ventas v ON v.rifa_id = nv.rifa_id AND v.numero = nv.numero AND v.vendedor_id = nv.vendedor_id
         WHERE nv.vendedor_id = $1
         GROUP BY nv.rifa_id, r.nombre, r.activa ORDER BY r.activa DESC, nv.rifa_id DESC`,
        [req.params.id]
      ),
      pool.query(
        `SELECT v.*, r.nombre AS rifa_nombre FROM ventas v JOIN rifas r ON r.id = v.rifa_id
         WHERE v.vendedor_id = $1 ORDER BY v.created_at DESC LIMIT 20`,
        [req.params.id]
      ),
    ]);
    if (!userR.rows[0]) return res.status(404).json({ error: 'Vendedor no encontrado' });
    res.json({ vendedor: userR.rows[0], numeros_por_cat: numerosR.rows, rifas_participando: rifasR.rows, ventas_recientes: ventasR.rows });
  } catch (err) {
    console.error('GET /vendedores/:id:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

router.put('/:id', authMiddleware, soloDueno, async (req, res) => {
  const { nombre, password, activo, cedula } = req.body;
  try {
    const fields = []; const params = []; let i = 1;
    if (nombre)                      { fields.push(`nombre = $${i++}`); params.push(nombre); }
    if (typeof activo === 'boolean')  { fields.push(`activo = $${i++}`); params.push(activo); }
    if (cedula !== undefined)         { fields.push(`cedula = $${i++}`); params.push(cedula || null); }
    if (password) {
      if (password.length < 6) return res.status(400).json({ error: 'Contraseña mínimo 6 caracteres' });
      fields.push(`password = $${i++}`); params.push(await bcrypt.hash(password, 10));
    }
    if (!fields.length) return res.status(400).json({ error: 'Nada que actualizar' });
    params.push(req.params.id);
    const result = await pool.query(
      `UPDATE users SET ${fields.join(', ')} WHERE id = $${i} RETURNING id, nombre, usuario, cedula, rol, activo`, params
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Vendedor no encontrado' });
    res.json({ message: 'Vendedor actualizado', vendedor: result.rows[0] });
  } catch (err) {
    console.error('PUT /vendedores/:id:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

router.delete('/:id', authMiddleware, soloDueno, async (req, res) => {
  try {
    const ventas = await pool.query('SELECT COUNT(*) FROM ventas WHERE vendedor_id = $1', [req.params.id]);
    if (parseInt(ventas.rows[0].count) > 0)
      return res.status(400).json({ error: 'No se puede eliminar un vendedor con ventas registradas. Desactívalo en su lugar.' });
    await pool.query('DELETE FROM numeros_vendedor WHERE vendedor_id = $1', [req.params.id]);
    await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
    res.json({ message: 'Vendedor eliminado exitosamente' });
  } catch (err) {
    console.error('DELETE /vendedores/:id:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

/* ══════════════════════════════════════════════════════════════
   RUTAS DE CATEGORÍAS GLOBALES  —  /api/categorias-globales
══════════════════════════════════════════════════════════════ */
const catRouter = express.Router();

catRouter.get('/', authMiddleware, soloDueno, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT cg.id, cg.nombre, cg.tipo, cg.monto, cg.descripcion, cg.created_at,
        COUNT(DISTINCT cga.vendedor_id)::int                      AS total_vendedores,
        COUNT(DISTINCT cga.id)::int                               AS total_asignaciones,
        COUNT(CASE WHEN cga.serie = 'A' THEN 1 END)::int         AS numeros_serie_a,
        COUNT(CASE WHEN cga.serie = 'B' THEN 1 END)::int         AS numeros_serie_b,
        COUNT(DISTINCT cvn.numero)::int                           AS total_numeros_definidos
      FROM categorias_globales cg
      LEFT JOIN cat_global_asignaciones cga ON cga.categoria_id = cg.id
      LEFT JOIN cat_vendedor_numeros    cvn ON cvn.categoria_id = cg.id
      GROUP BY cg.id, cg.nombre, cg.tipo, cg.monto, cg.descripcion, cg.created_at
      ORDER BY cg.nombre
    `);
    res.json(result.rows);
  } catch (err) { console.error('GET /categorias-globales:', err); res.status(500).json({ error: 'Error del servidor' }); }
});

catRouter.post('/', authMiddleware, soloDueno, async (req, res) => {
  const { nombre, tipo = 'parcial', monto, descripcion } = req.body;
  if (!nombre?.trim()) return res.status(400).json({ error: 'El nombre es requerido' });
  if (!['parcial', 'simultanea'].includes(tipo)) return res.status(400).json({ error: 'Tipo inválido' });
  try {
    const result = await pool.query(
      `INSERT INTO categorias_globales (nombre, tipo, monto, descripcion, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, nombre, tipo, monto, descripcion, created_at`,
      [nombre.trim(), tipo, monto || null, descripcion || null, req.user?.id || null]
    );
    res.status(201).json({ ...result.rows[0], total_vendedores: 0, total_asignaciones: 0, numeros_serie_a: 0, numeros_serie_b: 0, total_numeros_definidos: 0 });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Ya existe una categoría con ese nombre' });
    console.error('POST /categorias-globales:', err); res.status(500).json({ error: 'Error del servidor' });
  }
});

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
      `UPDATE categorias_globales SET ${fields.join(', ')}, updated_at = now() WHERE id = $${i} RETURNING id, nombre, tipo, monto, descripcion`, params
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Categoría no encontrada' });
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Ya existe una categoría con ese nombre' });
    console.error('PUT /categorias-globales/:id:', err); res.status(500).json({ error: 'Error del servidor' });
  }
});

catRouter.delete('/:id', authMiddleware, soloDueno, async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM categorias_globales WHERE id = $1 RETURNING id', [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Categoría no encontrada' });
    res.json({ message: 'Categoría eliminada.' });
  } catch (err) { console.error('DELETE /categorias-globales/:id:', err); res.status(500).json({ error: 'Error del servidor' }); }
});

/* ──────────────────────────────────────────────────────────────────
   GET /api/categorias-globales/:id/vendedores-resumen
──────────────────────────────────────────────────────────────────*/
catRouter.get('/:id/vendedores-resumen', authMiddleware, soloDueno, async (req, res) => {
  try {
    const catR = await pool.query('SELECT id, tipo FROM categorias_globales WHERE id = $1', [req.params.id]);
    if (!catR.rows[0]) return res.status(404).json({ error: 'Categoría no encontrada' });
    const { tipo } = catR.rows[0];

    // Para simultáneas, agrupamos por (vendedor, numero) y contamos cuántos slots tiene
    // para saber si tiene A, B o ambas.
    const result = await pool.query(
      `SELECT
         cvn.vendedor_id,
         u.nombre  AS vendedor_nombre,
         u.cedula,
         COUNT(cvn.id)::int                                        AS total_slots,
         COUNT(DISTINCT cvn.numero)::int                           AS total_numeros_unicos,
         COUNT(cga.id)::int                                        AS total_asignados,
         COUNT(CASE WHEN cga.serie = 'A' THEN 1 END)::int         AS serie_a,
         COUNT(CASE WHEN cga.serie = 'B' THEN 1 END)::int         AS serie_b,
         JSON_AGG(
           JSON_BUILD_OBJECT(
             'numero',        cvn.numero,
             'slot',          cvn.slot,
             'serie',         cga.serie,
             'asignacion_id', cga.id
           ) ORDER BY cvn.numero, cvn.slot
         ) AS numeros
       FROM cat_vendedor_numeros cvn
       JOIN users u ON u.id = cvn.vendedor_id
       LEFT JOIN cat_global_asignaciones cga
         ON  cga.categoria_id = cvn.categoria_id
         AND cga.vendedor_id  = cvn.vendedor_id
         AND cga.numero       = cvn.numero
         AND (
           -- slot=1 mapea a serie A, slot=2 mapea a serie B
           (cvn.slot = 1 AND cga.serie = 'A') OR
           (cvn.slot = 2 AND cga.serie = 'B')
         )
       WHERE cvn.categoria_id = $1
       GROUP BY cvn.vendedor_id, u.nombre, u.cedula
       ORDER BY u.nombre`,
      [req.params.id]
    );
    res.json({ tipo, vendedores: result.rows });
  } catch (err) { console.error('vendedores-resumen:', err); res.status(500).json({ error: 'Error del servidor' }); }
});

/* ──────────────────────────────────────────────────────────────────
   GET /api/categorias-globales/:id/validar-numero
   ?numero=012&vendedor_id=5
   
   Para SIMULTÁNEAS ahora distingue:
   - El vendedor no tiene ningún slot de ese número → puede agregar slot=1 (→ Serie A)
   - El vendedor ya tiene slot=1 (tiene la Serie A) → puede agregar slot=2 (→ Serie B)
     SOLO si Serie B no está ocupada por OTRO vendedor
   - El vendedor ya tiene slot=1 y slot=2 → ya tiene ambas series, no puede agregar más
   - Serie A de ese número la tiene OTRO → slot=1 va a colisión;
     pero puede agregar slot=2 si Serie B está libre
──────────────────────────────────────────────────────────────────*/
catRouter.get('/:id/validar-numero', authMiddleware, soloDueno, async (req, res) => {
  const { numero, vendedor_id } = req.query;
  if (!numero || !/^\d{3}$/.test(numero))
    return res.status(400).json({ error: 'numero debe ser 3 dígitos (000-999)' });
  if (!vendedor_id)
    return res.status(400).json({ error: 'vendedor_id es requerido' });

  try {
    const catR = await pool.query('SELECT id, tipo FROM categorias_globales WHERE id = $1', [req.params.id]);
    if (!catR.rows[0]) return res.status(404).json({ error: 'Categoría no encontrada' });
    const { tipo } = catR.rows[0];

    // Slots que el vendedor ya tiene para este número
    const slotsR = await pool.query(
      `SELECT slot, cga.serie AS serie_asignada
       FROM cat_vendedor_numeros cvn
       LEFT JOIN cat_global_asignaciones cga
         ON cga.categoria_id = cvn.categoria_id
         AND cga.vendedor_id = cvn.vendedor_id
         AND cga.numero      = cvn.numero
         AND ((cvn.slot = 1 AND cga.serie = 'A') OR (cvn.slot = 2 AND cga.serie = 'B'))
       WHERE cvn.categoria_id = $1 AND cvn.vendedor_id = $2 AND cvn.numero = $3
       ORDER BY cvn.slot`,
      [req.params.id, vendedor_id, numero]
    );
    const slotsVendedor = slotsR.rows; // [{ slot:1, serie_asignada:'A'|null }, ...]
    const tieneSlot1 = slotsVendedor.some(s => s.slot === 1);
    const tieneSlot2 = slotsVendedor.some(s => s.slot === 2);

    // Ocupación del número por OTROS vendedores
    const ocupR = await pool.query(
      `SELECT cga.serie, u.nombre AS dueno_nombre
       FROM cat_global_asignaciones cga
       JOIN users u ON u.id = cga.vendedor_id
       WHERE cga.categoria_id = $1 AND cga.numero = $2 AND cga.vendedor_id != $3
       ORDER BY cga.serie`,
      [req.params.id, numero, vendedor_id]
    );
    const serieAOtro = ocupR.rows.find(r => r.serie === 'A')?.dueno_nombre || null;
    const serieBOtro = ocupR.rows.find(r => r.serie === 'B')?.dueno_nombre || null;

    if (tipo === 'parcial') {
      // PARCIAL: solo un slot, solo Serie A
      if (tieneSlot1) {
        const asig = slotsVendedor[0]?.serie_asignada;
        return res.json({
          numero, tipo,
          disponible:    false,
          ya_en_pool:    true,
          ya_asignado:   !!asig,
          serie_destino: asig || null,
          serie_a:       { libre: !serieAOtro, dueno: serieAOtro },
          mensaje:       asig
            ? `Este número ya está asignado al vendedor en Serie A`
            : 'Este número ya está en el pool del vendedor (sin serie aún)',
        });
      }
      if (serieAOtro) {
        return res.json({
          numero, tipo, disponible: false, ya_en_pool: false, ya_asignado: false,
          serie_destino: null,
          serie_a: { libre: false, dueno: serieAOtro },
          mensaje: `Número ocupado por ${serieAOtro} (Serie A). No disponible en categoría parcial.`,
        });
      }
      return res.json({
        numero, tipo, disponible: true, ya_en_pool: false, ya_asignado: false,
        serie_destino: 'A',
        serie_a: { libre: true, dueno: null },
        mensaje: 'Número libre. Se asignará en Serie A.',
      });
    }

    // ── SIMULTÁNEA ────────────────────────────────────────────────
    // Determinar qué slot puede agregar el vendedor ahora
    if (!tieneSlot1) {
      // No tiene ningún slot → puede agregar slot=1 → Serie A
      // (si A está ocupada por otro, igual lo agrega; al asignar se mostrará la colisión)
      if (serieAOtro) {
        // Serie A de otro → avisamos, pero el vendedor AÚN puede agregar para luego ir a B
        // si también quiere B, podrá agregar el número dos veces
        return res.json({
          numero, tipo, disponible: true, ya_en_pool: false, ya_asignado: false,
          serie_destino: 'B_via_colision',   // señal especial al frontend
          serie_a: { libre: false, dueno: serieAOtro },
          serie_b: { libre: !serieBOtro, dueno: serieBOtro },
          slot_a_agregar: 1,
          mensaje: serieBOtro
            ? `Serie A → ${serieAOtro} / Serie B → ${serieBOtro}. Ambas ocupadas por otros.`
            : `Serie A ocupada por ${serieAOtro}. Se intentará Serie B al asignar.`,
          sin_espacio: !!serieBOtro,
        });
      }
      return res.json({
        numero, tipo, disponible: true, ya_en_pool: false, ya_asignado: false,
        serie_destino: 'A',
        serie_a: { libre: true, dueno: null },
        serie_b: { libre: !serieBOtro, dueno: serieBOtro },
        slot_a_agregar: 1,
        mensaje: 'Serie A libre. Se asignará en Serie A.',
      });
    }

    if (tieneSlot1 && !tieneSlot2) {
      // Ya tiene slot=1 (para Serie A). Puede agregar slot=2 para Serie B
      if (serieBOtro) {
        return res.json({
          numero, tipo, disponible: false, ya_en_pool: true, ya_asignado: false,
          serie_destino: null,
          serie_a: { libre: false, dueno: serieAOtro },
          serie_b: { libre: false, dueno: serieBOtro },
          slot_a_agregar: null,
          mensaje: `Serie B ocupada por ${serieBOtro}. No puedes agregar el número por segunda vez.`,
        });
      }
      return res.json({
        numero, tipo, disponible: true, ya_en_pool: true, ya_asignado: false,
        serie_destino: 'B',
        serie_a: { libre: !serieAOtro, dueno: serieAOtro },
        serie_b: { libre: true, dueno: null },
        slot_a_agregar: 2,
        mensaje: 'Ya tienes este número (Serie A). Puedes agregarlo de nuevo para obtener la Serie B.',
      });
    }

    // Ya tiene slot=1 y slot=2 → tiene ambas series
    return res.json({
      numero, tipo, disponible: false, ya_en_pool: true, ya_asignado: true,
      serie_destino: null,
      serie_a: { libre: false, dueno: 'este vendedor' },
      serie_b: { libre: false, dueno: 'este vendedor' },
      slot_a_agregar: null,
      mensaje: 'Ya tienes este número en Serie A y Serie B. No puedes agregarlo más.',
    });
  } catch (err) {
    console.error('GET /validar-numero:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

/* ──────────────────────────────────────────────────────────────────
   POST /api/categorias-globales/:id/vendedores/:vendedorId/numeros
   Body: { numeros: ['001','001','050'] }  ← puede venir el mismo número dos veces
   
   Lógica de slots:
   - Para PARCIAL: UNIQUE (categoria_id, vendedor_id, numero, slot=1). No duplicados.
   - Para SIMULTÁNEA: acepta hasta 2 entradas del mismo número (slot=1 y slot=2).
     Si viene el número 3 veces o más, las extras se ignoran.
──────────────────────────────────────────────────────────────────*/
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

    const catR = await client.query('SELECT id, tipo FROM categorias_globales WHERE id = $1', [req.params.id]);
    if (!catR.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Categoría no encontrada' }); }
    const { tipo } = catR.rows[0];

    const vendR = await client.query('SELECT id, nombre, activo FROM users WHERE id = $1 AND rol = $2', [req.params.vendedorId, 'vendedor']);
    if (!vendR.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Vendedor no encontrado' }); }
    if (!vendR.rows[0].activo) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'El vendedor está inactivo' }); }

    // Slots ya existentes para este vendedor en esta categoría
    const existentesR = await client.query(
      `SELECT numero, slot FROM cat_vendedor_numeros
       WHERE categoria_id = $1 AND vendedor_id = $2`,
      [req.params.id, req.params.vendedorId]
    );
    // Mapa: { '001': [1], '123': [1,2] }
    const slotsExistentes = {};
    for (const row of existentesR.rows) {
      if (!slotsExistentes[row.numero]) slotsExistentes[row.numero] = [];
      slotsExistentes[row.numero].push(row.slot);
    }

    // Contar cuántas veces viene cada número en el request
    const conteoRequest = {};
    for (const num of numeros) {
      conteoRequest[num] = (conteoRequest[num] || 0) + 1;
    }

    let insertados = 0;
    const yaExistian = [];
    const infoSeries = [];
    const sinEspacio = [];

    // Ocupación global de los números pedidos
    const numerosUnicos = Object.keys(conteoRequest);
    const ocupR = await client.query(
      `SELECT cga.numero, cga.serie, u.nombre AS dueno_nombre
       FROM cat_global_asignaciones cga
       JOIN users u ON u.id = cga.vendedor_id
       WHERE cga.categoria_id = $1 AND cga.numero = ANY($2::char[]) AND cga.vendedor_id != $3`,
      [req.params.id, numerosUnicos, req.params.vendedorId]
    );
    const ocupMap = {};
    for (const row of ocupR.rows) {
      if (!ocupMap[row.numero]) ocupMap[row.numero] = { A: null, B: null };
      ocupMap[row.numero][row.serie] = row.dueno_nombre;
    }

    for (const [num, veces] of Object.entries(conteoRequest)) {
      const slotsActuales = slotsExistentes[num] || [];
      const ocupA = ocupMap[num]?.A || null;
      const ocupB = ocupMap[num]?.B || null;

      // Determinar qué slots necesitamos insertar
      // veces=1 → solo slot=1 (o slot=2 si ya tiene slot=1)
      // veces=2 → slot=1 y slot=2
      const slotsDeseados = tipo === 'parcial'
        ? [1]
        : veces >= 2 ? [1, 2] : [Math.max(1, ...slotsActuales, 0) === 1 && slotsActuales.includes(1) ? 2 : 1];

      for (const slot of slotsDeseados) {
        if (slotsActuales.includes(slot)) {
          yaExistian.push({ numero: num, slot });
          continue;
        }
        if (tipo === 'parcial' && slot > 1) continue; // parcial solo slot=1

        // Para simultáneas: verificar que la serie destino no esté ocupada por OTRO
        const serieDestino = slot === 1 ? 'A' : 'B';
        const ocupadoPorOtro = slot === 1 ? ocupA : ocupB;

        if (tipo === 'simultanea' && slotsDeseados.length === 1) {
          // El usuario pidió el número solo 1 vez — elegir el slot correcto automáticamente
          // Si viene 1 vez y no tiene ningún slot: slot=1
          // Si viene 1 vez y ya tiene slot=1: slot=2
          // (slotsDeseados ya está calculado correctamente arriba)
        }

        await client.query(
          `INSERT INTO cat_vendedor_numeros (categoria_id, vendedor_id, numero, slot)
           VALUES ($1, $2, $3, $4)`,
          [req.params.id, req.params.vendedorId, num, slot]
        );
        insertados++;

        // Calcular info_series
        const serieInfo = {
          numero:       num,
          slot,
          disponible:   !ocupadoPorOtro,
          serie_destino: ocupadoPorOtro && tipo === 'simultanea' && slot === 1 && !ocupB ? 'B' : serieDestino,
          serie_a: { libre: !ocupA, dueno: ocupA },
          ...(tipo === 'simultanea' ? { serie_b: { libre: !ocupB, dueno: ocupB } } : {}),
          mensaje: !ocupadoPorOtro
            ? `Serie ${serieDestino} libre`
            : tipo === 'simultanea' && slot === 1 && !ocupB
              ? `Serie A → ${ocupA}; irá a Serie B al asignar`
              : `Serie ocupada por ${ocupadoPorOtro}`,
        };
        infoSeries.push(serieInfo);
      }
    }

    await client.query('COMMIT');
    res.status(201).json({
      message:     `${insertados} entrada(s) agregadas al pool de ${vendR.rows[0].nombre}.`,
      insertados,
      ya_existian: yaExistian,
      info_series: infoSeries,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error: 'Ese número ya está en el pool con ese slot' });
    console.error('POST numeros:', err); res.status(500).json({ error: 'Error del servidor' });
  } finally { client.release(); }
});

/* ──────────────────────────────────────────────────────────────────
   DELETE /api/categorias-globales/:id/vendedores/:vendedorId/numeros
   Body: { numeros: ['001'], slot?: 1 }
   Si slot no se indica, elimina TODOS los slots de ese número.
──────────────────────────────────────────────────────────────────*/
catRouter.delete('/:id/vendedores/:vendedorId/numeros', authMiddleware, soloDueno, async (req, res) => {
  const { numeros, slot } = req.body;
  if (!Array.isArray(numeros) || !numeros.length)
    return res.status(400).json({ error: 'numeros[] es requerido' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Determinar las series a eliminar según el slot
    if (slot) {
      const serieAEliminar = slot === 1 ? 'A' : 'B';
      await client.query(
        `DELETE FROM cat_global_asignaciones
         WHERE categoria_id = $1 AND vendedor_id = $2 AND numero = ANY($3::char[]) AND serie = $4`,
        [req.params.id, req.params.vendedorId, numeros, serieAEliminar]
      );
      await client.query(
        `DELETE FROM cat_vendedor_numeros
         WHERE categoria_id = $1 AND vendedor_id = $2 AND numero = ANY($3::char[]) AND slot = $4`,
        [req.params.id, req.params.vendedorId, numeros, slot]
      );
    } else {
      // Eliminar todos los slots y asignaciones del número
      await client.query(
        `DELETE FROM cat_global_asignaciones
         WHERE categoria_id = $1 AND vendedor_id = $2 AND numero = ANY($3::char[])`,
        [req.params.id, req.params.vendedorId, numeros]
      );
      await client.query(
        `DELETE FROM cat_vendedor_numeros
         WHERE categoria_id = $1 AND vendedor_id = $2 AND numero = ANY($3::char[])`,
        [req.params.id, req.params.vendedorId, numeros]
      );
    }

    await client.query('COMMIT');
    res.json({ message: `Número(s) eliminados del pool.`, removidos: numeros });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('DELETE numeros:', err); res.status(500).json({ error: 'Error del servidor' });
  } finally { client.release(); }
});

/* ──────────────────────────────────────────────────────────────────
   POST /api/categorias-globales/:id/vendedores/:vendedorId/asignar
──────────────────────────────────────────────────────────────────*/
catRouter.post('/:id/vendedores/:vendedorId/asignar', authMiddleware, soloDueno, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const catR = await client.query('SELECT id, tipo FROM categorias_globales WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!catR.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Categoría no encontrada' }); }
    const { tipo } = catR.rows[0];

    const vendR = await client.query('SELECT id, nombre, activo FROM users WHERE id = $1 AND rol = $2', [req.params.vendedorId, 'vendedor']);
    if (!vendR.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Vendedor no encontrado' }); }
    if (!vendR.rows[0].activo) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'El vendedor está inactivo' }); }
    const vendedorNombre = vendR.rows[0].nombre;

    const poolCheckR = await client.query(
      `SELECT COUNT(*) FROM cat_vendedor_numeros WHERE categoria_id = $1 AND vendedor_id = $2`,
      [req.params.id, req.params.vendedorId]
    );
    if (parseInt(poolCheckR.rows[0].count) === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `${vendedorNombre} no tiene números en esta categoría.` });
    }

    const { insertados, colisiones, infoAdicional } =
      await asignarSeriesParaVendedor(client, req.params.id, req.params.vendedorId, tipo);

    if (!insertados.length && !colisiones.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Todos los números de ${vendedorNombre} ya están asignados.` });
    }

    await client.query('COMMIT');

    if (insertados.length === 0 && colisiones.length > 0) {
      return res.status(409).json({
        error: `Todos los números de ${vendedorNombre} tienen conflictos.`,
        insertados: [], colisiones, info_adicional: [], vendedor_nombre: vendedorNombre,
      });
    }

    const mensajes = [];
    if (insertados.length) mensajes.push(`✅ ${insertados.length} número(s) asignados`);
    if (colisiones.length) mensajes.push(`⚠️ ${colisiones.length} conflicto(s) — serie ocupada por otro vendedor`);

    res.status(201).json({
      message: mensajes.join('. '),
      vendedor_nombre: vendedorNombre,
      insertados, colisiones, info_adicional: infoAdicional,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST asignar:', err); res.status(500).json({ error: 'Error del servidor' });
  } finally { client.release(); }
});

/* ──────────────────────────────────────────────────────────────────
   GET /api/categorias-globales/:id/preview/:vendedorId
──────────────────────────────────────────────────────────────────*/
catRouter.get('/:id/preview/:vendedorId', authMiddleware, soloDueno, async (req, res) => {
  try {
    const catR = await pool.query('SELECT id, tipo FROM categorias_globales WHERE id = $1', [req.params.id]);
    if (!catR.rows[0]) return res.status(404).json({ error: 'Categoría no encontrada' });
    const { tipo } = catR.rows[0];

    const vendR = await pool.query('SELECT id, nombre FROM users WHERE id = $1 AND rol = $2', [req.params.vendedorId, 'vendedor']);
    if (!vendR.rows[0]) return res.status(404).json({ error: 'Vendedor no encontrado' });

    const poolR = await pool.query(
      `SELECT numero, slot FROM cat_vendedor_numeros
       WHERE categoria_id = $1 AND vendedor_id = $2 ORDER BY numero, slot`,
      [req.params.id, req.params.vendedorId]
    );
    if (!poolR.rows.length)
      return res.json({ tipo, libres: [], colisiones: [], info_adicional: [], puedeAgregar: false, sinNumeros: true, vendedor_nombre: vendR.rows[0].nombre });

    // Ya asignados propios
    const propiosR = await pool.query(
      `SELECT numero, serie FROM cat_global_asignaciones WHERE categoria_id = $1 AND vendedor_id = $2`,
      [req.params.id, req.params.vendedorId]
    );
    const propiosMap = {};
    for (const row of propiosR.rows) {
      if (!propiosMap[row.numero]) propiosMap[row.numero] = [];
      propiosMap[row.numero].push(row.serie);
    }

    const pendientes = poolR.rows.filter(row => {
      const serieDeseada = tipo === 'parcial' ? 'A' : (row.slot === 1 ? 'A' : 'B');
      return !(propiosMap[row.numero] || []).includes(serieDeseada);
    });

    if (!pendientes.length)
      return res.json({ tipo, libres: [], colisiones: [], info_adicional: [], puedeAgregar: false, todoAsignado: true, vendedor_nombre: vendR.rows[0].nombre });

    const todosNumeros = [...new Set(pendientes.map(r => r.numero))];
    const ocupR = await pool.query(
      `SELECT cga.numero, cga.serie, u.nombre AS dueno_nombre
       FROM cat_global_asignaciones cga JOIN users u ON u.id = cga.vendedor_id
       WHERE cga.categoria_id = $1 AND cga.numero = ANY($2::char[]) AND cga.vendedor_id != $3`,
      [req.params.id, todosNumeros, req.params.vendedorId]
    );
    const ocupMap = {};
    for (const row of ocupR.rows) {
      if (!ocupMap[row.numero]) ocupMap[row.numero] = {};
      ocupMap[row.numero][row.serie] = row.dueno_nombre;
    }

    const libres = []; const colisiones = []; const infoAdicional = [];

    for (const row of pendientes) {
      const num  = row.numero;
      const ocupA = ocupMap[num]?.A || null;
      const ocupB = ocupMap[num]?.B || null;

      if (tipo === 'parcial') {
        if (!ocupA) libres.push({ numero: num, serie: 'A' });
        else        colisiones.push({ numero: num, dueno_a: ocupA, dueno_b: null });
      } else {
        const serieDeseada = row.slot === 1 ? 'A' : 'B';
        const ocupadoEnSerie = row.slot === 1 ? ocupA : ocupB;
        if (!ocupadoEnSerie) {
          libres.push({ numero: num, serie: serieDeseada, slot: row.slot });
        } else {
          colisiones.push({ numero: num, slot: row.slot, dueno_a: ocupA, dueno_b: ocupB,
            serie_intentada: serieDeseada, dueno_serie: ocupadoEnSerie });
        }
      }
    }

    res.json({
      tipo, vendedor_nombre: vendR.rows[0].nombre,
      total_slots: poolR.rows.length, total_pendientes: pendientes.length,
      libres, colisiones, info_adicional: infoAdicional,
      puedeAgregar: libres.length > 0,
    });
  } catch (err) { console.error('preview:', err); res.status(500).json({ error: 'Error del servidor' }); }
});

/* ──────────────────────────────────────────────────────────────────
   POST /api/categorias-globales/:id/vendedores
   Crea/vincula un vendedor y le asigna números de una vez.
──────────────────────────────────────────────────────────────────*/
catRouter.post('/:id/vendedores', authMiddleware, soloDueno, async (req, res) => {
  const { vendedor_id, nombre, cedula, usuario, password, numeros = [] } = req.body;
  if (!vendedor_id && !nombre?.trim())
    return res.status(400).json({ error: 'Debes indicar vendedor_id o el nombre del nuevo vendedor' });
  const invalidos = numeros.filter(n => !/^\d{3}$/.test(n));
  if (invalidos.length) return res.status(400).json({ error: `Números inválidos: ${invalidos.join(', ')}` });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const catR = await client.query('SELECT id, tipo FROM categorias_globales WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!catR.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Categoría no encontrada' }); }
    const { tipo } = catR.rows[0];

    let vendedorFinal; let credencialesGeneradas = null;

    if (vendedor_id) {
      const vendR = await client.query('SELECT id, nombre, usuario, cedula, activo FROM users WHERE id = $1 AND rol = $2', [vendedor_id, 'vendedor']);
      if (!vendR.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Vendedor no encontrado' }); }
      if (!vendR.rows[0].activo) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'El vendedor está inactivo' }); }
      vendedorFinal = vendR.rows[0];
    } else {
      const nombreLimpio = nombre.trim();
      const creds = { usuario: usuario?.trim() || generarCredenciales(nombreLimpio).usuario, password: password || generarCredenciales(nombreLimpio).password };
      const existeR = await client.query('SELECT id FROM users WHERE usuario = $1', [creds.usuario]);
      if (existeR.rows[0]) { await client.query('ROLLBACK'); return res.status(409).json({ error: `El usuario "${creds.usuario}" ya existe` }); }
      const hash = await bcrypt.hash(creds.password, 10);
      const newUserR = await client.query(
        `INSERT INTO users (nombre, cedula, usuario, password, rol, activo) VALUES ($1,$2,$3,$4,'vendedor',true) RETURNING id, nombre, usuario, cedula`,
        [nombreLimpio, cedula || null, creds.usuario, hash]
      );
      vendedorFinal = newUserR.rows[0];
      credencialesGeneradas = { usuario: creds.usuario, password: creds.password };
    }

    // Insertar slots
    let numerosAgregados = 0;
    if (numeros.length > 0) {
      const conteo = {};
      for (const n of numeros) conteo[n] = (conteo[n] || 0) + 1;

      for (const [num, veces] of Object.entries(conteo)) {
        const slotsAInsertar = tipo === 'parcial' ? [1] : veces >= 2 ? [1, 2] : [1];
        for (const sl of slotsAInsertar) {
          const existe = await client.query(
            `SELECT id FROM cat_vendedor_numeros WHERE categoria_id=$1 AND vendedor_id=$2 AND numero=$3 AND slot=$4`,
            [req.params.id, vendedorFinal.id, num, sl]
          );
          if (!existe.rows[0]) {
            await client.query(
              `INSERT INTO cat_vendedor_numeros (categoria_id, vendedor_id, numero, slot) VALUES ($1,$2,$3,$4)`,
              [req.params.id, vendedorFinal.id, num, sl]
            );
            numerosAgregados++;
          }
        }
      }
    }

    const { insertados, colisiones, infoAdicional } =
      await asignarSeriesParaVendedor(client, req.params.id, vendedorFinal.id, tipo);

    await client.query('COMMIT');

    const mensajes = [];
    if (insertados.length) mensajes.push(`✅ ${insertados.length} número(s) asignados`);
    if (colisiones.length) mensajes.push(`⚠️ ${colisiones.length} conflicto(s)`);
    if (!mensajes.length && numerosAgregados === 0) mensajes.push('Vendedor vinculado sin números');

    res.status(201).json({
      vendedor: { id: vendedorFinal.id, nombre: vendedorFinal.nombre, usuario: vendedorFinal.usuario, cedula: vendedorFinal.cedula },
      credenciales: credencialesGeneradas,
      numeros_agregados: numerosAgregados,
      asignacion: { insertados, colisiones, info_adicional: infoAdicional, mensaje: mensajes.join('. ') },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error: 'Conflicto de datos' });
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
      return res.status(404).json({ error: 'Este vendedor no tiene números en la categoría' });
    }
    const asigR = await client.query(
      `DELETE FROM cat_global_asignaciones WHERE categoria_id=$1 AND vendedor_id=$2 RETURNING numero, serie`,
      [req.params.id, req.params.vendedorId]
    );
    const poolR = await client.query(
      `DELETE FROM cat_vendedor_numeros WHERE categoria_id=$1 AND vendedor_id=$2 RETURNING numero`,
      [req.params.id, req.params.vendedorId]
    );
    await client.query('COMMIT');
    res.json({ message: `Vendedor removido. ${poolR.rows.length} slot(s) eliminados.`, asignaciones_removidas: asigR.rows });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('DELETE vendedor de cat:', err); res.status(500).json({ error: 'Error del servidor' });
  } finally { client.release(); }
});

/* ──────────────────────────────────────────────────────────────────
   DELETE /api/categorias-globales/:id/asignaciones/:asigId
──────────────────────────────────────────────────────────────────*/
catRouter.delete('/:id/asignaciones/:asigId', authMiddleware, soloDueno, async (req, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM cat_global_asignaciones WHERE id=$1 AND categoria_id=$2 RETURNING numero, serie, vendedor_id`,
      [req.params.asigId, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Asignación no encontrada' });
    res.json({ message: `Número ${result.rows[0].numero} (Serie ${result.rows[0].serie}) liberado. Sigue en el pool.`, ...result.rows[0] });
  } catch (err) { console.error('DELETE asignacion:', err); res.status(500).json({ error: 'Error del servidor' }); }
});


module.exports = {
  vendedoresRouter:         router,
  categoriasGlobalesRouter: catRouter,
};