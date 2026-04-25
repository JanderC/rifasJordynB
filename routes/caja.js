// ============================================================
//   RIFAS JORDYN — Rutas: Módulo de Caja (v4)
//   - GET /caja/rifa-activa — rifa dentro del rango de fechas,
//     semana asociada, deudas vencidas (+3 días), deudas anteriores
//   - PUT /caja/lotes/:id/saldar-deuda-anterior
//   - Resto de endpoints mantenidos de v3
// ============================================================
const router = require('express').Router();
const pool   = require('../config/db');
const { authMiddleware, soloDueno } = require('../middleware/auth');

router.use(authMiddleware, soloDueno);

/* ─── HELPER: recalcular estado de pago ─── */
async function recalcularEstadoLote(client, loteId) {
  const r = await client.query(
    `SELECT por_pagar, abono, pendiente FROM caja_lotes WHERE id=$1`, [loteId]
  );
  if (!r.rows[0]) return;
  const { por_pagar, abono } = r.rows[0];
  const pendiente = Math.max(Number(por_pagar) - Number(abono), 0);
  let estado = 'pendiente';
  if (pendiente <= 0 && Number(por_pagar) > 0) estado = 'pagado';
  else if (Number(abono) > 0)                  estado = 'parcial';
  await client.query(
    `UPDATE caja_lotes SET pendiente=$1, estado=$2 WHERE id=$3`,
    [pendiente, estado, loteId]
  );
}

/* ─── HELPER: números vendidos públicamente de una rifa ─── */
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
      const r2 = await pool.query(
        `SELECT DISTINCT numero FROM ventas WHERE rifa_id=$1 ORDER BY numero`, [rifaId]
      );
      return r2.rows.map(x => x.numero);
    } catch { return []; }
  }
}

/* ─── HELPER: parsear string de números ─── */
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

/* ══════════════════════════════════════════════════════════
   GET /api/caja/rifa-activa
   Devuelve:
   {
     rifa,             — rifa dentro del rango de fechas hoy
     semana,           — caja_semana asociada a esa rifa (crea una si no existe)
     deudas_vencidas,  — lotes pendientes de rifas cuyo sorteo fue hace >3 días
     deudas_anteriores — lotes marcados como deuda_anterior=true para la rifa activa
   }
══════════════════════════════════════════════════════════ */
router.get('/rifa-activa', async (req, res) => {
  const client = await pool.connect();
  try {
    const hoy = new Date();

    // 1. Buscar rifa cuyo rango incluya hoy
    //    fecha_inicio <= hoy <= fecha_sorteo  (o activa=true si no hay fecha_inicio)
    const rifaR = await client.query(`
      SELECT *
      FROM rifas
      WHERE activa = true
        AND fecha_sorteo IS NOT NULL
        AND fecha_sorteo::date >= CURRENT_DATE
        AND (fecha_inicio IS NULL OR fecha_inicio::date <= CURRENT_DATE)
      ORDER BY fecha_sorteo ASC
      LIMIT 1
    `);

    const rifa = rifaR.rows[0] || null;

    // 2. Deudas vencidas: rifas con sorteo hace >3 días que tienen lotes pendientes
    const vencR = await client.query(`
      SELECT
        l.id            AS lote_id,
        l.vendedor_nombre,
        l.pendiente     AS monto_pendiente,
        l.direccion,
        r.nombre        AS rifa_nombre,
        r.id            AS rifa_id,
        r.fecha_sorteo,
        s.id            AS semana_id
      FROM caja_lotes l
      JOIN caja_semanas s ON s.id = l.semana_id
      JOIN rifas r        ON r.id = s.rifa_id
      WHERE l.estado IN ('pendiente','parcial')
        AND l.deuda_traspasada IS NOT TRUE
        AND r.fecha_sorteo IS NOT NULL
        AND r.fecha_sorteo::date < (CURRENT_DATE - INTERVAL '3 days')
        AND (r.id != $1 OR $1 IS NULL)
      ORDER BY r.fecha_sorteo DESC, l.vendedor_nombre
    `, [rifa?.id || null]);

    const deudasVencidas = vencR.rows;

    // 3. Deudas anteriores ya confirmadas para mostrar en la rifa actual
    let deudasAnteriores = [];
    if (rifa) {
      const antR = await client.query(`
        SELECT
          l.id            AS lote_id,
          l.vendedor_nombre,
          l.pendiente     AS monto_pendiente,
          l.direccion,
          r.nombre        AS rifa_nombre
        FROM caja_lotes l
        JOIN caja_semanas s ON s.id = l.semana_id
        JOIN rifas r        ON r.id = s.rifa_id
        WHERE l.deuda_traspasada = true
          AND l.deuda_saldada IS NOT TRUE
          AND r.id != $1
        ORDER BY l.vendedor_nombre
      `, [rifa.id]);
      deudasAnteriores = antR.rows;
    }

    // 4. Buscar o crear semana para la rifa activa
    let semana = null;
    if (rifa) {
      const semR = await client.query(
        `SELECT * FROM caja_semanas WHERE rifa_id=$1 ORDER BY created_at DESC LIMIT 1`,
        [rifa.id]
      );
      if (semR.rows[0]) {
        semana = semR.rows[0];
      } else {
        // Auto-crear semana para esta rifa y cargar vendedores fijos
        const nuevaR = await client.query(`
          INSERT INTO caja_semanas (nombre, rifa_id, notas, created_by)
          VALUES ($1,$2,NULL,$3) RETURNING *
        `, [`Caja — ${rifa.nombre}`, rifa.id, req.user.id]);
        semana = nuevaR.rows[0];

        // Auto-importar vendedores desde numeros_vendedor de esta rifa
        // (ya contiene solo los seleccionados al crear/editar la rifa,
        //  con sus series A/B copiadas desde cat_global_asignaciones)
        const precio_rifa = Number(rifa.precio) || 0;
        const vendR = await client.query(`
          SELECT
            nv.vendedor_id,
            u.nombre                                  AS vendedor_nombre,
            COUNT(nv.numero)::int                     AS total_numeros,
            STRING_AGG(DISTINCT nv.numero::text, ',' ORDER BY nv.numero::text) AS numeros_str,
            -- Series: si la columna serie existe la agrupamos, si no queda null
            COALESCE(
              JSON_AGG(
                JSON_BUILD_OBJECT(
                  'numero', nv.numero,
                  'serie',  COALESCE(nv.serie, 'A')
                )
                ORDER BY nv.numero, nv.serie
              ), '[]'
            ) AS series_detalle
          FROM numeros_vendedor nv
          JOIN users u ON u.id = nv.vendedor_id
          WHERE nv.rifa_id = $1
          GROUP BY nv.vendedor_id, u.nombre
          ORDER BY u.nombre
        `, [rifa.id]);

        for (const v of vendR.rows) {
          const monto_pendiente = v.total_numeros * precio_rifa;
          await client.query(`
            INSERT INTO caja_lotes
              (semana_id, vendedor_nombre, vendedor_id, numeros_fijos,
               cant_entregados, abono, numeros_asignados, por_pagar, estado)
            VALUES ($1,$2,$3,true,$4,0,$5,$6,'pendiente')
            ON CONFLICT DO NOTHING
          `, [semana.id, v.vendedor_nombre, v.vendedor_id, v.total_numeros, v.numeros_str, monto_pendiente]);
        }
      }
    }

    await client.query('COMMIT');

    res.json({
      rifa,
      semana,
      deudas_vencidas:    deudasVencidas,
      deudas_anteriores:  deudasAnteriores,
    });
  } catch (e) {
    console.error('/rifa-activa:', e);
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

/* ══════════════════════════════════════════════════════════
   POST /api/caja/rifa-activa/traspasar-deudas
   Marca los lotes vencidos como deuda_traspasada=true
   para que aparezcan en la siguiente rifa
══════════════════════════════════════════════════════════ */
router.post('/rifa-activa/traspasar-deudas', async (req, res) => {
  const { lote_ids } = req.body; // array de IDs a traspasar
  if (!Array.isArray(lote_ids) || !lote_ids.length)
    return res.status(400).json({ error: 'lote_ids requerido' });
  try {
    await pool.query(
      `UPDATE caja_lotes SET deuda_traspasada=true WHERE id = ANY($1::int[])`,
      [lote_ids]
    );
    res.json({ ok: true, traspasados: lote_ids.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ══════════════════════════════════════════════════════════
   SEMANAS
══════════════════════════════════════════════════════════ */

router.get('/semanas', async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM vista_caja_semanas ORDER BY created_at DESC`);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/semanas/:id', async (req, res) => {
  try {
    const [semanaR, lotesR] = await Promise.all([
      pool.query(`SELECT * FROM vista_caja_semanas WHERE id=$1`, [req.params.id]),
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
        WHERE l.semana_id=$1
        GROUP BY l.id
        ORDER BY l.direccion NULLS LAST, l.vendedor_nombre
      `, [req.params.id]),
    ]);

    if (!semanaR.rows[0]) return res.status(404).json({ error: 'Semana no encontrada' });

    const semana  = semanaR.rows[0];
    const numsPublicos = await getNumerosVendidosPublicoRifa(semana.rifa_id);

    const lotes = lotesR.rows.map(lote => {
      const asignados = parseNumsServer(lote.numeros_asignados || '');
      return {
        ...lote,
        numeros_vendidos_publico: asignados.filter(n => numsPublicos.includes(n)),
      };
    });

    res.json({ ...semana, lotes });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

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

router.delete('/semanas/:id', async (req, res) => {
  try {
    await pool.query(`DELETE FROM caja_semanas WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ══════════════════════════════════════════════════════════
   LOTES
══════════════════════════════════════════════════════════ */

router.post('/lotes', async (req, res) => {
  const {
    semana_id, vendedor_nombre, vendedor_id, direccion, numeros_fijos,
    cant_entregados, cant_vendidos, abono, numeros_asignados, observacion, por_pagar,
  } = req.body;
  if (!semana_id || !vendedor_nombre)
    return res.status(400).json({ error: 'semana_id y vendedor_nombre requeridos' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let monto_por_pagar = por_pagar || 0;
    if (!monto_por_pagar && numeros_asignados) {
      const nums  = parseNumsServer(numeros_asignados);
      const semR  = await client.query(
        `SELECT r.precio FROM caja_semanas s JOIN rifas r ON r.id=s.rifa_id WHERE s.id=$1`, [semana_id]
      );
      if (semR.rows[0]) monto_por_pagar = nums.length * Number(semR.rows[0].precio);
    }

    const abonoNum = Number(abono) || 0;
    const pendiente = Math.max(monto_por_pagar - abonoNum, 0);
    const estado = pendiente <= 0 && monto_por_pagar > 0 ? 'pagado'
                 : abonoNum > 0                           ? 'parcial'
                 : 'pendiente';

    const r = await client.query(`
      INSERT INTO caja_lotes
        (semana_id, vendedor_nombre, vendedor_id, direccion, numeros_fijos,
         cant_entregados, cant_vendidos, abono, pendiente, numeros_asignados, observacion, por_pagar, estado)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      RETURNING *
    `, [
      semana_id, vendedor_nombre.trim(), vendedor_id || null,
      direccion || null, numeros_fijos || false,
      cant_entregados || 0, cant_vendidos || 0,
      abonoNum, pendiente, numeros_asignados || null, observacion || null,
      monto_por_pagar, estado,
    ]);

    if (abonoNum > 0) {
      await client.query(
        `INSERT INTO caja_abonos (lote_id, monto, nota, registrado_por) VALUES ($1,$2,$3,$4)`,
        [r.rows[0].id, abonoNum, 'Abono inicial', req.user.id]
      );
    }

    await client.query('COMMIT');
    res.status(201).json(r.rows[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

router.put('/lotes/:id', async (req, res) => {
  const { vendedor_nombre, direccion, numeros_fijos, cant_entregados, cant_vendidos, numeros_asignados, observacion } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      UPDATE caja_lotes SET
        vendedor_nombre   = COALESCE($1, vendedor_nombre),
        direccion         = COALESCE($2, direccion),
        numeros_fijos     = COALESCE($3, numeros_fijos),
        cant_entregados   = COALESCE($4, cant_entregados),
        cant_vendidos     = COALESCE($5, cant_vendidos),
        numeros_asignados = COALESCE($6, numeros_asignados),
        observacion       = COALESCE($7, observacion)
      WHERE id=$8
    `, [vendedor_nombre, direccion, numeros_fijos, cant_entregados, cant_vendidos, numeros_asignados, observacion, req.params.id]);

    if (numeros_asignados !== undefined) {
      const semR = await client.query(
        `SELECT r.precio FROM caja_semanas s JOIN rifas r ON r.id=s.rifa_id
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
    if (!updated.rows[0]) return res.status(404).json({ error: 'Lote no encontrado' });
    res.json(updated.rows[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

/* PUT /lotes/:id/estado — toggle rápido */
router.put('/lotes/:id/estado', async (req, res) => {
  const { estado } = req.body;
  if (!['pagado','parcial','pendiente'].includes(estado))
    return res.status(400).json({ error: 'Estado inválido' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const loteR = await client.query(`SELECT * FROM caja_lotes WHERE id=$1`, [req.params.id]);
    if (!loteR.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Lote no encontrado' }); }

    const lote = loteR.rows[0];

    if (estado === 'pagado' && Number(lote.abono) < Number(lote.por_pagar)) {
      const faltante = Number(lote.por_pagar) - Number(lote.abono);
      await client.query(
        `UPDATE caja_lotes SET abono=por_pagar, pendiente=0, estado='pagado' WHERE id=$1`, [req.params.id]
      );
      await client.query(
        `INSERT INTO caja_abonos (lote_id, monto, nota, registrado_por) VALUES ($1,$2,$3,$4)`,
        [req.params.id, faltante, 'Marcado como pagado manualmente', req.user.id]
      );
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

/* PUT /lotes/:id/saldar-deuda-anterior — marca la deuda vieja como saldada */
router.put('/lotes/:id/saldar-deuda-anterior', async (req, res) => {
  try {
    const r = await pool.query(
      `UPDATE caja_lotes SET deuda_saldada=true, estado='pagado' WHERE id=$1 RETURNING *`,
      [req.params.id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Lote no encontrado' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/lotes/:id', async (req, res) => {
  try {
    await pool.query(`DELETE FROM caja_lotes WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ══════════════════════════════════════════════════════════
   ABONOS
══════════════════════════════════════════════════════════ */

router.post('/abonos', async (req, res) => {
  const { lote_id, monto, nota } = req.body;
  if (!lote_id || !monto || monto <= 0)
    return res.status(400).json({ error: 'lote_id y monto > 0 requeridos' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `INSERT INTO caja_abonos (lote_id, monto, nota, registrado_por) VALUES ($1,$2,$3,$4) RETURNING *`,
      [lote_id, monto, nota || null, req.user.id]
    );
    await client.query(`
      UPDATE caja_lotes
      SET abono = COALESCE(abono, 0) + $1
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

router.delete('/abonos/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ab = await client.query(`DELETE FROM caja_abonos WHERE id=$1 RETURNING *`, [req.params.id]);
    if (!ab.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Abono no encontrado' }); }

    const lote_id = ab.rows[0].lote_id;
    const totR = await client.query(`SELECT COALESCE(SUM(monto),0) AS total FROM caja_abonos WHERE lote_id=$1`, [lote_id]);
    await client.query(`UPDATE caja_lotes SET abono=$1 WHERE id=$2`, [totR.rows[0].total, lote_id]);
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
        COALESCE(direccion,'Sin zona') AS zona,
        COUNT(*)                       AS lotes,
        SUM(cant_entregados)           AS entregados,
        SUM(cant_vendidos)             AS vendidos,
        SUM(por_pagar)                 AS por_cobrar,
        SUM(abono)                     AS cobrado,
        SUM(pendiente)                 AS pendiente
      FROM caja_lotes
      WHERE semana_id=$1
      GROUP BY direccion
      ORDER BY SUM(por_pagar) DESC
    `, [req.params.id]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ══════════════════════════════════════════════════════════
   NÚMEROS VENDIDOS PÚBLICAMENTE
══════════════════════════════════════════════════════════ */
router.get('/semanas/:id/numeros-publico', async (req, res) => {
  try {
    const semR = await pool.query(`SELECT * FROM vista_caja_semanas WHERE id=$1`, [req.params.id]);
    if (!semR.rows[0]) return res.status(404).json({ error: 'Semana no encontrada' });

    const numsPublicos = await getNumerosVendidosPublicoRifa(semR.rows[0].rifa_id);
    const lotesR = await pool.query(
      `SELECT id, vendedor_nombre, numeros_asignados FROM caja_lotes WHERE semana_id=$1 ORDER BY vendedor_nombre`,
      [req.params.id]
    );

    const porVendedor = lotesR.rows.map(l => {
      const asignados  = parseNumsServer(l.numeros_asignados || '');
      return {
        lote_id:          l.id,
        vendedor_nombre:  l.vendedor_nombre,
        total_asignados:  asignados.length,
        vendidos_publico: asignados.filter(n => numsPublicos.includes(n)),
        pendientes:       asignados.filter(n => !numsPublicos.includes(n)),
      };
    });

    res.json({
      rifa_id:                      semR.rows[0].rifa_id,
      total_numeros_vendidos_publico: numsPublicos.length,
      numeros_vendidos_publico:     numsPublicos,
      por_vendedor:                 porVendedor,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ══════════════════════════════════════════════════════════
   IMPORTAR LOTES EN BULK
══════════════════════════════════════════════════════════ */
router.post('/semanas/:id/importar', async (req, res) => {
  const { lotes } = req.body;
  if (!Array.isArray(lotes) || !lotes.length)
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
        req.params.id, l.vendedor_nombre.trim(), l.direccion || null, l.numeros_fijos || false,
        l.cant_entregados || 0, l.cant_vendidos || 0, l.abono || 0,
        l.numeros_asignados || null, l.observacion || null,
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

module.exports = router;