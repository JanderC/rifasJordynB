// ============================================================
//   RIFAS JORDYN — Rutas: Módulo de Caja (v5 — refactored)
//
//   CAMBIOS CLAVE vs v4:
//   1. FUENTE ÚNICA DE VENDEDORES: el endpoint principal
//      /rifas/:rifaId/vendedores devuelve TODO en una sola
//      llamada — lista, lotes, cuadre, precio — eliminando
//      las 3 llamadas en paralelo que se desincronizaban.
//   2. CUADRE ROBUSTO: el PUT /cuadre/:vendedorId usa una
//      transacción atómica y devuelve el estado completo.
//   3. ABONO ATÓMICO: POST /abonos recalcula pendiente en
//      la misma transacción, nunca hay estado sucio.
//   4. LOTES AUTO-CREADOS CON VENDEDOR_ID: ya no depende
//      de búsqueda por nombre (fuente de duplicados).
//   5. SIN TABLAS LEGACY: no usa boleteria_numeros_extra
//      para la lista; la fuente es numeros_vendedor.
// ============================================================
const router = require('express').Router();
const pool   = require('../config/db');
const { authMiddleware, soloDueno } = require('../middleware/auth');

router.use(authMiddleware, soloDueno);

/* ══════════════════════════════════════════════════════════
   HELPERS
══════════════════════════════════════════════════════════ */

/** Recalcula pendiente y estado del lote dentro de una transacción */
async function recalcularLote(client, loteId) {
  const r = await client.query(
    `SELECT por_pagar, abono FROM caja_lotes WHERE id = $1 FOR UPDATE`,
    [loteId]
  );
  if (!r.rows[0]) return;
  const porPagar  = Number(r.rows[0].por_pagar || 0);
  const abono     = Number(r.rows[0].abono     || 0);
  const pendiente = Math.max(porPagar - abono, 0);
  const estado    = pendiente <= 0 && porPagar > 0 ? 'pagado'
                  : abono > 0                      ? 'parcial'
                  : 'pendiente';
  await client.query(
    `UPDATE caja_lotes SET pendiente = $1, estado = $2 WHERE id = $3`,
    [pendiente, estado, loteId]
  );
  return { porPagar, abono, pendiente, estado };
}

/** Garantiza que exista caja_semana + lote para el vendedor.
 *  Si no existe, los crea. Devuelve { semanaId, lote }. */
async function garantizarLoteVendedor(client, rifaId, vendedorId, vendedorNombre, porPagar, semanaId) {
  // Buscar lote por vendedor_id (fuente autoritativa)
  let loteR = await client.query(
    `SELECT id, abono, por_pagar, pendiente, estado
     FROM caja_lotes WHERE semana_id = $1 AND vendedor_id = $2 LIMIT 1`,
    [semanaId, vendedorId]
  );

  if (loteR.rows[0]) {
    const lote = loteR.rows[0];
    // Actualizar por_pagar si cambió el porcentaje (solo si no está cuadrado)
    const cuadreR = await client.query(
      `SELECT cuadrado FROM caja_cuadre_vendedor WHERE rifa_id = $1 AND vendedor_id = $2`,
      [rifaId, vendedorId]
    );
    const yaCuadrado = cuadreR.rows[0]?.cuadrado === true;
    if (!yaCuadrado && porPagar > 0 && Number(lote.por_pagar) !== porPagar) {
      await client.query(
        `UPDATE caja_lotes
         SET por_pagar = $1, pendiente = GREATEST($1 - COALESCE(abono, 0), 0)
         WHERE id = $2`,
        [porPagar, lote.id]
      );
      lote.por_pagar = porPagar;
      lote.pendiente = Math.max(porPagar - Number(lote.abono || 0), 0);
    }
    return lote;
  }

  // Crear nuevo lote
  const nuevoR = await client.query(`
    INSERT INTO caja_lotes
      (semana_id, vendedor_nombre, vendedor_id, numeros_fijos,
       cant_entregados, abono, por_pagar, pendiente, estado)
    VALUES ($1, $2, $3, true, 0, 0, $4, $4, 'pendiente')
    RETURNING id, abono, por_pagar, pendiente, estado
  `, [semanaId, vendedorNombre, vendedorId, porPagar]);

  return nuevoR.rows[0];
}

/* ══════════════════════════════════════════════════════════
   SETUP — crear tablas si no existen
══════════════════════════════════════════════════════════ */
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS caja_rifa_config (
        rifa_id    UUID PRIMARY KEY REFERENCES rifas(id) ON DELETE CASCADE,
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
    await pool.query(`
      CREATE TABLE IF NOT EXISTS caja_cuadre_vendedor (
        rifa_id          UUID        NOT NULL REFERENCES rifas(id) ON DELETE CASCADE,
        vendedor_id      UUID        NOT NULL,
        cuadrado         BOOLEAN     NOT NULL DEFAULT FALSE,
        pendiente_flag   BOOLEAN     NOT NULL DEFAULT FALSE,
        monto_cuadrado   NUMERIC(12,2),
        nums_cuadrados   INTEGER,
        monto_entregado  NUMERIC(12,2),
        notas            TEXT,
        updated_at       TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (rifa_id, vendedor_id)
      )
    `);
    // Migraciones seguras
    for (const col of [
      `ALTER TABLE caja_cuadre_vendedor ADD COLUMN IF NOT EXISTS pendiente_flag BOOLEAN NOT NULL DEFAULT FALSE`,
      `ALTER TABLE caja_cuadre_vendedor ADD COLUMN IF NOT EXISTS monto_cuadrado NUMERIC(12,2)`,
      `ALTER TABLE caja_cuadre_vendedor ADD COLUMN IF NOT EXISTS nums_cuadrados INTEGER`,
      `ALTER TABLE caja_cuadre_vendedor ADD COLUMN IF NOT EXISTS monto_entregado NUMERIC(12,2)`,
    ]) {
      await pool.query(col).catch(() => {});
    }
  } catch (e) {
    console.error('[caja v5] Error en setup:', e.message);
  }
})();

/* ══════════════════════════════════════════════════════════
   GET /api/caja/rifas/:rifaId/vendedores
   ──────────────────────────────────────────────────────────
   FUENTE ÚNICA — devuelve en una sola respuesta:
   {
     rifa,
     porcentaje,
     precio_boleto_original,
     precio_boleto_efectivo,
     semana_id,
     vendedores: [{
       vendedor_id, vendedor_nombre, cedula,
       total_numeros,
       por_pagar, abono, pendiente, lote_id,
       cuadrado, pendiente_flag, monto_cuadrado,
       nums_cuadrados, monto_entregado
     }]
   }
══════════════════════════════════════════════════════════ */
router.get('/rifas/:rifaId/vendedores', async (req, res) => {
  const { rifaId } = req.params;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Rifa
    const rifaR = await client.query(`SELECT * FROM rifas WHERE id = $1`, [rifaId]);
    if (!rifaR.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Rifa no encontrada' });
    }
    const rifa        = rifaR.rows[0];
    const precioBoleto = Number(rifa.precio || 0);

    // 2. Porcentaje
    const cfgR = await client.query(
      `SELECT porcentaje FROM caja_rifa_config WHERE rifa_id = $1`, [rifaId]
    );
    const porcentaje = Number(cfgR.rows[0]?.porcentaje || 50);
    if (!cfgR.rows[0]) {
      await client.query(
        `INSERT INTO caja_rifa_config (rifa_id, porcentaje) VALUES ($1, 50) ON CONFLICT DO NOTHING`,
        [rifaId]
      );
    }
    const precioEfectivo = precioBoleto > 0
      ? +(precioBoleto * porcentaje / 100).toFixed(2)
      : 0;

    // 3. Semana activa (crea si no existe)
    let semanaR = await client.query(
      `SELECT id FROM caja_semanas WHERE rifa_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [rifaId]
    );
    let semanaId;
    if (semanaR.rows[0]) {
      semanaId = semanaR.rows[0].id;
    } else {
      const nuevaS = await client.query(`
        INSERT INTO caja_semanas (nombre, rifa_id, notas, created_by)
        VALUES ($1, $2, NULL, $3) RETURNING id
      `, [`Caja — ${rifa.nombre}`, rifaId, req.user.id]);
      semanaId = nuevaS.rows[0].id;
    }

    // 4. Vendedores con números asignados (numeros_vendedor es la fuente)
    const vendsR = await client.query(`
      SELECT
        nv.vendedor_id::text,
        u.nombre      AS vendedor_nombre,
        u.cedula,
        COUNT(*)::int AS total_numeros
      FROM numeros_vendedor nv
      JOIN users u ON u.id = nv.vendedor_id
      WHERE nv.rifa_id = $1
      GROUP BY nv.vendedor_id, u.nombre, u.cedula
      ORDER BY u.nombre
    `, [rifaId]);

    // 5. Cuadres existentes
    const cuadresR = await client.query(`
      SELECT
        vendedor_id::text, cuadrado, pendiente_flag,
        monto_cuadrado, nums_cuadrados, monto_entregado, notas
      FROM caja_cuadre_vendedor
      WHERE rifa_id = $1
    `, [rifaId]);
    const cuadreMap = {};
    for (const row of cuadresR.rows) {
      cuadreMap[row.vendedor_id] = row;
    }

    // 6. Garantizar lote para cada vendedor y construir respuesta
    const vendedores = [];
    for (const v of vendsR.rows) {
      const porPagar = precioEfectivo > 0
        ? +(precioEfectivo * v.total_numeros).toFixed(2)
        : 0;

      const lote = await garantizarLoteVendedor(
        client, rifaId, v.vendedor_id, v.vendedor_nombre, porPagar, semanaId
      );

      const cuadre = cuadreMap[v.vendedor_id] || {};

      vendedores.push({
        vendedor_id:     v.vendedor_id,
        vendedor_nombre: v.vendedor_nombre,
        cedula:          v.cedula || null,
        total_numeros:   v.total_numeros,
        lote_id:         lote.id,
        por_pagar:       Number(lote.por_pagar  || 0),
        abono:           Number(lote.abono      || 0),
        pendiente:       Number(lote.pendiente  || 0),
        estado_lote:     lote.estado || 'pendiente',
        // cuadre
        cuadrado:        cuadre.cuadrado        || false,
        pendiente_flag:  cuadre.pendiente_flag  || false,
        monto_cuadrado:  cuadre.monto_cuadrado  ?? null,
        nums_cuadrados:  cuadre.nums_cuadrados  ?? null,
        monto_entregado: cuadre.monto_entregado ?? null,
      });
    }

    // 7. Incluir vendedores que solo tienen cuadre (sin números activos)
    const presentesIds = new Set(vendedores.map(v => v.vendedor_id));
    for (const [vid, cuadre] of Object.entries(cuadreMap)) {
      if (presentesIds.has(vid)) continue;
      const userR = await client.query(
        `SELECT nombre, cedula FROM users WHERE id = $1`, [vid]
      );
      if (!userR.rows[0]) continue;
      // Buscar lote existente
      const loteR = await client.query(
        `SELECT id, abono, por_pagar, pendiente, estado FROM caja_lotes
         WHERE semana_id = $1 AND vendedor_id = $2 LIMIT 1`,
        [semanaId, vid]
      );
      const lote = loteR.rows[0] || { id: null, abono: 0, por_pagar: 0, pendiente: 0, estado: 'pendiente' };
      vendedores.push({
        vendedor_id:     vid,
        vendedor_nombre: userR.rows[0].nombre,
        cedula:          userR.rows[0].cedula || null,
        total_numeros:   cuadre.nums_cuadrados || 0,
        lote_id:         lote.id,
        por_pagar:       Number(lote.por_pagar  || 0),
        abono:           Number(lote.abono      || 0),
        pendiente:       Number(lote.pendiente  || 0),
        estado_lote:     lote.estado || 'pendiente',
        cuadrado:        cuadre.cuadrado        || false,
        pendiente_flag:  cuadre.pendiente_flag  || false,
        monto_cuadrado:  cuadre.monto_cuadrado  ?? null,
        nums_cuadrados:  cuadre.nums_cuadrados  ?? null,
        monto_entregado: cuadre.monto_entregado ?? null,
      });
    }

    await client.query('COMMIT');

    res.json({
      rifa,
      porcentaje,
      precio_boleto_original: precioBoleto,
      precio_boleto_efectivo: precioEfectivo,
      semana_id: semanaId,
      vendedores,
    });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[caja v5] /vendedores:', e);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

/* ══════════════════════════════════════════════════════════
   PUT /api/caja/rifas/:rifaId/porcentaje
   Guarda porcentaje y recalcula todos los lotes abiertos.
══════════════════════════════════════════════════════════ */
router.put('/rifas/:rifaId/porcentaje', async (req, res) => {
  const { rifaId }    = req.params;
  const { porcentaje } = req.body;
  const pct = Number(porcentaje);
  if (!pct || pct < 1 || pct > 100)
    return res.status(400).json({ error: 'porcentaje debe estar entre 1 y 100' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Guardar config
    await client.query(`
      INSERT INTO caja_rifa_config (rifa_id, porcentaje, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (rifa_id) DO UPDATE SET porcentaje = $2, updated_at = NOW()
    `, [rifaId, pct]);

    // Precio efectivo nuevo
    const rifaR = await client.query(`SELECT precio FROM rifas WHERE id = $1`, [rifaId]);
    const precio = Number(rifaR.rows[0]?.precio || 0);
    const precioEfectivo = precio > 0 ? +(precio * pct / 100).toFixed(2) : 0;

    if (precioEfectivo > 0) {
      // Recalcular lotes NO cuadrados
      const semR = await client.query(
        `SELECT id FROM caja_semanas WHERE rifa_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [rifaId]
      );
      if (semR.rows[0]) {
        const semanaId = semR.rows[0].id;

        // Vendedores con cuadre activo — no tocar sus lotes
        const cuadradosR = await client.query(
          `SELECT vendedor_id::text FROM caja_cuadre_vendedor WHERE rifa_id = $1 AND cuadrado = true`,
          [rifaId]
        );
        const cuadradosIds = cuadradosR.rows.map(r => r.vendedor_id);

        const vendsR = await client.query(`
          SELECT nv.vendedor_id::text, COUNT(*)::int AS total
          FROM numeros_vendedor nv
          WHERE nv.rifa_id = $1
          GROUP BY nv.vendedor_id
        `, [rifaId]);

        for (const v of vendsR.rows) {
          if (cuadradosIds.includes(v.vendedor_id)) continue;
          const nuevoPorPagar = +(precioEfectivo * v.total).toFixed(2);
          await client.query(`
            UPDATE caja_lotes
            SET por_pagar = $1,
                pendiente = GREATEST($1 - COALESCE(abono, 0), 0),
                estado = CASE
                  WHEN GREATEST($1 - COALESCE(abono, 0), 0) <= 0 AND $1 > 0 THEN 'pagado'
                  WHEN COALESCE(abono, 0) > 0 THEN 'parcial'
                  ELSE 'pendiente'
                END
            WHERE semana_id = $2 AND vendedor_id = $3
          `, [nuevoPorPagar, semanaId, v.vendedor_id]);
        }
      }
    }

    await client.query('COMMIT');
    res.json({ ok: true, porcentaje: pct, precio_efectivo: precioEfectivo });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[caja v5] /porcentaje:', e);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

/* ══════════════════════════════════════════════════════════
   PUT /api/caja/rifas/:rifaId/cuadre/:vendedorId
   Guarda el cuadre de forma atómica.
   Body: { cuadrado, pendiente_flag, monto_cuadrado?,
           nums_cuadrados?, monto_entregado?, notas? }
══════════════════════════════════════════════════════════ */
router.put('/rifas/:rifaId/cuadre/:vendedorId', async (req, res) => {
  const { rifaId, vendedorId } = req.params;
  const b = req.body || {};

  const numOrNull = v => (v === null || v === undefined || v === '' || isNaN(Number(v))) ? null : Number(v);
  const intOrNull = v => (v === null || v === undefined || v === '' || isNaN(parseInt(v))) ? null : parseInt(v, 10);

  const cuadrado        = !!b.cuadrado;
  const pendiente_flag  = !!b.pendiente_flag;
  const monto_cuadrado  = numOrNull(b.monto_cuadrado);
  const nums_cuadrados  = intOrNull(b.nums_cuadrados);
  const monto_entregado = numOrNull(b.monto_entregado);
  const notas           = b.notas ?? null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const r = await client.query(`
      INSERT INTO caja_cuadre_vendedor
        (rifa_id, vendedor_id, cuadrado, pendiente_flag, monto_cuadrado,
         nums_cuadrados, monto_entregado, notas, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
      ON CONFLICT (rifa_id, vendedor_id) DO UPDATE SET
        cuadrado        = EXCLUDED.cuadrado,
        pendiente_flag  = EXCLUDED.pendiente_flag,
        monto_cuadrado  = EXCLUDED.monto_cuadrado,
        nums_cuadrados  = EXCLUDED.nums_cuadrados,
        monto_entregado = EXCLUDED.monto_entregado,
        notas           = EXCLUDED.notas,
        updated_at      = NOW()
      RETURNING *
    `, [rifaId, vendedorId, cuadrado, pendiente_flag, monto_cuadrado,
        nums_cuadrados, monto_entregado, notas]);

    await client.query('COMMIT');
    res.json({ ok: true, cuadre: r.rows[0] });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[caja v5] /cuadre PUT:', e);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

/* ══════════════════════════════════════════════════════════
   POST /api/caja/abonos
   Registra un abono y recalcula el lote atómicamente.
══════════════════════════════════════════════════════════ */
router.post('/abonos', async (req, res) => {
  const { lote_id, monto, nota } = req.body;
  if (!lote_id || !monto || Number(monto) <= 0)
    return res.status(400).json({ error: 'lote_id y monto > 0 requeridos' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Verificar lote existe
    const loteCheck = await client.query(`SELECT id FROM caja_lotes WHERE id = $1 FOR UPDATE`, [lote_id]);
    if (!loteCheck.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Lote no encontrado' });
    }

    // Insertar abono
    const abonoR = await client.query(
      `INSERT INTO caja_abonos (lote_id, monto, nota, registrado_por) VALUES ($1, $2, $3, $4) RETURNING *`,
      [lote_id, Number(monto), nota || 'Abono', req.user.id]
    );

    // Actualizar abono acumulado en lote (recalcular desde suma real)
    await client.query(`
      UPDATE caja_lotes
      SET abono = (SELECT COALESCE(SUM(monto), 0) FROM caja_abonos WHERE lote_id = $1)
      WHERE id = $1
    `, [lote_id]);

    const loteActualizado = await recalcularLote(client, lote_id);

    await client.query('COMMIT');

    const loteR = await pool.query(`SELECT * FROM caja_lotes WHERE id = $1`, [lote_id]);
    res.status(201).json({ abono: abonoR.rows[0], lote: loteR.rows[0] });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[caja v5] /abonos POST:', e);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

/* ══════════════════════════════════════════════════════════
   GET /api/caja/rifa-activa
   Rifa más próxima + deudas vencidas + deudas anteriores.
══════════════════════════════════════════════════════════ */
router.get('/rifa-activa', async (req, res) => {
  const client = await pool.connect();
  try {
    // Rifa activa más próxima
    const rifaR = await client.query(`
      SELECT * FROM rifas
      WHERE activa = true
        AND fecha_sorteo IS NOT NULL
        AND fecha_sorteo::date >= CURRENT_DATE
      ORDER BY fecha_sorteo ASC
      LIMIT 1
    `);
    const rifa = rifaR.rows[0] || null;

    // Deudas vencidas (sorteo hace >3 días, lotes pendientes sin traspasar)
    const vencR = await client.query(`
      SELECT
        l.id            AS lote_id,
        l.vendedor_nombre,
        l.pendiente     AS monto_pendiente,
        r.nombre        AS rifa_nombre,
        r.id            AS rifa_id,
        r.fecha_sorteo
      FROM caja_lotes l
      JOIN caja_semanas s ON s.id = l.semana_id
      JOIN rifas r        ON r.id = s.rifa_id
      WHERE l.estado IN ('pendiente','parcial')
        AND l.deuda_traspasada IS NOT TRUE
        AND r.fecha_sorteo IS NOT NULL
        AND r.fecha_sorteo::date < (CURRENT_DATE - INTERVAL '3 days')
        AND ($1::uuid IS NULL OR r.id != $1::uuid)
      ORDER BY r.fecha_sorteo DESC, l.vendedor_nombre
    `, [rifa?.id || null]);

    // Deudas anteriores ya traspasadas
    let deudasAnteriores = [];
    if (rifa) {
      const antR = await client.query(`
        SELECT
          l.id            AS lote_id,
          l.vendedor_nombre,
          l.pendiente     AS monto_pendiente,
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

    res.json({
      rifa,
      deudas_vencidas:   vencR.rows,
      deudas_anteriores: deudasAnteriores,
    });
  } catch (e) {
    console.error('[caja v5] /rifa-activa:', e);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

/* ══════════════════════════════════════════════════════════
   POST /api/caja/rifa-activa/traspasar-deudas
══════════════════════════════════════════════════════════ */
router.post('/rifa-activa/traspasar-deudas', async (req, res) => {
  const { lote_ids } = req.body;
  if (!Array.isArray(lote_ids) || !lote_ids.length)
    return res.status(400).json({ error: 'lote_ids requerido' });
  try {
    await pool.query(
      `UPDATE caja_lotes SET deuda_traspasada = true WHERE id = ANY($1::uuid[])`,
      [lote_ids]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ══════════════════════════════════════════════════════════
   PUT /api/caja/lotes/:id/saldar-deuda-anterior
══════════════════════════════════════════════════════════ */
router.put('/lotes/:id/saldar-deuda-anterior', async (req, res) => {
  try {
    const r = await pool.query(
      `UPDATE caja_lotes SET deuda_saldada = true, estado = 'pagado' WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Lote no encontrado' });
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ══════════════════════════════════════════════════════════
   DELETE /api/caja/abonos/:id
══════════════════════════════════════════════════════════ */
router.delete('/abonos/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ab = await client.query(
      `DELETE FROM caja_abonos WHERE id = $1 RETURNING *`, [req.params.id]
    );
    if (!ab.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Abono no encontrado' });
    }
    const lote_id = ab.rows[0].lote_id;
    await client.query(`
      UPDATE caja_lotes
      SET abono = (SELECT COALESCE(SUM(monto), 0) FROM caja_abonos WHERE lote_id = $1)
      WHERE id = $1
    `, [lote_id]);
    await recalcularLote(client, lote_id);
    await client.query('COMMIT');
    const loteR = await pool.query(`SELECT * FROM caja_lotes WHERE id = $1`, [lote_id]);
    res.json({ ok: true, lote: loteR.rows[0] });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

/* ══════════════════════════════════════════════════════════
   ENDPOINTS LEGACY (mantenidos para compatibilidad)
══════════════════════════════════════════════════════════ */

// GET semanas
router.get('/semanas', async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM vista_caja_semanas ORDER BY created_at DESC`);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT semanas/:id
router.put('/semanas/:id', async (req, res) => {
  const { nombre, estado, notas } = req.body;
  try {
    const r = await pool.query(
      `UPDATE caja_semanas SET nombre=COALESCE($1,nombre), estado=COALESCE($2,estado), notas=COALESCE($3,notas) WHERE id=$4 RETURNING *`,
      [nombre, estado, notas, req.params.id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Semana no encontrada' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;