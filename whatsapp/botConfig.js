// ============================================================
//  botConfig.js — Configuración del bot de WhatsApp (guardada en la BD)
//  Las API keys viven aquí y no en el .env/Git; al leerlas desde el
//  panel se devuelven enmascaradas.
// ============================================================
const pool = require('../config/db');
const { tablasListas } = require('../services/waChats');

const PERSONALIDAD_DEFECTO = `Eres parte del equipo de ventas y atiendes a los clientes por WhatsApp desde el teléfono del negocio, en Venezuela.
Escribe como una persona real: mensajes cortos, tono cercano y natural, sin frases de call center ni listas con viñetas.
Usa emojis solo de vez en cuando. No digas que eres un bot o una IA; si te lo preguntan directamente, di con naturalidad que eres del equipo de atención.
Nunca inventes rifas, precios, fechas ni disponibilidad: consúltalo siempre con tus herramientas.
Resuelve tú todo lo de la compra de principio a fin; solo pasa a una persona cuando de verdad no puedas.`;

const DEFECTO = {
  activo: true,
  proveedor: 'gemini',
  modelo: '',
  api_keys: {},
  nombre_negocio: 'Rifas Jordyn',
  moneda: 'pesos',              // moneda de los precios de las rifas (la IA no debe adivinarla)
  nombre_asistente: '',
  personalidad: PERSONALIDAD_DEFECTO,
  // Temas que el bot NO resuelve: avisa al dueño para que él dé la información
  temas_dueno: '- Quiere ser vendedor o pregunta cómo puede vender números.\n- Quiere cobrar un premio.',
  apartado_minutos: 45,         // minutos que quedan bloqueados los números esperando el comprobante (en el panel se escribe en horas)
  // El dueño recibe por WhatsApp los clientes que necesitan una persona y puede
  // responder desde ahí mismo (1 = lo atiende él, 2 = sigue el bot, o le dicta qué decir).
  dueno: {
    nombre: 'Jordyn',
    telefono: '584129287210',
    notificar: true,            // avisar apenas un cliente necesite atención
    resumen_cada_min: 60,       // recordatorio de pendientes (0 = nunca)
    silencio_desde: '22:00',    // sin avisos de noche (los pendientes llegan en el resumen de la mañana)
    silencio_hasta: '07:00',
    panel_url: 'https://rifas-jordyn-f.vercel.app/whatsapp',
  },
  // Administradores: además del dueño, pueden preguntarle al bot cosas del sistema
  // (ventas, clientes, pagos por aprobar…). No reciben los avisos ni manejan la cola.
  administradores: [
    { nombre: 'Lorena Rangel', telefono: '584121015761' },
  ],
  info_extra: '',
  pedir_cedula: true,
  leer_comprobantes: true,
  avisar_rechazo: true,
  mensaje_sin_ia: 'Hola 👋 dame un momentico y ya te atiendo.',
  horario: {
    activo: false,
    desde: '08:00',
    hasta: '21:00',
    dias: [1, 2, 3, 4, 5, 6],
    mensaje_fuera: 'Hola! Ahorita estamos fuera de horario, apenas abramos te respondemos 🙌',
  },
  antiban: {
    max_por_minuto: 12,          // mensajes salientes por minuto (todo el número)
    max_por_dia: 1000,           // mensajes salientes por día
    max_chats_nuevos_dia: 30,    // números que nunca nos escribieron y a los que les escribimos primero
    escribiendo_cps: 28,         // velocidad de "escribiendo…" (caracteres por segundo)
    espera_min_ms: 1200,         // pausa aleatoria entre mensajes
    espera_max_ms: 3500,
    agrupar_ms: 6000,            // espera para juntar ráfagas del cliente en una sola respuesta
    ignorar_viejos_min: 10,      // no responder solo mensajes con más de X min (al reconectar)
    max_respuestas_5min: 8,      // si el bot responde más que esto en 5 min a un chat → pausa (anti-bucle)
    // Tickets a clientes "fríos" (compraron por la página y nunca escribieron):
    frio_espera_min_seg: 90,     // pausa aleatoria entre uno y otro
    frio_espera_max_seg: 240,
    frio_desde: '08:00',         // solo de día
    frio_hasta: '20:30',
  },
};

let cache = null;
let cacheAt = 0;

function fusionar(base, extra) {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object'
      ? { ...base[k], ...v }
      : v;
  }
  return out;
}

async function obtenerConfig({ fresca = false } = {}) {
  if (!fresca && cache && Date.now() - cacheAt < 30000) return cache;
  await tablasListas;
  const r = await pool.query(`SELECT config FROM wa_bot_config WHERE id=1`);
  cache = fusionar(DEFECTO, r.rows[0]?.config || {});
  cacheAt = Date.now();
  return cache;
}

const enmascarar = (k) => (k ? `${k.slice(0, 4)}••••••${k.slice(-4)}` : '');

// Versión para el panel: claves enmascaradas
async function configPublica() {
  const c = await obtenerConfig({ fresca: true });
  const api_keys = {};
  for (const [p, k] of Object.entries(c.api_keys || {})) api_keys[p] = enmascarar(k);
  return { ...c, api_keys };
}

// Guarda cambios. Una clave vacía o enmascarada no reemplaza la guardada;
// para borrarla se envía null.
async function guardarConfig(cambios) {
  const actual = await obtenerConfig({ fresca: true });
  const api_keys = { ...(actual.api_keys || {}) };
  for (const [p, k] of Object.entries(cambios.api_keys || {})) {
    if (k === null) delete api_keys[p];
    else if (typeof k === 'string' && k.trim() && !k.includes('••')) api_keys[p] = k.trim();
  }
  const nueva = fusionar(actual, { ...cambios, api_keys });
  nueva.api_keys = api_keys;
  await pool.query(`
    INSERT INTO wa_bot_config (id, config, updated_at) VALUES (1, $1, NOW())
    ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config, updated_at = NOW()`, [JSON.stringify(nueva)]);
  cache = nueva;
  cacheAt = Date.now();
  return configPublica();
}

module.exports = { DEFECTO, obtenerConfig, configPublica, guardarConfig };
