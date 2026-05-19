// ============================================================
//  wa-plantillas.js — CRUD de plantillas de mensajes
//  Tipos: text | image | video | image_text | button
// ============================================================
const express = require('express');
const router  = express.Router();
const pool    = require('../config/db');
const { authMiddleware, soloDueno } = require('../middleware/auth');

// ── GET /api/whatsapp/plantillas ─────────────────────────────
router.get('/', authMiddleware, soloDueno, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT p.id, p.nombre, p.tipo, p.cuerpo, p.pie, p.botones, p.activa,
              p.created_at, p.updated_at,
              m.url_publica AS media_url, m.tipo AS media_tipo, m.nombre AS media_nombre
         FROM wa_plantillas p
         LEFT JOIN wa_media m ON m.id = p.media_id
         ORDER BY p.id DESC`
    );
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/whatsapp/plantillas/:id ─────────────────────────
router.get('/:id', authMiddleware, soloDueno, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT p.*, m.url_publica AS media_url, m.tipo AS media_tipo
         FROM wa_plantillas p
         LEFT JOIN wa_media m ON m.id = p.media_id
         WHERE p.id = $1`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Plantilla no encontrada' });
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/whatsapp/plantillas ────────────────────────────
router.post('/', authMiddleware, soloDueno, async (req, res) => {
  const { nombre, tipo, cuerpo, pie, media_id, botones } = req.body;

  if (!nombre || !tipo) {
    return res.status(400).json({ error: 'nombre y tipo son requeridos' });
  }

  const tiposValidos = ['text','image','video','image_text','button'];
  if (!tiposValidos.includes(tipo)) {
    return res.status(400).json({ error: `tipo inválido. Valores: ${tiposValidos.join(', ')}` });
  }

  // Validar botones
  let botonesArr = [];
  if (botones) {
    try {
      botonesArr = typeof botones === 'string' ? JSON.parse(botones) : botones;
      if (!Array.isArray(botonesArr)) throw new Error();
      if (botonesArr.length > 3) {
        return res.status(400).json({ error: 'Máximo 3 botones por mensaje interactivo' });
      }
      for (const b of botonesArr) {
        if (!b.id || !b.titulo) return res.status(400).json({ error: 'Cada botón necesita id y titulo' });
      }
    } catch {
      return res.status(400).json({ error: 'botones debe ser un array JSON válido' });
    }
  }

  try {
    const r = await pool.query(
      `INSERT INTO wa_plantillas (nombre, tipo, cuerpo, pie, media_id, botones, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [nombre, tipo, cuerpo || null, pie || null, media_id || null, JSON.stringify(botonesArr), req.user.id]
    );
    res.json({ ok: true, plantilla: r.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Ya existe una plantilla con ese nombre' });
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/whatsapp/plantillas/:id ─────────────────────────
router.put('/:id', authMiddleware, soloDueno, async (req, res) => {
  const { nombre, tipo, cuerpo, pie, media_id, botones, activa } = req.body;
  const { id } = req.params;

  const sets   = [];
  const values = [];
  let   idx    = 1;

  if (nombre   !== undefined) { sets.push(`nombre = $${idx++}`);   values.push(nombre); }
  if (tipo     !== undefined) { sets.push(`tipo = $${idx++}`);     values.push(tipo); }
  if (cuerpo   !== undefined) { sets.push(`cuerpo = $${idx++}`);   values.push(cuerpo); }
  if (pie      !== undefined) { sets.push(`pie = $${idx++}`);      values.push(pie); }
  if (media_id !== undefined) { sets.push(`media_id = $${idx++}`); values.push(media_id || null); }
  if (activa   !== undefined) { sets.push(`activa = $${idx++}`);   values.push(activa); }
  if (botones  !== undefined) {
    const arr = typeof botones === 'string' ? JSON.parse(botones) : botones;
    sets.push(`botones = $${idx++}`);
    values.push(JSON.stringify(arr));
  }

  if (!sets.length) return res.status(400).json({ error: 'Nada que actualizar' });

  values.push(id);
  try {
    const r = await pool.query(
      `UPDATE wa_plantillas SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Plantilla no encontrada' });
    res.json({ ok: true, plantilla: r.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/whatsapp/plantillas/:id ──────────────────────
router.delete('/:id', authMiddleware, soloDueno, async (req, res) => {
  try {
    // Verificar si algún nodo usa esta plantilla
    const uso = await pool.query(
      `SELECT COUNT(*) FROM wa_flujo_nodos WHERE plantilla_id = $1`,
      [req.params.id]
    );
    if (parseInt(uso.rows[0].count) > 0) {
      return res.status(409).json({ error: 'Esta plantilla está en uso por uno o más nodos del flujo' });
    }
    const r = await pool.query(
      `DELETE FROM wa_plantillas WHERE id = $1 RETURNING id, nombre`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Plantilla no encontrada' });
    res.json({ ok: true, eliminada: r.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
