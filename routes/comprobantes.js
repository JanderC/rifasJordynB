// ============================================================
//  /api/comprobantes — Archivo de comprobantes de pago (solo el dueño)
//   GET  /            ?dias=30   comprobantes recibidos (reservas y abonos)
//   POST /leer        { tipo: 'reserva'|'abono', id, forzar }   datos leídos con IA + referencias repetidas
// ============================================================
const express = require('express');
const router  = express.Router();
const { authMiddleware, soloDueno } = require('../middleware/auth');
const comprobantes = require('../services/comprobantes');
const ia = require('../whatsapp/ia');
const { obtenerConfig } = require('../whatsapp/botConfig');

router.get('/', authMiddleware, soloDueno, async (req, res) => {
  try {
    const cfg = await obtenerConfig();
    res.json({ comprobantes: await comprobantes.archivo({ dias: req.query.dias }), puede_leer: !!ia.proveedorVision(cfg) });
  } catch (e) {
    console.error('Error listando comprobantes:', e);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

router.post('/leer', authMiddleware, soloDueno, async (req, res) => {
  const { tipo, id, forzar } = req.body || {};
  if (!['reserva', 'abono'].includes(tipo) || !id) return res.status(400).json({ error: 'tipo e id son requeridos' });
  try {
    res.json(await comprobantes.leer({ tipo, id, forzar: !!forzar }));
  } catch (e) {
    if (!e.status) console.error('Error leyendo comprobante:', e);
    res.status(e.status || 500).json({ error: e.status ? e.message : 'Error del servidor' });
  }
});

module.exports = router;
