// ============================================================
//   RIFAS JORDYN — Rutas de Vendedores + Categorías Globales  (v3)
//
//   CAMBIOS RESPECTO A v2:
//   ──────────────────────────────────────────────────────────
//   1. POST /categorias-globales/:id/vendedores/:vendedorId/numeros
//      → Ahora devuelve "info_series" por número: indica en qué serie
//        quedará disponible (A libre / B libre / ambas ocupadas).
//        Esto permite que el frontend muestre la previsualización
//        MIENTRAS el usuario escribe el número, sin esperar al botón
//        "Asignar series".
//
//   2. GET /categorias-globales/:id/validar-numero
//      → NUEVA ruta. Query: ?numero=012&vendedor_id=5
//        Responde al instante el estado del número para ese vendedor
//        en esa categoría. Usada por el campo manual del modal de números.
//
//   3. POST /categorias-globales/:id/vendedores
//      → NUEVA ruta. Crea o vincula un vendedor a la categoría y
//        opcionalmente le asigna un rango de números de una vez.
//        Body: { vendedor_id?, nombre?, cedula?, numeros: ['001',...] }
//        Si se omite vendedor_id se crea el usuario (rol=vendedor).
//        Al finalizar se ejecuta el proceso de asignación de series
//        automáticamente para los números provistos.
//
//   El resto de rutas es idéntico a v2.
// ============================================================

const express = require('express');
const router  = express.Router();
const bcrypt  = require('bcryptjs');
const pool    = require('../config/db');
const { authMiddleware, soloDueno } = require('../middleware/auth');

/* ══════════════════════════════════════════════════════════════
   HELPERS
══════════════════════════════════════════════════════════════ */

/**
 * Genera credenciales automáticas a partir del nombre del vendedor.
 * Solo se usa en el backend cuando el frontend no las genera.
 */
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
 * Devuelve el mapa de ocupación { numero -> { A: nombre|null, B: nombre|null } }
 * para una lista de números en una categoría, EXCLUYENDO al vendedor indicado.
 */
async function getOcupacionMap(client, categoriaId, numeros, excluirVendedorId) {
  if (!numeros.length) return {};
  const ocupadosR = await client.query(
    `SELECT cga.numero, cga.serie, u.nombre AS dueno_nombre
     FROM cat_global_asignaciones cga
     JOIN users u ON u.id = cga.vendedor_id
     WHERE cga.categoria_id = $1
       AND cga.numero = ANY($2::char[])
       AND cga.vendedor_id != $3
     ORDER BY cga.numero, cga.serie`,
    [categoriaId, numeros, excluirVendedorId]
  );
  const map = {};
  for (const row of ocupadosR.rows) {
    if (!map[row.numero]) map[row.numero] = { A: null, B: null };
    map[row.numero][row.serie] = row.dueno_nombre;
  }
  return map;
}

/**
 * Ejecuta el algoritmo de asignación de series para los números pendientes
 * de un vendedor en una categoría. Inserta en cat_global_asignaciones.
 * Retorna { insertados, colisiones, infoAdicional }.
 * Requiere una transacción activa (client con BEGIN ya hecho).
 */
async function asignarSeriesParaVendedor(client, categoriaId, vendedorId, tipo) {
  // Pool completo del vendedor
  const poolR = await client.query(
    `SELECT numero FROM cat_vendedor_numeros
     WHERE categoria_id = $1 AND vendedor_id = $2 ORDER BY numero`,
    [categoriaId, vendedorId]
  );
  const poolNumeros = poolR.rows.map(r => r.numero);
  if (!poolNumeros.length) return { insertados: [], colisiones: [], infoAdicional: [] };

  // Ya asignados (propios)
  const propiosR = await client.query(
    `SELECT numero FROM cat_global_asignaciones
     WHERE categoria_id = $1 AND vendedor_id = $2`,
    [categoriaId, vendedorId]
  );
  const propiosSet = new Set(propiosR.rows.map(r => r.numero));
  const pendientes = poolNumeros.filter(n => !propiosSet.has(n));
  if (!pendientes.length) return { insertados: [], colisiones: [], infoAdicional: [] };

  const ocupadosMap = await getOcupacionMap(client, categoriaId, pendientes, vendedorId);

  const aInsertar    = [];
  const colisiones   = [];
  const infoAdicional = [];

  for (const num of pendientes) {
    const ocupA = ocupadosMap[num]?.A || null;
    const ocupB = ocupadosMap[num]?.B || null;

    if (tipo === 'parcial') {
      if (!ocupA) aInsertar.push({ numero: num, serie: 'A' });
      else        colisiones.push({ numero: num, dueno_a: ocupA, dueno_b: null });
    } else {
      // SIMULTÁNEA
      if (!ocupA) {
        aInsertar.push({ numero: num, serie: 'A' });
      } else if (!ocupB) {
        aInsertar.push({ numero: num, serie: 'B' });
        infoAdicional.push({
          numero:        num,
          accion:        'serie_b_por_conflicto_a',
          serie_a_dueno: ocupA,
          mensaje:       `Serie A ocupada por ${ocupA} → asignado en Serie B`,
        });
      } else {
        colisiones.push({ numero: num, dueno_a: ocupA, dueno_b: ocupB });
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

// GET /api/vendedores
router.get('/', authMiddleware, soloDueno, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        u.id, u.nombre, u.usuario, u.cedula, u.rol, u.activo, u.created_at,
        COUNT(DISTINCT v.id)::int           AS total_ventas,
        COALESCE(SUM(v.precio_venta), 0)    AS total_ingresos,
        COUNT(DISTINCT cvn.id)::int         AS numeros_count,
        COUNT(DISTINCT cvn.categoria_id)::int AS categorias_count
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

// GET /api/vendedores/:id
router.get('/:id', authMiddleware, soloDueno, async (req, res) => {
  try {
    const [userR, numerosR, rifasR, ventasR] = await Promise.all([
      pool.query(
        'SELECT id, nombre, usuario, cedula, rol, activo, created_at FROM users WHERE id = $1',
        [req.params.id]
      ),
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
      vendedor:           userR.rows[0],
      numeros_por_cat:    numerosR.rows,
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
    await pool.query('DELETE FROM numeros_vendedor WHERE vendedor_id = $1', [req.params.id]);
    await pool.query('DELETE FROM users            WHERE id = $1',          [req.params.id]);
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

// GET /api/categorias-globales
catRouter.get('/', authMiddleware, soloDueno, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        cg.id, cg.nombre, cg.tipo, cg.monto, cg.descripcion, cg.created_at,
        COUNT(DISTINCT cga.vendedor_id)::int                      AS total_vendedores,
        COUNT(DISTINCT cga.id)::int                               AS total_asignaciones,
        COUNT(CASE WHEN cga.serie = 'A' THEN 1 END)::int         AS numeros_serie_a,
        COUNT(CASE WHEN cga.serie = 'B' THEN 1 END)::int         AS numeros_serie_b,
        COUNT(DISTINCT cvn.id)::int                               AS total_numeros_definidos
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
      total_vendedores: 0, total_asignaciones: 0,
      numeros_serie_a: 0, numeros_serie_b: 0, total_numeros_definidos: 0,
    });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Ya existe una categoría con ese nombre' });
    console.error('POST /categorias-globales:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// PUT /api/categorias-globales/:id
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
    res.json({ message: 'Categoría eliminada. Vendedores y números de la categoría removidos automáticamente.' });
  } catch (err) {
    console.error('DELETE /categorias-globales/:id:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

/* ──────────────────────────────────────────────────────────────────
   ✅ NUEVA RUTA v3
   GET /api/categorias-globales/:id/validar-numero
   ?numero=012&vendedor_id=5

   Validación en tiempo real de un número mientras el usuario escribe.
   No modifica nada — solo consulta el estado actual del número en la
   categoría considerando quién ya lo tiene asignado.

   Respuesta:
   {
     numero,         // "012"
     tipo,           // "simultanea" | "parcial"
     disponible,     // true = se puede agregar/asignar
     serie_destino,  // "A" | "B" | null (si no disponible)
     serie_a: { libre: bool, dueno: string|null },
     serie_b: { libre: bool, dueno: string|null },  // solo simultanea
     ya_en_pool,     // true si el vendedor ya tiene este número en su pool
     ya_asignado,    // true si ya tiene serie asignada para este vendedor
     mensaje,        // string descriptivo para mostrar al usuario
   }
────────────────────────────────────────────────────────────────── */
catRouter.get('/:id/validar-numero', authMiddleware, soloDueno, async (req, res) => {
  const { numero, vendedor_id } = req.query;
  if (!numero || !/^\d{3}$/.test(numero))
    return res.status(400).json({ error: 'numero debe ser 3 dígitos (000-999)' });
  if (!vendedor_id)
    return res.status(400).json({ error: 'vendedor_id es requerido' });

  try {
    const catR = await pool.query(
      'SELECT id, tipo FROM categorias_globales WHERE id = $1', [req.params.id]
    );
    if (!catR.rows[0]) return res.status(404).json({ error: 'Categoría no encontrada' });
    const { tipo } = catR.rows[0];

    // ¿Ya está en el pool del vendedor?
    const enPoolR = await pool.query(
      `SELECT id FROM cat_vendedor_numeros
       WHERE categoria_id = $1 AND vendedor_id = $2 AND numero = $3`,
      [req.params.id, vendedor_id, numero]
    );
    const yaEnPool = enPoolR.rows.length > 0;

    // ¿Ya tiene serie asignada para ESTE vendedor?
    const asignadoR = await pool.query(
      `SELECT serie FROM cat_global_asignaciones
       WHERE categoria_id = $1 AND vendedor_id = $2 AND numero = $3`,
      [req.params.id, vendedor_id, numero]
    );
    const yaAsignado = asignadoR.rows.length > 0;
    const seriePropia = asignadoR.rows[0]?.serie || null;

    // Estado de ocupación del número por OTROS vendedores
    const ocupacionR = await pool.query(
      `SELECT cga.serie, u.nombre AS dueno_nombre
       FROM cat_global_asignaciones cga
       JOIN users u ON u.id = cga.vendedor_id
       WHERE cga.categoria_id = $1 AND cga.numero = $2 AND cga.vendedor_id != $3
       ORDER BY cga.serie`,
      [req.params.id, numero, vendedor_id]
    );
    const serieA = ocupacionR.rows.find(r => r.serie === 'A') || null;
    const serieB = ocupacionR.rows.find(r => r.serie === 'B') || null;

    // Calcular disponibilidad y destino
    let disponible   = false;
    let serieDestino = null;
    let mensaje      = '';

    if (tipo === 'parcial') {
      if (yaAsignado) {
        disponible   = false;
        serieDestino = seriePropia;
        mensaje      = `Este número ya está asignado al vendedor en Serie ${seriePropia}.`;
      } else if (yaEnPool) {
        disponible   = false;
        serieDestino = null;
        mensaje      = 'Este número ya está en el pool del vendedor (sin serie aún).';
      } else if (!serieA) {
        disponible   = true;
        serieDestino = 'A';
        mensaje      = 'Número libre. Se asignará en Serie A.';
      } else {
        disponible   = false;
        serieDestino = null;
        mensaje      = `Número ocupado por ${serieA.dueno_nombre} (Serie A). No disponible en categoría parcial.`;
      }
    } else {
      // SIMULTÁNEA
      if (yaAsignado) {
        disponible   = false;
        serieDestino = seriePropia;
        mensaje      = `Este número ya está asignado al vendedor en Serie ${seriePropia}.`;
      } else if (yaEnPool) {
        disponible   = false;
        serieDestino = null;
        mensaje      = 'Este número ya está en el pool del vendedor (sin serie aún).';
      } else if (!serieA) {
        disponible   = true;
        serieDestino = 'A';
        mensaje      = 'Serie A libre. Se asignará en Serie A.';
      } else if (!serieB) {
        disponible   = true;
        serieDestino = 'B';
        mensaje      = `Serie A ocupada por ${serieA.dueno_nombre}. Se asignará en Serie B.`;
      } else {
        disponible   = false;
        serieDestino = null;
        mensaje      = `Número ocupado: Serie A → ${serieA.dueno_nombre}, Serie B → ${serieB.dueno_nombre}. Sin espacio disponible.`;
      }
    }

    res.json({
      numero,
      tipo,
      disponible,
      serie_destino: serieDestino,
      serie_a:      { libre: !serieA, dueno: serieA?.dueno_nombre || null },
      serie_b:      tipo === 'simultanea' ? { libre: !serieB, dueno: serieB?.dueno_nombre || null } : undefined,
      ya_en_pool:   yaEnPool,
      ya_asignado:  yaAsignado,
      mensaje,
    });
  } catch (err) {
    console.error('GET /categorias-globales/:id/validar-numero:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

/* ──────────────────────────────────────────────────────────────────
   ✅ NUEVA RUTA v3
   POST /api/categorias-globales/:id/vendedores
   Crea o vincula un vendedor a la categoría y le asigna números
   de una sola vez (flujo unificado para el modal de creación).

   Body:
   {
     // Opción A — vendedor existente:
     vendedor_id: 5,

     // Opción B — crear nuevo vendedor:
     nombre: "Juan Pérez",
     cedula: "12345678",        // opcional
     usuario: "juan_1234",      // opcional; si se omite se genera automáticamente
     password: "juan1234",      // opcional; si se omite se genera automáticamente

     // Común para ambas opciones:
     numeros: ["001", "002", "050"]  // opcional; puede estar vacío
   }

   Respuesta:
   {
     vendedor: { id, nombre, usuario, cedula },
     credenciales: { usuario, password } | null,  // solo si se creó nuevo
     numeros_agregados: number,
     asignacion: {
       insertados: [{numero, serie}],
       colisiones: [{numero, dueno_a, dueno_b}],
       info_adicional: [{numero, mensaje, serie_a_dueno}],
       mensaje: string
     }
   }
────────────────────────────────────────────────────────────────── */
catRouter.post('/:id/vendedores', authMiddleware, soloDueno, async (req, res) => {
  const { vendedor_id, nombre, cedula, usuario, password, numeros = [] } = req.body;

  // Validaciones básicas
  if (!vendedor_id && !nombre?.trim())
    return res.status(400).json({ error: 'Debes indicar vendedor_id o el nombre del nuevo vendedor' });

  const invalidos = numeros.filter(n => !/^\d{3}$/.test(n));
  if (invalidos.length)
    return res.status(400).json({ error: `Números inválidos: ${invalidos.join(', ')}` });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Obtener la categoría
    const catR = await client.query(
      'SELECT id, tipo FROM categorias_globales WHERE id = $1 FOR UPDATE',
      [req.params.id]
    );
    if (!catR.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Categoría no encontrada' });
    }
    const { tipo } = catR.rows[0];

    let vendedorFinal;
    let credencialesGeneradas = null;

    if (vendedor_id) {
      // ─── Opción A: vendedor existente ────────────────────────────
      const vendR = await client.query(
        'SELECT id, nombre, usuario, cedula, activo FROM users WHERE id = $1 AND rol = $2',
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
      vendedorFinal = vendR.rows[0];

    } else {
      // ─── Opción B: crear nuevo vendedor ──────────────────────────
      const nombreLimpio = nombre.trim();
      const creds = {
        usuario:  usuario?.trim() || generarCredenciales(nombreLimpio).usuario,
        password: password        || generarCredenciales(nombreLimpio).password,
      };

      // Verificar que el usuario no exista ya
      const existeR = await client.query(
        'SELECT id FROM users WHERE usuario = $1', [creds.usuario]
      );
      if (existeR.rows[0]) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: `El usuario "${creds.usuario}" ya existe` });
      }

      const hash = await bcrypt.hash(creds.password, 10);
      const newUserR = await client.query(
        `INSERT INTO users (nombre, cedula, usuario, password, rol, activo)
         VALUES ($1, $2, $3, $4, 'vendedor', true)
         RETURNING id, nombre, usuario, cedula`,
        [nombreLimpio, cedula || null, creds.usuario, hash]
      );
      vendedorFinal        = newUserR.rows[0];
      credencialesGeneradas = { usuario: creds.usuario, password: creds.password };
    }

    // ─── Agregar números al pool ────────────────────────────────────
    let numerosAgregados = 0;
    if (numeros.length > 0) {
      // Verificar cuáles ya existen en el pool para este vendedor
      const existentesR = await client.query(
        `SELECT numero FROM cat_vendedor_numeros
         WHERE categoria_id = $1 AND vendedor_id = $2 AND numero = ANY($3::char[])`,
        [req.params.id, vendedorFinal.id, numeros]
      );
      const yaExisten = new Set(existentesR.rows.map(r => r.numero));
      const nuevos    = numeros.filter(n => !yaExisten.has(n));

      for (const num of nuevos) {
        await client.query(
          `INSERT INTO cat_vendedor_numeros (categoria_id, vendedor_id, numero)
           VALUES ($1, $2, $3)`,
          [req.params.id, vendedorFinal.id, num]
        );
        numerosAgregados++;
      }
    }

    // ─── Asignar series automáticamente ────────────────────────────
    const { insertados, colisiones, infoAdicional } =
      await asignarSeriesParaVendedor(client, req.params.id, vendedorFinal.id, tipo);

    await client.query('COMMIT');

    const mensajes = [];
    if (insertados.length)    mensajes.push(`✅ ${insertados.length} número(s) asignado(s)`);
    if (infoAdicional.length) mensajes.push(`ℹ️ ${infoAdicional.length} redirigido(s) a Serie B`);
    if (colisiones.length)    mensajes.push(`⚠️ ${colisiones.length} conflicto(s) sin asignar`);
    if (!mensajes.length && numerosAgregados === 0) mensajes.push('Vendedor vinculado a la categoría sin números');

    res.status(201).json({
      vendedor:         { id: vendedorFinal.id, nombre: vendedorFinal.nombre, usuario: vendedorFinal.usuario, cedula: vendedorFinal.cedula },
      credenciales:     credencialesGeneradas,
      numeros_agregados: numerosAgregados,
      asignacion: {
        insertados,
        colisiones,
        info_adicional: infoAdicional,
        mensaje:        mensajes.join('. ') || 'Sin cambios en series',
      },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error: 'El usuario ya existe o el número ya está en el pool' });
    console.error('POST /categorias-globales/:id/vendedores:', err);
    res.status(500).json({ error: 'Error del servidor' });
  } finally { client.release(); }
});

/* ──────────────────────────────────────────────────────────────────
   GET /api/categorias-globales/:id/vendedores-resumen
   Resumen por vendedor con sus números y estado de series.
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
         u.cedula,
         COUNT(cvn.numero)::int                            AS total_numeros,
         COUNT(cga.id)::int                                AS total_asignados,
         COUNT(CASE WHEN cga.serie = 'A' THEN 1 END)::int AS serie_a,
         COUNT(CASE WHEN cga.serie = 'B' THEN 1 END)::int AS serie_b,
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
       GROUP BY cvn.vendedor_id, u.nombre, u.cedula
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
   Agrega números al pool del vendedor dentro de la categoría.
   Body: { numeros: ['000','001',...] }
   ✅ v3: ahora también devuelve info_series con el estado/destino de
   cada número agregado para que el frontend lo muestre al instante.
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
    const { tipo } = catR.rows[0];

    const vendR = await client.query(
      'SELECT id, nombre, activo FROM users WHERE id = $1 AND rol = $2',
      [req.params.vendedorId, 'vendedor']
    );
    if (!vendR.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Vendedor no encontrado' }); }
    if (!vendR.rows[0].activo) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'El vendedor está inactivo' }); }

    // Cuáles ya existen en el pool
    const existentesR = await client.query(
      `SELECT numero FROM cat_vendedor_numeros
       WHERE categoria_id = $1 AND vendedor_id = $2 AND numero = ANY($3::char[])`,
      [req.params.id, req.params.vendedorId, numeros]
    );
    const yaExisten = existentesR.rows.map(r => r.numero);
    const nuevos    = numeros.filter(n => !yaExisten.includes(n));

    for (const num of nuevos) {
      await client.query(
        `INSERT INTO cat_vendedor_numeros (categoria_id, vendedor_id, numero)
         VALUES ($1, $2, $3)`,
        [req.params.id, req.params.vendedorId, num]
      );
    }

    // ── v3: calcular info_series para los nuevos ──────────────────
    // (previsualización del estado de cada número recién agregado)
    let infoSeries = [];
    if (nuevos.length > 0) {
      const ocupMap = await getOcupacionMap(client, req.params.id, nuevos, req.params.vendedorId);
      infoSeries = nuevos.map(num => {
        const ocupA = ocupMap[num]?.A || null;
        const ocupB = ocupMap[num]?.B || null;
        if (tipo === 'parcial') {
          return {
            numero:       num,
            disponible:   !ocupA,
            serie_destino: !ocupA ? 'A' : null,
            serie_a:      { libre: !ocupA, dueno: ocupA },
            mensaje:      !ocupA
              ? 'Libre — Serie A disponible'
              : `Serie A ocupada por ${ocupA}`,
          };
        } else {
          // SIMULTÁNEA
          const destino = !ocupA ? 'A' : !ocupB ? 'B' : null;
          return {
            numero:       num,
            disponible:   destino !== null,
            serie_destino: destino,
            serie_a:      { libre: !ocupA, dueno: ocupA },
            serie_b:      { libre: !ocupB, dueno: ocupB },
            mensaje:
              !ocupA             ? 'Serie A libre'
              : !ocupB           ? `Serie A tiene ${ocupA} → irá a Serie B`
              :                   `Ambas series ocupadas (A:${ocupA}, B:${ocupB})`,
          };
        }
      });
    }

    await client.query('COMMIT');
    res.status(201).json({
      message:     `${nuevos.length} número(s) agregados al pool de ${vendR.rows[0].nombre} en esta categoría.`,
      insertados:  nuevos.length,
      ya_existian: yaExisten,
      info_series: infoSeries,   // ← nuevo en v3
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /categorias-globales/:id/vendedores/:vendedorId/numeros:', err);
    res.status(500).json({ error: 'Error del servidor' });
  } finally { client.release(); }
});

/* ──────────────────────────────────────────────────────────────────
   DELETE /api/categorias-globales/:id/vendedores/:vendedorId/numeros
   Quita números del pool del vendedor en la categoría.
   Body: { numeros: ['000','001',...] }
────────────────────────────────────────────────────────────────── */
catRouter.delete('/:id/vendedores/:vendedorId/numeros', authMiddleware, soloDueno, async (req, res) => {
  const { numeros } = req.body;
  if (!Array.isArray(numeros) || !numeros.length)
    return res.status(400).json({ error: 'numeros[] es requerido' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `DELETE FROM cat_global_asignaciones
       WHERE categoria_id = $1 AND vendedor_id = $2 AND numero = ANY($3::char[])`,
      [req.params.id, req.params.vendedorId, numeros]
    );
    const result = await client.query(
      `DELETE FROM cat_vendedor_numeros
       WHERE categoria_id = $1 AND vendedor_id = $2 AND numero = ANY($3::char[])
       RETURNING numero`,
      [req.params.id, req.params.vendedorId, numeros]
    );
    await client.query('COMMIT');
    res.json({
      message:  `${result.rows.length} número(s) removidos.`,
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
   Asigna series a los números pendientes del vendedor en la categoría.
   (misma lógica, ahora delega al helper asignarSeriesParaVendedor)
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

    // Verificar que tenga números en el pool
    const poolCheckR = await client.query(
      `SELECT COUNT(*)::int AS total FROM cat_vendedor_numeros
       WHERE categoria_id = $1 AND vendedor_id = $2`,
      [req.params.id, req.params.vendedorId]
    );
    if (poolCheckR.rows[0].total === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: `${vendedorNombre} no tiene números en esta categoría. Agrégalos primero.`
      });
    }

    // Verificar que haya pendientes
    const pendientesCheckR = await client.query(
      `SELECT cvn.numero
       FROM cat_vendedor_numeros cvn
       WHERE cvn.categoria_id = $1 AND cvn.vendedor_id = $2
         AND NOT EXISTS (
           SELECT 1 FROM cat_global_asignaciones cga
           WHERE cga.categoria_id = cvn.categoria_id
             AND cga.vendedor_id  = cvn.vendedor_id
             AND cga.numero       = cvn.numero
         )`,
      [req.params.id, req.params.vendedorId]
    );
    if (pendientesCheckR.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: `Todos los números de ${vendedorNombre} ya están asignados en esta categoría.`
      });
    }

    const { insertados, colisiones, infoAdicional } =
      await asignarSeriesParaVendedor(client, req.params.id, req.params.vendedorId, tipo);

    await client.query('COMMIT');

    if (insertados.length === 0 && colisiones.length > 0) {
      return res.status(409).json({
        error:          `Todos los números de ${vendedorNombre} tienen conflictos en esta categoría.`,
        insertados:     [],
        colisiones,
        info_adicional: [],
        vendedor_nombre: vendedorNombre,
      });
    }

    const mensajes = [];
    if (insertados.length)    mensajes.push(`✅ ${insertados.length} número(s) asignados`);
    if (infoAdicional.length) mensajes.push(`ℹ️ ${infoAdicional.length} número(s) redirigidos a Serie B`);
    if (colisiones.length)    mensajes.push(`⚠️ ${colisiones.length} número(s) con conflicto total`);

    res.status(201).json({
      message:         mensajes.join('. '),
      vendedor_nombre: vendedorNombre,
      insertados,
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
   Previsualiza la asignación de series sin modificar nada.
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
      const ocupA = ocupadosMap[num]?.A || null;
      const ocupB = ocupadosMap[num]?.B || null;
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
   Quita al vendedor completo de la categoría.
────────────────────────────────────────────────────────────────── */
catRouter.delete('/:id/vendedores/:vendedorId', authMiddleware, soloDueno, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existeR = await client.query(
      `SELECT COUNT(*) FROM cat_vendedor_numeros
       WHERE categoria_id = $1 AND vendedor_id = $2`,
      [req.params.id, req.params.vendedorId]
    );
    if (parseInt(existeR.rows[0].count) === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Este vendedor no tiene números en la categoría' });
    }
    const asigR = await client.query(
      `DELETE FROM cat_global_asignaciones
       WHERE categoria_id = $1 AND vendedor_id = $2
       RETURNING numero, serie`,
      [req.params.id, req.params.vendedorId]
    );
    const poolR = await client.query(
      `DELETE FROM cat_vendedor_numeros
       WHERE categoria_id = $1 AND vendedor_id = $2
       RETURNING numero`,
      [req.params.id, req.params.vendedorId]
    );
    await client.query('COMMIT');
    res.json({
      message:               `Vendedor removido de la categoría. ${poolR.rows.length} número(s) eliminados.`,
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
   Libera una asignación de serie específica.
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
   Números del 000–999 que aún no están en ningún pool de vendedor.
────────────────────────────────────────────────────────────────── */
catRouter.get('/:id/numeros-disponibles', authMiddleware, soloDueno, async (req, res) => {
  const { vendedor_id } = req.query;
  try {
    const catR = await pool.query(
      'SELECT id, tipo FROM categorias_globales WHERE id = $1', [req.params.id]
    );
    if (!catR.rows[0]) return res.status(404).json({ error: 'Categoría no encontrada' });
    const { tipo } = catR.rows[0];

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
   Estado de un número específico en la categoría.
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

    const libre  = tipo === 'parcial' ? !series['A'] : (!series['A'] || !series['B']);
    const estado = !series['A'] && !series['B'] ? 'libre'
                 : tipo === 'parcial'            ? 'ocupado'
                 : !series['A'] || !series['B']  ? 'semi_ocupado'
                 : 'ocupado';

    res.json({ numero: req.params.numero, tipo, estado, serie_a: series['A'] || null, serie_b: series['B'] || null, libre });
  } catch (err) {
    console.error('GET /categorias-globales/:id/numero/:numero/estado:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

module.exports = {
  vendedoresRouter:         router,
  categoriasGlobalesRouter: catRouter,
};