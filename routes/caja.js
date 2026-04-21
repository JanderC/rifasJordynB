// ============================================================
//   RIFAS JORDYN — Rutas: Módulo de Caja (REFORMA v3)
//   Solo accesible por rol: dueño
//   NUEVAS FEATURES:
//   - Auto-cargar vendedores con números fijos desde la rifa
//   - PUT /lotes/:id/estado — toggle pagado/pendiente/parcial
//   - GET /semanas/:id — incluye numeros_vendidos_publico por lote
//   - GET /semanas/:id/numeros-publico — resumen de ventas públicas
//   - POST /semanas — crea semana y opcionalmente importa vendedores
// ============================================================
const router = require('express').Router();
const pool   = require('../config/db');
const { authMiddleware, soloDueno } = require('../middleware/auth');

router.use(authMiddleware, soloDueno);

/* ─── HELPER: recalcular estado de pago de un lote ─── */
async function recalcularEstadoLote(client, loteId) {
  const r = await client.query(`SELECT por_pagar, abono, pendiente FROM caja_lotes WHERE id=$1`, [loteId]);
  if (!r.rows[0]) return;
  const { por_pagar, abono, pendiente } = r.rows[0];
  let estado = 'pendiente';
  if (Number(pendiente) <= 0)          estado = 'pagado';
  else if (Number(abono) > 0)          estado = 'parcial';
  await client.query(`UPDATE caja_lotes SET estado=$1 WHERE id=$2`, [estado, loteId]);
}

/* ─── HELPER: obtener números vendidos en pantalla pública para un vendedor en una rifa ─── */
async function getNumerosVendidosPublico(rifaId, vendedorId) {
  if (!rifaId || !vendedorId) return [];
  try {
    // ventas de la pantalla pública/cliente (rol cliente o ventas sin vendedor = público)
    const r = await pool.query(`
      SELECT DISTINCT vn.numero
      FROM ventas v
      JOIN venta_numeros vn ON vn.venta_id = v.id
      WHERE v.rifa_id = $1
        AND (v.vendedor_id = $2 OR v.canal = 'publico')
      ORDER BY vn.numero
    `, [rifaId, vendedorId]);
    return r.rows.map(x => x.numero);
  } catch {
    // tabla puede no existir o columna diferente — intentamos forma alternativa
    try {
      const r2 = await pool.query(`
        SELECT DISTINCT numero
        FROM ventas
        WHERE rifa_id = $1 AND (vendedor_id = $2 OR canal = 'publico')
        ORDER BY numero
      `, [rifaId, vendedorId]);
      return r2.rows.map(x => x.numero);
    } catch { return []; }
  }
}

/* ─── HELPER: obtener todos los números vendidos públicamente para una rifa ─── */
async function getNumerosVendidosPublicoRifa(rifaId) {
  if (!rifaId) return [];
  try {
    const r = await pool.query(`
      SELECT DISTINCT vn.numero
      FROM ventas v
      JOIN venta_numeros vn ON vn.venta_id = v.id
      WHERE v.rifa_id = $1
      ORDER BY vn.numero
    `, [rifaId]);
    return r.rows.map(x => x.numero);
  } catch {
    try {
      const r2 = await pool.query(`
        SELECT DISTINCT numero FROM ventas WHERE rifa_id=$1 ORDER BY numero
      `, [rifaId]);
      return r2.rows.map(x => x.numero);
    } catch { return []; }
  }
}

/* ══════════════════════════════════════════════════════════
   SEMANAS
══════════════════════════════════════════════════════════ */

// GET /api/caja/semanas
router.get('/semanas', async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM vista_caja_semanas ORDER BY created_at DESC`);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/caja/semanas/:id — con lotes + numeros vendidos publico
router.get('/semanas/:id', async (req, res) => {
  try {
    const [semanaR, lotesR] = await Promise.all([
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
        ORDER BY l.direccion NULLS LAST, l.vendedor_nombre
      `, [req.params.id]),
    ]);

    if (!semanaR.rows[0]) return res.status(404).json({ error: 'Semana no encontrada' });

    const semana   = semanaR.rows[0];
    const rifaId   = semana.rifa_id;

    // Enriquecer cada lote con números vendidos en pantalla pública
    const numerosPublicosRifa = await getNumerosVendidosPublicoRifa(rifaId);

    const lotes = lotesR.rows.map(lote => {
      // Números asignados a este vendedor (parsear el campo de texto)
      const numsAsignados = parseNumsServer(lote.numeros_asignados || '');
      // Cuáles de esos números ya están vendidos en pantalla pública
      const numsVendidosPublico = numsAsignados.filter(n => numerosPublicosRifa.includes(n));
      return { ...lote, numeros_vendidos_publico: numsVendidosPublico };
    });

    res.json({ ...semana, lotes });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/caja/semanas — crear semana (con opción de auto-importar vendedores de la rifa)
router.post('/semanas', async (req, res) => {
  const { nombre, rifa_id, notas, cargar_vendedores_rifa } = req.body;
  if (!nombre || !rifa_id) return res.status(400).json({ error: 'nombre y rifa_id son requeridos' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Crear semana
    const semanaR = await client.query(
      `INSERT INTO caja_semanas (nombre, rifa_id, notas, created_by)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [nombre.trim(), rifa_id, notas || null, req.user.id]
    );
    const semana = semanaR.rows[0];

    let importados = 0;

    if (cargar_vendedores_rifa) {
      // Obtener datos de la rifa
      const rifaR = await client.query(`SELECT id, precio, categoria_seleccionada_id FROM rifas WHERE id=$1`, [rifa_id]);
      const rifa  = rifaR.rows[0];

      if (rifa && rifa.categoria_seleccionada_id) {
        const precio_rifa = Number(rifa.precio) || 0;

        // Obtener vendedores con sus asignaciones de la categoría de la rifa
        const vendR = await client.query(`
          SELECT
            cvn.vendedor_id,
            u.nombre        AS vendedor_nombre,
            u.cedula,
            ARRAY_AGG(DISTINCT cvn.numero ORDER BY cvn.numero) AS numeros_pool,
            COALESCE(
              JSON_AGG(
                JSON_BUILD_OBJECT('numero', cga.numero, 'serie', cga.serie)
                ORDER BY cga.numero, cga.serie
              ) FILTER (WHERE cga.id IS NOT NULL),
              '[]'
            ) AS asignaciones
          FROM cat_vendedor_numeros cvn
          JOIN users u ON u.id = cvn.vendedor_id
          LEFT JOIN cat_global_asignaciones cga
            ON  cga.categoria_id = cvn.categoria_id
            AND cga.vendedor_id  = cvn.vendedor_id
            AND cga.numero       = cvn.numero
          WHERE cvn.categoria_id = $1
          GROUP BY cvn.vendedor_id, u.nombre, u.cedula
          ORDER BY u.nombre
        `, [rifa.categoria_seleccionada_id]);

        for (const v of vendR.rows) {
          const total_series   = v.asignaciones.length;
          const monto_pendiente = total_series * precio_rifa;
          const numeros_asignados = v.numeros_pool.join(',');

          const loteR = await client.query(`
            INSERT INTO caja_lotes
              (semana_id, vendedor_nombre, vendedor_id, numeros_fijos,
               cant_entregados, abono, numeros_asignados, por_pagar, estado)
            VALUES ($1,$2,$3,true,$4,0,$5,$6,'pendiente')
            ON CONFLICT DO NOTHING
            RETURNING id
          `, [
            semana.id,
            v.vendedor_nombre,
            v.vendedor_id,
            total_series,
            numeros_asignados,
            monto_pendiente,
          ]);
          if (loteR.rows[0]) importados++;
        }
      }
    }

    await client.query('COMMIT');

    res.status(201).json({
      ...semana,
      vendedores_importados: importados,
      mensaje: importados > 0 ? `${importados} vendedor(es) cargados automáticamente` : 'Semana creada sin vendedores auto-importados',
    });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

// PUT /api/caja/semanas/:id
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

/* ══════════════════════════════════════════════════════════
   LOTES
══════════════════════════════════════════════════════════ */

// POST /api/caja/lotes
router.post('/lotes', async (req, res) => {
  const {
    semana_id, vendedor_nombre, vendedor_id,
    direccion, numeros_fijos,
    cant_entregados, cant_vendidos,
    abono, numeros_asignados, observacion, por_pagar,
  } = req.body;
  if (!semana_id || !vendedor_nombre) return res.status(400).json({ error: 'semana_id y vendedor_nombre requeridos' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Calcular por_pagar si no viene explícito (desde precio_boleto de la semana)
    let monto_por_pagar = por_pagar || 0;
    if (!monto_por_pagar && numeros_asignados) {
      const nums = parseNumsServer(numeros_asignados);
      const semR = await client.query(`SELECT s.rifa_id, r.precio FROM caja_semanas s JOIN rifas r ON r.id=s.rifa_id WHERE s.id=$1`, [semana_id]);
      if (semR.rows[0]) {
        monto_por_pagar = nums.length * Number(semR.rows[0].precio);
      }
    }

    const estado = (abono || 0) >= monto_por_pagar && monto_por_pagar > 0 ? 'pagado'
                 : (abono || 0) > 0                                        ? 'parcial'
                 : 'pendiente';

    const r = await client.query(`
      INSERT INTO caja_lotes
        (semana_id, vendedor_nombre, vendedor_id, direccion, numeros_fijos,
         cant_entregados, cant_vendidos, abono, numeros_asignados, observacion, por_pagar, estado)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      RETURNING *
    `, [
      semana_id, vendedor_nombre.trim(), vendedor_id || null,
      direccion || null, numeros_fijos || false,
      cant_entregados || 0, cant_vendidos || 0,
      abono || 0, numeros_asignados || null, observacion || null,
      monto_por_pagar, estado,
    ]);

    if ((abono || 0) > 0) {
      await client.query(
        `INSERT INTO caja_abonos (lote_id, monto, nota, registrado_por) VALUES ($1,$2,$3,$4)`,
        [r.rows[0].id, abono, 'Abono inicial', req.user.id]
      );
    }

    await client.query('COMMIT');
    res.status(201).json(r.rows[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

// PUT /api/caja/lotes/:id — editar campos del lote
router.put('/lotes/:id', async (req, res) => {
  const {
    vendedor_nombre, direccion, numeros_fijos,
    cant_entregados, cant_vendidos,
    numeros_asignados, observacion,
  } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(`
      UPDATE caja_lotes SET
        vendedor_nombre   = COALESCE($1, vendedor_nombre),
        direccion         = COALESCE($2, direccion),
        numeros_fijos     = COALESCE($3, numeros_fijos),
        cant_entregados   = COALESCE($4, cant_entregados),
        cant_vendidos     = COALESCE($5, cant_vendidos),
        numeros_asignados = COALESCE($6, numeros_asignados),
        observacion       = COALESCE($7, observacion)
      WHERE id=$8 RETURNING *
    `, [vendedor_nombre, direccion, numeros_fijos, cant_entregados, cant_vendidos, numeros_asignados, observacion, req.params.id]);

    if (!r.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Lote no encontrado' }); }

    // Si se actualizaron los números asignados, recalcular por_pagar
    if (numeros_asignados !== undefined) {
      const semR = await client.query(
        `SELECT s.rifa_id, r.precio FROM caja_semanas s JOIN rifas r ON r.id=s.rifa_id
         WHERE s.id=(SELECT semana_id FROM caja_lotes WHERE id=$1)`, [req.params.id]
      );
      if (semR.rows[0]) {
        const nums = parseNumsServer(numeros_asignados || '');
        const nuevo_por_pagar = nums.length * Number(semR.rows[0].precio);
        await client.query(`UPDATE caja_lotes SET por_pagar=$1 WHERE id=$2`, [nuevo_por_pagar, req.params.id]);
      }
      await recalcularEstadoLote(client, req.params.id);
    }

    await client.query('COMMIT');
    const updated = await pool.query(`SELECT * FROM caja_lotes WHERE id=$1`, [req.params.id]);
    res.json(updated.rows[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

// PUT /api/caja/lotes/:id/estado — toggle rápido de estado de pago
router.put('/lotes/:id/estado', async (req, res) => {
  const { estado } = req.body;
  const estadosValidos = ['pagado', 'parcial', 'pendiente'];
  if (!estadosValidos.includes(estado)) return res.status(400).json({ error: 'Estado inválido' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const loteR = await client.query(`SELECT * FROM caja_lotes WHERE id=$1`, [req.params.id]);
    if (!loteR.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Lote no encontrado' }); }

    const lote = loteR.rows[0];

    // Si se marca como pagado y no hay abono suficiente, poner abono = por_pagar
    if (estado === 'pagado' && Number(lote.abono) < Number(lote.por_pagar)) {
      const faltante = Number(lote.por_pagar) - Number(lote.abono);
      await client.query(`UPDATE caja_lotes SET abono=por_pagar, pendiente=0, estado='pagado' WHERE id=$1`, [req.params.id]);
      await client.query(
        `INSERT INTO caja_abonos (lote_id, monto, nota, registrado_por) VALUES ($1,$2,$3,$4)`,
        [req.params.id, faltante, 'Marcado como pagado manualmente', req.user.id]
      );
    } else if (estado === 'pendiente') {
      // Revertir todos los abonos NO — solo cambiar el estado visual
      await client.query(`UPDATE caja_lotes SET estado='pendiente' WHERE id=$1`, [req.params.id]);
    } else {
      await client.query(`UPDATE caja_lotes SET estado=$1 WHERE id=$2`, [estado, req.params.id]);
    }

    await client.query('COMMIT');
    const updated = await pool.query(`SELECT * FROM caja_lotes WHERE id=$1`, [req.params.id]);
    res.json(updated.rows[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

// DELETE /api/caja/lotes/:id
router.delete('/lotes/:id', async (req, res) => {
  try {
    await pool.query(`DELETE FROM caja_lotes WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ══════════════════════════════════════════════════════════
   ABONOS
══════════════════════════════════════════════════════════ */

// POST /api/caja/abonos
router.post('/abonos', async (req, res) => {
  const { lote_id, monto, nota } = req.body;
  if (!lote_id || !monto || monto <= 0) return res.status(400).json({ error: 'lote_id y monto > 0 requeridos' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `INSERT INTO caja_abonos (lote_id, monto, nota, registrado_por) VALUES ($1,$2,$3,$4) RETURNING *`,
      [lote_id, monto, nota || null, req.user.id]
    );
    // Actualizar abono acumulado y pendiente
    await client.query(`
      UPDATE caja_lotes
      SET abono    = COALESCE(abono, 0) + $1,
          pendiente = GREATEST(COALESCE(por_pagar, 0) - (COALESCE(abono, 0) + $1), 0)
      WHERE id=$2
    `, [monto, lote_id]);
    await recalcularEstadoLote(client, lote_id);
    await client.query('COMMIT');

    const lote = await pool.query(`SELECT * FROM caja_lotes WHERE id=$1`, [lote_id]);
    res.status(201).json({ abono: r.rows[0], lote: lote.rows[0] });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

// DELETE /api/caja/abonos/:id
router.delete('/abonos/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ab = await client.query(`DELETE FROM caja_abonos WHERE id=$1 RETURNING *`, [req.params.id]);
    if (!ab.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Abono no encontrado' }); }

    const lote_id = ab.rows[0].lote_id;
    // Recalcular abono total desde los abonos restantes
    const totR = await client.query(`SELECT COALESCE(SUM(monto),0) AS total FROM caja_abonos WHERE lote_id=$1`, [lote_id]);
    const total = Number(totR.rows[0].total);
    await client.query(`
      UPDATE caja_lotes SET abono=$1, pendiente=GREATEST(por_pagar-$1,0) WHERE id=$2
    `, [total, lote_id]);
    await recalcularEstadoLote(client, lote_id);
    await client.query('COMMIT');

    const lote = await pool.query(`SELECT * FROM caja_lotes WHERE id=$1`, [lote_id]);
    res.json({ ok: true, lote: lote.rows[0] });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

/* ══════════════════════════════════════════════════════════
   RESUMEN POR ZONA
══════════════════════════════════════════════════════════ */
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

/* ══════════════════════════════════════════════════════════
   NÚMEROS VENDIDOS PÚBLICAMENTE (pantalla del cliente)
   GET /api/caja/semanas/:id/numeros-publico
   Devuelve todos los números vendidos en la pantalla pública
   de la rifa asociada a la semana, cruzados con los lotes
══════════════════════════════════════════════════════════ */
router.get('/semanas/:id/numeros-publico', async (req, res) => {
  try {
    const semR = await pool.query(`SELECT * FROM vista_caja_semanas WHERE id=$1`, [req.params.id]);
    if (!semR.rows[0]) return res.status(404).json({ error: 'Semana no encontrada' });
    const rifa_id = semR.rows[0].rifa_id;

    const numerosPublicos = await getNumerosVendidosPublicoRifa(rifa_id);

    // Por cada lote, decir qué números vendió en pantalla pública
    const lotesR = await pool.query(
      `SELECT id, vendedor_nombre, numeros_asignados FROM caja_lotes WHERE semana_id=$1 ORDER BY vendedor_nombre`,
      [req.params.id]
    );

    const resultado = lotesR.rows.map(lote => {
      const asignados = parseNumsServer(lote.numeros_asignados || '');
      const vendidos  = asignados.filter(n => numerosPublicos.includes(n));
      const pendientes = asignados.filter(n => !numerosPublicos.includes(n));
      return {
        lote_id:          lote.id,
        vendedor_nombre:  lote.vendedor_nombre,
        total_asignados:  asignados.length,
        vendidos_publico: vendidos,
        pendientes:       pendientes,
      };
    });

    res.json({
      rifa_id,
      total_numeros_vendidos_publico: numerosPublicos.length,
      numeros_vendidos_publico: numerosPublicos,
      por_vendedor: resultado,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ══════════════════════════════════════════════════════════
   IMPORTAR LOTES EN BULK (pegar desde Excel)
══════════════════════════════════════════════════════════ */
router.post('/semanas/:id/importar', async (req, res) => {
  const { lotes } = req.body;
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
           cant_entregados, cant_vendidos, abono, numeros_asignados, observacion, estado)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pendiente')
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
        l.observacion || null,
      ]);
      if ((l.abono || 0) > 0) {
        await client.query(
          `INSERT INTO caja_abonos (lote_id, monto, nota, registrado_por) VALUES ($1,$2,$3,$4)`,
          [r.rows[0].id, l.abono, 'Importación', req.user.id]
        );
        await recalcularEstadoLote(client, r.rows[0].id);
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

/* ══════════════════════════════════════════════════════════
   HELPER SERVER: parsear string de números (igual que en frontend)
══════════════════════════════════════════════════════════ */
function parseNumsServer(str) {
  if (!str) return [];
  const nums = new Set();
  String(str).split(',').forEach(part => {
    part = part.trim();
    if (part.includes('-')) {
      const [a, b] = part.split('-').map(Number);
      for (let i = a; i <= b; i++) nums.add(i);
    } else if (part !== '') {
      const n = Number(part);
      if (!isNaN(n)) nums.add(n);
    }
  });
  return [...nums].sort((a, b) => a - b);
}

module.exports = router;