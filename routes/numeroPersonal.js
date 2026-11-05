// ============================================================
//  routes/numeroPersonal.js — WhatsApp → Número personal
//   GET  /api/numero-personal              estado, términos y uso
//   POST /api/numero-personal/codigo       { acepto: true } → código de vinculación
//   POST /api/numero-personal/desvincular
//   PUT  /api/numero-personal/uso          { principal: bool } → todos los envíos salen por el personal
//   POST /api/numero-personal/prueba       { telefono }
//  Solo el dueño.
// ============================================================
const express = require('express');
const router = express.Router();
const { authMiddleware, soloDueno } = require('../middleware/auth');
const personal = require('../whatsapp/numeroPersonal');

router.use(authMiddleware, soloDueno);

router.get('/', async (req, res) => {
  try { res.json(await personal.panel()); }
  catch (e) { console.error('numero-personal:', e); res.status(500).json({ error: 'Error del servidor' }); }
});

router.post('/codigo', async (req, res) => {
  if (req.body?.acepto !== true) return res.status(400).json({ error: 'Debes aceptar los términos para vincular el número.' });
  try { res.json({ codigo: await personal.pedirCodigo(req.user?.usuario || req.user?.nombre || req.user?.id) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/desvincular', async (req, res) => {
  try { await personal.desvincular(); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// El bot del negocio le avisa al dueño en su número personal
const AVISO_PRINCIPAL = 'Jordyn, no tendremos respuestas automáticas mientras tu número personal esté predeterminado como principal.';
const AVISO_NEGOCIO = 'Jordyn, el número del negocio volvió a ser el principal: las respuestas automáticas siguen funcionando.';

router.put('/uso', async (req, res) => {
  try {
    const si = !!req.body?.principal;
    if (si && !personal.conectado()) return res.status(400).json({ error: 'Primero vincula el número personal.' });
    await personal.ponerPrincipal(si);
    // Sin esperar: el aviso pasa por la cola anti-bloqueo y puede tardar unos segundos.
    // Se requiere aquí para no cruzar la carga de los módulos de WhatsApp.
    Promise.resolve()
      .then(() => require('../whatsapp/whatsappService').sendText(personal.NUMERO, si ? AVISO_PRINCIPAL : AVISO_NEGOCIO))
      .catch((e) => console.error('⚠️ [Número personal] No se pudo avisar al dueño:', e.message));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/prueba', async (req, res) => {
  try { await personal.enviarPrueba(req.body?.telefono); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = router;
