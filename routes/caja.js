// ============================================================
//   RIFAS JORDYN — Rutas: Módulo de Caja (v5)
//   Endpoint único /rifas/:rifaId/vendedores — fuente de verdad
//   + todas las rutas que usan otros módulos del sistema
// ============================================================
const router = require('express').Router();
const pool   = require('../config/db');
const { authMiddleware, soloDueno } = require('../middleware/auth');

router.use(authMiddleware, soloDueno);

/* ══════════════════════════════════════════════════════════
   HELPERS
══════════════════════════════════════════════════════════ */
async function recalcularLote(client, loteId) {
  const r = await client.query(
    `SELECT por_pagar, abono FROM caja_lotes WHERE id=$1 FOR UPDATE`, [loteId]
  );
  if (!r.rows[0]) return;
  const porPagar  = Number(r.rows[0].por_pagar || 0);
  const abono     = Number(r.rows[0].abono     || 0);
  const pendiente = Math.max(porPagar - abono, 0);
  const estado    = pendiente <= 0 && porPagar > 0 ? 'pagado'
                  : abono > 0                      ? 'parcial'
                  : 'pendiente';
  await client.query(
    `UPDATE caja_lotes SET pendiente=$1, estado=$2 WHERE id=$3`,
    [pendiente, estado, loteId]
  );
  return { porPagar, abono, pendiente, estado };
}

async function garantizarLote(client, rifaId, semanaId, vendedorId, vendedorNombre, porPagar) {
  let r = await client.query(
    `SELECT id, abono, por_pagar, pendiente, estado
     FROM caja_lotes WHERE semana_id=$1 AND vendedor_id=$2 LIMIT 1`,
    [semanaId, vendedorId]
  );
  if (r.rows[0]) {
    const lote = r.rows[0];
    const cR = await client.query(
      `SELECT cuadrado FROM caja_cuadre_vendedor WHERE rifa_id=$1 AND vendedor_id=$2`,
      [rifaId, vendedorId]
    );
    const cuadrado = cR.rows[0]?.cuadrado === true;
    if (!cuadrado && porPagar > 0 && Number(lote.por_pagar) !== porPagar) {
      await client.query(
        `UPDATE caja_lotes
         SET por_pagar=$1, pendiente=GREATEST($1 - COALESCE(abono,0), 0)
         WHERE id=$2`,
        [porPagar, lote.id]
      );
      lote.por_pagar = porPagar;
      lote.pendiente = Math.max(porPagar - Number(lote.abono || 0), 0);
    }
    return lote;
  }
  const n = await client.query(`
    INSERT INTO caja_lotes
      (semana_id, vendedor_nombre, vendedor_id, numeros_fijos,
       cant_entregados, abono, por_pagar, pendiente, estado)
    VALUES ($1,$2,$3,true,0,0,$4,$4,'pendiente')
    RETURNING id, abono, por_pagar, pendiente, estado
  `, [semanaId, vendedorNombre, vendedorId, porPagar]);
  return n.rows[0];
}

async function getSemana(client, rifaId, userId, rifaNombre) {
  const r = await client.query(
    `SELECT id FROM caja_semanas WHERE rifa_id=$1 ORDER BY created_at DESC LIMIT 1`, [rifaId]
  );
  if (r.rows[0]) return r.rows[0].id;
  const n = await client.query(`
    INSERT INTO caja_semanas (nombre, rifa_id, notas, created_by)
    VALUES ($1,$2,NULL,$3) RETURNING id
  `, [`Caja — ${rifaNombre}`, rifaId, userId]);
  return n.rows[0].id;
}

function parseNums(str) {
  if (!str) return [];
  const nums = new Set();
  String(str).split(',').forEach(p => {
    p = p.trim();
    if (p.includes('-')) {
      const [a, b] = p.split('-').map(Number);
      for (let i = a; i <= b; i++) nums.add(i);
    } else if (p !== '') {
      const n = Number(p);
      if (!isNaN(n)) nums.add(n);
    }
  });
  return [...nums].sort((a, b) => a - b);
}

/* ══════════════════════════════════════════════════════════
   SETUP TABLAS
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
        rifa_id          UUID NOT NULL REFERENCES rifas(id) ON DELETE CASCADE,
        vendedor_id      UUID NOT NULL,
        cuadrado         BOOLEAN NOT NULL DEFAULT FALSE,
        pendiente_flag   BOOLEAN NOT NULL DEFAULT FALSE,
        monto_cuadrado   NUMERIC(12,2),
        nums_cuadrados   INTEGER,
        monto_entregado  NUMERIC(12,2),
        notas            TEXT,
        updated_at       TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (rifa_id, vendedor_id)
      )
    `);
    for (const sql of [
      `ALTER TABLE caja_cuadre_vendedor ADD COLUMN IF NOT EXISTS pendiente_flag  BOOLEAN NOT NULL DEFAULT FALSE`,
      `ALTER TABLE caja_cuadre_vendedor ADD COLUMN IF NOT EXISTS monto_cuadrado  NUMERIC(12,2)`,
      `ALTER TABLE caja_cuadre_vendedor ADD COLUMN IF NOT EXISTS nums_cuadrados  INTEGER`,
      `ALTER TABLE caja_cuadre_vendedor ADD COLUMN IF NOT EXISTS monto_entregado NUMERIC(12,2)`,
    ]) { await pool.query(sql).catch(() => {}); }
  } catch (e) {
    console.error('[caja v5] setup:', e.message);
  }
})();

/* ══════════════════════════════════════════════════════════
   GET /api/caja/rifas/:rifaId/vendedores   ← NUEVO — fuente única
   Devuelve rifa + porcentaje + precio_boleto_efectivo +
   vendedores con lote + cuadre, TODO en una transacción.
══════════════════════════════════════════════════════════ */
router.get('/rifas/:rifaId/vendedores', async (req, res) => {
  const { rifaId } = req.params;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const rifaR = await client.query(`SELECT * FROM rifas WHERE id=$1`, [rifaId]);
    if (!rifaR.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Rifa no encontrada' }); }
    const rifa = rifaR.rows[0];
    const precioBoleto = Number(rifa.precio || 0);

    const cfgR = await client.query(`SELECT porcentaje FROM caja_rifa_config WHERE rifa_id=$1`, [rifaId]);
    const porcentaje = Number(cfgR.rows[0]?.porcentaje || 50);
    if (!cfgR.rows[0]) {
      await client.query(`INSERT INTO caja_rifa_config (rifa_id,porcentaje) VALUES ($1,50) ON CONFLICT DO NOTHING`, [rifaId]);
    }
    const precioEfectivo = precioBoleto > 0 ? +(precioBoleto * porcentaje / 100).toFixed(2) : 0;

    const semanaId = await getSemana(client, rifaId, req.user.id, rifa.nombre);

    // ── FUENTE ÚNICA DE VENDEDORES: rifa_vendedores_sel ──
    // Es la misma tabla que usa /api/rifas para listar vendedores de la
    // rifa (por eso ahí aparecían 69). Antes caja.js solo miraba
    // numeros_vendedor (fijos), perdiendo vendedores que solo tenían
    // extras o que aún no tenían ningún número cargado.
    // El conteo automático (fijos + extras) se trae aparte, solo como
    // referencia; nunca decide el por_pagar si hay un valor manual.
    const vendsR = await client.query(`
      SELECT
        rvs.vendedor_id::text,
        u.nombre AS vendedor_nombre,
        u.cedula,
        COALESCE(cnt.total_auto, 0)::int AS total_numeros_auto
      FROM rifa_vendedores_sel rvs
      JOIN users u ON u.id = rvs.vendedor_id
      LEFT JOIN (
        SELECT vendedor_id, COUNT(*)::int AS total_auto
        FROM numeros_vendedor_rifa_completo
        WHERE rifa_id = $1
        GROUP BY vendedor_id
      ) cnt ON cnt.vendedor_id = rvs.vendedor_id
      WHERE rvs.rifa_id = $1
      ORDER BY u.nombre
    `, [rifaId]);

    const cuadresR = await client.query(`
      SELECT vendedor_id::text, cuadrado, pendiente_flag,
             monto_cuadrado, nums_cuadrados, monto_entregado, notas,
             total_numeros_manual
      FROM caja_cuadre_vendedor WHERE rifa_id=$1
    `, [rifaId]);
    const cuadreMap = {};
    for (const row of cuadresR.rows) cuadreMap[row.vendedor_id] = row;

    const vendedores = [];
    for (const v of vendsR.rows) {
      const c = cuadreMap[v.vendedor_id] || {};
      // El número manual (si existe) manda sobre el conteo automático.
      const totalNumeros = c.total_numeros_manual != null
        ? Number(c.total_numeros_manual)
        : v.total_numeros_auto;
      const porPagar = precioEfectivo > 0 ? +(precioEfectivo * totalNumeros).toFixed(2) : 0;
      const lote = await garantizarLote(client, rifaId, semanaId, v.vendedor_id, v.vendedor_nombre, porPagar);
      vendedores.push({
        vendedor_id:          v.vendedor_id,
        vendedor_nombre:      v.vendedor_nombre,
        cedula:               v.cedula || null,
        total_numeros:        totalNumeros,
        total_numeros_auto:   v.total_numeros_auto,
        total_numeros_manual: c.total_numeros_manual ?? null,
        lote_id:              lote.id,
        por_pagar:            Number(lote.por_pagar  || 0),
        abono:                Number(lote.abono      || 0),
        pendiente:            Number(lote.pendiente  || 0),
        estado_lote:          lote.estado || 'pendiente',
        cuadrado:             c.cuadrado        || false,
        pendiente_flag:       c.pendiente_flag  || false,
        monto_cuadrado:       c.monto_cuadrado  ?? null,
        nums_cuadrados:       c.nums_cuadrados  ?? null,
        monto_entregado:      c.monto_entregado ?? null,
      });
    }

    await client.query('COMMIT');
    res.json({
      rifa, porcentaje,
      precio_boleto_original: precioBoleto,
      precio_boleto_efectivo: precioEfectivo,
      semana_id: semanaId,
      vendedores,
    });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[caja v5] /vendedores:', e);
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

/* ══════════════════════════════════════════════════════════
   GET /api/caja/rifas/:rifaId/lotes-vendedores  ← ALIAS LEGACY
   Retorna el mismo shape que esperaba el frontend viejo.
══════════════════════════════════════════════════════════ */
router.get('/rifas/:rifaId/lotes-vendedores', async (req, res) => {
  const { rifaId } = req.params;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const rifaR = await client.query(`SELECT id, precio FROM rifas WHERE id=$1`, [rifaId]);
    if (!rifaR.rows[0]) { await client.query('ROLLBACK'); return res.json({ semana_id: null, lotes: [] }); }
    const precioBoleto = Number(rifaR.rows[0].precio || 0);

    const cfgR = await client.query(`SELECT porcentaje FROM caja_rifa_config WHERE rifa_id=$1`, [rifaId]);
    const porcentaje = Number(cfgR.rows[0]?.porcentaje || 50);
    if (!cfgR.rows[0]) {
      await client.query(`INSERT INTO caja_rifa_config (rifa_id,porcentaje) VALUES ($1,50) ON CONFLICT DO NOTHING`, [rifaId]);
    }
    const precioConPct = precioBoleto > 0 ? +(precioBoleto * porcentaje / 100).toFixed(2) : 0;

    const semR = await client.query(
      `SELECT id FROM caja_semanas WHERE rifa_id=$1 ORDER BY created_at DESC LIMIT 1`, [rifaId]
    );
    if (!semR.rows[0]) {
      await client.query('ROLLBACK');
      return res.json({ semana_id: null, lotes: [], porcentaje, precio_con_pct: precioConPct });
    }
    const semanaId = semR.rows[0].id;

    const vendsR = await client.query(`
      SELECT
        rvs.vendedor_id::text,
        u.nombre AS vendedor_nombre,
        COALESCE(cnt.total_auto, 0)::int AS total_numeros_auto,
        ccv.total_numeros_manual
      FROM rifa_vendedores_sel rvs
      JOIN users u ON u.id = rvs.vendedor_id
      LEFT JOIN (
        SELECT vendedor_id, COUNT(*)::int AS total_auto
        FROM numeros_vendedor_rifa_completo WHERE rifa_id=$1 GROUP BY vendedor_id
      ) cnt ON cnt.vendedor_id = rvs.vendedor_id
      LEFT JOIN caja_cuadre_vendedor ccv ON ccv.rifa_id = rvs.rifa_id AND ccv.vendedor_id = rvs.vendedor_id
      WHERE rvs.rifa_id=$1
    `, [rifaId]);

    const cuadreR = await client.query(
      `SELECT vendedor_id::text, cuadrado FROM caja_cuadre_vendedor WHERE rifa_id=$1`, [rifaId]
    );
    const cuadreMap = {};
    for (const row of cuadreR.rows) cuadreMap[row.vendedor_id] = row.cuadrado;

    const lotes = [];
    for (const v of vendsR.rows) {
      const totalNumeros = v.total_numeros_manual != null ? Number(v.total_numeros_manual) : v.total_numeros_auto;
      const porPagar = precioConPct > 0 ? +(precioConPct * totalNumeros).toFixed(2) : 0;
      const lote = await garantizarLote(client, rifaId, semanaId, v.vendedor_id, v.vendedor_nombre, porPagar);
      const abono = Number(lote.abono || 0);
      const porPagarFinal = Number(lote.por_pagar || porPagar);
      const pendiente = Number(lote.pendiente ?? Math.max(porPagarFinal - abono, 0));
      lotes.push({
        lote_id: lote.id, vendedor_id: v.vendedor_id, vendedor_nombre: v.vendedor_nombre,
        por_pagar: porPagarFinal, precio_ticket: precioConPct,
        total_numeros: totalNumeros, abono, pendiente,
        estado: lote.estado || (pendiente <= 0 && porPagarFinal > 0 ? 'pagado' : abono > 0 ? 'parcial' : 'pendiente'),
      });
    }

    await client.query('COMMIT');
    res.json({ semana_id: semanaId, lotes, porcentaje, precio_con_pct: precioConPct });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[caja v5] /lotes-vendedores:', e);
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

/* ══════════════════════════════════════════════════════════
   GET /api/caja/rifas/:rifaId/cobro-vendedores  ← ALIAS LEGACY
   Shape completo igual al que usaba CajaRifa.js
══════════════════════════════════════════════════════════ */
router.get('/rifas/:rifaId/cobro-vendedores', async (req, res) => {
  const { rifaId } = req.params;
  const porcentajeParsed = Math.min(Math.max(Number(req.query.porcentaje) || 50, 1), 100);

  try {
    const rifaR = await pool.query(`SELECT * FROM rifas WHERE id=$1`, [rifaId]);
    if (!rifaR.rows[0]) return res.status(404).json({ error: 'Rifa no encontrada' });
    const rifa = rifaR.rows[0];

    const cfgR = await pool.query(`SELECT porcentaje FROM caja_rifa_config WHERE rifa_id=$1`, [rifaId]);
    const porcentaje = req.query.porcentaje ? porcentajeParsed : Number(cfgR.rows[0]?.porcentaje || 50);
    const precioBoleto = Number(rifa.precio || 0);
    const precioConPct = +(precioBoleto * porcentaje / 100).toFixed(2);

    const vendR = await pool.query(`
      SELECT nv.vendedor_id, u.nombre AS vendedor_nombre,
        JSON_AGG(JSON_BUILD_OBJECT(
          'numero', LPAD(nv.numero::text,3,'0'), 'serie', COALESCE(nv.serie,'A'), 'origen','fijo'
        ) ORDER BY nv.numero, nv.serie) AS numeros
      FROM numeros_vendedor nv JOIN users u ON u.id=nv.vendedor_id
      WHERE nv.rifa_id=$1 GROUP BY nv.vendedor_id, u.nombre ORDER BY u.nombre
    `, [rifaId]);

    const pagosR = await pool.query(
      `SELECT vendedor_id::text, numero, serie, pagado FROM caja_pagos_numero WHERE rifa_id=$1`, [rifaId]
    );
    const pagosMap = {};
    for (const p of pagosR.rows) pagosMap[`${p.vendedor_id}|${p.numero}|${p.serie}`] = p.pagado;

    const cuadreR = await pool.query(`
      SELECT vendedor_id::text, cuadrado, pendiente_flag,
             monto_cuadrado, nums_cuadrados, monto_entregado, notas
      FROM caja_cuadre_vendedor WHERE rifa_id=$1
    `, [rifaId]);
    const cuadreMap = {};
    for (const row of cuadreR.rows) cuadreMap[row.vendedor_id] = row;

    const vendedoresMap = {};
    for (const v of vendR.rows) {
      vendedoresMap[v.vendedor_id] = { vendedor_id: v.vendedor_id, vendedor_nombre: v.vendedor_nombre, numeros: v.numeros || [] };
    }

    const vendedores = Object.values(vendedoresMap).map(v => {
      const seen = new Set();
      const nums = [];
      for (const n of v.numeros) {
        const key = `${n.numero}|${n.serie}`;
        if (!seen.has(key)) {
          seen.add(key);
          const pk = `${v.vendedor_id}|${n.numero}|${n.serie}`;
          nums.push({ ...n, pagado: pagosMap[pk] === true });
        }
      }
      nums.sort((a, b) => a.numero.localeCompare(b.numero));
      const totalNums    = nums.length;
      const totalPagados = nums.filter(n => n.pagado).length;
      const c = cuadreMap[v.vendedor_id] || {};
      return {
        ...v, numeros: nums, total_numeros: totalNums, total_pagados: totalPagados,
        precio_por_num: precioConPct,
        total_cobrar:   +(precioConPct * totalNums).toFixed(2),
        cobrado:        +(precioConPct * totalPagados).toFixed(2),
        deuda:          +(precioConPct * (totalNums - totalPagados)).toFixed(2),
        cuadrado:        c.cuadrado        || false,
        pendiente_flag:  c.pendiente_flag  || false,
        monto_cuadrado:  c.monto_cuadrado  || null,
        nums_cuadrados:  c.nums_cuadrados  || null,
        monto_entregado: c.monto_entregado || null,
      };
    });

    res.json({ rifa, porcentaje, precio_boleto_original: precioBoleto, precio_boleto_efectivo: precioConPct, vendedores });
  } catch (e) {
    console.error('[caja v5] /cobro-vendedores:', e);
    res.status(500).json({ error: e.message });
  }
});

/* ══════════════════════════════════════════════════════════
   PUT /api/caja/rifas/:rifaId/porcentaje  ← NUEVO
   PUT /api/caja/rifas/:rifaId/cobro-vendedores/porcentaje ← ALIAS LEGACY
══════════════════════════════════════════════════════════ */
async function handleGuardarPorcentaje(req, res) {
  const { rifaId } = req.params;
  const pct = Number(req.body.porcentaje);
  if (!pct || pct < 1 || pct > 100)
    return res.status(400).json({ error: 'porcentaje debe estar entre 1 y 100' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      INSERT INTO caja_rifa_config (rifa_id, porcentaje, updated_at)
      VALUES ($1,$2,NOW())
      ON CONFLICT (rifa_id) DO UPDATE SET porcentaje=$2, updated_at=NOW()
    `, [rifaId, pct]);

    const rifaR = await client.query(`SELECT precio FROM rifas WHERE id=$1`, [rifaId]);
    const precio = Number(rifaR.rows[0]?.precio || 0);
    const precioEfectivo = precio > 0 ? +(precio * pct / 100).toFixed(2) : 0;

    if (precioEfectivo > 0) {
      const semR = await client.query(
        `SELECT id FROM caja_semanas WHERE rifa_id=$1 ORDER BY created_at DESC LIMIT 1`, [rifaId]
      );
      if (semR.rows[0]) {
        const semanaId = semR.rows[0].id;
        const cuadradosR = await client.query(
          `SELECT vendedor_id::text FROM caja_cuadre_vendedor WHERE rifa_id=$1 AND cuadrado=true`, [rifaId]
        );
        const cuadrados = new Set(cuadradosR.rows.map(r => r.vendedor_id));
        const vendsR = await client.query(`
          SELECT
            rvs.vendedor_id::text,
            COALESCE(cnt.total_auto, 0)::int AS total_auto,
            ccv.total_numeros_manual
          FROM rifa_vendedores_sel rvs
          LEFT JOIN (
            SELECT vendedor_id, COUNT(*)::int AS total_auto
            FROM numeros_vendedor_rifa_completo WHERE rifa_id=$1 GROUP BY vendedor_id
          ) cnt ON cnt.vendedor_id = rvs.vendedor_id
          LEFT JOIN caja_cuadre_vendedor ccv ON ccv.rifa_id = rvs.rifa_id AND ccv.vendedor_id = rvs.vendedor_id
          WHERE rvs.rifa_id=$1
        `, [rifaId]);
        for (const v of vendsR.rows) {
          if (cuadrados.has(v.vendedor_id)) continue;
          const total = v.total_numeros_manual != null ? Number(v.total_numeros_manual) : v.total_auto;
          const nuevoPorPagar = +(precioEfectivo * total).toFixed(2);
          await client.query(`
            UPDATE caja_lotes
            SET por_pagar=$1,
                pendiente=GREATEST($1 - COALESCE(abono,0), 0),
                estado=CASE
                  WHEN GREATEST($1 - COALESCE(abono,0),0) <= 0 AND $1 > 0 THEN 'pagado'
                  WHEN COALESCE(abono,0) > 0 THEN 'parcial'
                  ELSE 'pendiente' END
            WHERE semana_id=$2 AND vendedor_id=$3
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
  } finally { client.release(); }
}

router.put('/rifas/:rifaId/porcentaje', handleGuardarPorcentaje);
router.put('/rifas/:rifaId/cobro-vendedores/porcentaje', handleGuardarPorcentaje);

/* ══════════════════════════════════════════════════════════
   POST /api/caja/rifas/:rifaId/cobro-vendedores/:vendedorId/pagar-numero
   (usado por CajaRifa.js — pantalla de cobro por número)
══════════════════════════════════════════════════════════ */
router.post('/rifas/:rifaId/cobro-vendedores/:vendedorId/pagar-numero', async (req, res) => {
  const { rifaId, vendedorId } = req.params;
  const { numero, serie = 'A', pagado = true } = req.body;
  if (!numero) return res.status(400).json({ error: 'numero requerido' });
  try {
    const numPad = String(numero).padStart(3, '0');
    const pagado_at = pagado ? new Date() : null;
    await pool.query(`
      INSERT INTO caja_pagos_numero (rifa_id, vendedor_id, numero, serie, pagado, pagado_at)
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (rifa_id, vendedor_id, numero, serie) DO UPDATE SET pagado=$5, pagado_at=$6
    `, [rifaId, vendedorId, numPad, serie.toUpperCase(), pagado, pagado_at]);
    res.json({ ok: true, numero: numPad, serie, pagado });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ══════════════════════════════════════════════════════════
   PUT /api/caja/rifas/:rifaId/cuadre/:vendedorId
══════════════════════════════════════════════════════════ */
router.put('/rifas/:rifaId/cuadre/:vendedorId', async (req, res) => {
  const { rifaId, vendedorId } = req.params;
  const b = req.body || {};
  const numOrNull = v => (v === null || v === undefined || v === '' || isNaN(Number(v))) ? null : Number(v);
  const intOrNull = v => (v === null || v === undefined || v === '' || isNaN(parseInt(v))) ? null : parseInt(v, 10);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // total_numeros_manual es opcional: si no viene en el body, se
    // conserva el valor ya guardado (no se borra por accidente).
    const totalManual = Object.prototype.hasOwnProperty.call(b, 'total_numeros_manual')
      ? intOrNull(b.total_numeros_manual)
      : undefined;

    const r = await client.query(`
      INSERT INTO caja_cuadre_vendedor
        (rifa_id, vendedor_id, cuadrado, pendiente_flag, monto_cuadrado,
         nums_cuadrados, monto_entregado, notas, total_numeros_manual, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
      ON CONFLICT (rifa_id, vendedor_id) DO UPDATE SET
        cuadrado             = EXCLUDED.cuadrado,
        pendiente_flag       = EXCLUDED.pendiente_flag,
        monto_cuadrado       = EXCLUDED.monto_cuadrado,
        nums_cuadrados       = EXCLUDED.nums_cuadrados,
        monto_entregado      = EXCLUDED.monto_entregado,
        notas                = EXCLUDED.notas,
        total_numeros_manual = COALESCE($10, caja_cuadre_vendedor.total_numeros_manual),
        updated_at           = NOW()
      RETURNING *
    `, [rifaId, vendedorId, !!b.cuadrado, !!b.pendiente_flag,
        numOrNull(b.monto_cuadrado), intOrNull(b.nums_cuadrados),
        numOrNull(b.monto_entregado), b.notas ?? null,
        totalManual === undefined ? null : totalManual,
        totalManual === undefined ? null : totalManual]);

    const cuadre = r.rows[0];

    // Si se editó el número manual y el vendedor NO está cuadrado,
    // recalculamos por_pagar del lote actual de inmediato (no esperamos
    // a que se vuelva a abrir la pantalla).
    let lote = null;
    if (totalManual !== undefined && !cuadre.cuadrado) {
      const rifaR = await client.query(`SELECT precio FROM rifas WHERE id=$1`, [rifaId]);
      const cfgR  = await client.query(`SELECT porcentaje FROM caja_rifa_config WHERE rifa_id=$1`, [rifaId]);
      const precio     = Number(rifaR.rows[0]?.precio || 0);
      const porcentaje = Number(cfgR.rows[0]?.porcentaje || 50);
      const precioEfectivo = precio > 0 ? +(precio * porcentaje / 100).toFixed(2) : 0;
      const nuevoTotal = totalManual ?? 0;
      const nuevoPorPagar = +(precioEfectivo * nuevoTotal).toFixed(2);

      const loteR = await client.query(
        `SELECT id FROM caja_lotes WHERE semana_id=(
           SELECT id FROM caja_semanas WHERE rifa_id=$1 ORDER BY created_at DESC LIMIT 1
         ) AND vendedor_id=$2 LIMIT 1`,
        [rifaId, vendedorId]
      );
      if (loteR.rows[0]) {
        await client.query(`
          UPDATE caja_lotes
          SET por_pagar=$1, pendiente=GREATEST($1 - COALESCE(abono,0), 0)
          WHERE id=$2
        `, [nuevoPorPagar, loteR.rows[0].id]);
        const r2 = await recalcularLote(client, loteR.rows[0].id);
        lote = { id: loteR.rows[0].id, ...r2 };
      }
    }

    await client.query('COMMIT');
    res.json({ ok: true, cuadre, lote });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[caja v5] /cuadre:', e);
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

/* ══════════════════════════════════════════════════════════
   POST /api/caja/abonos
══════════════════════════════════════════════════════════ */
router.post('/abonos', async (req, res) => {
  const { lote_id, monto, nota } = req.body;
  if (!lote_id || !monto || Number(monto) <= 0)
    return res.status(400).json({ error: 'lote_id y monto > 0 requeridos' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const check = await client.query(`SELECT id FROM caja_lotes WHERE id=$1 FOR UPDATE`, [lote_id]);
    if (!check.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Lote no encontrado' }); }

    const abonoR = await client.query(
      `INSERT INTO caja_abonos (lote_id, monto, nota, registrado_por) VALUES ($1,$2,$3,$4) RETURNING *`,
      [lote_id, Number(monto), nota || 'Abono', req.user.id]
    );
    await client.query(`
      UPDATE caja_lotes
      SET abono = (SELECT COALESCE(SUM(monto),0) FROM caja_abonos WHERE lote_id=$1)
      WHERE id=$1
    `, [lote_id]);
    await recalcularLote(client, lote_id);
    await client.query('COMMIT');

    const loteR = await pool.query(`SELECT * FROM caja_lotes WHERE id=$1`, [lote_id]);
    res.status(201).json({ abono: abonoR.rows[0], lote: loteR.rows[0] });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[caja v5] /abonos:', e);
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

/* ══════════════════════════════════════════════════════════
   DELETE /api/caja/abonos/:id
══════════════════════════════════════════════════════════ */
router.delete('/abonos/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ab = await client.query(`DELETE FROM caja_abonos WHERE id=$1 RETURNING *`, [req.params.id]);
    if (!ab.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Abono no encontrado' }); }
    const lote_id = ab.rows[0].lote_id;
    await client.query(`
      UPDATE caja_lotes
      SET abono=(SELECT COALESCE(SUM(monto),0) FROM caja_abonos WHERE lote_id=$1)
      WHERE id=$1
    `, [lote_id]);
    await recalcularLote(client, lote_id);
    await client.query('COMMIT');
    const loteR = await pool.query(`SELECT * FROM caja_lotes WHERE id=$1`, [lote_id]);
    res.json({ ok: true, lote: loteR.rows[0] });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

/* ══════════════════════════════════════════════════════════
   GET /api/caja/rifa-activa
══════════════════════════════════════════════════════════ */
router.get('/rifa-activa', async (req, res) => {
  const client = await pool.connect();
  try {
    const rifaR = await client.query(`
      SELECT * FROM rifas
      WHERE activa=true AND fecha_sorteo IS NOT NULL AND fecha_sorteo::date >= CURRENT_DATE
      ORDER BY fecha_sorteo ASC LIMIT 1
    `);
    const rifa = rifaR.rows[0] || null;

    const vencR = await client.query(`
      SELECT l.id AS lote_id, l.vendedor_nombre, l.pendiente AS monto_pendiente,
             r.nombre AS rifa_nombre, r.id AS rifa_id, r.fecha_sorteo
      FROM caja_lotes l
      JOIN caja_semanas s ON s.id=l.semana_id
      JOIN rifas r ON r.id=s.rifa_id
      WHERE l.estado IN ('pendiente','parcial')
        AND l.deuda_traspasada IS NOT TRUE
        AND r.fecha_sorteo IS NOT NULL
        AND r.fecha_sorteo::date < (CURRENT_DATE - INTERVAL '3 days')
        AND ($1::uuid IS NULL OR r.id != $1::uuid)
      ORDER BY r.fecha_sorteo DESC, l.vendedor_nombre
    `, [rifa?.id || null]);

    let deudasAnteriores = [];
    if (rifa) {
      const antR = await client.query(`
        SELECT l.id AS lote_id, l.vendedor_nombre, l.pendiente AS monto_pendiente, r.nombre AS rifa_nombre
        FROM caja_lotes l
        JOIN caja_semanas s ON s.id=l.semana_id
        JOIN rifas r ON r.id=s.rifa_id
        WHERE l.deuda_traspasada=true AND l.deuda_saldada IS NOT TRUE AND r.id!=$1
        ORDER BY l.vendedor_nombre
      `, [rifa.id]);
      deudasAnteriores = antR.rows;
    }

    res.json({ rifa, deudas_vencidas: vencR.rows, deudas_anteriores: deudasAnteriores });
  } catch (e) {
    console.error('[caja v5] /rifa-activa:', e);
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

/* ══════════════════════════════════════════════════════════
   POST /api/caja/rifa-activa/traspasar-deudas
══════════════════════════════════════════════════════════ */
router.post('/rifa-activa/traspasar-deudas', async (req, res) => {
  const { lote_ids } = req.body;
  if (!Array.isArray(lote_ids) || !lote_ids.length)
    return res.status(400).json({ error: 'lote_ids requerido' });
  try {
    await pool.query(`UPDATE caja_lotes SET deuda_traspasada=true WHERE id=ANY($1::uuid[])`, [lote_ids]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ══════════════════════════════════════════════════════════
   PUT /api/caja/lotes/:id/saldar-deuda-anterior
══════════════════════════════════════════════════════════ */
router.put('/lotes/:id/saldar-deuda-anterior', async (req, res) => {
  try {
    const r = await pool.query(
      `UPDATE caja_lotes SET deuda_saldada=true, estado='pagado' WHERE id=$1 RETURNING *`, [req.params.id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Lote no encontrado' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ══════════════════════════════════════════════════════════
   SEMANAS (legacy — otros módulos las usan)
══════════════════════════════════════════════════════════ */
router.get('/semanas', async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM vista_caja_semanas ORDER BY created_at DESC`);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/semanas/:id', async (req, res) => {
  try {
    const [semR, lotesR] = await Promise.all([
      pool.query(`SELECT * FROM vista_caja_semanas WHERE id=$1`, [req.params.id]),
      pool.query(`
        SELECT l.*,
          COALESCE(json_agg(json_build_object('id',a.id,'monto',a.monto,'nota',a.nota,'fecha',a.created_at) ORDER BY a.created_at) FILTER (WHERE a.id IS NOT NULL), '[]') AS abonos_historial
        FROM caja_lotes l LEFT JOIN caja_abonos a ON a.lote_id=l.id
        WHERE l.semana_id=$1 GROUP BY l.id ORDER BY l.vendedor_nombre
      `, [req.params.id]),
    ]);
    if (!semR.rows[0]) return res.status(404).json({ error: 'Semana no encontrada' });
    res.json({ ...semR.rows[0], lotes: lotesR.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

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

router.delete('/semanas/:id', async (req, res) => {
  try {
    await pool.query(`DELETE FROM caja_semanas WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* LOTES CRUD */
router.put('/lotes/:id', async (req, res) => {
  const { vendedor_nombre, direccion, numeros_fijos, cant_entregados, cant_vendidos, numeros_asignados, observacion } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      UPDATE caja_lotes SET
        vendedor_nombre=COALESCE($1,vendedor_nombre), direccion=COALESCE($2,direccion),
        numeros_fijos=COALESCE($3,numeros_fijos), cant_entregados=COALESCE($4,cant_entregados),
        cant_vendidos=COALESCE($5,cant_vendidos), numeros_asignados=COALESCE($6,numeros_asignados),
        observacion=COALESCE($7,observacion) WHERE id=$8
    `, [vendedor_nombre, direccion, numeros_fijos, cant_entregados, cant_vendidos, numeros_asignados, observacion, req.params.id]);
    if (numeros_asignados !== undefined) {
      const semR = await client.query(
        `SELECT r.precio FROM caja_semanas s JOIN rifas r ON r.id=s.rifa_id
         WHERE s.id=(SELECT semana_id FROM caja_lotes WHERE id=$1)`, [req.params.id]
      );
      if (semR.rows[0]) {
        const nums = parseNums(numeros_asignados || '');
        await client.query(`UPDATE caja_lotes SET por_pagar=$1 WHERE id=$2`,
          [nums.length * Number(semR.rows[0].precio), req.params.id]);
      }
      await recalcularLote(client, req.params.id);
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

router.delete('/lotes/:id', async (req, res) => {
  try {
    await pool.query(`DELETE FROM caja_lotes WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/semanas/:id/por-zona', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT COALESCE(direccion,'Sin zona') AS zona, COUNT(*) AS lotes,
             SUM(cant_entregados) AS entregados, SUM(cant_vendidos) AS vendidos,
             SUM(por_pagar) AS por_cobrar, SUM(abono) AS cobrado, SUM(pendiente) AS pendiente
      FROM caja_lotes WHERE semana_id=$1 GROUP BY direccion ORDER BY SUM(por_pagar) DESC
    `, [req.params.id]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;