// ============================================================
//  envios.js — Cola de envío de tickets por WhatsApp (anti-bloqueo)
//
//  Al aprobar un pago NO se envía en el momento: se encola (tabla wa_envios)
//  y un trabajador los reparte de forma dinámica:
//   - Cliente "tibio" (ya nos escribió alguna vez): sale enseguida.
//   - Cliente "frío" (compró por la página y nunca escribió): es lo que más
//     bloquea WhatsApp, así que se espacian con pausas aleatorias largas,
//     con tope diario y nunca de noche. Si se llena el tope, espera a que el
//     cliente escriba (en ese momento sale al instante) o al día siguiente.
//   - Antes de escribirle a un número frío se verifica que tenga WhatsApp.
//   - Un solo mensaje por ticket: la foto con un texto corto y natural,
//     variado, sin enlaces ni plantilla fija.
//   - Reintentos con espera creciente si algo falla.
// ============================================================
const pool = require('../config/db');
const bus  = require('../services/waBus');
const { obtenerConfig } = require('./botConfig');

let t = null;   // transporte: { enviarImagen, enviarTexto, escribiendo, conectado, existeEnWhatsApp, toJID }
function init(transporte) { t = transporte; }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const azar = (a, b) => Math.floor(a + Math.random() * Math.max(1, b - a));
const elegir = (arr) => arr[Math.floor(Math.random() * arr.length)];

const tablaLista = (async () => {
  const sqls = [
    `CREATE TABLE IF NOT EXISTS wa_envios (
       id           BIGSERIAL PRIMARY KEY,
       tipo         VARCHAR(20) NOT NULL DEFAULT 'ticket',
       reserva_ids  UUID[] NOT NULL DEFAULT '{}',
       jid          TEXT NOT NULL,
       nombre       TEXT,
       rifa         TEXT,
       numeros      TEXT[] NOT NULL DEFAULT '{}',
       imagenes     TEXT[] NOT NULL DEFAULT '{}',
       nota         TEXT,
       frio         BOOLEAN NOT NULL DEFAULT TRUE,
       estado       VARCHAR(20) NOT NULL DEFAULT 'en_cola',   -- en_cola | esperando_cliente | enviando | enviado | error
       intentos     INTEGER NOT NULL DEFAULT 0,
       error        TEXT,
       proximo_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       enviado_at   TIMESTAMPTZ,
       created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
    `CREATE INDEX IF NOT EXISTS idx_wa_envios_pendientes ON wa_envios (estado, proximo_at)`,
    `CREATE INDEX IF NOT EXISTS idx_wa_envios_reservas ON wa_envios USING GIN (reserva_ids)`,
  ];
  for (const sql of sqls) {
    try { await pool.query(sql); } catch (e) { console.error('[envios] esquema:', e.message); }
  }
})();

// ── Utilidades ───────────────────────────────────────────────
function horaVE() {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Caracas' }));
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function horarioFrioAbierto(ab) {
  const h = horaVE();
  return h >= (ab.frio_desde || '08:00') && h <= (ab.frio_hasta || '20:30');
}
async function esTibio(jid) {
  const r = await pool.query(`SELECT 1 FROM wa_chat_mensajes WHERE jid = $1 AND de_mi = FALSE LIMIT 1`, [jid]);
  return r.rows.length > 0;
}
function emitir(envio) { bus.emit('wa:envio', envio); }

async function actualizar(id, cambios) {
  const campos = Object.keys(cambios);
  const r = await pool.query(
    `UPDATE wa_envios SET ${campos.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING *`,
    [id, ...campos.map((c) => cambios[c])]);
  if (r.rows[0]) emitir(r.rows[0]);
  return r.rows[0];
}

// Texto corto y natural para la foto (varía para no parecer plantilla)
function textoTicket(envio, i, total) {
  const nombre = String(envio.nombre || '').trim().split(/\s+/)[0] || '';
  const num = envio.numeros[i] || envio.numeros[0];
  if (i > 0) return total > 1 ? `🎟️ ${num}` : '';
  const varios = envio.numeros.length > 1;
  const saludo = elegir([`¡Hola${nombre ? ' ' + nombre : ''}!`, `Hola${nombre ? ' ' + nombre : ''} 👋`, `¡Epa${nombre ? ' ' + nombre : ''}!`]);
  const cuerpo = elegir([
    `Ya verificamos tu pago ✅ aquí ${varios ? 'tienes tus tickets' : 'tienes tu ticket'} de *${envio.rifa}*${varios ? '' : ` con el *${num}*`}.`,
    `tu pago quedó confirmado 🎉 te dejo ${varios ? 'tus tickets' : 'tu ticket'} de *${envio.rifa}*${varios ? '' : ` (número *${num}*)`}.`,
    `listo, pago verificado 🙌 ${varios ? 'estos son tus tickets' : `este es tu ticket del *${num}*`} para *${envio.rifa}*.`,
  ]);
  const cierre = elegir(['¡Mucha suerte! 🍀', 'Guárdalo bien y ¡suerte! 🍀', '¡Que sea el ganador! 🤞']);
  return `${saludo} ${cuerpo}${envio.nota ? `\n\n${envio.nota}` : ''}\n\n${cierre}`;
}

// ── Encolar tickets al aprobar ───────────────────────────────
// reservas: filas aprobadas (mismo cliente).
// tickets: [{ numero, url }] — la foto de cada número (si no hay fotos, sale solo el texto)
async function encolarTicket({ reservas, tickets = [], nota = null, destino }) {
  await tablaLista;
  if (!reservas?.length || !destino) return null;
  const numerosConFoto = tickets.map((x) => x.numero);
  const sinFoto = reservas.map((x) => String(x.numero).trim()).filter((n) => !numerosConFoto.includes(n));
  const jid = t?.toJID ? t.toJID(destino) : destino;
  const r0 = reservas[0];
  const rifaR = await pool.query(`SELECT nombre FROM rifas WHERE id = $1`, [r0.rifa_id]);
  const frio = !(await esTibio(jid));
  const ins = await pool.query(`
    INSERT INTO wa_envios (reserva_ids, jid, nombre, rifa, numeros, imagenes, nota, frio)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
  [reservas.map((x) => x.id), jid, r0.nombre_cliente, rifaR.rows[0]?.nombre || '',
    [...numerosConFoto, ...sinFoto], tickets.map((x) => x.url), nota && !/^auto-/i.test(nota) ? nota : null, frio]);
  emitir(ins.rows[0]);
  despertar();
  return ins.rows[0];
}

// El cliente escribió: sus envíos pendientes salen ya (ahora es "tibio")
async function clienteEscribio(jid) {
  await tablaLista;
  const r = await pool.query(`
    UPDATE wa_envios SET frio = FALSE, estado = CASE WHEN estado = 'esperando_cliente' THEN 'en_cola' ELSE estado END, proximo_at = NOW()
     WHERE jid = $1 AND estado IN ('en_cola', 'esperando_cliente') RETURNING *`, [jid]);
  if (r.rows.length) { r.rows.forEach(emitir); despertar(); }
}

async function reintentar(id) {
  const e = await actualizar(id, { estado: 'en_cola', proximo_at: new Date(), error: null });
  despertar();
  return e;
}

async function porReservas(ids) {
  await tablaLista;
  const r = await pool.query(`SELECT DISTINCT ON (id) * FROM wa_envios WHERE reserva_ids && $1::uuid[] ORDER BY id DESC`, [ids]);
  return r.rows;
}

// ── Trabajador ───────────────────────────────────────────────
let ultimoFrio = 0;     // cuándo se le escribió al último contacto frío
let trabajando = false;
let timer = null;
function despertar() { clearTimeout(timer); timer = setTimeout(ciclo, 300); }

async function ciclo() {
  if (trabajando) return;
  trabajando = true;
  try {
    await tablaLista;
    if (!t?.conectado()) return;
    const ab = (await obtenerConfig()).antiban;

    // Los tibios primero; los fríos solo si toca según el ritmo dinámico
    const r = await pool.query(`
      SELECT * FROM wa_envios
       WHERE estado = 'en_cola' AND proximo_at <= NOW()
       ORDER BY frio ASC, created_at ASC LIMIT 1`);
    const envio = r.rows[0];
    if (!envio) return;

    if (envio.frio) {
      if (!horarioFrioAbierto(ab)) return;                       // de noche no se le escribe a desconocidos
      const esperaMin = (ab.frio_espera_min_seg ?? 90) * 1000;
      const esperaMax = (ab.frio_espera_max_seg ?? 240) * 1000;
      const siguiente = ultimoFrio + azar(esperaMin, esperaMax);
      if (Date.now() < siguiente) { timer = setTimeout(ciclo, siguiente - Date.now()); return; }
      // ¿Ese número tiene WhatsApp? (escribirle a números sin WhatsApp también penaliza)
      const existe = await t.existeEnWhatsApp(envio.jid).catch(() => null);
      if (existe === false) {
        await actualizar(envio.id, { estado: 'error', error: 'Ese número no tiene WhatsApp' });
        return;
      }
      // Tope diario de contactos fríos: esperar a que escriba o al día siguiente
      const hoy = await pool.query(`
        SELECT COUNT(DISTINCT jid)::int n FROM wa_envios
         WHERE frio AND estado = 'enviado' AND enviado_at >= date_trunc('day', NOW() AT TIME ZONE 'America/Caracas') AT TIME ZONE 'America/Caracas'`);
      if (hoy.rows[0].n >= (ab.max_chats_nuevos_dia || 30)) {
        await actualizar(envio.id, { estado: 'esperando_cliente', proximo_at: new Date(Date.now() + 6 * 3600000), error: 'Tope diario de contactos nuevos: sale cuando el cliente escriba o mañana' });
        return;
      }
    }

    await enviar(envio, ab);
  } catch (e) {
    console.error('❌ [Envíos] ciclo:', e.message);
  } finally {
    trabajando = false;
  }
}

async function enviar(envio, ab) {
  await actualizar(envio.id, { estado: 'enviando', intentos: envio.intentos + 1 });
  try {
    // "escribiendo…" como una persona antes de mandar
    await t.escribiendo(envio.jid, azar(1500, 3500));
    const imgs = envio.imagenes.length ? envio.imagenes : [];
    if (imgs.length) {
      for (let i = 0; i < imgs.length; i++) {
        await t.enviarImagen(envio.jid, imgs[i], textoTicket(envio, i, imgs.length), { autor: 'sistema', prioridad: envio.frio ? 'bot' : 'humano' });
        if (i < imgs.length - 1) await sleep(azar(1200, 2800));
      }
    } else {
      await t.enviarTexto(envio.jid, textoTicket(envio, 0, 1), { autor: 'sistema' });
    }
    if (envio.frio) ultimoFrio = Date.now();
    await actualizar(envio.id, { estado: 'enviado', enviado_at: new Date(), error: null });
  } catch (e) {
    const limite = /Límite diario|Límite de .* chats nuevos/i.test(e.message);
    const espera = [60, 300, 900][Math.min(envio.intentos, 2)] * 1000;
    await actualizar(envio.id, {
      estado: limite ? 'esperando_cliente' : envio.intentos + 1 >= 4 ? 'error' : 'en_cola',
      error: e.message.slice(0, 300),
      proximo_at: new Date(Date.now() + (limite ? 6 * 3600000 : espera)),
    });
  } finally {
    despertar();
  }
}

// Revisión periódica (por si se reinició el servidor o toca un reintento)
setInterval(() => ciclo(), 30 * 1000).unref();

module.exports = { init, encolarTicket, clienteEscribio, reintentar, porReservas, tablaLista };
