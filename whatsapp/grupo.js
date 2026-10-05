// ============================================================
//  grupo.js — El bot en el grupo de WhatsApp del negocio
//
//  1. Avisos automáticos (cada uno se prende/apaga en el panel):
//      - resultado del sorteo (con la foto del ganador si ya está cargada)
//      - foto del ganador cuando se sube después
//      - recordatorio unas horas antes del sorteo
//      - rifa nueva
//  2. Mensaje manual desde el panel (texto y/o imagen).
//  3. Respuestas en el grupo SOLO cuando mencionan al bot o le responden a
//     un mensaje suyo, cortas y con información pública. Las compras siguen
//     por el chat privado (nada de cédulas ni datos de pago en el grupo).
//
//  Cada aviso sale una sola vez (tabla wa_grupo_envios, clave única).
//  Los mensajes del grupo no se guardan en la BD ni aparecen en Chats.
// ============================================================
const pool = require('../config/db');
const bus  = require('../services/waBus');
const reservas = require('../services/reservas');
const resultados = require('../services/resultados');
const ganadores = require('../services/ganadores');
const sitio = require('../services/sitio');
const { obtenerConfig, guardarConfig } = require('./botConfig');

let t = null;     // transporte: lo inyecta whatsappService
let bot = null;   // { responderEnGrupo } — lo inyecta bot.js (evita dependencia circular)
function init(transporte) { t = transporte; }
function usarBot(b) { bot = b; }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tablaLista = (async () => {
  const sqls = [
    `CREATE TABLE IF NOT EXISTS wa_grupo_envios (
       id          BIGSERIAL PRIMARY KEY,
       clave       TEXT UNIQUE,                          -- evita repetir un aviso automático (NULL = manual)
       tipo        VARCHAR(20) NOT NULL,                 -- resultado | ganador | previo | nueva | manual | instalado
       texto       TEXT,
       imagen_url  TEXT,
       estado      VARCHAR(12) NOT NULL DEFAULT 'enviando',   -- enviando | enviado | error
       error       TEXT,
       created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
    // Marca desde cuándo existe esta función: las rifas creadas antes no se anuncian como "nuevas"
    `INSERT INTO wa_grupo_envios (clave, tipo, estado) VALUES ('instalado', 'instalado', 'enviado') ON CONFLICT (clave) DO NOTHING`,
  ];
  for (const sql of sqls) {
    try { await pool.query(sql); } catch (e) { console.error('[grupo] esquema:', e.message); }
  }
})();

// ── Utilidades ───────────────────────────────────────────────
function horaVE() {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Caracas' }));
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
// De noche no se escribe en el grupo (los avisos programados esperan a la mañana)
const deDia = () => { const h = horaVE(); return h >= '07:00' && h < '22:00'; };

const fmtMonto = (n, cfg) => `${Number(n || 0).toLocaleString('es-CO')} ${cfg.moneda || 'pesos'}`;
function fmtFecha(f) {
  const d = new Date(`${String(f).slice(0, 10)}T12:00:00-04:00`);
  return isNaN(d.getTime()) ? String(f) : d.toLocaleDateString('es-VE', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Caracas' });
}
function fmtHora(h) {
  const [hh, mm] = String(h || '').split(':').map(Number);
  if (isNaN(hh)) return null;
  return `${hh % 12 || 12}:${String(mm || 0).padStart(2, '0')} ${hh < 12 ? 'a. m.' : 'p. m.'}`;
}

// Dónde comprar: la página y el privado del bot
function comoComprar(cfg) {
  const url = cfg.grupo?.url_pagina;
  const numero = t?.numeroBot?.();
  return [
    url ? `🌐 ${url}` : null,
    numero ? `💬 O escríbeme al privado: wa.me/${numero}` : null,
  ].filter(Boolean).join('\n');
}

// ── Qué grupo es ─────────────────────────────────────────────
// El elegido en el panel; si no hay, se deduce del enlace de invitación
// configurado para la página del cliente y se deja guardado.
async function resolverGrupo(cfg) {
  if (cfg.grupo?.jid) return cfg.grupo.jid;
  if (!t?.conectado()) return null;
  try {
    const enlace = (await sitio.obtenerConfig()).grupo_whatsapp || '';
    const codigo = enlace.match(/chat\.whatsapp\.com\/([A-Za-z0-9]+)/)?.[1];
    if (!codigo) return null;
    const info = await t.infoInvitacion(codigo);
    if (!info?.id) return null;
    await guardarConfig({ grupo: { ...cfg.grupo, jid: info.id, nombre: info.subject || '' } });
    console.log(`👥 [Grupo] Grupo detectado por el enlace: ${info.subject || info.id}`);
    return info.id;
  } catch (e) {
    console.error('❌ [Grupo] No se pudo detectar el grupo por el enlace:', e.message);
    return null;
  }
}

// ── Publicar ─────────────────────────────────────────────────
// Con clave: el aviso sale una sola vez. Devuelve la fila o null si no se envió.
async function publicar({ clave = null, tipo, texto, imagen = null }) {
  await tablaLista;
  const cfg = await obtenerConfig();
  if (!cfg.grupo?.activo && tipo !== 'manual') return null;
  if (!t?.conectado()) { if (tipo === 'manual') throw new Error('WhatsApp no está conectado.'); return null; }
  const jid = await resolverGrupo(cfg);
  if (!jid) { if (tipo === 'manual') throw new Error('No hay un grupo configurado. Elígelo en WhatsApp → Grupo.'); return null; }

  const ins = await pool.query(
    `INSERT INTO wa_grupo_envios (clave, tipo, texto, imagen_url) VALUES ($1, $2, $3, $4)
     ON CONFLICT (clave) DO NOTHING RETURNING id`, [clave, tipo, texto, typeof imagen === 'string' ? imagen : null]);
  if (!ins.rows[0]) return null;   // ese aviso ya salió
  const id = ins.rows[0].id;
  try {
    await t.enviarAGrupo(jid, imagen ? { image: typeof imagen === 'string' ? { url: imagen } : imagen, caption: texto || '' } : { text: texto });
    const r = await pool.query(`UPDATE wa_grupo_envios SET estado = 'enviado' WHERE id = $1 RETURNING *`, [id]);
    return r.rows[0];
  } catch (e) {
    console.error(`❌ [Grupo] No se pudo publicar (${tipo}):`, e.message);
    await pool.query(`UPDATE wa_grupo_envios SET estado = 'error', error = $2 WHERE id = $1`, [id, e.message.slice(0, 300)]);
    if (tipo === 'manual') throw e;
    return null;
  }
}

// ── 1a. Resultado del sorteo ─────────────────────────────────
// Si se cargan varios premios seguidos, sale un solo mensaje con todos.
const resultadosPendientes = new Map();   // rifa_id → timer
bus.on('resultado:registrado', ({ rifaId }) => {
  clearTimeout(resultadosPendientes.get(rifaId));
  resultadosPendientes.set(rifaId, setTimeout(() => {
    resultadosPendientes.delete(rifaId);
    anunciarResultado(rifaId).catch((e) => console.error('❌ [Grupo] resultado:', e.message));
  }, 2 * 60000));
});

function lineaResultado(x, varios) {
  const quien = x.ganador
    ? `🏆 Ganador: *${x.ganador}*`
    : /^Nadie/i.test(x.detalle || '') ? 'Esta vez nadie tenía ese número 😮' : 'El ganador se anuncia pronto 👀';
  return `${varios ? `${x.premio}: ` : 'Número ganador: '}*${x.numero}*${x.serie ? ` (serie ${x.serie})` : ''}\n${quien}`;
}

async function anunciarResultado(rifaId) {
  const cfg = await obtenerConfig();
  if (!cfg.grupo?.activo || !cfg.grupo.avisar_resultado) return;
  const sorteo = (await resultados.sorteosRecientes(21)).find((s) => s.id === rifaId);
  if (!sorteo?.resultados.length) return;
  const clave = `resultado:${rifaId}:${sorteo.resultados.map((x) => `${x.premio}=${x.numero}`).join('|')}`;
  const varios = sorteo.resultados.length > 1;
  const texto = `🎉 *Resultado de ${sorteo.nombre}*\n\n${sorteo.resultados.map((x) => lineaResultado(x, varios)).join('\n\n')}\n\n¡Felicidades! 🥳 Gracias a todos por participar 🍀`;
  // Si la foto del ganador ya está cargada, sale con ella
  const fotos = await ganadores.fotosDeResultados([sorteo]).catch(() => new Map());
  const foto = [...fotos.values()][0] || null;
  const enviado = await publicar({ clave, tipo: 'resultado', texto, imagen: foto?.imagen_url || null });
  if (enviado && foto) {
    // Esa foto ya salió: que no se repita como "foto del ganador"
    await pool.query(`INSERT INTO wa_grupo_envios (clave, tipo, estado) VALUES ($1, 'ganador', 'enviado') ON CONFLICT (clave) DO NOTHING`, [`foto:${foto.id}`]);
  }
}

// ── 1b. Foto del ganador subida después ──────────────────────
bus.on('ganador:publicado', (g) => {
  anunciarGanador(g).catch((e) => console.error('❌ [Grupo] ganador:', e.message));
});
async function anunciarGanador(g) {
  const cfg = await obtenerConfig();
  if (!cfg.grupo?.activo || !cfg.grupo.avisar_ganador || !g?.imagen_url || !g.visible || !g.rifa_id) return;
  const texto = `🏆 *¡Nuestro ganador!*\n\n*${g.nombre}*${g.premio ? ` se llevó: ${g.premio}` : ''}${g.numero ? `\nNúmero ganador: *${g.numero}*` : ''}${g.rifa ? `\n🎟️ ${g.rifa}` : ''}\n\n¡Felicidades! 🥳 El próximo puedes ser tú 🍀`;
  await publicar({ clave: `foto:${g.id}`, tipo: 'ganador', texto, imagen: g.imagen_url });
}

// ── 1c y 1d. Recordatorio antes del sorteo y rifa nueva ──────
async function revisarProgramados() {
  await tablaLista;
  const cfg = await obtenerConfig();
  if (!cfg.grupo?.activo || !t?.conectado() || !deDia()) return;

  if (cfg.grupo.avisar_antes_sorteo) {
    const horas = Math.min(24, Math.max(1, Number(cfg.grupo.horas_antes) || 2));
    const r = await pool.query(`
      SELECT id FROM rifas
       WHERE activa AND publicada AND COALESCE(estado, 'activa') = 'activa' AND fecha_sorteo IS NOT NULL AND hora_sorteo IS NOT NULL
         AND (fecha_sorteo + hora_sorteo) > (NOW() AT TIME ZONE 'America/Caracas')
         AND (fecha_sorteo + hora_sorteo) <= (NOW() AT TIME ZONE 'America/Caracas') + $1 * INTERVAL '1 hour'
         AND NOT EXISTS (SELECT 1 FROM wa_grupo_envios e WHERE e.clave = 'previo:' || rifas.id::text || ':' || rifas.fecha_sorteo::text)`, [horas]);
    for (const { id } of r.rows) {
      const rifa = await reservas.infoRifa(pool, id);
      const { totalLibres } = await reservas.numerosLibres(pool, rifa, { cantidad: 1 });
      const cerrada = rifa.fecha_desactivacion_compra && new Date(rifa.fecha_desactivacion_compra) <= new Date();
      const texto =
        `⏰ *Hoy se sortea ${rifa.nombre}* a las ${fmtHora(rifa.hora_sorteo)}\n` +
        `🏆 ${rifa.premio}\n` +
        (cerrada || !totalLibres
          ? '\nYa no quedan números a la venta. ¡Mucha suerte a todos! 🍀'
          : `🎟️ ${totalLibres === 1 ? 'Queda *1* número' : `Quedan *${totalLibres}* números`} a ${fmtMonto(rifa.precio, cfg)}\n\n¡Todavía estás a tiempo! 👇\n${comoComprar(cfg)}`);
      await publicar({ clave: `previo:${rifa.id}:${rifa.fecha_sorteo}`, tipo: 'previo', texto });
      await sleep(20000);
    }
  }

  if (cfg.grupo.avisar_rifa_nueva) {
    // Se espera unos minutos tras crearla, por si el dueño todavía la está ajustando
    const r = await pool.query(`
      SELECT id, imagen_url FROM rifas
       WHERE activa AND publicada AND COALESCE(estado, 'activa') = 'activa'
         AND created_at <= NOW() - INTERVAL '10 minutes' AND created_at >= NOW() - INTERVAL '24 hours'
         AND created_at > (SELECT created_at FROM wa_grupo_envios WHERE clave = 'instalado')
         AND (fecha_sorteo IS NULL OR fecha_sorteo >= (NOW() AT TIME ZONE 'America/Caracas')::date)
         AND NOT EXISTS (SELECT 1 FROM wa_grupo_envios e WHERE e.clave = 'nueva:' || rifas.id::text)`);
    for (const { id, imagen_url } of r.rows) {
      const rifa = await reservas.infoRifa(pool, id);
      const ofertas = (rifa.ofertas || []).map((o) => `${o.cantidad} por ${fmtMonto(o.precio_total, cfg)}`);
      const texto =
        `🚨 *¡Nueva rifa!* ${rifa.nombre}\n\n` +
        `🏆 Premio: ${rifa.premio}\n` +
        ((rifa.premios_extra || []).length ? `🎁 Además: ${rifa.premios_extra.map((p) => p.nombre).join(' · ')}\n` : '') +
        `💰 ${fmtMonto(rifa.precio, cfg)} por número${ofertas.length ? `\n🔥 Ofertas: ${ofertas.join(' · ')}` : ''}\n` +
        (rifa.fecha_sorteo ? `📅 Sorteo: ${fmtFecha(rifa.fecha_sorteo)}${fmtHora(rifa.hora_sorteo) ? ` a las ${fmtHora(rifa.hora_sorteo)}` : ''}\n` : '') +
        `\nAparta tu número 👇\n${comoComprar(cfg)}`;
      await publicar({ clave: `nueva:${rifa.id}`, tipo: 'nueva', texto, imagen: /^https?:\/\//.test(imagen_url || '') ? imagen_url : null });
      await sleep(20000);
    }
  }
}
let revisando = false;
setInterval(() => {
  if (revisando) return;
  revisando = true;
  revisarProgramados().catch((e) => console.error('❌ [Grupo] programados:', e.message)).finally(() => { revisando = false; });
}, 5 * 60000).unref();

// ── 3. Mensajes del grupo: solo si mencionan al bot ──────────
const respuestasGrupo = [];           // timestamps de las últimas respuestas en el grupo
const ultimaPorPersona = new Map();   // participante → timestamp
const soloId = (j) => String(j || '').split('@')[0].split(':')[0];

// msg: mensaje crudo de Baileys · m: su contenido ya desenvuelto · texto: lo que escribió
async function alRecibir(msg, m, texto) {
  const cfg = await obtenerConfig();
  if (!cfg.activo || !cfg.grupo?.activo || !cfg.grupo.responder_menciones || !bot || !t?.conectado()) return;
  if (msg.key.fromMe || msg.key.remoteJid !== cfg.grupo.jid) return;
  // Mensajes viejos (llegaron al reconectar): no se contestan
  if (Date.now() - Number(msg.messageTimestamp || 0) * 1000 > 3 * 60000) return;

  const ctx = (m.extendedTextMessage || m.imageMessage || m.videoMessage || {}).contextInfo || {};
  const yo = new Set(t.idsBot().map(soloId).filter(Boolean));
  const meMencionan = (ctx.mentionedJid || []).some((j) => yo.has(soloId(j)));
  const meResponden = !!ctx.quotedMessage && yo.has(soloId(ctx.participant));
  if (!meMencionan && !meResponden) return;

  const pregunta = String(texto || '').replace(/@\d{5,}/g, ' ').replace(/\s+/g, ' ').trim();
  if (pregunta.length < 2) return;

  // Límites: que el bot no llene el grupo ni lo usen para hacerlo hablar sin parar
  const ahora = Date.now();
  while (respuestasGrupo.length && ahora - respuestasGrupo[0] > 10 * 60000) respuestasGrupo.shift();
  if (respuestasGrupo.length >= (Number(cfg.grupo.max_respuestas_10min) || 6)) return;
  const quien = msg.key.participant || msg.participant || '';
  if (ahora - (ultimaPorPersona.get(quien) || 0) < 45000) return;
  respuestasGrupo.push(ahora);
  ultimaPorPersona.set(quien, ahora);
  if (ultimaPorPersona.size > 500) ultimaPorPersona.clear();

  const r = await bot.responderEnGrupo(pregunta.slice(0, 600), msg.pushName || null);
  if (!r?.texto) return;
  await sleep(1500 + Math.random() * 2500);
  await t.enviarAGrupo(cfg.grupo.jid, { text: r.texto }, { quoted: msg });
  // Como mucho una foto (la del ganador por el que preguntaron)
  if (r.fotos?.[0]) await t.enviarAGrupo(cfg.grupo.jid, { image: { url: r.fotos[0].url }, caption: r.fotos[0].caption || '' });
}

// ── Para el panel ────────────────────────────────────────────
async function estado() {
  await tablaLista;
  const cfg = await obtenerConfig({ fresca: true });
  const conectado = !!t?.conectado();
  let grupos = [];
  if (conectado) { try { grupos = await t.listarGrupos(); } catch (e) { console.error('❌ [Grupo] listar:', e.message); } }
  if (conectado && !cfg.grupo?.jid) await resolverGrupo(cfg);
  const fresca = await obtenerConfig({ fresca: true });
  const h = await pool.query(`SELECT id, tipo, texto, imagen_url, estado, error, created_at FROM wa_grupo_envios WHERE tipo <> 'instalado' AND texto IS NOT NULL ORDER BY id DESC LIMIT 20`);
  return { config: fresca.grupo, conectado, grupos, historial: h.rows };
}

async function guardar(cambios) {
  const actual = (await obtenerConfig({ fresca: true })).grupo || {};
  const nueva = { ...actual };
  for (const k of ['activo', 'avisar_resultado', 'avisar_ganador', 'avisar_antes_sorteo', 'avisar_rifa_nueva', 'responder_menciones']) {
    if (k in cambios) nueva[k] = cambios[k] === true;
  }
  if ('horas_antes' in cambios) nueva.horas_antes = Math.min(24, Math.max(1, Math.round(Number(cambios.horas_antes)) || 2));
  if ('url_pagina' in cambios) nueva.url_pagina = String(cambios.url_pagina || '').trim().slice(0, 200);
  if ('jid' in cambios) {
    const jid = String(cambios.jid || '').trim();
    if (jid && !jid.endsWith('@g.us')) throw new Error('Ese no es un grupo de WhatsApp.');
    nueva.jid = jid;
    nueva.nombre = String(cambios.nombre || '').trim().slice(0, 120);
  }
  await guardarConfig({ grupo: nueva });
  return nueva;
}

const enviarManual = ({ texto, imagen }) => publicar({ tipo: 'manual', texto: String(texto || '').trim(), imagen: imagen || null });

module.exports = { init, usarBot, alRecibir, estado, guardar, enviarManual, revisarProgramados };
