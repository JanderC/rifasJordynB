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

    // 1. Buscar la rifa activa más próxima a sortear
    const rifaR = await client.query(`
      SELECT *
      FROM rifas
      WHERE activa = true
        AND fecha_sorteo IS NOT NULL
        AND fecha_sorteo::date >= CURRENT_DATE
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

/* ══════════════════════════════════════════════════════════
   LOTES POR RIFA — devuelve todos los lotes de la semana
   activa de una rifa con por_pagar / abono / pendiente
   para que el frontend pueda construir el mapa de deudas
   sin depender del estado de detalleSemana.
   GET /api/caja/rifas/:rifaId/lotes-vendedores
   Devuelve: { semana_id, lotes: [{ lote_id, vendedor_id,
     vendedor_nombre, por_pagar, abono, pendiente, estado }] }
══════════════════════════════════════════════════════════ */
router.get('/rifas/:rifaId/lotes-vendedores', async (req, res) => {
  const { rifaId } = req.params;
  try {
    // Obtener semana más reciente de la rifa
    const semR = await pool.query(
      `SELECT id FROM caja_semanas WHERE rifa_id=$1 ORDER BY created_at DESC LIMIT 1`,
      [rifaId]
    );
    if (!semR.rows[0]) return res.json({ semana_id: null, lotes: [] });

    const semanaId = semR.rows[0].id;
    const lotesR = await pool.query(`
      SELECT
        l.id             AS lote_id,
        l.vendedor_id,
        l.vendedor_nombre,
        l.por_pagar,
        l.abono,
        l.pendiente,
        l.estado
      FROM caja_lotes l
      WHERE l.semana_id = $1
        AND l.vendedor_id IS NOT NULL
      ORDER BY l.vendedor_nombre
    `, [semanaId]);

    res.json({ semana_id: semanaId, lotes: lotesR.rows });
  } catch (e) {
    console.error('/rifas/:rifaId/lotes-vendedores:', e);
    res.status(500).json({ error: e.message });
  }
});

/* ══════════════════════════════════════════════════════════
   COBRO POR VENDEDOR — pantalla de cobro rifa individual
   ──────────────────────────────────────────────────────────
   GET  /api/caja/rifas/:rifaId/cobro-vendedores?porcentaje=50
        Devuelve todos los vendedores de la rifa con sus
        números (fijos + extras), precio por número al
        porcentaje indicado, y estado pagado por número.
   POST /api/caja/rifas/:rifaId/cobro-vendedores/:vendedorId/pagar-numero
        Body: { numero, serie, pagado: true|false }
        Marca/desmarca un número como pagado para ese vendedor.
   PUT  /api/caja/rifas/:rifaId/cobro-vendedores/porcentaje
        Body: { porcentaje: 50 }
        Guarda el porcentaje activo para esa rifa en caja_rifa_config.
══════════════════════════════════════════════════════════ */

/* ── Asegurar tabla caja_rifa_config y caja_pagos_numero ── */
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS caja_rifa_config (
        rifa_id   UUID PRIMARY KEY REFERENCES rifas(id) ON DELETE CASCADE,
        porcentaje NUMERIC(5,2) NOT NULL DEFAULT 50,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS caja_pagos_numero (
        id          SERIAL PRIMARY KEY,
        rifa_id     UUID NOT NULL REFERENCES rifas(id) ON DELETE CASCADE,
        vendedor_id UUID NOT NULL,
        numero      VARCHAR(10) NOT NULL,
        serie       VARCHAR(5)  NOT NULL DEFAULT 'A',
        pagado      BOOLEAN     NOT NULL DEFAULT FALSE,
        pagado_at   TIMESTAMPTZ,
        UNIQUE(rifa_id, vendedor_id, numero, serie)
      )
    `);
  } catch(e) {
    console.error('[caja] Error creando tablas cobro:', e.message);
  }
})();

/* GET /rifas/:rifaId/cobro-vendedores */
router.get('/rifas/:rifaId/cobro-vendedores', async (req, res) => {
  const { rifaId } = req.params;
  const porcentajeParsed = Math.min(Math.max(Number(req.query.porcentaje) || 50, 1), 100);

  try {
    // 1. Rifa
    const rifaR = await pool.query(`SELECT * FROM rifas WHERE id=$1`, [rifaId]);
    if (!rifaR.rows[0]) return res.status(404).json({ error: 'Rifa no encontrada' });
    const rifa = rifaR.rows[0];

    // 2. Config porcentaje guardado (si existe, lo usamos; query param gana)
    const cfgR = await pool.query(
      `SELECT porcentaje FROM caja_rifa_config WHERE rifa_id=$1`, [rifaId]
    );
    const porcentaje = req.query.porcentaje
      ? porcentajeParsed
      : Number(cfgR.rows[0]?.porcentaje || 50);

    const precioBoleto = Number(rifa.precio) || 0;
    const precioConPct = +(precioBoleto * porcentaje / 100).toFixed(2);

    // 3. Vendedores con números fijos desde numeros_vendedor
    const vendR = await pool.query(`
      SELECT
        nv.vendedor_id,
        u.nombre AS vendedor_nombre,
        JSON_AGG(
          JSON_BUILD_OBJECT(
            'numero', LPAD(nv.numero::text, 3, '0'),
            'serie',  COALESCE(nv.serie, 'A'),
            'origen', 'fijo'
          )
          ORDER BY nv.numero, nv.serie
        ) AS numeros
      FROM numeros_vendedor nv
      JOIN users u ON u.id = nv.vendedor_id
      WHERE nv.rifa_id = $1
      GROUP BY nv.vendedor_id, u.nombre
      ORDER BY u.nombre
    `, [rifaId]);

    // 4. Números extras desde caja_lotes (origen='extra')
    //    Los lotes con numeros_fijos=false tienen números extras asignados
    const extrasR = await pool.query(`
      SELECT
        l.vendedor_id,
        l.vendedor_nombre,
        l.numeros_asignados
      FROM caja_lotes l
      JOIN caja_semanas s ON s.id = l.semana_id
      WHERE s.rifa_id = $1
        AND l.numeros_fijos = false
        AND l.numeros_asignados IS NOT NULL
        AND l.numeros_asignados <> ''
    `, [rifaId]);

    // 5. Estados de pago por número
    const pagosR = await pool.query(
      `SELECT vendedor_id::text, numero, serie, pagado FROM caja_pagos_numero WHERE rifa_id=$1`,
      [rifaId]
    );
    const pagosMap = {};
    for (const p of pagosR.rows) {
      const key = `${p.vendedor_id}|${p.numero}|${p.serie}`;
      pagosMap[key] = p.pagado;
    }

    // 6. Combinar vendedores fijos + extras
    const vendedoresMap = {};

    for (const v of vendR.rows) {
      vendedoresMap[v.vendedor_id] = {
        vendedor_id:     v.vendedor_id,
        vendedor_nombre: v.vendedor_nombre,
        numeros:         v.numeros || [],
      };
    }

    for (const e of extrasR.rows) {
      if (!e.vendedor_id) continue;
      const vid = e.vendedor_id;
      if (!vendedoresMap[vid]) {
        vendedoresMap[vid] = {
          vendedor_id:     vid,
          vendedor_nombre: e.vendedor_nombre,
          numeros:         [],
        };
      }
      const extras = parseNumsServer(e.numeros_asignados).map(n => ({
        numero: String(n).padStart(3, '0'),
        serie:  'A',
        origen: 'extra',
      }));
      vendedoresMap[vid].numeros.push(...extras);
    }

    // 7. Deduplicar por numero+serie y agregar estado pagado
    const vendedores = Object.values(vendedoresMap).map(v => {
      const seen = new Set();
      const numsSinDup = [];
      for (const n of v.numeros) {
        const key = `${n.numero}|${n.serie}`;
        if (!seen.has(key)) {
          seen.add(key);
          const pagoKey = `${v.vendedor_id}|${n.numero}|${n.serie}`;
          numsSinDup.push({ ...n, pagado: pagosMap[pagoKey] === true });
        }
      }
      numsSinDup.sort((a, b) => a.numero.localeCompare(b.numero) || a.serie.localeCompare(b.serie));

      const totalNums    = numsSinDup.length;
      const totalPagados = numsSinDup.filter(n => n.pagado).length;
      const deuda        = +(precioConPct * (totalNums - totalPagados)).toFixed(2);
      const cobrado      = +(precioConPct * totalPagados).toFixed(2);

      return {
        ...v,
        numeros:        numsSinDup,
        total_numeros:  totalNums,
        total_pagados:  totalPagados,
        precio_por_num: precioConPct,
        total_cobrar:   +(precioConPct * totalNums).toFixed(2),
        cobrado,
        deuda,
      };
    });

    // 8. Cargar estado de cuadre por vendedor
    const cuadreR = await pool.query(
      `SELECT vendedor_id::text, cuadrado, pendiente_flag, monto_cuadrado, notas FROM caja_cuadre_vendedor WHERE rifa_id=$1`,
      [rifaId]
    );
    const cuadreMap = {};
    for (const row of cuadreR.rows) {
      cuadreMap[row.vendedor_id] = {
        cuadrado:       row.cuadrado,
        pendiente_flag: row.pendiente_flag,
        monto_cuadrado: row.monto_cuadrado,
        notas:          row.notas,
      };
    }

    // Agregar cuadre a cada vendedor
    const vendedoresConCuadre = vendedores.map(v => ({
      ...v,
      cuadrado:       cuadreMap[v.vendedor_id]?.cuadrado       || false,
      pendiente_flag: cuadreMap[v.vendedor_id]?.pendiente_flag || false,
      monto_cuadrado: cuadreMap[v.vendedor_id]?.monto_cuadrado || null,
      cuadre_notas:   cuadreMap[v.vendedor_id]?.notas          || null,
    }));

    res.json({
      rifa,
      porcentaje,
      precio_boleto_original: precioBoleto,
      precio_boleto_efectivo: precioConPct,
      vendedores: vendedoresConCuadre,
    });
  } catch (e) {
    console.error('/cobro-vendedores:', e);
    res.status(500).json({ error: e.message });
  }
});

/* POST /rifas/:rifaId/cobro-vendedores/:vendedorId/pagar-numero */
router.post('/rifas/:rifaId/cobro-vendedores/:vendedorId/pagar-numero', async (req, res) => {
  const { rifaId, vendedorId } = req.params;
  const { numero, serie = 'A', pagado = true } = req.body;
  if (!numero) return res.status(400).json({ error: 'numero requerido' });

  try {
    const numPad = String(numero).padStart(3, '0');
    const pagado_at = pagado ? new Date() : null;
    await pool.query(`
      INSERT INTO caja_pagos_numero (rifa_id, vendedor_id, numero, serie, pagado, pagado_at)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (rifa_id, vendedor_id, numero, serie)
      DO UPDATE SET pagado=$5, pagado_at=$6
    `, [rifaId, vendedorId, numPad, serie.toUpperCase(), pagado, pagado_at]);

    res.json({ ok: true, numero: numPad, serie, pagado });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* PUT /rifas/:rifaId/cobro-vendedores/porcentaje */
router.put('/rifas/:rifaId/cobro-vendedores/porcentaje', async (req, res) => {
  const { rifaId } = req.params;
  const { porcentaje } = req.body;
  if (!porcentaje || porcentaje <= 0 || porcentaje > 100)
    return res.status(400).json({ error: 'porcentaje debe estar entre 1 y 100' });

  try {
    await pool.query(`
      INSERT INTO caja_rifa_config (rifa_id, porcentaje, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (rifa_id) DO UPDATE SET porcentaje=$2, updated_at=NOW()
    `, [rifaId, porcentaje]);
    res.json({ ok: true, porcentaje });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ══════════════════════════════════════════════════════════
   CUADRE DE VENDEDOR — estado visual persistente
   Tabla: caja_cuadre_vendedor
     rifa_id, vendedor_id → cuadrado (bool), notas, updated_at
   GET  /rifas/:rifaId/cobro-vendedores  → ya incluye cuadrado en cada vendedor
   PUT  /rifas/:rifaId/cuadre/:vendedorId  { cuadrado: true|false, notas? }
══════════════════════════════════════════════════════════ */

/* ── Crear / migrar tabla caja_cuadre_vendedor ── */
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS caja_cuadre_vendedor (
        rifa_id         UUID        NOT NULL REFERENCES rifas(id) ON DELETE CASCADE,
        vendedor_id     UUID        NOT NULL,
        cuadrado        BOOLEAN     NOT NULL DEFAULT FALSE,
        pendiente_flag  BOOLEAN     NOT NULL DEFAULT FALSE,
        monto_cuadrado  NUMERIC(12,2),
        notas           TEXT,
        updated_at      TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (rifa_id, vendedor_id)
      )
    `);
    // Migración segura: agregar columnas si no existen
    await pool.query(`ALTER TABLE caja_cuadre_vendedor ADD COLUMN IF NOT EXISTS pendiente_flag BOOLEAN NOT NULL DEFAULT FALSE`);
    await pool.query(`ALTER TABLE caja_cuadre_vendedor ADD COLUMN IF NOT EXISTS monto_cuadrado NUMERIC(12,2)`);
  } catch (e) {
    console.error('[caja] Error creando tabla caja_cuadre_vendedor:', e.message);
  }
})();

/* PUT /rifas/:rifaId/cuadre/:vendedorId
   Body: { cuadrado, pendiente_flag, monto_cuadrado?, notas? }
   cuadrado=true      → vendedor cuadrado y cerrado con ese monto
   pendiente_flag=true → vendedor marcado como pendiente (prioritario)
   Ambos pueden coexistir, pero semánticamente son excluyentes en la UI */
router.put('/rifas/:rifaId/cuadre/:vendedorId', async (req, res) => {
  const { rifaId, vendedorId } = req.params;
  const {
    cuadrado       = false,
    pendiente_flag = false,
    monto_cuadrado = null,
    notas          = null,
  } = req.body;

  try {
    await pool.query(`
      INSERT INTO caja_cuadre_vendedor
        (rifa_id, vendedor_id, cuadrado, pendiente_flag, monto_cuadrado, notas, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
      ON CONFLICT (rifa_id, vendedor_id)
      DO UPDATE SET
        cuadrado       = $3,
        pendiente_flag = $4,
        monto_cuadrado = $5,
        notas          = $6,
        updated_at     = NOW()
    `, [rifaId, vendedorId, !!cuadrado, !!pendiente_flag, monto_cuadrado || null, notas]);

    res.json({
      ok: true,
      rifa_id:        rifaId,
      vendedor_id:    vendedorId,
      cuadrado:       !!cuadrado,
      pendiente_flag: !!pendiente_flag,
      monto_cuadrado: monto_cuadrado || null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;