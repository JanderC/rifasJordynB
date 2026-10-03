// ============================================================
//  routes/wa-chat.js — Panel de chats de WhatsApp + configuración del bot
//  Montado en /api/wa-chat (solo dueño)
//
//  GET    /stream?token=         eventos en tiempo real (SSE)
//  GET    /resumen               contadores (no leídos, atención, comprobantes)
//  GET    /chats                 ?q=&filtro=&antes=
//  GET    /chats/:jid            chat + reservas del cliente
//  GET    /chats/:jid/mensajes   ?antes=<id>&alrededor=<id>
//  POST   /chats/:jid/mensajes   { texto }            → enviar como humano
//  POST   /chats/:jid/imagen     multipart imagen + caption
//  POST   /chats/:jid/leer
//  PATCH  /chats/:jid            { bot_activo, necesita_humano, nombre_guardado, archivado, estado_compra:null }
//  GET    /buscar?q=             búsqueda dentro de las conversaciones
//  GET    /bot/config  PUT /bot/config
//  GET    /bot/proveedores       catálogo de IAs
//  POST   /bot/modelos           { proveedor, api_key? } → modelos en vivo
//  POST   /bot/probar-proveedor  prueba clave + modelo + herramientas
//  POST   /bot/probar-conversacion { mensajes: [{role, content}] }
// ============================================================
const router = require('express').Router();
const multer = require('multer');
const jwt    = require('jsonwebtoken');
const pool   = require('../config/db');
const { authMiddleware, soloDueno } = require('../middleware/auth');
const bus    = require('../services/waBus');
const chats  = require('../services/waChats');
const wa     = require('../whatsapp/whatsappService');
const bot    = require('../whatsapp/bot');
const dueno  = require('../whatsapp/dueno');
const resultados = require('../services/resultados');
const grupo  = require('../whatsapp/grupo');
const ia     = require('../whatsapp/ia');
const { configPublica, guardarConfig, obtenerConfig } = require('../whatsapp/botConfig');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => (file.mimetype.startsWith('image/') ? cb(null, true) : cb(new Error('Solo imágenes'), false)),
});

const err500 = (res, e) => res.status(500).json({ error: e.message });

// ── Tiempo real (Server-Sent Events) ─────────────────────────
// EventSource no permite cabeceras, así que el JWT viaja en ?token=
router.get('/stream', (req, res) => {
  let user;
  try { user = jwt.verify(String(req.query.token || ''), process.env.JWT_SECRET); }
  catch (_) { return res.status(401).end(); }
  if (user.rol !== 'dueno') return res.status(403).end();

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');

  const enviar = (evento, datos) => res.write(`event: ${evento}\ndata: ${JSON.stringify(datos)}\n\n`);
  const onMensaje = (d) => enviar('mensaje', d);
  const onEstado  = (d) => enviar('estado', d);
  const onChat    = (d) => enviar('chat', d);
  const onReserva = (d) => enviar('reserva', d);
  const onEnvio   = (d) => enviar('envio', d);
  bus.on('wa:mensaje', onMensaje);
  bus.on('wa:estado', onEstado);
  bus.on('wa:chat', onChat);
  bus.on('wa:reserva', onReserva);
  bus.on('wa:envio', onEnvio);
  enviar('conexion', wa.getStatus());
  // Latido: mantiene viva la conexión a través de proxies y avisa el estado
  const latido = setInterval(() => enviar('conexion', wa.getStatus()), 20000);

  req.on('close', () => {
    clearInterval(latido);
    bus.off('wa:mensaje', onMensaje);
    bus.off('wa:estado', onEstado);
    bus.off('wa:chat', onChat);
    bus.off('wa:reserva', onReserva);
    bus.off('wa:envio', onEnvio);
  });
});

router.use(authMiddleware, soloDueno);

// ── Chats ────────────────────────────────────────────────────
router.get('/resumen', async (req, res) => {
  try { res.json(await chats.resumen()); } catch (e) { err500(res, e); }
});

router.get('/chats', async (req, res) => {
  try {
    res.json(await chats.listarChats({
      q: String(req.query.q || ''), filtro: String(req.query.filtro || 'todos'), antes: req.query.antes || null,
    }));
  } catch (e) { err500(res, e); }
});

router.get('/chats/:jid', async (req, res) => {
  try {
    const chat = await chats.obtenerChat(req.params.jid);
    if (!chat) return res.status(404).json({ error: 'Chat no encontrado' });
    const r = await pool.query(`
      SELECT rc.id, rc.numero, rc.estado, rc.nombre_cliente, rc.cedula, rc.metodo_pago,
             rc.comprobante_base64 AS comprobante_url, rc.comprobante_datos, rc.nota_admin,
             rc.created_at, rc.origen, r.nombre AS rifa_nombre, r.precio
        FROM reservas_cliente rc JOIN rifas r ON r.id = rc.rifa_id
       WHERE rc.wa_jid = $1 OR ($2::text IS NOT NULL AND regexp_replace(rc.telefono, '\\D', '', 'g') = $2)
       ORDER BY rc.created_at DESC LIMIT 60`, [chat.jid, chat.telefono || null]);
    const reservas = r.rows.map((x) => ({
      ...x, numero: String(x.numero).trim(),
      comprobante_url: /^https?:\/\//.test(x.comprobante_url || '') ? x.comprobante_url : null,
    }));
    res.json({ chat, reservas });
  } catch (e) { err500(res, e); }
});

router.get('/chats/:jid/mensajes', async (req, res) => {
  try {
    res.json(await chats.listarMensajes(req.params.jid, {
      antes: req.query.antes || null, alrededor: req.query.alrededor || null, limite: req.query.limite,
    }));
  } catch (e) { err500(res, e); }
});

router.post('/chats/:jid/mensajes', async (req, res) => {
  const texto = String(req.body?.texto || '').trim();
  if (!texto) return res.status(400).json({ error: 'Escribe un mensaje.' });
  try {
    res.json(await wa.enviarTexto(req.params.jid, texto, { autor: 'humano' }));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/chats/:jid/imagen', upload.single('imagen'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Falta la imagen.' });
  try {
    res.json(await wa.enviarImagen(req.params.jid, req.file.buffer, String(req.body?.caption || ''), { autor: 'humano' }));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/chats/:jid/leer', async (req, res) => {
  try { await wa.marcarChatLeido(req.params.jid); res.json({ ok: true }); } catch (e) { err500(res, e); }
});

router.patch('/chats/:jid', async (req, res) => {
  const permitidos = ['bot_activo', 'necesita_humano', 'nombre_guardado', 'archivado', 'estado_compra'];
  const cambios = {};
  for (const k of permitidos) if (k in (req.body || {})) cambios[k] = req.body[k];
  // Devolverle el chat al bot quita la alerta de "necesita atención"
  if (cambios.bot_activo === true && !('necesita_humano' in cambios)) cambios.necesita_humano = false;
  if (cambios.necesita_humano === false) cambios.motivo_humano = null;
  try {
    const chat = await chats.actualizarChat(req.params.jid, cambios);
    if (!chat) return res.status(404).json({ error: 'Chat no encontrado' });
    res.json(chat);
  } catch (e) { err500(res, e); }
});

// ── Resultados de los sorteos (el bot los usa para responder) ─
router.get('/resultados', async (req, res) => {
  try { res.json(await resultados.sorteosRecientes(Number(req.query.dias) || 45)); } catch (e) { err500(res, e); }
});
// Vista previa: quién tiene ese número antes de guardar
router.get('/resultados/quien', async (req, res) => {
  try { res.json(await resultados.quienTiene(String(req.query.rifa_id), String(req.query.numero || '').trim())); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/resultados', async (req, res) => {
  const { rifa_id, numero, premio, serie, ganador } = req.body || {};
  if (!rifa_id || !numero) return res.status(400).json({ error: 'Faltan la rifa y el número.' });
  try { res.json(await resultados.registrar({ rifaId: rifa_id, numero, premio: premio || 'Premio mayor', serie: serie || null, ganador: ganador || null })); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.delete('/resultados/:id', async (req, res) => {
  try { await resultados.eliminar(Number(req.params.id)); res.json({ ok: true }); } catch (e) { err500(res, e); }
});

// ── Cola de atención ─────────────────────────────────────────
router.get('/cola', async (req, res) => {
  try {
    const cfg = await obtenerConfig();
    res.json(await chats.colaAtencion(dueno.telefonoDueno(cfg)));
  } catch (e) { err500(res, e); }
});

// "Que lo atienda el bot" — opcional { instruccion } con lo que debe decirle al cliente
router.post('/chats/:jid/atender-bot', async (req, res) => {
  try {
    const enviados = await bot.atenderConBot(req.params.jid, String(req.body?.instruccion || '').trim() || null);
    res.json({ ok: true, enviados });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// "Este es el comprobante": registra la reserva con esa foto (último paso de la compra)
router.post('/chats/:jid/mensajes/:id/es-comprobante', async (req, res) => {
  try {
    const r = await bot.registrarComprobanteManual(req.params.jid, Number(req.params.id));
    if (!r.ok) return res.status(409).json({ error: r.error || 'No se pudo registrar.' });
    res.json(r);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Mensajes al dueño por WhatsApp
router.post('/dueno/probar', async (req, res) => {
  try { res.json(await dueno.probar()); } catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/dueno/resumen', async (req, res) => {
  try { await dueno.enviarResumen({ forzar: true }); res.json({ ok: true }); } catch (e) { res.status(400).json({ error: e.message }); }
});

router.get('/buscar', async (req, res) => {
  try { res.json(await chats.buscarMensajes(String(req.query.q || ''))); } catch (e) { err500(res, e); }
});

// ── Bot / IA ─────────────────────────────────────────────────
router.get('/bot/config', async (req, res) => {
  try { res.json(await configPublica()); } catch (e) { err500(res, e); }
});

router.put('/bot/config', async (req, res) => {
  try { res.json(await guardarConfig(req.body || {})); } catch (e) { err500(res, e); }
});

// ── Grupo de WhatsApp del negocio ────────────────────────────
// GET  /grupo           estado: configuración, grupos donde está el bot e historial de avisos
// PUT  /grupo           { activo, avisar_*, horas_antes, responder_menciones, url_pagina, jid, nombre }
// POST /grupo/enviar    multipart: texto + imagen (opcional) → mensaje manual al grupo
router.get('/grupo', async (req, res) => {
  try { res.json(await grupo.estado()); } catch (e) { err500(res, e); }
});
router.put('/grupo', async (req, res) => {
  try { await grupo.guardar(req.body || {}); res.json(await grupo.estado()); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/grupo/enviar', upload.single('imagen'), async (req, res) => {
  const texto = String(req.body?.texto || '').trim();
  if (!texto && !req.file) return res.status(400).json({ error: 'Escribe el mensaje o adjunta una imagen.' });
  if (texto.length > 3000) return res.status(400).json({ error: 'El mensaje es demasiado largo.' });
  try {
    await grupo.enviarManual({ texto, imagen: req.file?.buffer || null });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.get('/bot/proveedores', (req, res) => res.json(ia.catalogo()));

// Prueba con los valores del formulario aunque aún no estén guardados
async function cfgDePrueba(body = {}) {
  const cfg = { ...(await obtenerConfig({ fresca: true })) };
  if (body.proveedor) cfg.proveedor = body.proveedor;
  if (body.modelo !== undefined) cfg.modelo = body.modelo;
  const clave = body.api_key;
  if (clave && !clave.includes('••')) cfg.api_keys = { ...cfg.api_keys, [cfg.proveedor]: clave.trim() };
  return cfg;
}

// Modelos disponibles en vivo (con la clave del formulario o la guardada)
router.post('/bot/modelos', async (req, res) => {
  try {
    const cfg = await cfgDePrueba(req.body);
    res.json(await ia.listarModelos(cfg, cfg.proveedor));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/bot/probar-proveedor', async (req, res) => {
  try { res.json(await ia.probar(await cfgDePrueba(req.body))); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

router.post('/bot/probar-conversacion', async (req, res) => {
  const mensajes = (req.body?.mensajes || [])
    .filter((m) => ['user', 'assistant'].includes(m.role) && String(m.content || '').trim())
    .slice(-20)
    .map((m) => ({ role: m.role, content: String(m.content) }));
  if (!mensajes.length || mensajes[mensajes.length - 1].role !== 'user') {
    return res.status(400).json({ error: 'El último mensaje debe ser del cliente.' });
  }
  try { res.json(await bot.probarConversacion(mensajes, req.body?.estado_compra || null)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = router;
