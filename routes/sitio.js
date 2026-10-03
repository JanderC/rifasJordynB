// routes/sitio.js
// ── Ajustes de la página del cliente ──────────────────────
// Grupo de WhatsApp (burbuja flotante) y top de compradores.
const express = require('express');
const router  = express.Router();
const { authMiddleware, soloDueno } = require('../middleware/auth');
const sitio = require('../services/sitio');

// ── GET /api/sitio ─────────────────────────────────────────
// Pública: enlace del grupo (si está activo) y top de compradores
router.get('/', async (req, res) => {
  try { res.json(await sitio.datosPublicos()); }
  catch (err) {
    console.error('[Sitio] Error:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ── GET /api/sitio/config ──────────────────────────────────
// Dueño: la configuración completa + el top tal como sale
router.get('/config', authMiddleware, soloDueno, async (req, res) => {
  try { res.json({ ...(await sitio.obtenerConfig()), top_compradores: await sitio.topCompradores() }); }
  catch (err) {
    console.error('[Sitio] Error config:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ── PUT /api/sitio/config ──────────────────────────────────
// Body: { grupo_whatsapp?, grupo_activo?, top_compradores_activo? }
router.put('/config', authMiddleware, soloDueno, async (req, res) => {
  try { res.json(await sitio.guardarConfig(req.body || {})); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

module.exports = router;
