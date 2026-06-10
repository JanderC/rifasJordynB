/**
 * autoReply.js — Motor de respuestas automáticas para sistema de rifas
 *
 * Ahora usa Google Gemini como motor principal de IA.
 * El guión hardcodeado queda como FALLBACK si Gemini falla o no está configurado.
 *
 * Uso:
 *   const { getAutoReply } = require("./autoReply");
 *   const respuesta = await getAutoReply(jid, "hola quiero saber las rifas");
 *
 * ⚠️  IMPORTANTE: getAutoReply ahora es ASYNC, actualiza tus await en whatsappService.js
 */

const { getGeminiReply } = require("./geminiService");

// ─────────────────────────────────────────────────────────────
// GUIÓN DE FALLBACK (se usa si Gemini no está disponible)
// ─────────────────────────────────────────────────────────────
const guion = [
  {
    id: 1,
    nombre: "saludo",
    triggers: ["hola", "buenos dias", "buenas tardes", "buenas noches", "buenas", "hey", "inicio", "menu", "menú", "start"],
    response:
      `¡Hola! 👋 Bienvenido a *Rifas XYZ*.

¿En qué te puedo ayudar?

1️⃣ Ver rifas activas
2️⃣ Comprar número
3️⃣ Ver mis números
4️⃣ Resultado del sorteo
5️⃣ Hablar con un asesor

Escribe el número de la opción que deseas 👆`,
  },
  {
    id: 2,
    nombre: "ver_rifas",
    triggers: ["1", "rifas", "ver rifas", "que tienen", "qué tienen", "que rifas", "qué rifas", "rifas activas", "disponibles"],
    response:
      `🎟️ *Rifas activas ahora mismo:*

━━━━━━━━━━━━━━━━━━
🏆 *Rifa #42* — Premio: iPhone 15 Pro
💵 Precio: $5 por número
🎯 Números disponibles: 100
📅 Fecha de sorteo: 01/07/2025
━━━━━━━━━━━━━━━━━━
🏆 *Rifa #43* — Premio: Smart TV 55"
💵 Precio: $3 por número
🎯 Números disponibles: 50
📅 Fecha de sorteo: 15/07/2025
━━━━━━━━━━━━━━━━━━

Para apartar un número escribe:
👉 *quiero el #07 de la rifa 42*`,
  },
  {
    id: 3,
    nombre: "comprar",
    triggers: ["2", "comprar", "quiero", "apartar", "precio", "como compro", "cómo compro", "quiero participar", "quiero uno"],
    response:
      `🎉 ¡Perfecto! Para apartar tu número necesito:

✅ Tu *nombre completo*
✅ El *número que quieres* (ej: #07)
✅ La *rifa* en la que participas (ej: Rifa #42)
✅ *Captura del pago* una vez que canceles

━━━━━━━━━━━━━━━━━━
📲 *Métodos de pago aceptados:*
• Pago Móvil
• Zelle
• Binance (USDT)
━━━━━━━━━━━━━━━━━━

Cuando tengas todo listo envíalo todo junto y un asesor confirma tu número 🙌`,
  },
  {
    id: 4,
    nombre: "mis_numeros",
    triggers: ["3", "mis numeros", "mis números", "tengo", "verificar", "verificar numeros", "mis tickets", "que numeros tengo", "qué números tengo", "cuales son mis numeros"],
    response:
      `📋 Para verificar tus números dime:

👤 Tu *nombre completo* o
📞 El *número de teléfono* con el que compraste

Y te confirmo en segundos ✅`,
  },
  {
    id: 5,
    nombre: "sorteo",
    triggers: ["4", "resultado", "ganador", "sorteo", "cuando es el sorteo", "cuándo es el sorteo", "cuando sortean", "quien gano", "quién ganó", "ya sortearon"],
    response:
      `🎰 Los sorteos se transmiten en *vivo* por:

📸 Instagram: *@rifas_xyz*
▶️ YouTube: *Rifas XYZ Oficial*

━━━━━━━━━━━━━━━━━━
📅 *Próximo sorteo:*
Rifa #42 → 01/07/2025 a las 8:00pm
━━━━━━━━━━━━━━━━━━

¡No te lo pierdas! 🔴 Activa las notificaciones.`,
  },
  {
    id: 6,
    nombre: "asesor",
    triggers: ["5", "asesor", "humano", "persona", "ayuda", "soporte", "hablar con alguien", "quiero hablar", "agente", "operador"],
    response:
      `👤 Enseguida te conecto con un asesor.

⏳ *Tiempo de espera aproximado:* 2-5 minutos

⏰ *Horario de atención:*
Lun – Vie: 9:00am – 8:00pm
Sábado: 9:00am – 2:00pm
Domingo: Solo por WhatsApp 📲

Si es urgente también puedes escribirnos directo a:
📧 rifasxyz@gmail.com`,
  },
  {
    id: 7,
    nombre: "pago",
    triggers: ["pago", "pagar", "como pago", "cómo pago", "metodos de pago", "métodos de pago", "donde pago", "dónde pago", "cuenta", "datos de pago"],
    response:
      `💳 *Métodos de pago disponibles:*

━━━━━━━━━━━━━━━━━━
📱 *Pago Móvil (Venezuela)*
Banco: Mercantil
RIF: J-123456789
Teléfono: 0414-1234567
━━━━━━━━━━━━━━━━━━
💵 *Zelle (USA)*
Email: rifasxyz@gmail.com
Nombre: Rifas XYZ
━━━━━━━━━━━━━━━━━━
🔶 *Binance (USDT – TRC20)*
Dirección: TXxxx...xxxx
━━━━━━━━━━━━━━━━━━

Después de pagar envía la *captura* por aquí 📸`,
  },
  {
    id: 8,
    nombre: "gracias",
    triggers: ["gracias", "muchas gracias", "thanks", "ok gracias", "perfecto gracias", "listo gracias"],
    response:
      `¡Con mucho gusto! 😊 Estamos para servirte.

Si necesitas algo más escribe *menú* y te mostramos las opciones. 🍀`,
  },
];

const FALLBACK =
  `No entendí bien tu mensaje 😅

Puedes escribir el número de una opción:

1️⃣ Ver rifas activas
2️⃣ Comprar número
3️⃣ Ver mis números
4️⃣ Resultado del sorteo
5️⃣ Hablar con asesor

O escribe *menú* para ver las opciones.`;

// ─────────────────────────────────────────────────────────────
// Lógica de fallback por guión (sin IA)
// ─────────────────────────────────────────────────────────────
function normalize(text) {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

let guionActivo = guion;

function getGuionReply(incoming) {
  if (!incoming || typeof incoming !== "string") return FALLBACK;
  const msg = normalize(incoming);
  for (const item of guionActivo) {
    if (item.triggers.some((t) => msg.includes(normalize(t)))) {
      return item.response;
    }
  }
  return FALLBACK;
}

// ─────────────────────────────────────────────────────────────
// Motor principal: Gemini con fallback al guión
// ─────────────────────────────────────────────────────────────

const GEMINI_ENABLED = !!process.env.GEMINI_API_KEY;

if (GEMINI_ENABLED) {
  console.log("🤖 [AutoReply] Motor: Google Gemini AI");
} else {
  console.log("⚠️  [AutoReply] GEMINI_API_KEY no configurada. Usando guión hardcodeado.");
}

/**
 * Obtiene la respuesta automática para un mensaje entrante.
 * Usa Gemini si está configurado, o el guión hardcodeado como fallback.
 *
 * @param {string} jid      — JID de WhatsApp del remitente
 * @param {string} incoming — Texto del mensaje recibido
 * @returns {Promise<string>} — Respuesta a enviar
 */
async function getAutoReply(jid, incoming) {
  if (!incoming || typeof incoming !== "string") return FALLBACK;

  // Si no hay API key, usar guión directamente
  if (!GEMINI_ENABLED) {
    return getGuionReply(incoming);
  }

  try {
    const reply = await getGeminiReply(jid, incoming);
    return reply;
  } catch (err) {
    console.error(`❌ [AutoReply] Gemini falló, usando guión: ${err.message}`);
    return getGuionReply(incoming);
  }
}

// ─────────────────────────────────────────────────────────────
// Compatibilidad con loadGuionesFromDB (para futura migración a BD)
// ─────────────────────────────────────────────────────────────
async function loadGuionesFromDB(dbQuery) {
  try {
    const rows = await dbQuery(
      "SELECT id, nombre, triggers, response FROM bot_guiones WHERE activo = true ORDER BY orden ASC"
    );
    guionActivo = rows.map((r) => ({
      id: r.id,
      nombre: r.nombre,
      triggers: JSON.parse(r.triggers),
      response: r.response,
    }));
    console.log(`✅ [AutoReply] Guiones de fallback cargados desde BD: ${guionActivo.length} entradas`);
  } catch (err) {
    console.error("❌ [AutoReply] Error cargando guiones desde BD:", err.message);
    guionActivo = guion;
  }
}

function getGuion() {
  return guionActivo;
}

module.exports = {
  getAutoReply,
  loadGuionesFromDB,
  getGuion,
};