// ============================================================
//  ia.js — Proveedores de IA intercambiables para el bot de WhatsApp
//  Todos soportan herramientas (function calling) y, si el modelo lo
//  permite, imágenes (para leer comprobantes de pago).
//
//  - Compatibles con el formato OpenAI: Gemini, OpenAI, Groq, OpenRouter, DeepSeek
//  - Anthropic (Claude): SDK oficial @anthropic-ai/sdk
// ============================================================
const AnthropicSDK = require('@anthropic-ai/sdk');
const Anthropic = AnthropicSDK.default || AnthropicSDK;

const PROVEEDORES = {
  gemini: {
    nombre: 'Google Gemini',
    base: 'https://generativelanguage.googleapis.com/v1beta/openai',
    env: 'GEMINI_API_KEY',
    modeloDefecto: 'gemini-3.8-flash',
    nota: 'Capa gratuita generosa, lee imágenes. Recomendado para empezar.',
    urlClave: 'https://aistudio.google.com/apikey',
  },
  anthropic: {
    nombre: 'Anthropic Claude',
    env: 'ANTHROPIC_API_KEY',
    modeloDefecto: 'claude-opus-5-5',
    nota: 'La conversación más natural y el mejor uso de herramientas. De pago.',
    urlClave: 'https://platform.claude.com/settings/keys',
  },
  openai: {
    nombre: 'OpenAI',
    base: 'https://api.openai.com/v1',
    env: 'OPENAI_API_KEY',
    modeloDefecto: '',
    nota: 'De pago. Elige el modelo con "Cargar modelos".',
    urlClave: 'https://platform.openai.com/api-keys',
  },
  groq: {
    nombre: 'Groq',
    base: 'https://api.groq.com/openai/v1',
    env: 'GROQ_API_KEY',
    modeloDefecto: 'openai/gpt-oss-120b',
    modelosRespaldo: ['qwen/qwen3.8-27b', 'openai/gpt-oss-20b'],   // cada modelo tiene su propio cupo por minuto
    nota: 'Gratis y muy rápido (cupo limitado por minuto). El servidor debe estar fuera de Venezuela.',
    urlClave: 'https://console.groq.com/keys',
  },
  openrouter: {
    nombre: 'OpenRouter',
    base: 'https://openrouter.ai/api/v1',
    env: 'OPENROUTER_API_KEY',
    modeloDefecto: '',
    nota: 'Una sola clave para cientos de modelos de distintas empresas.',
    urlClave: 'https://openrouter.ai/keys',
  },
  deepseek: {
    nombre: 'DeepSeek',
    base: 'https://api.deepseek.com',
    env: 'DEEPSEEK_API_KEY',
    modeloDefecto: 'deepseek-chat',
    nota: 'Muy económico. No lee imágenes.',
    urlClave: 'https://platform.deepseek.com/api_keys',
  },
};

function claveDe(cfg, proveedor = cfg.proveedor) {
  return (cfg.api_keys && cfg.api_keys[proveedor]) || process.env[PROVEEDORES[proveedor]?.env] || '';
}

function modeloDe(cfg) {
  return (cfg.modelo || '').trim() || PROVEEDORES[cfg.proveedor]?.modeloDefecto || '';
}

class ErrorIA extends Error {
  constructor(msg, { status, reintentable = false } = {}) {
    super(msg); this.status = status; this.reintentable = reintentable;
  }
}

// ── Formato OpenAI ───────────────────────────────────────────
function aOpenAI(m) {
  if (typeof m.content === 'string') return { role: m.role, content: m.content };
  return {
    role: m.role,
    content: m.content.map((p) => p.type === 'image'
      ? { type: 'image_url', image_url: { url: `data:${p.mime};base64,${p.base64}` } }
      : { type: 'text', text: p.text }),
  };
}

// Reintenta si el proveedor dice "límite por minuto" (429) o falla temporalmente,
// esperando lo que él indica. Si sigue limitado, prueba los modelos de respaldo.
async function llamarOpenAI(cfg, cuerpo) {
  const prov = PROVEEDORES[cfg.proveedor];
  const modelos = [cuerpo.model, ...(prov.modelosRespaldo || []).filter((m) => m !== cuerpo.model)];
  let ultimoError;
  for (const model of modelos) {
    for (let intento = 0; intento < 2; intento++) {
      try {
        return await llamarOpenAIUnaVez(cfg, { ...cuerpo, model });
      } catch (e) {
        ultimoError = e;
        if (!e.reintentable) throw e;
        const espera = Math.min(20, Number((e.message.match(/try again in ([\d.]+)s/i) || [])[1]) || 2 ** intento * 2);
        if (e.status === 429 && espera > 8) break;      // cupo largo: mejor otro modelo
        await new Promise((r) => setTimeout(r, espera * 1000 + 300));
      }
    }
  }
  throw ultimoError;
}

async function llamarOpenAIUnaVez(cfg, cuerpo) {
  const prov = PROVEEDORES[cfg.proveedor];
  const clave = claveDe(cfg);
  if (!clave) throw new ErrorIA(`Falta la API key de ${prov.nombre}.`);
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${clave}` };
  if (cfg.proveedor === 'openrouter') { headers['X-Title'] = 'Rifas Jordyn WhatsApp'; }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 60000);
  let r;
  try {
    r = await fetch(`${prov.base}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(cuerpo), signal: ctrl.signal });
  } catch (e) {
    throw new ErrorIA(`No se pudo conectar con ${prov.nombre}: ${e.message}`, { reintentable: true });
  } finally { clearTimeout(t); }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = d?.error?.message || d?.[0]?.error?.message || `HTTP ${r.status}`;
    throw new ErrorIA(`${prov.nombre}: ${msg}`, { status: r.status, reintentable: r.status === 429 || r.status >= 500 });
  }
  return d;
}

async function chatOpenAI(cfg, { system, mensajes, herramientas, ejecutar, maxPasos, maxTokens }) {
  const tools = herramientas?.length
    ? herramientas.map((h) => ({ type: 'function', function: { name: h.nombre, description: h.descripcion, parameters: h.parametros } }))
    : undefined;
  const msgs = [{ role: 'system', content: system }, ...mensajes.map(aOpenAI)];
  const llamadas = [];
  const limite = cfg.proveedor === 'openai' ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens };

  for (let paso = 0; paso <= maxPasos; paso++) {
    const d = await llamarOpenAI(cfg, { model: modeloDe(cfg), messages: msgs, ...(tools ? { tools } : {}), ...limite });
    const msg = d.choices?.[0]?.message;
    if (!msg) throw new ErrorIA('La IA no devolvió respuesta.');
    const calls = msg.tool_calls || [];
    if (!calls.length || paso === maxPasos) return { texto: (msg.content || '').trim(), llamadas };

    msgs.push({ role: 'assistant', content: msg.content || null, tool_calls: calls });
    for (const c of calls) {
      let args = {};
      try { args = JSON.parse(c.function.arguments || '{}'); } catch (_) {}
      const resultado = await ejecutar(c.function.name, args);
      llamadas.push({ nombre: c.function.name, args, resultado });
      msgs.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(resultado) });
    }
  }
  return { texto: '', llamadas };
}

// ── Anthropic (Claude) con el SDK oficial ────────────────────
function aAnthropic(m) {
  if (typeof m.content === 'string') return { role: m.role, content: m.content };
  return {
    role: m.role,
    content: m.content.map((p) => p.type === 'image'
      ? { type: 'image', source: { type: 'base64', media_type: p.mime, data: p.base64 } }
      : { type: 'text', text: p.text }),
  };
}

// Modelos de la generación actual: esfuerzo configurable y respaldo del
// lado del servidor si el modelo rechaza la petición.
const esGeneracionActual = (m) => /^claude-(opus-5|sonnet-5-5|fable-5)/.test(m);

async function chatAnthropic(cfg, { system, mensajes, herramientas, ejecutar, maxPasos }) {
  const clave = claveDe(cfg);
  if (!clave) throw new ErrorIA('Falta la API key de Anthropic.');
  const client = new Anthropic({ apiKey: clave, maxRetries: 2, timeout: 90000 });
  const model = modeloDe(cfg);
  const tools = (herramientas || []).map((h) => ({ name: h.nombre, description: h.descripcion, input_schema: h.parametros }));
  const messages = mensajes.map(aAnthropic);
  const llamadas = [];

  for (let paso = 0; paso <= maxPasos; paso++) {
    const params = { model, max_tokens: 8000, system, messages, ...(tools.length ? { tools } : {}) };
    let resp;
    try {
      resp = esGeneracionActual(model)
        ? await client.beta.messages.create({
            ...params,
            output_config: { effort: 'low' },          // chat de ventas: rápido y conciso
            betas: ['server-side-fallback-2026-07-01'],
            fallbacks: 'default',
          })
        : await client.messages.create(params);
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError) throw new ErrorIA('Anthropic: API key inválida.', { status: 401 });
      if (e instanceof Anthropic.NotFoundError) throw new ErrorIA(`Anthropic: el modelo "${model}" no existe.`, { status: 404 });
      if (e instanceof Anthropic.RateLimitError) throw new ErrorIA('Anthropic: límite de uso alcanzado, intenta luego.', { status: 429, reintentable: true });
      if (e instanceof Anthropic.APIError) throw new ErrorIA(`Anthropic: ${e.message}`, { status: e.status, reintentable: (e.status || 0) >= 500 });
      throw new ErrorIA(`No se pudo conectar con Anthropic: ${e.message}`, { reintentable: true });
    }

    if (resp.stop_reason === 'refusal') throw new ErrorIA('Claude no quiso responder este mensaje.');
    const texto = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    const usos = resp.content.filter((b) => b.type === 'tool_use');
    if (resp.stop_reason !== 'tool_use' || !usos.length || paso === maxPasos) return { texto, llamadas };

    messages.push({ role: 'assistant', content: resp.content });   // contenido completo, sin editar
    const resultados = [];
    for (const u of usos) {
      const resultado = await ejecutar(u.name, u.input || {});
      llamadas.push({ nombre: u.name, args: u.input, resultado });
      resultados.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(resultado) });
    }
    messages.push({ role: 'user', content: resultados });           // todos juntos en un solo mensaje
  }
  return { texto: '', llamadas };
}

/**
 * Conversación con herramientas.
 * mensajes: [{ role: 'user'|'assistant', content: string | [{type:'text',text}|{type:'image',mime,base64}] }]
 * herramientas: [{ nombre, descripcion, parametros (JSON Schema) }]
 * ejecutar: async (nombre, args) => resultado (objeto serializable)
 */
async function chatConHerramientas(cfg, opciones) {
  if (!PROVEEDORES[cfg.proveedor]) throw new ErrorIA(`Proveedor desconocido: ${cfg.proveedor}`);
  if (!modeloDe(cfg)) throw new ErrorIA('Elige un modelo en la configuración del bot.');
  const o = { maxPasos: 5, maxTokens: 4096, ...opciones };
  return cfg.proveedor === 'anthropic' ? chatAnthropic(cfg, o) : chatOpenAI(cfg, o);
}

// ── Leer un comprobante de pago con visión ───────────────────
async function leerComprobante(cfg, { base64, mime }) {
  const system = 'Extraes datos de comprobantes de pago (pago móvil, transferencias, Zelle, Binance) de Venezuela. Respondes SOLO con JSON válido, sin texto adicional.';
  const pedido = 'Analiza la imagen. Devuelve este JSON: {"es_comprobante": true|false, "monto": number|null, "moneda": "Bs"|"USD"|"USDT"|null, "referencia": string|null, "banco": string|null, "fecha": string|null, "titular": string|null}. Si no es un comprobante de pago, es_comprobante=false.';
  const { texto } = await chatConHerramientas(cfg, {
    system,
    mensajes: [{ role: 'user', content: [{ type: 'image', mime, base64 }, { type: 'text', text: pedido }] }],
    herramientas: [], ejecutar: async () => ({}), maxPasos: 0, maxTokens: 1024,
  });
  const json = texto.match(/\{[\s\S]*\}/);
  if (!json) return null;
  try { return JSON.parse(json[0]); } catch (_) { return null; }
}

// ── Probar la configuración (clave + modelo + herramientas) ──
async function probar(cfg) {
  const t0 = Date.now();
  let usoHerramienta = false;
  const { texto } = await chatConHerramientas(cfg, {
    system: 'Eres un asistente de pruebas. Usa la herramienta hora_actual y luego responde en una frase en español.',
    mensajes: [{ role: 'user', content: '¿Qué hora es?' }],
    herramientas: [{ nombre: 'hora_actual', descripcion: 'Devuelve la hora actual', parametros: { type: 'object', properties: {}, required: [] } }],
    ejecutar: async () => { usoHerramienta = true; return { hora: new Date().toLocaleTimeString('es-VE') }; },
    maxPasos: 2, maxTokens: 1024,
  });
  return { ok: true, ms: Date.now() - t0, usoHerramienta, respuesta: texto };
}

// ── Modelos disponibles en vivo ──────────────────────────────
async function listarModelos(cfg, proveedor) {
  const prov = PROVEEDORES[proveedor];
  if (!prov) throw new ErrorIA('Proveedor desconocido');
  const clave = claveDe(cfg, proveedor);
  if (!clave) throw new ErrorIA(`Falta la API key de ${prov.nombre}.`);

  if (proveedor === 'anthropic') {
    const client = new Anthropic({ apiKey: clave });
    const ids = [];
    for await (const m of client.models.list()) ids.push(m.id);
    return ids;
  }
  const r = await fetch(`${prov.base}/models`, { headers: { Authorization: `Bearer ${clave}` } });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new ErrorIA(`${prov.nombre}: ${d?.error?.message || d?.[0]?.error?.message || 'HTTP ' + r.status}`, { status: r.status });
  let ids = (d.data || []).map((m) => String(m.id).replace(/^models\//, ''));
  if (proveedor === 'gemini') ids = ids.filter((id) => /^gemini/.test(id) && !/embedding|tts|image|audio|live/.test(id));
  if (proveedor === 'openai') ids = ids.filter((id) => /^(gpt|o\d|chatgpt)/.test(id) && !/audio|realtime|transcribe|tts|image|search/.test(id));
  if (proveedor === 'groq') ids = ids.filter((id) => !/whisper|tts|guard/.test(id));
  return ids.sort();
}

function catalogo() {
  return Object.entries(PROVEEDORES).map(([id, p]) => ({
    id, nombre: p.nombre, nota: p.nota, modeloDefecto: p.modeloDefecto, urlClave: p.urlClave,
    claveEnServidor: !!process.env[p.env],
  }));
}

module.exports = { PROVEEDORES, ErrorIA, chatConHerramientas, leerComprobante, probar, listarModelos, catalogo, claveDe, modeloDe };
