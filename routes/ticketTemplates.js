const express = require('express');
const router  = express.Router();
const pool    = require('../config/db');
const { authMiddleware, soloDueno } = require('../middleware/auth');

// ── Helpers ───────────────────────────────────────────────
const validateDesign = (design) => {
  if (!design || typeof design !== 'object' || Array.isArray(design)) {
    return 'design debe ser un objeto JSON';
  }
  return null;
};

// ── GET /api/ticket-templates ─────────────────────────────
// Pública: la consume el form de rifas para mostrar el selector
router.get('/', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT t.id, t.nombre, t.descripcion, t.design,
              t.is_default, t.created_at, t.updated_at,
              u.id AS created_by_id
       FROM ticket_templates t
       LEFT JOIN users u ON u.id = t.created_by
       ORDER BY t.is_default DESC, t.updated_at DESC`
    );
    res.json(r.rows);
  } catch (err) {
    console.error('Error listando plantillas:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ── GET /api/ticket-templates/:id ─────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, nombre, descripcion, design, is_default,
              created_at, updated_at
       FROM ticket_templates WHERE id = $1`,
      [req.params.id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Plantilla no encontrada' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error('Error obteniendo plantilla:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ── POST /api/ticket-templates ────────────────────────────
router.post('/', authMiddleware, soloDueno, async (req, res) => {
  const { nombre, descripcion, design, is_default } = req.body;

  if (!nombre || !nombre.trim()) {
    return res.status(400).json({ error: 'El nombre es requerido' });
  }
  const err = validateDesign(design);
  if (err) return res.status(400).json({ error: err });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Si va a ser default, quitar el flag a los demás
    if (is_default) {
      await client.query('UPDATE ticket_templates SET is_default = FALSE WHERE is_default = TRUE');
    }

    const r = await client.query(
      `INSERT INTO ticket_templates (nombre, descripcion, design, is_default, created_by)
       VALUES ($1, $2, $3::jsonb, $4, $5)
       RETURNING id, nombre, descripcion, design, is_default, created_at, updated_at`,
      [
        nombre.trim(),
        descripcion || null,
        JSON.stringify(design),
        !!is_default,
        req.user.id,
      ]
    );

    await client.query('COMMIT');
    res.status(201).json(r.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error creando plantilla:', err);
    res.status(500).json({ error: 'Error del servidor' });
  } finally {
    client.release();
  }
});

// ── PUT /api/ticket-templates/:id ─────────────────────────
router.put('/:id', authMiddleware, soloDueno, async (req, res) => {
  const { nombre, descripcion, design, is_default } = req.body;

  if (!nombre || !nombre.trim()) {
    return res.status(400).json({ error: 'El nombre es requerido' });
  }
  const err = validateDesign(design);
  if (err) return res.status(400).json({ error: err });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (is_default) {
      await client.query(
        'UPDATE ticket_templates SET is_default = FALSE WHERE is_default = TRUE AND id <> $1',
        [req.params.id]
      );
    }

    const r = await client.query(
      `UPDATE ticket_templates
       SET nombre      = $1,
           descripcion = $2,
           design      = $3::jsonb,
           is_default  = $4,
           updated_at  = NOW()
       WHERE id = $5
       RETURNING id, nombre, descripcion, design, is_default, created_at, updated_at`,
      [
        nombre.trim(),
        descripcion || null,
        JSON.stringify(design),
        !!is_default,
        req.params.id,
      ]
    );

    if (!r.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Plantilla no encontrada' });
    }

    await client.query('COMMIT');
    res.json(r.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error actualizando plantilla:', err);
    res.status(500).json({ error: 'Error del servidor' });
  } finally {
    client.release();
  }
});

// ── DELETE /api/ticket-templates/:id ──────────────────────
router.delete('/:id', authMiddleware, soloDueno, async (req, res) => {
  try {
    // No permitir borrar la default
    const chk = await pool.query(
      'SELECT is_default FROM ticket_templates WHERE id = $1',
      [req.params.id]
    );
    if (!chk.rows[0]) return res.status(404).json({ error: 'Plantilla no encontrada' });
    if (chk.rows[0].is_default) {
      return res.status(400).json({
        error: 'No se puede eliminar la plantilla por defecto. Marca otra como default primero.',
      });
    }

    // Las rifas que apunten a esta plantilla quedarán con NULL (ON DELETE SET NULL)
    await pool.query('DELETE FROM ticket_templates WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Error eliminando plantilla:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ── POST /api/ticket-templates/:id/duplicate ──────────────
router.post('/:id/duplicate', authMiddleware, soloDueno, async (req, res) => {
  try {
    const orig = await pool.query(
      'SELECT nombre, descripcion, design FROM ticket_templates WHERE id = $1',
      [req.params.id]
    );
    if (!orig.rows[0]) return res.status(404).json({ error: 'Plantilla no encontrada' });

    const o = orig.rows[0];
    const nuevoNombre = `${o.nombre} (copia)`;

    const r = await pool.query(
      `INSERT INTO ticket_templates (nombre, descripcion, design, is_default, created_by)
       VALUES ($1, $2, $3, FALSE, $4)
       RETURNING id, nombre, descripcion, design, is_default, created_at, updated_at`,
      [nuevoNombre, o.descripcion, o.design, req.user.id]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    console.error('Error duplicando plantilla:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ── POST /api/ticket-templates/:id/default ────────────────
// Marca esta plantilla como default (sin tocar el design)
router.post('/:id/default', authMiddleware, soloDueno, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE ticket_templates SET is_default = FALSE WHERE is_default = TRUE');
    const r = await client.query(
      'UPDATE ticket_templates SET is_default = TRUE, updated_at = NOW() WHERE id = $1 RETURNING id, nombre, is_default',
      [req.params.id]
    );
    if (!r.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Plantilla no encontrada' });
    }
    await client.query('COMMIT');
    res.json(r.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error marcando default:', err);
    res.status(500).json({ error: 'Error del servidor' });
  } finally {
    client.release();
  }
});

module.exports = router;