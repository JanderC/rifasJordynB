// ============================================================
//  wa-webhook.js — Webhook de WhatsApp Business Cloud API
//  GET  → verificación del webhook (Meta lo requiere)
//  POST → recibir mensajes entrantes y procesarlos
// ============================================================
const express           = require('express');
const router            = express.Router();
const pool              = require('../config/db');
const { procesarMensaje } = require('../services/wa-bot-engine');

// ── GET /api/whatsapp/webhook — Verificación ─────────────────
// Meta llama a este endpoint cuando configuras el webhook en el portal.
router.get('/webhook', async (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  try {
    const r = await pool.query(
      `SELECT verify_token FROM wa_config WHERE activo = true LIMIT 1`
    );
    const savedToken = r.rows[0]?.verify_token;

    if (mode === 'subscribe' && token === savedToken) {
      console.log('[WA Webhook] ✅ Verificado correctamente');
      return res.status(200).send(challenge);
    }
    console.warn('[WA Webhook] ❌ Token no coincide');
    res.sendStatus(403);
  } catch (err) {
    console.error('[WA Webhook] Error verificando:', err.message);
    res.sendStatus(500);
  }
});

// ── POST /api/whatsapp/webhook — Mensajes entrantes ──────────
router.post('/webhook', async (req, res) => {
  // Meta espera respuesta 200 de inmediato para no reintentar
  res.sendStatus(200);

  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    // Obtener config activa para el envío de respuestas
    const cfgR = await pool.query(
      `SELECT phone_number_id, access_token FROM wa_config WHERE activo = true LIMIT 1`
    );
    if (!cfgR.rows.length) return;
    const { phone_number_id, access_token } = cfgR.rows[0];

    for (const entry of (body.entry || [])) {
      for (const change of (entry.changes || [])) {
        if (change.field !== 'messages') continue;
        const value = change.value;

        // Status updates (entregado, leído) — solo loguear
        for (const status of (value.statuses || [])) {
          await pool.query(
            `UPDATE wa_mensajes_log
               SET estado_envio = $1
             WHERE wa_message_id = $2`,
            [status.status, status.id]
          ).catch(() => {});
        }

        // Mensajes entrantes
        for (const msg of (value.messages || [])) {
          const waNumero = msg.from;
          let texto  = null;
          let payload = null;
          const tipo = msg.type;

          if (tipo === 'text') {
            texto = msg.text?.body;
          } else if (tipo === 'interactive') {
            const inter = msg.interactive;
            if (inter?.type === 'button_reply') {
              texto   = inter.button_reply?.title;
              payload = inter.button_reply?.id;
            } else if (inter?.type === 'list_reply') {
              texto   = inter.list_reply?.title;
              payload = inter.list_reply?.id;
            }
          }

          // Procesar de forma asíncrona para no bloquear
          procesarMensaje({
            waNumero,
            texto,
            payload,
            tipo,
            phoneNumberId: phone_number_id,
            accessToken:   access_token,
          }).catch(err => console.error('[WA Bot] Error procesando mensaje:', err.message));
        }
      }
    }
  } catch (err) {
    console.error('[WA Webhook] Error general:', err.message);
  }
});

module.exports = router;
