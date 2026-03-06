// ============================================================
//   RIFAS JORDYN — Rutas: Módulo de Caja
//   Solo accesible por rol: dueño
// ============================================================
const router  = require('express').Router();
const pool    = require('../config/db');
const { authMiddleware, soloDueno } = require('../middleware/auth');

// Todos los endpoints de caja requieren auth + dueno
router.use(authMiddleware, soloDueno);

/* ──────────────────────────────────────────────────────────
   SEMANAS
────────────────────────────────────────────────────────── */

// GET /api/caja/semanas — listar todas con resumen
router.get('/semanas', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT * FROM vista_caja_semanas ORDER BY created_at DESC`
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/caja/semanas/:id — detalle con lotes
router.get('/semanas/:id', async (req, res) => {
  try {
    const [semana, lotes] = await Promise.all([
      pool.query(`SELECT * FROM vista_caja_semanas WHERE id = $1`, [req.params.id]),
      pool.query(`
        SELECT l.*,
               COALESCE(
                 json_agg(
                   json_build_object('id',a.id,'monto',a.monto,'nota',a.nota,'fecha',a.created_at)
                   ORDER BY a.created_at
                 ) FILTER (WHERE a.id IS NOT NULL),
                 '[]'
               ) AS abonos_historial
        FROM caja_lotes l
        LEFT JOIN caja_abonos a ON a.lote_id = l.id
        WHERE l.semana_id = $1
        GROUP BY l.id
        ORDER BY l.direccion, l.vendedor_nombre
      `, [req.params.id])
    ]);
    if (!semana.rows[0]) return res.status(404).json({ error: 'Semana no encontrada' });
    res.json({ ...semana.rows[0], lotes: lotes.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/caja/semanas — crear semana
router.post('/semanas', async (req, res) => {
  const { nombre, rifa_id, notas } = req.body;
  if (!nombre || !rifa_id) return res.status(400).json({ error: 'nombre y rifa_id son requeridos' });
  try {
    const r = await pool.query(
      `INSERT INTO caja_semanas (nombre, rifa_id, notas, created_by)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [nombre.trim(), rifa_id, notas || null, req.user.id]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/caja/semanas/:id — actualizar semana
router.put('/semanas/:id', async (req, res) => {
  const { nombre, estado, notas } = req.body;
  try {
    const r = await pool.query(
      `UPDATE caja_semanas SET nombre=COALESCE($1,nombre), estado=COALESCE($2,estado), notas=COALESCE($3,notas)
       WHERE id=$4 RETURNING *`,
      [nombre, estado, notas, req.params.id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Semana no encontrada' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/caja/semanas/:id
router.delete('/semanas/:id', async (req, res) => {
  try {
    await pool.query(`DELETE FROM caja_semanas WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ──────────────────────────────────────────────────────────
   LOTES (filas del Excel = un vendedor en una semana)
────────────────────────────────────────────────────────── */

// POST /api/caja/lotes — agregar lote
router.post('/lotes', async (req, res) => {
  const {
    semana_id, vendedor_nombre, vendedor_id,
    direccion, numeros_fijos,
    cant_entregados, cant_vendidos,
    abono, numeros_asignados, observacion
  } = req.body;
  if (!semana_id || !vendedor_nombre) return res.status(400).json({ error: 'semana_id y vendedor_nombre requeridos' });
  try {
    const r = await pool.query(`
      INSERT INTO caja_lotes
        (semana_id, vendedor_nombre, vendedor_id, direccion, numeros_fijos,
         cant_entregados, cant_vendidos, abono, numeros_asignados, observacion)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      RETURNING *
    `, [
      semana_id, vendedor_nombre.trim(), vendedor_id || null,
      direccion || null, numeros_fijos || false,
      cant_entregados || 0, cant_vendidos || 0,
      abono || 0, numeros_asignados || null, observacion || null
    ]);
    // Si hay abono inicial, registrarlo en historial
    if ((abono || 0) > 0) {
      await pool.query(
        `INSERT INTO caja_abonos (lote_id, monto, nota, registrado_por) VALUES ($1,$2,$3,$4)`,
        [r.rows[0].id, abono, 'Abono inicial', req.user.id]
      );
    }
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/caja/lotes/:id — editar lote inline
router.put('/lotes/:id', async (req, res) => {
  const {
    vendedor_nombre, direccion, numeros_fijos,
    cant_entregados, cant_vendidos,
    numeros_asignados, observacion
  } = req.body;
  try {
    const r = await pool.query(`
      UPDATE caja_lotes SET
        vendedor_nombre  = COALESCE($1, vendedor_nombre),
        direccion        = COALESCE($2, direccion),
        numeros_fijos    = COALESCE($3, numeros_fijos),
        cant_entregados  = COALESCE($4, cant_entregados),
        cant_vendidos    = COALESCE($5, cant_vendidos),
        numeros_asignados= COALESCE($6, numeros_asignados),
        observacion      = COALESCE($7, observacion)
      WHERE id=$8 RETURNING *
    `, [vendedor_nombre, direccion, numeros_fijos, cant_entregados, cant_vendidos, numeros_asignados, observacion, req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Lote no encontrado' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/caja/lotes/:id
router.delete('/lotes/:id', async (req, res) => {
  try {
    await pool.query(`DELETE FROM caja_lotes WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ──────────────────────────────────────────────────────────
   ABONOS
────────────────────────────────────────────────────────── */

// POST /api/caja/abonos — registrar abono
router.post('/abonos', async (req, res) => {
  const { lote_id, monto, nota } = req.body;
  if (!lote_id || !monto || monto <= 0) return res.status(400).json({ error: 'lote_id y monto > 0 requeridos' });
  try {
    const r = await pool.query(
      `INSERT INTO caja_abonos (lote_id, monto, nota, registrado_por) VALUES ($1,$2,$3,$4) RETURNING *`,
      [lote_id, monto, nota || null, req.user.id]
    );
    // Devolver lote actualizado
    const lote = await pool.query(`SELECT * FROM caja_lotes WHERE id=$1`, [lote_id]);
    res.status(201).json({ abono: r.rows[0], lote: lote.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/caja/abonos/:id
router.delete('/abonos/:id', async (req, res) => {
  try {
    const ab = await pool.query(`DELETE FROM caja_abonos WHERE id=$1 RETURNING *`, [req.params.id]);
    if (!ab.rows[0]) return res.status(404).json({ error: 'Abono no encontrado' });
    const lote = await pool.query(`SELECT * FROM caja_lotes WHERE id=$1`, [ab.rows[0].lote_id]);
    res.json({ ok: true, lote: lote.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ──────────────────────────────────────────────────────────
   RESUMEN POR ZONA (para el panel de totales)
────────────────────────────────────────────────────────── */
router.get('/semanas/:id/por-zona', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT
        COALESCE(direccion, 'Sin zona') AS zona,
        COUNT(*)                        AS lotes,
        SUM(cant_entregados)            AS entregados,
        SUM(cant_vendidos)              AS vendidos,
        SUM(por_pagar)                  AS por_cobrar,
        SUM(abono)                      AS cobrado,
        SUM(pendiente)                  AS pendiente
      FROM caja_lotes
      WHERE semana_id = $1
      GROUP BY direccion
      ORDER BY SUM(por_pagar) DESC
    `, [req.params.id]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ──────────────────────────────────────────────────────────
   IMPORTAR LOTES EN BULK (pegar desde Excel)
────────────────────────────────────────────────────────── */
router.post('/semanas/:id/importar', async (req, res) => {
  const { lotes } = req.body; // array de objetos
  if (!Array.isArray(lotes) || lotes.length === 0)
    return res.status(400).json({ error: 'Se requiere un array de lotes' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = [];
    for (const l of lotes) {
      if (!l.vendedor_nombre) continue;
      const r = await client.query(`
        INSERT INTO caja_lotes
          (semana_id, vendedor_nombre, direccion, numeros_fijos,
           cant_entregados, cant_vendidos, abono, numeros_asignados, observacion)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        RETURNING *
      `, [
        req.params.id,
        l.vendedor_nombre.trim(),
        l.direccion || null,
        l.numeros_fijos || false,
        l.cant_entregados || 0,
        l.cant_vendidos || 0,
        l.abono || 0,
        l.numeros_asignados || null,
        l.observacion || null
      ]);
      if ((l.abono || 0) > 0) {
        await client.query(
          `INSERT INTO caja_abonos (lote_id, monto, nota, registrado_por) VALUES ($1,$2,$3,$4)`,
          [r.rows[0].id, l.abono, 'Importación', req.user.id]
        );
      }
      inserted.push(r.rows[0]);
    }
    await client.query('COMMIT');
    res.status(201).json({ insertados: inserted.length, lotes: inserted });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

module.exports = router;