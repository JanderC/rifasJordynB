// ============================================================
//  wa-flujo.js — CRUD de nodos y transiciones del guión/bot
// ============================================================
const express = require('express');
const router  = express.Router();
const pool    = require('../config/db');
const { authMiddleware, soloDueno } = require('../middleware/auth');

// ── GET /api/whatsapp/flujo ───────────────────────────────────
// Devuelve todos los nodos con sus transiciones
router.get('/', authMiddleware, soloDueno, async (req, res) => {
  try {
    const nodos = await pool.query(
      `SELECT n.id, n.nombre, n.descripcion, n.es_inicio, n.accion, n.orden, n.activo,
              n.created_at, n.updated_at,
              p.id AS plantilla_id, p.nombre AS plantilla_nombre, p.tipo AS plantilla_tipo,
              p.cuerpo AS plantilla_cuerpo, p.botones AS plantilla_botones
         FROM wa_flujo_nodos n
         LEFT JOIN wa_plantillas p ON p.id = n.plantilla_id
         ORDER BY n.orden, n.id`
    );

    const transiciones = await pool.query(
      `SELECT t.id, t.nodo_origen_id, t.nodo_destino_id,
              t.trigger_texto, t.trigger_payload, t.orden, t.activo,
              nd.nombre AS destino_nombre
         FROM wa_flujo_transiciones t
         JOIN wa_flujo_nodos nd ON nd.id = t.nodo_destino_id
         ORDER BY t.nodo_origen_id, t.orden`
    );

    // Agrupar transiciones por nodo origen
    const transPorNodo = {};
    transiciones.rows.forEach(t => {
      if (!transPorNodo[t.nodo_origen_id]) transPorNodo[t.nodo_origen_id] = [];
      transPorNodo[t.nodo_origen_id].push(t);
    });

    const result = nodos.rows.map(n => ({
      ...n,
      transiciones: transPorNodo[n.id] || [],
    }));

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/whatsapp/flujo/nodos ───────────────────────────
router.post('/nodos', authMiddleware, soloDueno, async (req, res) => {
  const { nombre, descripcion, es_inicio, plantilla_id, accion, orden } = req.body;
  if (!nombre) return res.status(400).json({ error: 'nombre es requerido' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Si es nodo inicio, desactivar el anterior
    if (es_inicio) {
      await client.query(`UPDATE wa_flujo_nodos SET es_inicio = false WHERE es_inicio = true`);
    }
    const r = await client.query(
      `INSERT INTO wa_flujo_nodos (nombre, descripcion, es_inicio, plantilla_id, accion, orden)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [nombre, descripcion || null, es_inicio || false, plantilla_id || null, accion || null, orden || 0]
    );
    await client.query('COMMIT');
    res.json({ ok: true, nodo: r.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ── PUT /api/whatsapp/flujo/nodos/:id ────────────────────────
router.put('/nodos/:id', authMiddleware, soloDueno, async (req, res) => {
  const { nombre, descripcion, es_inicio, plantilla_id, accion, orden, activo } = req.body;
  const { id } = req.params;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (es_inicio) {
      await client.query(`UPDATE wa_flujo_nodos SET es_inicio = false WHERE es_inicio = true AND id != $1`, [id]);
    }

    const sets = []; const values = []; let idx = 1;
    if (nombre       !== undefined) { sets.push(`nombre = $${idx++}`);       values.push(nombre); }
    if (descripcion  !== undefined) { sets.push(`descripcion = $${idx++}`);  values.push(descripcion); }
    if (es_inicio    !== undefined) { sets.push(`es_inicio = $${idx++}`);    values.push(es_inicio); }
    if (plantilla_id !== undefined) { sets.push(`plantilla_id = $${idx++}`); values.push(plantilla_id || null); }
    if (accion       !== undefined) { sets.push(`accion = $${idx++}`);       values.push(accion || null); }
    if (orden        !== undefined) { sets.push(`orden = $${idx++}`);        values.push(orden); }
    if (activo       !== undefined) { sets.push(`activo = $${idx++}`);       values.push(activo); }

    if (!sets.length) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Nada que actualizar' }); }

    values.push(id);
    const r = await client.query(
      `UPDATE wa_flujo_nodos SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );
    await client.query('COMMIT');
    if (!r.rows.length) return res.status(404).json({ error: 'Nodo no encontrado' });
    res.json({ ok: true, nodo: r.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ── DELETE /api/whatsapp/flujo/nodos/:id ─────────────────────
router.delete('/nodos/:id', authMiddleware, soloDueno, async (req, res) => {
  try {
    const r = await pool.query(
      `DELETE FROM wa_flujo_nodos WHERE id = $1 AND es_inicio = false RETURNING id, nombre`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(400).json({ error: 'No se puede eliminar: nodo no encontrado o es el nodo de inicio' });
    res.json({ ok: true, eliminado: r.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/whatsapp/flujo/transiciones ────────────────────
router.post('/transiciones', authMiddleware, soloDueno, async (req, res) => {
  const { nodo_origen_id, nodo_destino_id, trigger_texto, trigger_payload, orden } = req.body;
  if (!nodo_origen_id || !nodo_destino_id) {
    return res.status(400).json({ error: 'nodo_origen_id y nodo_destino_id son requeridos' });
  }
  try {
    const r = await pool.query(
      `INSERT INTO wa_flujo_transiciones (nodo_origen_id, nodo_destino_id, trigger_texto, trigger_payload, orden)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [nodo_origen_id, nodo_destino_id, trigger_texto || null, trigger_payload || null, orden || 0]
    );
    res.json({ ok: true, transicion: r.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/whatsapp/flujo/transiciones/:id ───────────────
router.delete('/transiciones/:id', authMiddleware, soloDueno, async (req, res) => {
  try {
    const r = await pool.query(
      `DELETE FROM wa_flujo_transiciones WHERE id = $1 RETURNING id`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Transición no encontrada' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/whatsapp/flujo/sesiones ─────────────────────────
router.get('/sesiones', authMiddleware, soloDueno, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT s.*, n.nombre AS nodo_nombre, r.nombre AS rifa_nombre
         FROM wa_sesiones s
         LEFT JOIN wa_flujo_nodos n ON n.id = s.nodo_actual_id
         LEFT JOIN rifas r ON r.id = s.rifa_id_selec
         ORDER BY s.ultimo_mensaje DESC
         LIMIT 100`
    );
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/whatsapp/flujo/logs ─────────────────────────────
router.get('/logs', authMiddleware, soloDueno, async (req, res) => {
  try {
    const { numero } = req.query;
    const values = [];
    let where = '';
    if (numero) { where = 'WHERE wa_numero = $1'; values.push(numero); }

    const r = await pool.query(
      `SELECT * FROM wa_mensajes_log ${where} ORDER BY created_at DESC LIMIT 200`,
      values
    );
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
