/**
 * autoReply.js — Motor de respuestas automáticas para sistema de rifas
 *
 * ✅ NUEVO: Flujo de compra por WhatsApp con estados de sesión por JID
 *   Paso 1 → Usuario pregunta / quiere un número
 *   Paso 2 → Bot pide su nombre completo
 *   Paso 3 → Bot pide el comprobante de pago (imagen)
 *   Paso 4 → Se crea la reserva en estado 'pendiente' automáticamente
 *   Paso 5 → Admin confirma desde GestionReservas y el bot envía el ticket
 *
 * Usa Groq (Gemini renombrado) como motor principal de IA.
 * El guión hardcodeado queda como FALLBACK si la IA falla.
 */

const { getGeminiReply } = require('./Geminiservice');
const pool               = require('../config/db');

// ─────────────────────────────────────────────────────────────
// SESIONES DE COMPRA — estado por JID
// ─────────────────────────────────────────────────────────────
// Estados:  null → idle | 'esperando_nombre' | 'esperando_comprobante'
// Map: jid → { estado, rifaId, rifaNombre, numero, nombre, telefono }
const sesionesCompra = new Map();

const TIMEOUT_SESION_MS = 15 * 60 * 1000; // 15 minutos sin actividad = reset

function getSesion(jid) {
  return sesionesCompra.get(jid) || null;
}

function setSesion(jid, datos) {
  sesionesCompra.set(jid, { ...datos, _ts: Date.now() });
}

function clearSesion(jid) {
  sesionesCompra.delete(jid);
}

function limpiarSesionesViejas() {
  const ahora = Date.now();
  for (const [jid, s] of sesionesCompra.entries()) {
    if (ahora - s._ts > TIMEOUT_SESION_MS) sesionesCompra.delete(jid);
  }
}
setInterval(limpiarSesionesViejas, 5 * 60 * 1000);

// ─────────────────────────────────────────────────────────────
// HELPER: extraer número de teléfono de JID de WhatsApp
// ─────────────────────────────────────────────────────────────
function jidToPhone(jid) {
  return jid.replace('@s.whatsapp.net', '').replace('@c.us', '');
}

// ─────────────────────────────────────────────────────────────
// CREAR RESERVA EN BD
// ─────────────────────────────────────────────────────────────
async function crearReservaWhatsApp({ rifa_id, numero, nombre_cliente, telefono, comprobante_base64 }) {
  try {
    // Verificar que el número sigue disponible
    const ocupada = await pool.query(
      `SELECT COUNT(*)::int AS v FROM reservas_cliente
        WHERE rifa_id = $1 AND numero = $2 AND estado IN ('pendiente','aprobado')`,
      [rifa_id, numero]
    );
    const ventas = await pool.query(
      `SELECT COUNT(*)::int AS v FROM ventas WHERE rifa_id = $1 AND numero = $2`,
      [rifa_id, numero]
    );
    if ((ocupada.rows[0]?.v || 0) + (ventas.rows[0]?.v || 0) > 0) {
      return { ok: false, error: 'numero_ocupado' };
    }

    // Obtener precio de la rifa
    const rifaR = await pool.query(
      `SELECT precio, nombre, premio, fecha_sorteo::text AS fecha_sorteo FROM rifas WHERE id = $1 AND activa = true`,
      [rifa_id]
    );
    if (!rifaR.rows.length) return { ok: false, error: 'rifa_no_encontrada' };
    const rifa = rifaR.rows[0];

    const numPad = String(numero).padStart(3, '0');

    const ins = await pool.query(
      `INSERT INTO reservas_cliente
         (rifa_id, numero, nombre_cliente, telefono, estado, precio, metodo_pago, comprobante_base64, origen, created_at)
       VALUES ($1, $2, $3, $4, 'pendiente', $5, 'whatsapp', $6, 'whatsapp', NOW())
       RETURNING id`,
      [rifa_id, numPad, nombre_cliente, telefono, Number(rifa.precio), comprobante_base64 || null]
    );

    return {
      ok: true,
      reserva_id: ins.rows[0].id,
      rifa_nombre: rifa.nombre,
      premio: rifa.premio,
      fecha_sorteo: rifa.fecha_sorteo,
      precio: rifa.precio,
      numero: numPad,
    };
  } catch (err) {
    console.error('❌ [AutoReply] Error creando reserva:', err.message);
    return { ok: false, error: 'db_error', detail: err.message };
  }
}

// ─────────────────────────────────────────────────────────────
// GUIÓN DE FALLBACK
// ─────────────────────────────────────────────────────────────
const guion = [
  {
    id: 1,
    nombre: 'saludo',
    triggers: ['hola','buenos dias','buenas tardes','buenas noches','buenas','hey','inicio','menu','menú','start'],
    response: `¡Hola! 👋 Bienvenido a *Rifas Jordyn*.\n\n¿En qué te puedo ayudar?\n\n1️⃣ Ver rifas activas\n2️⃣ Comprar número\n3️⃣ Ver mis números\n4️⃣ Resultado del sorteo\n5️⃣ Hablar con un asesor\n\nEscribe el número de la opción que deseas 👆`,
  },
  {
    id: 2,
    nombre: 'ver_rifas',
    triggers: ['1','rifas','ver rifas','que tienen','qué tienen','que rifas','qué rifas','rifas activas','disponibles'],
    response: `🎟️ Escríbeme *quiero comprar* y dime qué número te interesa para ver si está disponible.`,
  },
  {
    id: 3,
    nombre: 'comprar',
    triggers: ['2','comprar','quiero','apartar','como compro','cómo compro','quiero participar','quiero uno','quiero el'],
    response: `🎉 ¡Perfecto! Dime el *número* que quieres y en qué *rifa* para verificar si está disponible.`,
  },
  {
    id: 4,
    nombre: 'mis_numeros',
    triggers: ['3','mis numeros','mis números','tengo','verificar','mis tickets','que numeros tengo','cuales son mis numeros'],
    response: `📋 Para verificar tus números dime:\n\n👤 Tu *nombre completo* o\n📞 El *número de teléfono* con el que compraste\n\nY te confirmo en segundos ✅`,
  },
  {
    id: 5,
    nombre: 'sorteo',
    triggers: ['4','resultado','ganador','sorteo','cuando es el sorteo','cuando sortean','quien gano','ya sortearon'],
    response: `🎰 Los sorteos se transmiten en *vivo* por:\n\n📸 Instagram: *@rifas_jordyn*\n\n¡No te lo pierdas! 🔴 Activa las notificaciones.`,
  },
  {
    id: 6,
    nombre: 'asesor',
    triggers: ['5','asesor','humano','persona','ayuda','soporte','hablar con alguien','agente'],
    response: `👤 Enseguida te conecto con un asesor.\n\n⏰ *Horario:* Lun–Vie 9am–8pm | Sáb 9am–2pm | Dom solo WhatsApp 📲`,
  },
  {
    id: 7,
    nombre: 'pago',
    triggers: ['pago','pagar','como pago','cómo pago','metodos de pago','métodos de pago','datos de pago','cuenta'],
    response: `💳 *Métodos de pago disponibles:*\n\n📱 *Pago Móvil* — Mercantil | J-123456789 | 0414-1234567\n💵 *Zelle* — rifasxyz@gmail.com\n🔶 *Binance USDT TRC20* — TXxxx...xxxx\n\nDespués de pagar envía la *captura* por aquí 📸`,
  },
  {
    id: 8,
    nombre: 'gracias',
    triggers: ['gracias','muchas gracias','thanks','ok gracias','perfecto gracias','listo gracias'],
    response: `¡Con mucho gusto! 😊 Si necesitas algo más escribe *menú*. 🍀`,
  },
];

const FALLBACK = `No entendí bien tu mensaje 😅\n\nEscribe *menú* para ver las opciones o dime en qué te puedo ayudar.`;

function normalize(text) {
  return text.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ').trim();
}

let guionActivo = guion;

function getGuionReply(incoming) {
  if (!incoming || typeof incoming !== 'string') return FALLBACK;
  const msg = normalize(incoming);
  for (const item of guionActivo) {
    if (item.triggers.some(t => msg.includes(normalize(t)))) return item.response;
  }
  return FALLBACK;
}

// ─────────────────────────────────────────────────────────────
// DETECCIÓN DE INTENCIÓN DE COMPRA
// ─────────────────────────────────────────────────────────────
function detectarIntentCompra(texto) {
  const msg = normalize(texto);
  // Detectar "quiero el #07", "me aparto el 42", "número 15", etc.
  const numMatch = texto.match(/(?:quiero|aparto|numero|número|el|#)\s*0*(\d{1,3})\b/i);
  if (numMatch) return { numero: String(numMatch[1]).padStart(3, '0') };
  return null;
}

// ─────────────────────────────────────────────────────────────
// MOTOR PRINCIPAL — manejo del flujo de compra
// ─────────────────────────────────────────────────────────────
const GROQ_ENABLED = !!(process.env.GROQ_API_KEY || process.env.GEMINI_API_KEY);

if (GROQ_ENABLED) {
  console.log('🤖 [AutoReply] Motor: Groq AI + flujo de compra WhatsApp');
} else {
  console.log('⚠️  [AutoReply] Sin API key de IA. Usando guión + flujo de compra.');
}

/**
 * Respuesta de texto normal (IA o guión).
 */
async function getTextReply(jid, incoming) {
  if (!GROQ_ENABLED) return getGuionReply(incoming);
  try {
    return await getGeminiReply(jid, incoming);
  } catch (err) {
    console.error(`❌ [AutoReply] IA falló, usando guión: ${err.message}`);
    return getGuionReply(incoming);
  }
}

/**
 * Procesa un mensaje de IMAGEN (comprobante de pago).
 * Retorna la respuesta de texto que se enviará al cliente.
 *
 * @param {string} jid          — JID del cliente
 * @param {string|null} base64  — base64 del comprobante (puede ser null si no se pudo extraer)
 * @returns {Promise<string>}
 */
async function procesarComprobante(jid, base64) {
  const sesion = getSesion(jid);

  if (!sesion || sesion.estado !== 'esperando_comprobante') {
    // No hay flujo activo, informar que si quieren comprar lo digan
    return `📸 Recibí tu imagen.\n\nSi quieres comprar un número escríbeme cuál te interesa y en qué rifa.`;
  }

  const telefono = jidToPhone(jid);

  const resultado = await crearReservaWhatsApp({
    rifa_id:           sesion.rifaId,
    numero:            sesion.numero,
    nombre_cliente:    sesion.nombre,
    telefono,
    comprobante_base64: base64 || null,
  });

  clearSesion(jid);

  if (resultado.ok) {
    return (
      `✅ *¡Comprobante recibido!*\n\n` +
      `Tu reserva ha sido registrada correctamente 🎟️\n\n` +
      `📋 *Resumen:*\n` +
      `• Rifa: *${resultado.rifa_nombre}*\n` +
      `• Número: *${resultado.numero}*\n` +
      `• Premio: ${resultado.premio}\n` +
      `• Precio: $${resultado.precio}\n\n` +
      `⏳ Un asesor revisará tu pago y te confirmará en breve.\n` +
      `Cuando se apruebe recibirás tu *ticket oficial* por aquí. 🎉`
    );
  }

  if (resultado.error === 'numero_ocupado') {
    return (
      `😅 Ay, mientras procesaba tu pago el número *${sesion.numero}* fue ocupado por otro cliente.\n\n` +
      `Dime otro número que quieras y con gusto te lo aparto 🎟️`
    );
  }

  return `❌ Hubo un problema registrando tu reserva. Por favor escríbele a un asesor: wa.me/584129287210`;
}

/**
 * Obtiene la respuesta automática para un mensaje de TEXTO entrante.
 * Maneja el flujo de compra paso a paso.
 *
 * @param {string} jid      — JID de WhatsApp del remitente
 * @param {string} incoming — Texto del mensaje recibido
 * @returns {Promise<string>}
 */
async function getAutoReply(jid, incoming) {
  if (!incoming || typeof incoming !== 'string') return FALLBACK;

  const sesion = getSesion(jid);

  // ── PASO 2: esperando nombre ───────────────────────────────
  if (sesion?.estado === 'esperando_nombre') {
    const nombre = incoming.trim();
    if (nombre.length < 3) {
      return `Por favor dime tu *nombre completo* para poder apartar el número 😊`;
    }

    setSesion(jid, { ...sesion, estado: 'esperando_comprobante', nombre });

    // Construir datos de pago dinámicamente
    const pagos = `📱 *Pago Móvil* — Mercantil | J-123456789 | 0414-1234567\n💵 *Zelle* — rifasxyz@gmail.com\n🔶 *Binance USDT TRC20* — TXxxx...xxxx`;

    return (
      `Perfecto *${nombre}* 😊\n\n` +
      `Para apartar el número *${sesion.numero}* en *${sesion.rifaNombre}* realiza el pago y envíame el *comprobante* como imagen.\n\n` +
      `💳 *Datos de pago:*\n${pagos}\n\n` +
      `📸 Cuando tengas el comprobante mándalo por aquí y listo.`
    );
  }

  // ── PASO 3: esperando comprobante — puede cancelar ─────────
  if (sesion?.estado === 'esperando_comprobante') {
    const msg = normalize(incoming);
    if (msg.includes('cancelar') || msg.includes('cancel')) {
      clearSesion(jid);
      return `De acuerdo, cancelé tu reserva del número *${sesion.numero}*. Si quieres otro dímelo 😊`;
    }
    return (
      `📸 Estoy esperando la *imagen del comprobante* de pago para el número *${sesion.numero}*.\n\n` +
      `Si quieres cancelar escribe *cancelar*.`
    );
  }

  // ── DETECCIÓN DE INTENCIÓN DE COMPRA ──────────────────────
  // Solo si la IA no está manejando el flujo activamente
  const intentCompra = detectarIntentCompra(incoming);
  if (intentCompra?.numero && !GROQ_ENABLED) {
    // Flujo manual cuando no hay IA
    try {
      const rifas = await pool.query(
        `SELECT id, nombre FROM rifas WHERE activa = true AND COALESCE(estado,'activa') = 'activa' LIMIT 1`
      );
      if (rifas.rows.length) {
        const rifa = rifas.rows[0];
        // Verificar disponibilidad
        const ocupada = await pool.query(
          `SELECT COUNT(*)::int AS v FROM reservas_cliente WHERE rifa_id=$1 AND numero=$2 AND estado IN ('pendiente','aprobado')`,
          [rifa.id, intentCompra.numero]
        );
        const ventas = await pool.query(
          `SELECT COUNT(*)::int AS v FROM ventas WHERE rifa_id=$1 AND numero=$2`,
          [rifa.id, intentCompra.numero]
        );
        if ((ocupada.rows[0]?.v || 0) + (ventas.rows[0]?.v || 0) > 0) {
          return `😕 El número *${intentCompra.numero}* ya está ocupado. ¿Quieres elegir otro?`;
        }
        // Iniciar flujo de compra
        setSesion(jid, {
          estado:    'esperando_nombre',
          rifaId:    rifa.id,
          rifaNombre: rifa.nombre,
          numero:    intentCompra.numero,
        });
        return (
          `🎉 ¡El número *${intentCompra.numero}* está disponible!\n\n` +
          `Para apartar, dime tu *nombre completo*.`
        );
      }
    } catch (err) {
      console.error('[AutoReply] Error verificando número:', err.message);
    }
  }

  // ── RESPUESTA NORMAL (IA o guión) ─────────────────────────
  return await getTextReply(jid, incoming);
}

// ─────────────────────────────────────────────────────────────
// Compatibilidad con loadGuionesFromDB
// ─────────────────────────────────────────────────────────────
async function loadGuionesFromDB(dbQuery) {
  try {
    const rows = await dbQuery(
      "SELECT id, nombre, triggers, response FROM bot_guiones WHERE activo = true ORDER BY orden ASC"
    );
    guionActivo = rows.map(r => ({
      id: r.id,
      nombre: r.nombre,
      triggers: JSON.parse(r.triggers),
      response: r.response,
    }));
    console.log(`✅ [AutoReply] Guiones cargados desde BD: ${guionActivo.length}`);
  } catch (err) {
    console.error('❌ [AutoReply] Error cargando guiones:', err.message);
    guionActivo = guion;
  }
}

function getGuion() { return guionActivo; }

module.exports = {
  getAutoReply,
  procesarComprobante,   // ← NUEVO: para llamar desde whatsappService cuando llega imagen
  loadGuionesFromDB,
  getGuion,
  getSesion,             // ← expuesto para debug/tests
  clearSesion,
};