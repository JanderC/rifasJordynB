// ============================================================
//  waChats.js — Chats y mensajes de WhatsApp guardados en la BD
//  Todo mensaje (cliente, bot, humano desde el panel, o escrito en el
//  teléfono) queda aquí y se emite por el bus para verlo en tiempo real.
// ============================================================
const pool = require('../config/db');
const bus  = require('./waBus');

const tablasListas = (async () => {
  const sqls = [
    `CREATE TABLE IF NOT EXISTS wa_chats (
       jid              TEXT PRIMARY KEY,
       telefono         TEXT,
       nombre           TEXT,
       nombre_guardado  TEXT,
       ultimo_mensaje   TEXT,
       ultimo_at        TIMESTAMPTZ,
       ultimo_de_mi     BOOLEAN DEFAULT FALSE,
       no_leidos        INTEGER NOT NULL DEFAULT 0,
       bot_activo       BOOLEAN NOT NULL DEFAULT TRUE,
       necesita_humano  BOOLEAN NOT NULL DEFAULT FALSE,
       motivo_humano    TEXT,
       estado_compra    JSONB,
       archivado        BOOLEAN NOT NULL DEFAULT FALSE,
       created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
    `CREATE TABLE IF NOT EXISTS wa_chat_mensajes (
       id          BIGSERIAL PRIMARY KEY,
       jid         TEXT NOT NULL,
       wa_id       TEXT UNIQUE,
       wa_key      JSONB,
       de_mi       BOOLEAN NOT NULL DEFAULT FALSE,
       autor       VARCHAR(12) NOT NULL DEFAULT 'cliente',   -- cliente | bot | humano | telefono | sistema
       tipo        VARCHAR(12) NOT NULL DEFAULT 'texto',     -- texto | imagen | audio | documento | sticker | video | otro
       texto       TEXT,
       media_url   TEXT,
       media_mime  TEXT,
       estado      VARCHAR(12),                              -- pendiente | enviado | entregado | leido | error
       created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
    `CREATE INDEX IF NOT EXISTS idx_wa_msj_jid_fecha ON wa_chat_mensajes (jid, created_at DESC, id DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_wa_chats_ultimo ON wa_chats (ultimo_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_wa_chats_telefono ON wa_chats (telefono)`,
    `CREATE TABLE IF NOT EXISTS wa_bot_config (
       id          INTEGER PRIMARY KEY DEFAULT 1,
       config      JSONB NOT NULL DEFAULT '{}'::jsonb,
       updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       CONSTRAINT wa_bot_config_unica CHECK (id = 1)
     )`,
  ];
  for (const sql of sqls) {
    try { await pool.query(sql); } catch (e) { console.error('[waChats] esquema:', e.message); }
  }
})();

const telefonoDeJid = (jid) =>
  jid && jid.endsWith('@s.whatsapp.net') ? jid.split('@')[0].split(':')[0] : null;

function previa(m) {
  if (m.texto) return m.texto.slice(0, 200);
  return { imagen: '📷 Foto', audio: '🎤 Nota de voz', documento: '📄 Documento', sticker: '💟 Sticker', video: '🎥 Video' }[m.tipo] || 'Mensaje';
}

// ── Guardar un mensaje (y actualizar su chat) ────────────────
// Si el wa_id ya existe no duplica (p. ej. el eco de un mensaje que enviamos).
async function guardarMensaje(m) {
  await tablasListas;
  const fecha = m.fecha || new Date();
  const ins = await pool.query(`
    INSERT INTO wa_chat_mensajes (jid, wa_id, wa_key, de_mi, autor, tipo, texto, media_url, media_mime, estado, created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    ON CONFLICT (wa_id) DO NOTHING
    RETURNING *`,
  [
    m.jid, m.waId || null, m.waKey ? JSON.stringify(m.waKey) : null, !!m.deMi,
    m.autor || (m.deMi ? 'telefono' : 'cliente'), m.tipo || 'texto', m.texto || null,
    m.mediaUrl || null, m.mediaMime || null, m.estado || null, fecha,
  ]);
  const mensaje = ins.rows[0];
  if (!mensaje) return null;

  const chatR = await pool.query(`
    INSERT INTO wa_chats (jid, telefono, nombre, ultimo_mensaje, ultimo_at, ultimo_de_mi, no_leidos)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (jid) DO UPDATE SET
      telefono       = COALESCE(wa_chats.telefono, EXCLUDED.telefono),
      nombre         = COALESCE(EXCLUDED.nombre, wa_chats.nombre),
      ultimo_mensaje = CASE WHEN EXCLUDED.ultimo_at >= COALESCE(wa_chats.ultimo_at, 'epoch') THEN EXCLUDED.ultimo_mensaje ELSE wa_chats.ultimo_mensaje END,
      ultimo_de_mi   = CASE WHEN EXCLUDED.ultimo_at >= COALESCE(wa_chats.ultimo_at, 'epoch') THEN EXCLUDED.ultimo_de_mi ELSE wa_chats.ultimo_de_mi END,
      ultimo_at      = GREATEST(COALESCE(wa_chats.ultimo_at, 'epoch'), EXCLUDED.ultimo_at),
      no_leidos      = wa_chats.no_leidos + EXCLUDED.no_leidos,
      archivado      = CASE WHEN EXCLUDED.no_leidos > 0 THEN FALSE ELSE wa_chats.archivado END
    RETURNING *`,
  [
    m.jid, m.telefono || telefonoDeJid(m.jid), m.nombre || null,
    // El historial que sincroniza WhatsApp al vincular (noLeido:false) no cuenta como no leído
    previa(m), fecha, !!m.deMi, m.deMi || m.noLeido === false ? 0 : 1,
  ]);
  const chat = chatR.rows[0];
  bus.emit('wa:mensaje', { mensaje, chat });
  return { mensaje, chat };
}

async function actualizarEstadoMensaje(waId, estado) {
  // Nunca retroceder (p. ej. de "leído" a "entregado")
  const orden = { error: 0, pendiente: 1, enviado: 2, entregado: 3, leido: 4 };
  const r = await pool.query(`SELECT id, jid, estado FROM wa_chat_mensajes WHERE wa_id=$1`, [waId]);
  const actual = r.rows[0];
  if (!actual) return;
  if (estado !== 'error' && (orden[actual.estado] ?? -1) >= orden[estado]) return;
  await pool.query(`UPDATE wa_chat_mensajes SET estado=$1 WHERE id=$2`, [estado, actual.id]);
  bus.emit('wa:estado', { id: actual.id, jid: actual.jid, waId, estado });
}

async function obtenerChat(jid) {
  await tablasListas;
  const r = await pool.query(`SELECT * FROM wa_chats WHERE jid=$1`, [jid]);
  return r.rows[0] || null;
}

// Crea el chat si no existe (p. ej. primer mensaje saliente a un número)
async function asegurarChat(jid, datos = {}) {
  await tablasListas;
  const r = await pool.query(`
    INSERT INTO wa_chats (jid, telefono, nombre) VALUES ($1, $2, $3)
    ON CONFLICT (jid) DO UPDATE SET nombre = COALESCE(wa_chats.nombre, EXCLUDED.nombre)
    RETURNING *`, [jid, datos.telefono || telefonoDeJid(jid), datos.nombre || null]);
  return r.rows[0];
}

const CAMPOS_EDITABLES = ['bot_activo', 'necesita_humano', 'motivo_humano', 'estado_compra', 'nombre_guardado', 'archivado', 'no_leidos'];

async function actualizarChat(jid, cambios) {
  const sets = [], vals = [];
  for (const [k, v] of Object.entries(cambios)) {
    if (!CAMPOS_EDITABLES.includes(k)) continue;
    vals.push(k === 'estado_compra' && v != null ? JSON.stringify(v) : v);
    sets.push(`${k} = $${vals.length}`);
  }
  if (!sets.length) return obtenerChat(jid);
  vals.push(jid);
  const r = await pool.query(`UPDATE wa_chats SET ${sets.join(', ')} WHERE jid = $${vals.length} RETURNING *`, vals);
  if (r.rows[0]) bus.emit('wa:chat', r.rows[0]);
  return r.rows[0] || null;
}

// ── Listado para el panel ────────────────────────────────────
// filtro: todos | no_leidos | atencion | comprobante | bot | humano | archivados
async function listarChats({ q = '', filtro = 'todos', limite = 60, antes = null } = {}) {
  await tablasListas;
  const where = [], vals = [];
  const add = (sql, v) => { vals.push(v); where.push(sql.replace('?', `$${vals.length}`)); };

  if (filtro === 'archivados') where.push('c.archivado = TRUE');
  else where.push('c.archivado = FALSE');
  if (filtro === 'no_leidos')   where.push('c.no_leidos > 0');
  if (filtro === 'atencion')    where.push('c.necesita_humano = TRUE');
  if (filtro === 'comprobante') where.push(`c.estado_compra->>'paso' IN ('esperando_comprobante','esperando_confirmacion')`);
  if (filtro === 'bot')         where.push('c.bot_activo = TRUE');
  if (filtro === 'humano')      where.push('c.bot_activo = FALSE');
  if (antes) add('c.ultimo_at < ?', antes);
  if (q.trim()) {
    const like = `%${q.trim().toLowerCase()}%`;
    vals.push(like);
    const p = `$${vals.length}`;
    where.push(`(LOWER(COALESCE(c.nombre_guardado,'')) LIKE ${p} OR LOWER(COALESCE(c.nombre,'')) LIKE ${p}
               OR COALESCE(c.telefono,'') LIKE ${p} OR LOWER(COALESCE(c.ultimo_mensaje,'')) LIKE ${p})`);
  }
  vals.push(Math.min(Number(limite) || 60, 200));
  const r = await pool.query(`
    SELECT c.*,
           (SELECT COUNT(*)::int FROM reservas_cliente rc
             WHERE rc.estado = 'pendiente'
               AND (rc.wa_jid = c.jid OR (c.telefono IS NOT NULL AND regexp_replace(rc.telefono, '\\D', '', 'g') = c.telefono))
           ) AS reservas_pendientes
      FROM wa_chats c
     WHERE ${where.join(' AND ')}
     ORDER BY c.ultimo_at DESC NULLS LAST
     LIMIT $${vals.length}`, vals);
  return r.rows;
}

// Mensajes de un chat, del más viejo al más nuevo.
// antes=<id> para paginar hacia atrás; alrededor=<id> para saltar a un resultado de búsqueda.
async function listarMensajes(jid, { antes = null, alrededor = null, limite = 50 } = {}) {
  await tablasListas;
  const lim = Math.min(Number(limite) || 50, 200);
  if (alrededor) {
    const [prev, next] = await Promise.all([
      pool.query(`SELECT * FROM wa_chat_mensajes WHERE jid=$1 AND id <= $2 ORDER BY id DESC LIMIT $3`, [jid, alrededor, Math.ceil(lim / 2)]),
      pool.query(`SELECT * FROM wa_chat_mensajes WHERE jid=$1 AND id > $2 ORDER BY id ASC LIMIT $3`, [jid, alrededor, Math.floor(lim / 2)]),
    ]);
    return { mensajes: [...prev.rows.reverse(), ...next.rows], hayMas: prev.rows.length >= Math.ceil(lim / 2) };
  }
  const r = antes
    ? await pool.query(`SELECT * FROM wa_chat_mensajes WHERE jid=$1 AND id < $2 ORDER BY id DESC LIMIT $3`, [jid, antes, lim])
    : await pool.query(`SELECT * FROM wa_chat_mensajes WHERE jid=$1 ORDER BY id DESC LIMIT $2`, [jid, lim]);
  return { mensajes: r.rows.reverse(), hayMas: r.rows.length === lim };
}

// Búsqueda global dentro de las conversaciones
async function buscarMensajes(q, limite = 40) {
  await tablasListas;
  if (!q || q.trim().length < 2) return [];
  const r = await pool.query(`
    SELECT m.id, m.jid, m.texto, m.de_mi, m.autor, m.created_at,
           COALESCE(c.nombre_guardado, c.nombre, c.telefono, m.jid) AS chat_nombre
      FROM wa_chat_mensajes m
      JOIN wa_chats c ON c.jid = m.jid
     WHERE m.texto ILIKE $1
     ORDER BY m.created_at DESC
     LIMIT $2`, [`%${q.trim()}%`, Math.min(limite, 100)]);
  return r.rows;
}

// Historial reciente para el bot (solo lo necesario, en orden cronológico)
async function historialReciente(jid, limite = 20) {
  const r = await pool.query(`
    SELECT id, de_mi, autor, tipo, texto, created_at FROM wa_chat_mensajes
     WHERE jid=$1 ORDER BY id DESC LIMIT $2`, [jid, limite]);
  return r.rows.reverse();
}

async function marcarLeido(jid) {
  const r = await pool.query(`UPDATE wa_chats SET no_leidos = 0 WHERE jid=$1 RETURNING *`, [jid]);
  if (r.rows[0]) bus.emit('wa:chat', r.rows[0]);
  const keys = await pool.query(`
    SELECT wa_key FROM wa_chat_mensajes
     WHERE jid=$1 AND de_mi = FALSE AND wa_key IS NOT NULL
     ORDER BY id DESC LIMIT 20`, [jid]);
  return keys.rows.map((x) => x.wa_key);
}

async function resumen() {
  await tablasListas;
  const r = await pool.query(`
    SELECT COUNT(*) FILTER (WHERE no_leidos > 0 AND NOT archivado)::int AS no_leidos,
           COUNT(*) FILTER (WHERE necesita_humano AND NOT archivado)::int AS atencion,
           COUNT(*) FILTER (WHERE estado_compra->>'paso' IN ('esperando_comprobante','esperando_confirmacion') AND NOT archivado)::int AS comprobante,
           COUNT(*)::int AS total
      FROM wa_chats`);
  return r.rows[0];
}

// Cola de atención: clientes que esperan a una persona (el bot se trabó o pidieron
// una persona) y chats en modo humano con mensajes del cliente sin responder.
// excluirTelefono: el chat del dueño no es un cliente.
async function colaAtencion(excluirTelefono = null) {
  await tablasListas;
  const r = await pool.query(`
    SELECT c.*,
           (SELECT texto FROM wa_chat_mensajes m WHERE m.jid = c.jid AND m.de_mi = FALSE AND m.texto IS NOT NULL
             ORDER BY m.id DESC LIMIT 1) AS ultimo_del_cliente,
           (SELECT MIN(m.created_at) FROM wa_chat_mensajes m
             WHERE m.jid = c.jid AND m.de_mi = FALSE
               AND m.id > COALESCE((SELECT MAX(id) FROM wa_chat_mensajes x WHERE x.jid = c.jid AND x.de_mi = TRUE AND x.autor <> 'sistema'), 0)
           ) AS esperando_desde
      FROM wa_chats c
     WHERE NOT c.archivado
       AND ($1::text IS NULL OR c.telefono IS DISTINCT FROM $1)
       AND (c.necesita_humano OR (NOT c.bot_activo AND NOT c.ultimo_de_mi AND c.no_leidos > 0))
     ORDER BY COALESCE(c.necesita_humano, FALSE) DESC, c.ultimo_at ASC`, [excluirTelefono]);
  return r.rows;
}

// Chat de un teléfono (para asociar la confirmación de una reserva a su chat)
async function chatPorTelefono(telefono) {
  const t = String(telefono || '').replace(/\D/g, '');
  if (!t) return null;
  const variantes = [t, t.startsWith('0') ? '58' + t.slice(1) : t];
  const r = await pool.query(`SELECT * FROM wa_chats WHERE telefono = ANY($1) ORDER BY ultimo_at DESC NULLS LAST LIMIT 1`, [variantes]);
  return r.rows[0] || null;
}

module.exports = {
  tablasListas,
  telefonoDeJid,
  guardarMensaje,
  actualizarEstadoMensaje,
  obtenerChat,
  asegurarChat,
  actualizarChat,
  listarChats,
  listarMensajes,
  buscarMensajes,
  historialReciente,
  marcarLeido,
  resumen,
  colaAtencion,
  chatPorTelefono,
};
