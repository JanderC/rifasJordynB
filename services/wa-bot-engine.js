// ============================================================
//  wa-bot-engine.js — Motor del bot de conversación
//  Procesa mensajes entrantes y ejecuta el flujo configurado
// ============================================================
const pool = require('../config/db');

// ── Enviar mensaje via Meta API ───────────────────────────────
async function enviarMensaje(phoneNumberId, accessToken, to, payload) {
  const body = { messaging_product: 'whatsapp', recipient_type: 'individual', to, ...payload };

  const resp = await fetch(
    `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`,
    {
      method:  'POST',
      headers: {
        Authorization:  `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }
  );
  return resp.json();
}

// ── Construir payload según tipo de plantilla ─────────────────
function buildPayload(plantilla, variables = {}) {
  // Reemplazar variables en el texto: {{nombre_cliente}} → valor
  const interpolate = (text) => {
    if (!text) return text;
    return text.replace(/\{\{(\w+)\}\}/g, (_, key) => variables[key] || `{{${key}}}`);
  };

  const cuerpo  = interpolate(plantilla.cuerpo);
  const pie     = interpolate(plantilla.pie);
  const botones = typeof plantilla.botones === 'string'
    ? JSON.parse(plantilla.botones)
    : (plantilla.botones || []);

  switch (plantilla.tipo) {
    case 'text':
      return { type: 'text', text: { body: cuerpo, preview_url: false } };

    case 'image':
      return {
        type: 'image',
        image: { link: plantilla.media_url, caption: cuerpo },
      };

    case 'video':
      return {
        type: 'video',
        video: { link: plantilla.media_url, caption: cuerpo },
      };

    case 'image_text':
      return {
        type: 'image',
        image: { link: plantilla.media_url, caption: cuerpo },
      };

    case 'button':
      if (botones.length === 0) {
        return { type: 'text', text: { body: cuerpo } };
      }
      return {
        type: 'interactive',
        interactive: {
          type: 'button',
          body:    { text: cuerpo },
          footer:  pie ? { text: pie } : undefined,
          action:  {
            buttons: botones.map(b => ({
              type:  'reply',
              reply: { id: b.id, title: b.titulo.substring(0, 20) },
            })),
          },
        },
      };

    default:
      return { type: 'text', text: { body: cuerpo || '...' } };
  }
}

// ── Obtener o crear sesión de conversación ────────────────────
async function obtenerSesion(waNumero) {
  // Buscar sesión activa y no expirada
  const r = await pool.query(
    `SELECT * FROM wa_sesiones
      WHERE wa_numero = $1
        AND estado = 'activo'
        AND expira_at > NOW()
      ORDER BY created_at DESC
      LIMIT 1`,
    [waNumero]
  );
  return r.rows[0] || null;
}

async function crearSesion(waNumero, nodoInicioId) {
  const r = await pool.query(
    `INSERT INTO wa_sesiones (wa_numero, nodo_actual_id, estado, expira_at)
     VALUES ($1, $2, 'activo', NOW() + INTERVAL '30 minutes')
     RETURNING *`,
    [waNumero, nodoInicioId]
  );
  return r.rows[0];
}

async function actualizarSesion(sesionId, campos) {
  const sets = []; const vals = []; let i = 1;
  for (const [k, v] of Object.entries(campos)) {
    sets.push(`${k} = $${i++}`);
    vals.push(v);
  }
  sets.push(`ultimo_mensaje = NOW()`);
  sets.push(`expira_at = NOW() + INTERVAL '30 minutes'`);
  vals.push(sesionId);
  await pool.query(
    `UPDATE wa_sesiones SET ${sets.join(', ')} WHERE id = $${i}`,
    vals
  );
}

// ── Log de mensajes ───────────────────────────────────────────
async function logMensaje(sesionId, waNumero, direccion, tipo, contenido, waMessageId) {
  try {
    await pool.query(
      `INSERT INTO wa_mensajes_log (sesion_id, wa_numero, direccion, tipo, contenido, wa_message_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [sesionId || null, waNumero, direccion, tipo, contenido, waMessageId || null]
    );
  } catch { /* no bloquear flujo por error de log */ }
}

// ── Obtener rifas activas formateadas ─────────────────────────
async function getRifasActivas() {
  const r = await pool.query(
    `SELECT id, nombre, premio, precio, fecha_sorteo::text AS fecha_sorteo, loteria_ref
       FROM rifas
       WHERE activa = true AND estado = 'activa'
       ORDER BY created_at DESC`
  );
  return r.rows;
}

// ── Verificar disponibilidad de número ───────────────────────
async function verificarNumero(rifaId, numero) {
  const numPad = String(numero).padStart(3, '0');

  const ventas = await pool.query(
    `SELECT COUNT(*)::int AS c FROM ventas WHERE rifa_id = $1 AND numero = $2`,
    [rifaId, numPad]
  );
  const reservas = await pool.query(
    `SELECT COUNT(*)::int AS c FROM reservas_cliente
      WHERE rifa_id = $1 AND numero = $2 AND estado IN ('pendiente','aprobado')`,
    [rifaId, numPad]
  );

  const vecesVendido   = ventas.rows[0].c;
  const vecesReservado = reservas.rows[0].c;
  const disponible     = (vecesVendido + vecesReservado) < 2; // máx 2 series A/B

  return { disponible, numPad };
}

// ── Crear reserva automática desde el bot ────────────────────
async function crearReservaBot(rifaId, numero, nombreCliente, cedula, waNumero) {
  const rifa = await pool.query(
    `SELECT id, nombre, premio, precio, fecha_sorteo::text AS fecha_sorteo FROM rifas WHERE id = $1`,
    [rifaId]
  );
  if (!rifa.rows.length) return null;
  const r = rifa.rows[0];

  const res = await pool.query(
    `INSERT INTO reservas_cliente
       (rifa_id, numero, nombre_cliente, cedula, telefono, estado, metodo_pago)
     VALUES ($1, $2, $3, $4, $5, 'pendiente', 'whatsapp')
     RETURNING id`,
    [rifaId, numero, nombreCliente, cedula || '', waNumero]
  );

  return { ...res.rows[0], rifa: r };
}

// ── Procesar mensaje entrante ─────────────────────────────────
async function procesarMensaje({ waNumero, texto, payload, tipo, phoneNumberId, accessToken }) {
  const textoNorm = (texto || '').trim().toUpperCase();

  // Comandos globales que reinician la sesión
  const comandosReset = ['MENU', 'INICIO', 'HOLA', 'START', 'OLA', 'BUENAS', 'BUENOS'];
  const esReset = comandosReset.some(c => textoNorm === c || textoNorm.startsWith(c + ' '));

  // Obtener config del bot
  const cfgR = await pool.query(`SELECT * FROM wa_config WHERE activo = true LIMIT 1`);
  if (!cfgR.rows.length) return; // Sin configuración, no responder

  // Obtener nodo de inicio
  const inicioR = await pool.query(
    `SELECT n.*, p.*, p.id AS pid, p.tipo AS ptipo, p.cuerpo AS pcuerpo,
            p.botones AS pbotones, p.pie AS ppie, m.url_publica AS media_url
       FROM wa_flujo_nodos n
       LEFT JOIN wa_plantillas p ON p.id = n.plantilla_id
       LEFT JOIN wa_media m ON m.id = p.media_id
       WHERE n.es_inicio = true AND n.activo = true
       LIMIT 1`
  );
  const nodoInicio = inicioR.rows[0];
  if (!nodoInicio) return; // Flujo no configurado

  let sesion = esReset ? null : await obtenerSesion(waNumero);

  // Nueva sesión
  if (!sesion) {
    sesion = await crearSesion(waNumero, nodoInicio.id);
    // Enviar mensaje de bienvenida
    await enviarDesdeNodo(nodoInicio, {}, phoneNumberId, accessToken, waNumero, sesion.id);
    return;
  }

  // Logear mensaje entrante
  await logMensaje(sesion.id, waNumero, 'entrante', tipo, texto || payload, null);

  // Obtener nodo actual
  const nodoActualR = await pool.query(
    `SELECT n.*, p.id AS pid, p.tipo AS ptipo, p.cuerpo AS pcuerpo,
            p.botones AS pbotones, p.pie AS ppie, m.url_publica AS media_url
       FROM wa_flujo_nodos n
       LEFT JOIN wa_plantillas p ON p.id = n.plantilla_id
       LEFT JOIN wa_media m ON m.id = p.media_id
       WHERE n.id = $1`,
    [sesion.nodo_actual_id]
  );
  const nodoActual = nodoActualR.rows[0];
  if (!nodoActual) return;

  // ── Ejecutar acción del nodo actual según lo que dijo el usuario ──
  await procesarAccion({
    nodoActual, sesion, textoNorm, texto, payload,
    phoneNumberId, accessToken, waNumero,
  });
}

// ── Procesar la acción según el nodo ─────────────────────────
async function procesarAccion({ nodoActual, sesion, textoNorm, texto, payload, phoneNumberId, accessToken, waNumero }) {
  const datos = sesion.datos_captura || {};

  switch (nodoActual.accion) {

    case 'mostrar_rifas': {
      // El usuario ya recibió la lista. Ahora escoge una rifa.
      const rifas = await getRifasActivas();
      const idx   = parseInt(textoNorm) - 1;
      const rifa  = rifas[idx] || rifas.find(r => textoNorm.includes(r.nombre.toUpperCase().substring(0, 5)));

      if (!rifa) {
        // No entendimos; reenviar lista
        await enviarRifas(rifas, phoneNumberId, accessToken, waNumero, sesion.id);
        return;
      }
      // Guardar rifa seleccionada y avanzar a consultar número
      await actualizarSesion(sesion.id, { rifa_id_selec: rifa.id, datos_captura: JSON.stringify({ ...datos, rifa_nombre: rifa.nombre, rifa_precio: rifa.precio, rifa_premio: rifa.premio, rifa_fecha: rifa.fecha_sorteo }) });
      await avanzarANodo(sesion, 'consultar_numero', {}, phoneNumberId, accessToken, waNumero);
      break;
    }

    case 'consultar_numero': {
      // Validar que sea un número de 1-3 dígitos
      const numMatch = texto?.match(/^\d{1,3}$/);
      if (!numMatch) {
        await enviarTexto(phoneNumberId, accessToken, waNumero,
          '❌ Por favor escribe un número válido entre 000 y 999 (ejemplo: *042*)');
        return;
      }

      const rifaId = sesion.rifa_id_selec;
      if (!rifaId) {
        // No hay rifa seleccionada; volver al inicio
        await avanzarANodo(sesion, 'mostrar_rifas', {}, phoneNumberId, accessToken, waNumero);
        return;
      }

      const { disponible, numPad } = await verificarNumero(rifaId, texto);

      // Obtener plantilla correspondiente
      const plantillaNombre = disponible ? 'numero_disponible' : 'numero_no_disponible';
      const plantR = await pool.query(
        `SELECT p.*, m.url_publica AS media_url FROM wa_plantillas p
         LEFT JOIN wa_media m ON m.id = p.media_id
         WHERE p.nombre = $1`,
        [plantillaNombre]
      );

      const variables = { ...datos, numero: numPad };
      if (plantR.rows.length) {
        const msgR = await enviarMensaje(phoneNumberId, accessToken, waNumero,
          buildPayload(plantR.rows[0], variables));
        await logMensaje(sesion.id, waNumero, 'saliente', plantR.rows[0].tipo,
          plantR.rows[0].cuerpo, msgR.messages?.[0]?.id);
      }

      if (disponible) {
        await actualizarSesion(sesion.id, {
          numero_selec:    numPad,
          datos_captura:   JSON.stringify({ ...datos, numero: numPad }),
        });
        // Esperar respuesta del botón (reservar_si, etc.)
      } else {
        // Mantener en consultar_numero para que consulte otro
      }
      break;
    }

    case 'capturar_nombre': {
      if (texto && texto.trim().length >= 3) {
        await actualizarSesion(sesion.id, {
          nombre_cliente: texto.trim(),
          datos_captura:  JSON.stringify({ ...datos, nombre_cliente: texto.trim() }),
        });
        await avanzarANodo(sesion, 'capturar_cedula', { nombre_cliente: texto.trim() }, phoneNumberId, accessToken, waNumero);
      } else {
        await enviarTexto(phoneNumberId, accessToken, waNumero, '⚠️ Por favor escribe tu nombre completo (mínimo 3 caracteres).');
      }
      break;
    }

    case 'capturar_cedula': {
      const cedula = texto?.replace(/\D/g, '');
      if (cedula && cedula.length >= 6) {
        await actualizarSesion(sesion.id, {
          cedula:         cedula,
          datos_captura:  JSON.stringify({ ...datos, cedula }),
        });
        await avanzarANodo(sesion, 'confirmar_reserva', { ...datos, cedula }, phoneNumberId, accessToken, waNumero);
      } else {
        await enviarTexto(phoneNumberId, accessToken, waNumero, '⚠️ Por favor escribe tu cédula o documento de identidad (solo números).');
      }
      break;
    }

    case 'confirmar_reserva': {
      const nuevaReserva = await crearReservaBot(
        sesion.rifa_id_selec,
        sesion.numero_selec,
        sesion.nombre_cliente || datos.nombre_cliente,
        sesion.cedula || datos.cedula,
        waNumero
      );

      const plantR = await pool.query(
        `SELECT p.*, m.url_publica AS media_url FROM wa_plantillas p
         LEFT JOIN wa_media m ON m.id = p.media_id
         WHERE p.nombre = 'reserva_confirmada'`
      );
      if (plantR.rows.length && nuevaReserva) {
        const vars = {
          ...datos,
          nombre_cliente: sesion.nombre_cliente || datos.nombre_cliente,
          numero:         sesion.numero_selec,
          rifa_nombre:    nuevaReserva.rifa.nombre,
          premio:         nuevaReserva.rifa.premio,
          precio:         nuevaReserva.rifa.precio,
          fecha_sorteo:   nuevaReserva.rifa.fecha_sorteo,
        };
        const msgR = await enviarMensaje(phoneNumberId, accessToken, waNumero,
          buildPayload(plantR.rows[0], vars));
        await logMensaje(sesion.id, waNumero, 'saliente', 'text',
          plantR.rows[0].cuerpo, msgR.messages?.[0]?.id);
      }

      await actualizarSesion(sesion.id, { estado: 'completado' });
      break;
    }

    default: {
      // Nodo sin acción especial: buscar transición por trigger
      const trans = await pool.query(
        `SELECT t.*, n.accion AS dest_accion
           FROM wa_flujo_transiciones t
           JOIN wa_flujo_nodos n ON n.id = t.nodo_destino_id
           WHERE t.nodo_origen_id = $1
             AND t.activo = true
             AND (
               t.trigger_payload = $2
               OR UPPER(t.trigger_texto) = $3
               OR t.trigger_texto IS NULL
             )
           ORDER BY
             CASE WHEN t.trigger_payload = $2 OR UPPER(t.trigger_texto) = $3 THEN 0 ELSE 1 END,
             t.orden
           LIMIT 1`,
        [nodoActual.id, payload || '', textoNorm]
      );

      if (trans.rows.length) {
        const nodoDestR = await pool.query(
          `SELECT n.*, p.id AS pid, p.tipo AS ptipo, p.cuerpo AS pcuerpo,
                  p.botones AS pbotones, p.pie AS ppie, m.url_publica AS media_url
             FROM wa_flujo_nodos n
             LEFT JOIN wa_plantillas p ON p.id = n.plantilla_id
             LEFT JOIN wa_media m ON m.id = p.media_id
             WHERE n.id = $1`,
          [trans.rows[0].nodo_destino_id]
        );
        if (nodoDestR.rows.length) {
          const nodoDest = nodoDestR.rows[0];

          // Acción especial: antes de enviar plantilla de destino
          if (nodoDest.accion === 'mostrar_rifas') {
            const rifas = await getRifasActivas();
            await actualizarSesion(sesion.id, { nodo_actual_id: nodoDest.id });
            await enviarRifas(rifas, phoneNumberId, accessToken, waNumero, sesion.id);
            return;
          }

          await actualizarSesion(sesion.id, { nodo_actual_id: nodoDest.id });
          await enviarDesdeNodo(nodoDest, datos, phoneNumberId, accessToken, waNumero, sesion.id);
        }
      } else {
        // Sin transición definida: responder con mensaje de ayuda genérico
        const ayudaR = await pool.query(
          `SELECT p.*, m.url_publica AS media_url FROM wa_plantillas p
           LEFT JOIN wa_media m ON m.id = p.media_id
           WHERE p.nombre = 'ayuda'`
        );
        if (ayudaR.rows.length) {
          const msgR = await enviarMensaje(phoneNumberId, accessToken, waNumero,
            buildPayload(ayudaR.rows[0], datos));
          await logMensaje(sesion.id, waNumero, 'saliente', 'text', ayudaR.rows[0].cuerpo, msgR.messages?.[0]?.id);
        }
      }
    }
  }
}

// ── Helpers de envío ─────────────────────────────────────────
async function enviarDesdeNodo(nodo, variables, phoneNumberId, accessToken, waNumero, sesionId) {
  if (!nodo.pcuerpo && !nodo.media_url) return;
  const plantillaProxy = {
    tipo:      nodo.ptipo || nodo.tipo,
    cuerpo:    nodo.pcuerpo || nodo.cuerpo,
    pie:       nodo.ppie || nodo.pie,
    botones:   nodo.pbotones || nodo.botones,
    media_url: nodo.media_url,
  };
  const msgR = await enviarMensaje(phoneNumberId, accessToken, waNumero, buildPayload(plantillaProxy, variables));
  await logMensaje(sesionId, waNumero, 'saliente', plantillaProxy.tipo, plantillaProxy.cuerpo, msgR.messages?.[0]?.id);
}

async function enviarTexto(phoneNumberId, accessToken, waNumero, texto) {
  return enviarMensaje(phoneNumberId, accessToken, waNumero, {
    type: 'text', text: { body: texto },
  });
}

async function avanzarANodo(sesion, accionDestino, variables, phoneNumberId, accessToken, waNumero) {
  const nodoR = await pool.query(
    `SELECT n.*, p.id AS pid, p.tipo AS ptipo, p.cuerpo AS pcuerpo,
            p.botones AS pbotones, p.pie AS ppie, m.url_publica AS media_url
       FROM wa_flujo_nodos n
       LEFT JOIN wa_plantillas p ON p.id = n.plantilla_id
       LEFT JOIN wa_media m ON m.id = p.media_id
       WHERE n.accion = $1 AND n.activo = true
       LIMIT 1`,
    [accionDestino]
  );
  if (!nodoR.rows.length) return;
  const nodo = nodoR.rows[0];
  await actualizarSesion(sesion.id, { nodo_actual_id: nodo.id });
  await enviarDesdeNodo(nodo, variables, phoneNumberId, accessToken, waNumero, sesion.id);
}

async function enviarRifas(rifas, phoneNumberId, accessToken, waNumero, sesionId) {
  if (!rifas.length) {
    await enviarTexto(phoneNumberId, accessToken, waNumero,
      '😔 No hay rifas activas en este momento. ¡Vuelve pronto!');
    return;
  }

  const lista = rifas.map((r, i) =>
    `${i + 1}. 🏆 *${r.nombre}*\n   💰 $${r.precio} | Premio: ${r.premio}${r.fecha_sorteo ? `\n   📅 Sorteo: ${r.fecha_sorteo}` : ''}`
  ).join('\n\n');

  // Usar plantilla lista_rifas si existe
  const plantR = await pool.query(
    `SELECT p.*, m.url_publica AS media_url FROM wa_plantillas p
     LEFT JOIN wa_media m ON m.id = p.media_id
     WHERE p.nombre = 'lista_rifas'`
  );
  const vars = { rifas_lista: lista };

  if (plantR.rows.length) {
    const msgR = await enviarMensaje(phoneNumberId, accessToken, waNumero,
      buildPayload(plantR.rows[0], vars));
    await logMensaje(sesionId, waNumero, 'saliente', 'text', plantR.rows[0].cuerpo, msgR.messages?.[0]?.id);
  } else {
    await enviarTexto(phoneNumberId, accessToken, waNumero,
      `🏆 *Rifas disponibles:*\n\n${lista}\n\nResponde con el *número* de la rifa que te interesa.`);
  }
}

module.exports = { procesarMensaje };
