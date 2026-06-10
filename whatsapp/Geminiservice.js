/**
 * geminiService.js — Motor IA para el bot de WhatsApp de RESUELVE TU SEMANA
 *
 * Mejoras aplicadas:
 *  ✅ System prompt mejorado con datos reales del negocio + JSON de entrenamiento
 *  ✅ Acumulador de mensajes: espera 4s antes de responder para agrupar rafagas
 *  ✅ Disponibilidad simplificada: solo "disponible" o "no disponible" (sin series)
 *  ✅ Número de asesor real incluido
 *  ✅ Link a la página web incluido
 */

const https = require("https");
const pool  = require("../config/db");

const GROQ_MODEL   = process.env.GROQ_MODEL   || "llama-3.3-70b-versatile";
const GROQ_API_KEY = process.env.GROQ_API_KEY;

// ─────────────────────────────────────────────────────────────
// SYSTEM PROMPT — entrenamiento del bot
// ─────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `
Eres una persona real que atiende los clientes de RESUELVE TU SEMANA por WhatsApp.
No eres un bot ni un asistente virtual. Eres alguien del equipo respondiendo desde el teléfono.

━━━ DATOS DEL NEGOCIO ━━━
Nombre: RESUELVE TU SEMANA
Web: https://rifas-jordyn-f.vercel.app/comprar
Asesor directo: wa.me/584129287210
Horario: Lun–Vie 9am–8pm | Sáb 9am–2pm | Dom solo WhatsApp

Métodos de pago:
  • Pago Móvil — Banco Mercantil | RIF: J-123456789 | Telf: 0414-1234567
  • Zelle — rifasxyz@gmail.com (Nombre: Rifas XYZ)
  • Binance USDT TRC20 — TXxxx...xxxx

Redes: Instagram @rifas_xyz | YouTube: Rifas XYZ Oficial

━━━ CÓMO HABLAR ━━━
- Habla exactamente como lo haría una persona real por WhatsApp en Venezuela.
- Tono natural, cercano, sin formalismos. Nada de "¡Bienvenido!" ni frases de call center.
- Si te saludan, saluda de vuelta con algo natural como "hola qué tal", "buenas", "hola cómo estás".
- Si preguntan cómo estás, responde como una persona: "bien gracias, y tú?", "aquí andamos, en qué te puedo ayudar".
- Frases cortas. Como textos reales de WhatsApp, no párrafos largos.
- Nada de bullets, nada de listas con emojis en fila. Solo texto normal con saltos de línea cuando sea necesario.
- Usa emojis solo si la situación lo pide, máximo 1 o 2, nunca al inicio de cada línea.
- Nunca uses frases como "Con gusto te ayudo", "Estoy aquí para servirte", "¡Perfecto!", "¡Excelente elección!". Eso suena a bot.
- Si hay dos rifas activas, díselo así: "sí tenemos dos ahorita, una es [X] y la otra es [Y], cuál te interesa?"
- Si preguntan por un número: revisa el contexto y responde directo. "sí está libre" o "ese ya está ocupado, quieres otro?"
- Si quieren comprar: pídeles nombre y que manden el comprobante, sin listar pasos numerados.
- Nunca repitas información que ya dijiste en la misma conversación.
- Si no puedes resolver algo, pásales el contacto directo: wa.me/584129287210
- NUNCA menciones "series", "serie A" ni "serie B". Eso es interno.
  Número disponible en cualquier serie → "sí está disponible"
  Número ocupado en todas → "ese ya está ocupado"
- Si el cliente manda varios mensajes seguidos, respóndelos todos en uno solo de forma natural.
- No inventes rifas, precios ni fechas. Si no está en el contexto, di que ahorita lo verificas o pásalos con el asesor.

━━━ EJEMPLOS DE CONVERSACIÓN ━━━
[
  {
    "cliente": "Hola",
    "bot": "Hola qué tal"
  },
  {
    "cliente": "Hola cómo estás",
    "bot": "Bien gracias, y tú? en qué te puedo ayudar"
  },
  {
    "cliente": "Qué rifas tienen?",
    "bot": "Ahorita tenemos dos\nuna es [NOMBRE RIFA 1] con premio [PREMIO] a $[PRECIO] el número\ny la otra es [NOMBRE RIFA 2] con premio [PREMIO] a $[PRECIO]\ncuál te interesa?"
  },
  {
    "cliente": "Cuánto cuesta participar?",
    "bot": "depende de la rifa, la del [PREMIO 1] está a $[PRECIO] y la del [PREMIO 2] a $[PRECIO]\ncuál te llama más la atención?"
  },
  {
    "cliente": "El número 07 está disponible?",
    "bot": "sí, el 07 está disponible\nlo quieres apartar?"
  },
  {
    "cliente": "Quiero el 15",
    "bot": "ese ya está ocupado\nquieres que te diga cuáles están libres o prefieres tú elegir otro?"
  },
  {
    "cliente": "Quiero comprar el número 42",
    "bot": "perfecto, mándame tu nombre completo y cuando hagas el pago me mandas el comprobante y lo aparto\npuedes pagar por pago móvil, zelle o binance, cuál prefieres?"
  },
  {
    "cliente": "Cómo pago?",
    "bot": "tenemos tres opciones\npago móvil: Mercantil, J-123456789, 0414-1234567\nzelle: rifasxyz@gmail.com\nbinance USDT: TXxxx...xxxx\ncuál te queda mejor?"
  },
  {
    "cliente": "Ya pagué",
    "bot": "listo, mándame el comprobante y tu nombre para apartarte el número"
  },
  {
    "cliente": "Cuándo es el sorteo?",
    "bot": "la fecha la tienes en la página: rifas-jordyn-f.vercel.app/comprar\ntambién lo anunciamos por instagram @resuelvetusemana"
  },
  {
    "cliente": "Quiero hablar con alguien",
    "bot": "claro, escríbele directo aquí: wa.me/584129287210"
  },
  {
    "cliente": "hola / tienen rifas / el 7 está libre?",
    "bot": "hola! sí tenemos rifas activas ahorita\n[RIFAS DEL CONTEXTO]\ny el número 07 sí está disponible, lo quieres?"
  }
]

En cada mensaje recibirás un bloque [RIFAS EN ESTE MOMENTO] con los datos reales de la base de datos.
Úsalos como fuente de verdad. Lo que no esté ahí no lo inventes.
`.trim();

// ─────────────────────────────────────────────────────────────
// ACUMULADOR DE MENSAJES — agrupa ráfagas antes de responder
// Si el cliente manda 3 mensajes en 4 segundos, se procesan juntos
// ─────────────────────────────────────────────────────────────
const DEBOUNCE_MS = 4000; // tiempo de espera antes de procesar

// Map: jid -> { timer, mensajes: [] }
const pendingMessages = new Map();

/**
 * Acumula mensajes de un mismo JID y dispara el callback
 * solo cuando pasan DEBOUNCE_MS sin mensajes nuevos.
 *
 * @param {string}   jid      — JID del remitente
 * @param {string}   texto    — texto del mensaje recibido
 * @param {Function} callback — async (jid, textoAcumulado) => void
 */
function acumularMensaje(jid, texto, callback) {
  if (!pendingMessages.has(jid)) {
    pendingMessages.set(jid, { timer: null, mensajes: [] });
  }

  const entry = pendingMessages.get(jid);
  entry.mensajes.push(texto);

  // Reiniciar el timer cada vez que llega un mensaje nuevo
  if (entry.timer) clearTimeout(entry.timer);

  entry.timer = setTimeout(async () => {
    const textoCompleto = entry.mensajes.join("\n").trim();
    pendingMessages.delete(jid);
    try {
      await callback(jid, textoCompleto);
    } catch (err) {
      console.error("❌ [Acumulador] Error en callback:", err.message);
    }
  }, DEBOUNCE_MS);
}

// ─────────────────────────────────────────────────────────────
// CONSULTAS A LA BD
// ─────────────────────────────────────────────────────────────

async function getRifasActivas() {
  const result = await pool.query(`
    SELECT
      r.id,
      r.nombre,
      r.premio,
      r.precio,
      r.fecha_sorteo::text                        AS fecha_sorteo,
      r.hora_sorteo,
      COALESCE(r.tipo,   'sencilla')              AS tipo,
      COALESCE(r.estado, 'activa')                AS estado,
      COALESCE(r.ofertas, '[]'::jsonb)            AS ofertas,
      COALESCE(COUNT(DISTINCT v.id), 0)::int      AS total_ventas,
      r.descripcion
    FROM rifas r
    LEFT JOIN ventas v ON v.rifa_id = r.id
    WHERE r.activa = true
      AND COALESCE(r.estado, 'activa') = 'activa'
    GROUP BY r.id
    ORDER BY r.created_at DESC
  `);
  return result.rows;
}

async function getNumerosOcupadosPorRifa(rifa_id) {
  const ventasR = await pool.query(
    `SELECT COUNT(DISTINCT numero)::int AS vendidos FROM ventas WHERE rifa_id = $1`,
    [rifa_id]
  );
  const reservasR = await pool.query(
    `SELECT COUNT(DISTINCT numero)::int AS reservados
     FROM reservas_cliente
     WHERE rifa_id = $1 AND estado IN ('pendiente', 'aprobado')`,
    [rifa_id]
  );
  return {
    vendidos:   ventasR.rows[0]?.vendidos   || 0,
    reservados: reservasR.rows[0]?.reservados || 0,
  };
}

/**
 * Verifica disponibilidad de un número.
 * Devuelve solo true/false — las series son internas, el cliente no las ve.
 */
async function verificarNumero(rifa_id, numero) {
  const num = String(numero).padStart(3, "0");

  const rifaR = await pool.query(
    `SELECT tipo, categoria_seleccionada_id FROM rifas WHERE id = $1 AND activa = true`,
    [rifa_id]
  );
  if (!rifaR.rows.length) return { disponible: false };

  const { tipo, categoria_seleccionada_id } = rifaR.rows[0];
  const esSimultanea = tipo === "simultanea";
  const ocupadas = new Set();

  if (categoria_seleccionada_id) {
    const r = await pool.query(
      `SELECT serie FROM cat_global_asignaciones WHERE categoria_id = $1 AND numero = $2`,
      [categoria_seleccionada_id, num]
    );
    r.rows.forEach(x => ocupadas.add(x.serie));
  }

  const extraR = await pool.query(
    `SELECT serie FROM boleteria_numeros_extra WHERE rifa_id = $1 AND numero = $2`,
    [rifa_id, num]
  );
  extraR.rows.forEach(x => ocupadas.add(x.serie));

  const ventasR = await pool.query(
    `SELECT COUNT(*)::int AS v FROM ventas WHERE rifa_id = $1 AND numero = $2`,
    [rifa_id, num]
  );
  for (let i = 0; i < (ventasR.rows[0]?.v || 0); i++) {
    if      (!ocupadas.has("A")) ocupadas.add("A");
    else if (!ocupadas.has("B")) ocupadas.add("B");
  }

  const resR = await pool.query(
    `SELECT COUNT(*)::int AS v FROM reservas_cliente
      WHERE rifa_id = $1 AND numero = $2 AND estado IN ('pendiente','aprobado')`,
    [rifa_id, num]
  );
  for (let i = 0; i < (resR.rows[0]?.v || 0); i++) {
    if      (!ocupadas.has("A")) ocupadas.add("A");
    else if (!ocupadas.has("B")) ocupadas.add("B");
  }

  const seriesTotal  = esSimultanea ? ["A", "B"] : ["A"];
  const seriesLibres = seriesTotal.filter(s => !ocupadas.has(s));

  // Solo disponible/no disponible — sin exponer series al bot ni al cliente
  return { numero: num, disponible: seriesLibres.length > 0 };
}

// ─────────────────────────────────────────────────────────────
// BUILDER DE CONTEXTO
// ─────────────────────────────────────────────────────────────

function extraerNumerosMencionados(texto) {
  const matches = [...texto.matchAll(/(?:n[uú]mero|num|#)\s*0*(\d{1,3})\b/gi)];
  const fromEl  = [...texto.matchAll(/\bel\s+0*(\d{1,3})\b/gi)];
  const todos   = [...matches, ...fromEl].map(m => String(m[1]).padStart(3, "0"));
  return [...new Set(todos)]; // sin duplicados
}

function extraerRifaMencionada(texto, rifas) {
  const matchId = texto.match(/rifa\s*#?\s*(\w+)/i);
  if (matchId) {
    const term  = matchId[1].toLowerCase();
    const found = rifas.find(r =>
      r.id.toLowerCase().includes(term) ||
      r.nombre.toLowerCase().includes(term)
    );
    if (found) return found;
  }
  return rifas.find(r => texto.toLowerCase().includes(r.nombre.toLowerCase())) || null;
}

async function buildRifasContext(incoming) {
  try {
    const rifas = await getRifasActivas();

    if (!rifas.length) {
      return "[RIFAS EN ESTE MOMENTO]\nNo hay rifas activas en este momento.";
    }

    const lineas = [];
    for (const r of rifas) {
      const { vendidos, reservados } = await getNumerosOcupadosPorRifa(r.id);

      let ofertasTexto = "";
      if (Array.isArray(r.ofertas) && r.ofertas.length > 0) {
        ofertasTexto = " | Ofertas: " + r.ofertas
          .map(o => `${o.cantidad} números por $${o.precio_total}`)
          .join(", ");
      }

      lineas.push(
        `• "${r.nombre}" [id:${r.id}]` +
        ` — Premio: ${r.premio}` +
        ` — Precio: $${r.precio}/número${ofertasTexto}` +
        ` — Sorteo: ${r.fecha_sorteo || "por anunciar"}${r.hora_sorteo ? " " + r.hora_sorteo : ""}` +
        ` — Vendidos: ${vendidos} | Reservados: ${reservados}`
      );
    }

    let contexto = "[RIFAS EN ESTE MOMENTO]\n" + lineas.join("\n");

    // Verificar todos los números mencionados en el mensaje
    const numeros = extraerNumerosMencionados(incoming);
    if (numeros.length > 0) {
      const rifaMencionada = extraerRifaMencionada(incoming, rifas)
                          || (rifas.length === 1 ? rifas[0] : null);

      if (rifaMencionada) {
        const verificaciones = await Promise.all(
          numeros.map(n => verificarNumero(rifaMencionada.id, n))
        );
        const lines = verificaciones.map(d =>
          `Número ${d.numero}: ${d.disponible ? "DISPONIBLE ✅" : "NO DISPONIBLE ❌"}`
        );
        contexto += `\n\n[DISPONIBILIDAD EN "${rifaMencionada.nombre}"]\n` + lines.join("\n");
      }
    }

    return contexto;
  } catch (err) {
    console.error("❌ [AI] Error construyendo contexto de rifas:", err.message);
    return "[RIFAS EN ESTE MOMENTO]\nNo se pudo obtener la información en este momento.";
  }
}

// ─────────────────────────────────────────────────────────────
// HISTORIAL DE CONVERSACIÓN por JID
// ─────────────────────────────────────────────────────────────
const MAX_HISTORY = 10;
const conversationHistory = new Map();

function getHistory(jid) {
  if (!conversationHistory.has(jid)) conversationHistory.set(jid, []);
  return conversationHistory.get(jid);
}

function addToHistory(jid, role, content) {
  const history = getHistory(jid);
  history.push({ role, content });
  if (history.length > MAX_HISTORY * 2) history.splice(0, 2);
}

function clearHistory(jid) {
  conversationHistory.delete(jid);
  console.log(`🧹 [AI] Historial borrado para ${jid}`);
}

function clearAllHistories() {
  conversationHistory.clear();
  console.log("🧹 [AI] Todos los historiales borrados.");
}

function getHistoryStats() {
  const stats = [];
  for (const [jid, h] of conversationHistory.entries()) {
    stats.push({ jid, turns: Math.floor(h.length / 2) });
  }
  return { totalUsers: conversationHistory.size, users: stats };
}

// ─────────────────────────────────────────────────────────────
// LLAMADA A GROQ
// ─────────────────────────────────────────────────────────────
function callGroqAPI(messages) {
  return new Promise((resolve, reject) => {
    if (!GROQ_API_KEY) {
      return reject(new Error("GROQ_API_KEY no está configurada en las variables de entorno."));
    }

    const body = JSON.stringify({
      model: GROQ_MODEL,
      messages,
      temperature: 0.65,
      max_tokens: 512,
      top_p: 0.9,
    });

    const options = {
      hostname: "api.groq.com",
      path: "/openai/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${GROQ_API_KEY}`,
        "Content-Length": Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(`Groq API error: ${parsed.error.message}`));
          const text = parsed?.choices?.[0]?.message?.content;
          if (!text) return reject(new Error("Groq no devolvió texto en la respuesta."));
          resolve(text.trim());
        } catch (e) {
          reject(new Error(`Error parseando respuesta de Groq: ${e.message}`));
        }
      });
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────
// API PÚBLICA
// ─────────────────────────────────────────────────────────────

/**
 * Genera una respuesta para el mensaje (o ráfaga acumulada) del cliente.
 * Nombre mantenido como getGeminiReply para no romper importaciones.
 */
async function getGeminiReply(jid, incoming) {
  if (!incoming || typeof incoming !== "string") {
    throw new Error("El mensaje entrante debe ser un string no vacío.");
  }

  const rifasCtx = await buildRifasContext(incoming);
  const history  = getHistory(jid);

  const messages = [
    { role: "system",    content: SYSTEM_PROMPT },
    ...history,
    { role: "user",      content: `${incoming}\n\n${rifasCtx}` },
  ];

  const reply = await callGroqAPI(messages);

  addToHistory(jid, "user",      incoming);
  addToHistory(jid, "assistant", reply);

  return reply;
}

module.exports = {
  getGeminiReply,
  acumularMensaje,      // ← exportado para usar en whatsappService.js
  clearHistory,
  clearAllHistories,
  getHistoryStats,
  getRifasActivas,
  verificarNumero,
};