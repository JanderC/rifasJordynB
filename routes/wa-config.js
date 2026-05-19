// ============================================================
//  wa-config.js — Credenciales Meta / WhatsApp Business
//  Guarda y expone la configuración del número de WA.
//  NUNCA envíes el access_token al frontend completo.
// ============================================================
const express = require('express');
const router  = express.Router();
const pool    = require('../config/db');
const { authMiddleware, soloDueno } = require('../middleware/auth');

// ── GET /api/whatsapp/config ──────────────────────────────────
// Devuelve la config activa (oculta token completo)
router.get('/', authMiddleware, soloDueno, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, nombre, phone_number_id, waba_id,
              LEFT(access_token, 12) || '••••••••••••' AS access_token_preview,
              verify_token, webhook_url, activo, created_at, updated_at
       FROM wa_config
       ORDER BY id DESC LIMIT 1`
    );
    res.json(r.rows[0] || null);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/whatsapp/config ─────────────────────────────────
// Crea o reemplaza la configuración activa
router.post('/', authMiddleware, soloDueno, async (req, res) => {
  const { nombre, phone_number_id, waba_id, access_token, verify_token, webhook_url } = req.body;

  if (!phone_number_id || !waba_id || !access_token || !verify_token) {
    return res.status(400).json({ error: 'Faltan campos obligatorios: phone_number_id, waba_id, access_token, verify_token' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Desactivar config anterior
    await client.query(`UPDATE wa_config SET activo = false`);
    // Insertar nueva
    const r = await client.query(
      `INSERT INTO wa_config (nombre, phone_number_id, waba_id, access_token, verify_token, webhook_url, activo)
       VALUES ($1, $2, $3, $4, $5, $6, true)
       RETURNING id, nombre, phone_number_id, waba_id, verify_token, webhook_url, activo, created_at`,
      [nombre || 'Principal', phone_number_id, waba_id, access_token, verify_token, webhook_url || null]
    );
    await client.query('COMMIT');
    res.json({ ok: true, config: r.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ── PUT /api/whatsapp/config/:id ──────────────────────────────
router.put('/:id', authMiddleware, soloDueno, async (req, res) => {
  const { id } = req.params;
  const { nombre, phone_number_id, waba_id, access_token, verify_token, webhook_url } = req.body;

  try {
    const sets   = [];
    const values = [];
    let   idx    = 1;

    if (nombre)          { sets.push(`nombre = $${idx++}`);          values.push(nombre); }
    if (phone_number_id) { sets.push(`phone_number_id = $${idx++}`); values.push(phone_number_id); }
    if (waba_id)         { sets.push(`waba_id = $${idx++}`);         values.push(waba_id); }
    if (access_token)    { sets.push(`access_token = $${idx++}`);    values.push(access_token); }
    if (verify_token)    { sets.push(`verify_token = $${idx++}`);    values.push(verify_token); }
    if (webhook_url !== undefined) { sets.push(`webhook_url = $${idx++}`); values.push(webhook_url); }

    if (!sets.length) return res.status(400).json({ error: 'Nada que actualizar' });

    values.push(id);
    const r = await pool.query(
      `UPDATE wa_config SET ${sets.join(', ')} WHERE id = $${idx} RETURNING id, nombre, phone_number_id, waba_id, verify_token, webhook_url, activo`,
      values
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Config no encontrada' });
    res.json({ ok: true, config: r.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/whatsapp/config/test ────────────────────────────
// Prueba el token enviando una petición a la API de Meta
router.post('/test', authMiddleware, soloDueno, async (req, res) => {
  try {
    const r = await pool.query(`SELECT phone_number_id, access_token FROM wa_config WHERE activo = true LIMIT 1`);
    if (!r.rows.length) return res.status(404).json({ error: 'No hay configuración activa' });

    const { phone_number_id, access_token } = r.rows[0];
    const resp = await fetch(
      `https://graph.facebook.com/v19.0/${phone_number_id}`,
      { headers: { Authorization: `Bearer ${access_token}` } }
    );
    const data = await resp.json();

    if (data.error) {
      return res.json({ ok: false, error: data.error.message });
    }
    res.json({ ok: true, telefono: data.display_phone_number, nombre: data.verified_name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
