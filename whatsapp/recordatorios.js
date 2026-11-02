// ============================================================
//  recordatorios.js — Recordatorios de pago de números apartados
//
//  En las rifas con "pago diferido" el cliente aparta sin pagar y tiene
//  hasta unas horas antes del sorteo. El bot le recuerda por WhatsApp:
//    - la víspera del sorteo (10:00 a. m.)
//    - el día del sorteo (9:00 a. m.)
//    - el aviso final, unas horas antes de que venza el plazo
//  o, si el dueño lo configura así, cada X horas (más el aviso final).
//  También puede elegir días de la semana y una hora (p. ej. lunes y sábados
//  a las 10:00): entonces salen solo en esos momentos.
//  Una rifa puede tener sus propios días y horas (en Reservas o al editarla):
//  entonces sus recordatorios salen solo en esos momentos, aunque los
//  automáticos generales estén apagados.
//  El texto puede ser uno propio (con variables) y llevar la foto de la rifa.
//  Solo se manda el recordatorio que toca (nunca varios seguidos), uno por
//  cliente y rifa. A quien nunca nos escribió se le verifica el número y se le
//  escribe con pausas largas, igual que en los tickets (anti-bloqueo).
//  Cada envío queda registrado para que el dueño vea qué salió y qué no.
//  Al recordarle, el chat queda listo para que pague por ahí: dice el
//  método, el sistema le manda los datos y él envía la captura.
// ============================================================
const pool = require('../config/db');
const chats = require('../services/waChats');
const reservas = require('../services/reservas');
const opciones = require('../services/rifaOpciones');
const metodosPago = require('../services/metodosPago');
const { obtenerConfig } = require('./botConfig');

let t = null;   // { enviar(jid, texto), enviarImagen(jid, url, texto), conectado() } — lo inyecta bot.js
function init(transporte) { t = transporte; }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const azar = (a, b) => Math.floor(a + Math.random() * Math.max(1, b - a));
const soloDigitos = (x) => String(x || '').replace(/\D/g, '');

const tablaLista = pool.query(`
  CREATE TABLE IF NOT EXISTS wa_recordatorio_envios (
    id          BIGSERIAL PRIMARY KEY,
    rifa_id     UUID NOT NULL,
    momento     TIMESTAMPTZ,            -- el día y hora programados; NULL = automático general o "enviar ahora"
    persona     TEXT NOT NULL,
    nombre      TEXT,
    telefono    TEXT,
    estado      VARCHAR(10) NOT NULL,   -- enviado | error
    error       TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`).then(() => pool.query(`CREATE INDEX IF NOT EXISTS idx_wa_recordatorio_envios_rifa ON wa_recordatorio_envios (rifa_id, momento)`))
  .catch((e) => console.error('[recordatorios] esquema:', e.message));

function horaVE() {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Caracas' }));
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
const deDia = () => { const h = horaVE(); return h >= '08:00' && h < '21:30'; };

function jidDe(telefono) {
  let n = soloDigitos(telefono);
  if (n.startsWith('0')) n = '58' + n.slice(1);
  if (n.startsWith('580')) n = '58' + n.slice(3);   // +58 0412...
  return n.length >= 10 ? `${n}@s.whatsapp.net` : null;
}

// Estado de compra del chat para un grupo de apartados (el mismo que deja preparar_compra):
// con esto, cuando el cliente manda la captura, el sistema la registra sola.
function estadoDeApartado(g) {
  return {
    paso: 'esperando_comprobante', diferido: true,
    rifa_id: g.rifa.id, rifa_nombre: g.rifa.nombre, moneda: g.rifa.moneda, numeros: g.numeros,
    // total = lo que le FALTA pagar (el precio menos los abonos confirmados)
    nombre: g.nombre, cedula: g.cedula || null, total: g.saldo ?? g.total, metodo: null,
    total_rifa: g.total, abonado: g.abonado || 0, por_confirmar: g.por_confirmar || 0,
    reservas: g.ids, apartado_hasta: new Date(g.limite).getTime(), desde: Date.now(),
  };
}

// Deja el chat apuntando a los apartados sin pagar del cliente (si no tiene otra compra en curso).
// Devuelve el estado puesto o null.
async function vincularApartados(jid, chat) {
  if (chat?.estado_compra?.paso && !chat.estado_compra.diferido) return null;
  const grupos = await reservas.apartadosDe({ jid, telefono: chat?.telefono || soloDigitos(String(jid).split('@')[0]) });
  if (!grupos.length) {
    // Tenía un apartado diferido que ya no existe (se pagó por la página o lo liberó el dueño)
    if (chat?.estado_compra?.diferido) { await chats.actualizarChat(jid, { estado_compra: null }); chat.estado_compra = null; }
    return null;
  }
  const g = grupos.sort((a, b) => a.limite - b.limite)[0];   // el que vence primero
  const previo = chat?.estado_compra;
  // "Mismo" = mismos números y mismas cuentas (si le confirmaron un abono, cambia lo que debe)
  const mismo = previo?.diferido && previo.rifa_id === g.rifa.id && (previo.reservas || []).join() === g.ids.join()
    && previo.total === g.saldo && (previo.por_confirmar || 0) === (g.por_confirmar || 0);
  const estado = mismo ? previo : estadoDeApartado(g);
  if (!mismo) {
    await chats.actualizarChat(jid, { estado_compra: estado });
    await pool.query(`UPDATE reservas_cliente SET wa_jid = $1 WHERE id = ANY($2) AND wa_jid IS DISTINCT FROM $1`, [jid, g.ids]);
  }
  if (chat) chat.estado_compra = estado;
  return estado;
}

// ── Qué recordatorio toca ────────────────────────────────────
// Devuelve { etapa, marcar: [etapas ya vencidas que se dan por hechas] } o null
function etapaQueToca({ rifa, limite, creado, enviados, finalHoras }) {
  const ahora = Date.now();
  const sorteo = opciones.momentoSorteo(rifa);
  if (!sorteo || limite.getTime() - ahora < 20 * 60000) return null;
  const dia = String(rifa.fecha_sorteo).slice(0, 10);
  const vispera = new Date(new Date(`${dia}T10:00:00-04:00`).getTime() - 24 * 3600000);
  const etapas = [
    ['vispera', vispera.getTime()],
    ['dia', new Date(`${dia}T09:00:00-04:00`).getTime()],
    ['final', limite.getTime() - finalHoras * 3600000],
  ]
    // Las que ya pasaron cuando apartó no aplican (apartó hoy mismo: solo el aviso final)
    .filter(([, at]) => at <= ahora && at > creado.getTime() + 60 * 60000);
  const pendientes = etapas.filter(([e]) => !enviados.includes(e));
  if (!pendientes.length) return null;
  return { etapa: pendientes[pendientes.length - 1][0], marcar: etapas.map(([e]) => e) };
}

// Modo "cada X horas": cuenta desde que apartó o desde el último recordatorio
// (automático o a mano). El aviso final sale igual, una sola vez.
function tocaCada({ limite, creado, enviados, cadaHoras, finalHoras }) {
  const ahora = Date.now();
  if (limite.getTime() - ahora < 20 * 60000) return null;
  const tiempos = enviados.map((e) => /^(?:auto|manual):(\d+)$/.exec(e)).filter(Boolean).map((m) => Number(m[1]));
  const ultimo = Math.max(creado.getTime(), ...tiempos);
  const finalAt = limite.getTime() - finalHoras * 3600000;
  if (ahora >= finalAt && finalAt > creado.getTime() + 60 * 60000 && !enviados.includes('final') && ahora - ultimo >= 30 * 60000) {
    return { etapa: 'final', marcar: ['final', `auto:${ahora}`] };
  }
  if (ahora - ultimo >= cadaHoras * 3600000) return { etapa: 'cada', marcar: [`auto:${ahora}`] };
  return null;
}

// Rifa con días y horas propios: sale el que ya llegó y no se ha enviado.
// Uno que quedó atrás más de 6 horas (el bot estuvo desconectado) ya no se manda.
// Si se atrasó más de 30 minutos y aún no había empezado, tampoco sale de noche.
function tocaProgramado({ programados, limite, creado, enviados, esDeDia = true, iniciados = new Set() }) {
  const ahora = Date.now();
  if (limite.getTime() <= ahora) return null;
  const pasados = programados.filter((p) => p <= ahora);
  const pendientes = pasados.filter((p) => ahora - p < 6 * 3600000 && p > creado.getTime() && !enviados.includes(`prog:${p}`)
    && (ahora - p < 30 * 60000 || esDeDia || iniciados.has(p)));
  if (!pendientes.length) return null;
  return { etapa: 'programado', momento: Math.max(...pendientes), marcar: [...pasados.map((p) => `prog:${p}`), `auto:${ahora}`] };
}

// Días de la semana y hora elegidos por el dueño (hora de Venezuela, UTC-4 fijo).
// Sale una vez por día elegido, desde esa hora; si se pasó más de 6 horas, ya no.
function tocaDias({ dias, hora, limite, creado, enviados }) {
  const ahora = Date.now();
  if (limite.getTime() <= ahora) return null;
  const ve = new Date(ahora - 4 * 3600000);
  if (!dias.includes(ve.getUTCDay())) return null;
  const fecha = ve.toISOString().slice(0, 10);
  const slot = new Date(`${fecha}T${hora}:00-04:00`).getTime();
  if (!Number.isFinite(slot) || ahora < slot || ahora - slot >= 6 * 3600000) return null;
  if (slot <= creado.getTime() || enviados.includes(`dia:${fecha}`)) return null;
  return { etapa: 'dias', marcar: [`dia:${fecha}`, `auto:${ahora}`] };
}

function duracion(ms) {
  const min = Math.max(1, Math.round(ms / 60000));
  if (min < 60) return `${min} minutos`;
  const h = Math.floor(min / 60), m = min % 60;
  if (h >= 48) return `${Math.floor(h / 24)} días`;
  return `${h} ${h === 1 ? 'hora' : 'horas'}${m >= 10 ? ` y ${m} minutos` : ''}`;
}

function textoRecordatorio(etapa, g, cfg) {
  const nombre = String(g.nombre || '').trim().split(/\s+/)[0] || '';
  const varios = g.numeros.length > 1;
  const nums = `${varios ? 'los números' : 'el número'} *${g.numeros.join(', ')}*`;
  const pesos = (n) => metodosPago.fmtEnMoneda(n, g.rifa.moneda, cfg.moneda || 'pesos');
  // Con abonos se le recuerda lo que FALTA, no el precio completo
  const abonado = Number(g.abonado) || 0;
  const total = pesos(g.saldo ?? g.total);
  const cuenta = abonado > 0 ? `Llevas abonado ${pesos(abonado)}. Te falta: *${total}*` : null;
  const limite = opciones.fmtLimite(g.limite);
  const metodos = metodosPago.metodosDeRifa(g.rifa.moneda);
  const comoPagar = `¿Con qué vas a pagar? ${metodos.length ? `Tenemos ${metodos.join(', ')}. ` : ''}Dime y te paso los datos 👇`;
  const hora = g.limite.toLocaleTimeString('es-VE', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/Caracas' });
  if (etapa === 'final') {
    return `⏰ ${nombre ? `${nombre}, te` : 'Te'} quedan *${duracion(g.limite.getTime() - Date.now())}* para pagar ${nums} de *${g.rifa.nombre}*.\n\n` +
      (abonado > 0
        ? `${cuenta}. El plazo vence a las ${hora} 🙏\n\n${comoPagar}`
        : `Total: *${total}*. Después de las ${hora} ${varios ? 'se liberan y los puede tomar' : 'se libera y lo puede tomar'} otra persona 🙏\n\n${comoPagar}`);
  }
  // Recordatorio pedido a mano desde Reservas o el de "cada X horas": sin "mañana/hoy es el sorteo"
  if (['manual', 'cada', 'programado', 'dias'].includes(etapa)) {
    return `Hola${nombre ? ` ${nombre}` : ''} 👋 Te recuerdo que tienes ${varios ? 'apartados' : 'apartado'} ${nums} en *${g.rifa.nombre}* 🎟️\n\n` +
      `${cuenta || `Total a pagar: *${total}*`}. Tienes hasta el ${limite}.\n\n${comoPagar}`;
  }
  const cuando = etapa === 'vispera' ? 'mañana es el sorteo' : '¡hoy es el sorteo!';
  return `Hola${nombre ? ` ${nombre}` : ''} 👋 Te recuerdo que tienes ${varios ? 'apartados' : 'apartado'} ${nums} en *${g.rifa.nombre}* y ${cuando} 🎉\n\n` +
    `${cuenta || `Total a pagar: *${total}*`}. Tienes hasta el ${limite}.\n\n${comoPagar}`;
}

// ── Mensaje propio del dueño ─────────────────────────────────
// Variables que se pueden usar en el texto configurado (las mismas que muestra el panel)
function variablesDe(g, cfg) {
  const pesos = (n) => metodosPago.fmtEnMoneda(n, g.rifa.moneda, cfg.moneda || 'pesos');
  const metodos = metodosPago.metodosDeRifa(g.rifa.moneda);
  return {
    nombre: String(g.nombre || '').trim().split(/\s+/)[0] || '',
    numeros: g.numeros.join(', '),
    rifa: g.rifa.nombre || '',
    premio: g.rifa.premio || '',
    total: pesos(g.total),
    abonado: pesos(Number(g.abonado) || 0),
    falta: pesos(g.saldo ?? g.total),
    limite: opciones.fmtLimite(g.limite),
    tiempo: duracion(new Date(g.limite).getTime() - Date.now()),
    metodos: metodos.join(', '),
  };
}

// El texto que sale: el del dueño si escribió uno; si no, el automático de la etapa
function mensajeRecordatorio(etapa, g, cfg) {
  const propio = String(cfg.recordatorios_apartado?.mensaje || '').trim();
  if (!propio) return textoRecordatorio(etapa, g, cfg);
  const v = variablesDe(g, cfg);
  return propio.replace(/\{(\w+)\}/g, (todo, k) => (k.toLowerCase() in v ? v[k.toLowerCase()] : todo))
    .replace(/[ \t]+([,.!?])/g, '$1').trim();   // "Hola {nombre}," sin nombre → "Hola,"
}

// Envía el recordatorio: con la foto de la rifa (el texto va de pie de foto) si está
// activado y la rifa tiene foto; si la foto falla, sale solo el texto.
async function enviarRecordatorio(jid, etapa, g, cfg) {
  const texto = mensajeRecordatorio(etapa, g, cfg);
  if (cfg.recordatorios_apartado?.con_imagen && t.enviarImagen) {
    const url = (await pool.query(`SELECT imagen_url FROM rifas WHERE id = $1`, [g.rifa.id])).rows[0]?.imagen_url;
    if (url && texto.length <= 1000) {
      try { await t.enviarImagen(jid, url, texto); return; }
      catch (e) {
        if (/Límite/i.test(e.message)) throw e;
        console.error(`⚠️ [Recordatorios] No se pudo enviar la foto a ${jid}: ${e.message}. Va solo el texto.`);
      }
    }
  }
  await t.enviar(jid, texto);
}

function registrar({ rifaId, momento, persona, nombre, telefono, estado, error }) {
  return pool.query(
    `INSERT INTO wa_recordatorio_envios (rifa_id, momento, persona, nombre, telefono, estado, error) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [rifaId, momento ? new Date(momento) : null, persona, nombre, telefono, estado, error ? String(error).slice(0, 300) : null],
  ).catch((e) => console.error('❌ [Recordatorios] registro:', e.message));
}

const yaNosEscribio = async (jid) =>
  (await pool.query(`SELECT 1 FROM wa_chat_mensajes WHERE jid = $1 AND de_mi = FALSE LIMIT 1`, [jid])).rows.length > 0;

// Pausa que toca después de escribirle a alguien
async function pausaEnvio(tibio, cfg) {
  const ab = cfg.antiban || {};
  if (tibio) { await sleep(azar(20000, 40000)); return; }
  await sleep(azar((ab.frio_espera_min_seg ?? 90) * 1000, (ab.frio_espera_max_seg ?? 240) * 1000));
}

// Le escribe a una persona (x = fila de PERSONAS_APARTADAS). Devuelve 'enviado', 'omitido' o lanza el error.
async function enviarAPersona({ x, rifa, jid, toca, cfg, etiqueta, tibio }) {
  const total = reservas.calcularPrecioReal(x.numeros.length, rifa.ofertas, Number(rifa.precio));
  const ab = await pool.query(
    `SELECT COALESCE(SUM(monto) FILTER (WHERE estado = 'aprobado'), 0) AS abonado,
            COALESCE(SUM(monto) FILTER (WHERE estado = 'pendiente'), 0) AS por_confirmar
       FROM reserva_abonos WHERE reserva_ids && $1::uuid[] AND NOT aplicado`, [x.ids]);
  const abonado = Number(ab.rows[0].abonado), porConfirmar = Number(ab.rows[0].por_confirmar);
  // Ya mandó el pago de todo lo que falta y está por confirmarse: no se le recuerda
  if (total - abonado - porConfirmar <= 0) return 'omitido';
  if (!tibio && (await t.existe?.(jid).catch(() => null)) === false) throw new Error('Ese número no tiene WhatsApp');
  const g = {
    rifa, ids: x.ids, numeros: x.numeros, nombre: x.nombre, cedula: x.cedula, telefono: x.telefono, limite: new Date(x.limite),
    total, abonado, por_confirmar: porConfirmar, saldo: Math.max(total - abonado, 0),
  };
  await enviarRecordatorio(jid, toca.etapa, g, cfg);
  // De los "auto:<momento>" solo se guarda el último
  await pool.query(
    `UPDATE reservas_cliente
        SET recordatorios = (SELECT COALESCE(JSONB_AGG(DISTINCT e), '[]'::jsonb) FROM JSONB_ARRAY_ELEMENTS(recordatorios || $2::jsonb) e
                              WHERE e #>> '{}' NOT LIKE 'auto:%' OR $2::jsonb @> JSONB_BUILD_ARRAY(e)),
            wa_jid = COALESCE(wa_jid, $3)
      WHERE id = ANY($1)`, [x.ids, JSON.stringify(toca.marcar), jid]);
  // El chat queda listo para que pague por ahí
  const chat = await chats.obtenerChat(jid);
  if (chat && (!chat.estado_compra?.paso || chat.estado_compra.diferido)) {
    await chats.actualizarChat(jid, { estado_compra: estadoDeApartado(g) });
  }
  await chats.guardarMensaje({ jid, deMi: true, autor: 'sistema', tipo: 'texto', estado: null,
    texto: `🔔 Recordatorio de pago (${etiqueta}) · ${rifa.nombre} · números ${x.numeros.join(', ')}` });
  return 'enviado';
}

// Una fila por persona con números apartados sin pagar (en una rifa o en todas)
const PERSONAS_APARTADAS = `
  SELECT rifa_id,
         COALESCE(NULLIF(RIGHT(regexp_replace(COALESCE(telefono, ''), '\\D', '', 'g'), 10), ''), wa_jid) AS persona,
         ARRAY_AGG(id ORDER BY created_at) AS ids, ARRAY_AGG(TRIM(numero) ORDER BY created_at) AS numeros,
         (ARRAY_AGG(nombre_cliente ORDER BY created_at))[1] AS nombre, (ARRAY_AGG(cedula ORDER BY created_at))[1] AS cedula,
         (ARRAY_AGG(telefono ORDER BY created_at))[1] AS telefono, MAX(wa_jid) AS wa_jid,
         MIN(apartado_hasta) AS limite, MIN(created_at) AS creado,
         (SELECT COALESCE(JSONB_AGG(DISTINCT e), '[]'::jsonb) FROM reservas_cliente x, JSONB_ARRAY_ELEMENTS(x.recordatorios) e
           WHERE x.id = ANY(ARRAY_AGG(rc.id))) AS enviados
    FROM reservas_cliente rc
   WHERE estado = 'apartado' AND pago_diferido AND (apartado_hasta > NOW() OR tiene_abono) AND ($1::uuid IS NULL OR rifa_id = $1)
   GROUP BY rifa_id, persona
   ORDER BY MIN(apartado_hasta)
   LIMIT 200`;

// ── Revisión periódica ───────────────────────────────────────
const fallos = new Map();   // clave → cuándo reintentar (si no se pudo enviar)

async function revisar() {
  await opciones.esquemaListo;
  await tablaLista;
  const cfg = await obtenerConfig();
  const rc = cfg.recordatorios_apartado || {};
  if (!cfg.activo || !t?.conectado()) return;
  const generales = rc.activo !== false;   // apagarlos no toca las fechas que el dueño puso en cada rifa
  const esDeDia = deDia();   // los automáticos solo de día; los de fecha y hora propias, a la hora que puso el dueño
  const finalHoras = Math.min(12, Math.max(1, Number(rc.final_horas) || 2));
  const cadaHoras = rc.frecuencia === 'cada' ? Math.min(72, Math.max(6, Number(rc.cada_horas) || 12)) : 0;   // menos de 6 h arriesga el número
  const porDias = rc.frecuencia === 'dias';
  const dias = (Array.isArray(rc.dias) ? rc.dias : []).map(Number).filter((n) => n >= 0 && n <= 6);
  const hora = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(rc.hora || '')) ? rc.hora : '10:00';

  const r = await pool.query(PERSONAS_APARTADAS, [null]);

  // Fechas de rifa que ya empezaron a salir: una tanda larga termina aunque se haga de noche
  const iniciados = new Map();
  for (const x of r.rows) {
    const s = iniciados.get(x.rifa_id) || new Set();
    for (const e of x.enviados || []) { const m = /^prog:(\d+)$/.exec(e); if (m) s.add(Number(m[1])); }
    iniciados.set(x.rifa_id, s);
  }

  let enviadosAhora = 0;
  for (const x of r.rows) {
    if (enviadosAhora >= 12) break;   // el resto, en la próxima revisión
    const rifa = await reservas.infoRifa(pool, x.rifa_id);
    if (!rifa) continue;
    const limite = new Date(x.limite);
    const datos = { rifa, limite, creado: new Date(x.creado), enviados: x.enviados || [], finalHoras, cadaHoras };
    const programados = (rifa.recordatorios_programados || []).map((p) => new Date(p).getTime()).filter(Number.isFinite);
    const toca = programados.length ? tocaProgramado({ ...datos, programados, esDeDia, iniciados: iniciados.get(x.rifa_id) })
      : !generales ? null
      : porDias ? tocaDias({ ...datos, dias, hora })     // a la hora que eligió el dueño
      : !esDeDia ? null
      : cadaHoras ? tocaCada(datos) : etapaQueToca(datos);
    if (!toca) continue;
    const base = { rifaId: x.rifa_id, momento: toca.momento, persona: x.persona, nombre: x.nombre, telefono: x.telefono };
    const jid = x.wa_jid || jidDe(x.telefono);
    const clave = `${x.rifa_id}|${x.persona}|${toca.etapa}`;
    if ((fallos.get(clave) || 0) > Date.now()) continue;
    if (!jid) {
      fallos.set(clave, Date.now() + 6 * 3600000);
      await registrar({ ...base, estado: 'error', error: 'Teléfono incompleto o inválido' });
      continue;
    }
    const etiqueta = { final: 'aviso final', dia: 'día del sorteo', vispera: 'víspera', programado: 'programado para esta rifa', dias: 'día programado' }[toca.etapa] || `cada ${cadaHoras} h`;
    try {
      const tibio = await yaNosEscribio(jid);
      if (await enviarAPersona({ x, rifa, jid, toca, cfg, etiqueta, tibio }) !== 'enviado') continue;
      await registrar({ ...base, estado: 'enviado' });
      enviadosAhora++;
      await pausaEnvio(tibio, cfg);   // de a poco (anti-bloqueo)
    } catch (e) {
      console.error(`❌ [Recordatorios] ${jid}:`, e.message);
      await registrar({ ...base, estado: 'error', error: e.message });
      // Un número que no existe no se reintenta; lo demás, en una hora
      fallos.set(clave, Date.now() + (/no tiene WhatsApp/.test(e.message) ? 6 : 1) * 3600000);
      // Tope diario de chats nuevos o de mensajes: no seguir intentando en esta vuelta
      if (/Límite/i.test(e.message)) break;
    }
  }
  if (fallos.size > 2000) fallos.clear();
}

// ── Panel de Reservas ────────────────────────────────────────
// Por cada rifa con apartados: quiénes faltan por pagar, sus fechas y qué pasó en cada una
async function panel() {
  await opciones.esquemaListo;
  await tablaLista;
  const cfg = await obtenerConfig();
  const personas = (await pool.query(PERSONAS_APARTADAS, [null])).rows;
  const ids = [...new Set(personas.map((p) => p.rifa_id))];
  const envios = ids.length ? (await pool.query(`
    SELECT DISTINCT ON (rifa_id, momento, persona) rifa_id, momento, persona, nombre, telefono, estado, error, created_at
      FROM wa_recordatorio_envios WHERE rifa_id = ANY($1)
     ORDER BY rifa_id, momento, persona, id DESC`, [ids])).rows : [];
  const rifas = [];
  for (const id of ids) {
    const rifa = await reservas.infoRifa(pool, id);
    if (!rifa) continue;
    const suyas = personas.filter((p) => p.rifa_id === id);
    const deRifa = envios.filter((e) => e.rifa_id === id);
    const programados = (rifa.recordatorios_programados || []).map((iso) => {
      const ms = new Date(iso).getTime();
      const deEste = deRifa.filter((e) => e.momento && new Date(e.momento).getTime() === ms);
      return {
        momento: new Date(ms).toISOString(),
        enviados: deEste.filter((e) => e.estado === 'enviado').length,
        fallidos: deEste.filter((e) => e.estado === 'error').map((e) => ({ nombre: e.nombre, telefono: e.telefono, error: e.error })),
      };
    });
    const ahoraEnv = deRifa.filter((e) => !e.momento);
    rifas.push({
      rifa_id: id, nombre: rifa.nombre, fecha_sorteo: rifa.fecha_sorteo,
      personas: suyas.length, numeros: suyas.reduce((n, p) => n + p.numeros.length, 0),
      nuevos_para_el_bot: (await Promise.all(suyas.map((p) => yaNosEscribio(p.wa_jid || jidDe(p.telefono) || '')))).filter((v) => !v).length,
      programados,
      envio_en_curso: enCurso.get(id) || null,
      otros_fallidos: ahoraEnv.filter((e) => e.estado === 'error').map((e) => ({ nombre: e.nombre, telefono: e.telefono, error: e.error })),
      otros_enviados: ahoraEnv.filter((e) => e.estado === 'enviado').length,
    });
  }
  return {
    conectado: !!t?.conectado(), bot_activo: !!cfg.activo,
    generales_activos: cfg.recordatorios_apartado?.activo !== false, tope_nuevos_dia: cfg.antiban?.max_chats_nuevos_dia || 30,
    rifas,
  };
}

// Cambia las fechas de una rifa. Las que ya pasaron se conservan para ver qué salió.
async function guardarProgramados(rifaId, lista) {
  await opciones.esquemaListo;
  const ahora = Date.now();
  const ms = [...new Set((Array.isArray(lista) ? lista : []).map((x) => new Date(x).getTime()).filter(Number.isFinite))].sort((a, b) => a - b);
  const futuras = ms.filter((p) => p > ahora);
  if (futuras.length > 12) throw new Error('Máximo 12 recordatorios por rifa');
  const cupo = 12 - futuras.length;
  const pasadas = cupo ? ms.filter((p) => p <= ahora).slice(-cupo) : [];
  const r = await pool.query(`UPDATE rifas SET recordatorios_programados = $1::jsonb WHERE id = $2 RETURNING id`,
    [JSON.stringify([...pasadas, ...futuras].map((p) => new Date(p).toISOString())), rifaId]);
  if (!r.rows[0]) throw new Error('Rifa no encontrada');
}

// "Enviar ahora a todos": sale en segundo plano y con las mismas pausas
const enCurso = new Map();   // rifa → { total, hechos }
async function enviarAhoraRifa(rifaId) {
  await opciones.esquemaListo;
  await tablaLista;
  if (!t?.conectado()) throw new Error('WhatsApp no está conectado.');
  if (enCurso.has(rifaId)) throw new Error('Ya se están enviando los recordatorios de esta rifa.');
  const rifa = await reservas.infoRifa(pool, rifaId);
  if (!rifa) throw new Error('Rifa no encontrada');
  const personas = (await pool.query(PERSONAS_APARTADAS, [rifaId])).rows;
  if (!personas.length) throw new Error('Esta rifa no tiene números apartados sin pagar.');
  const cfg = await obtenerConfig();
  const progreso = { total: personas.length, hechos: 0 };
  enCurso.set(rifaId, progreso);
  (async () => {
    for (const x of personas) {
      const base = { rifaId, persona: x.persona, nombre: x.nombre, telefono: x.telefono };
      const jid = x.wa_jid || jidDe(x.telefono);
      progreso.hechos += 1;
      if (!jid) { await registrar({ ...base, estado: 'error', error: 'Teléfono incompleto o inválido' }); continue; }
      try {
        const tibio = await yaNosEscribio(jid);
        const toca = { etapa: 'manual', marcar: [`manual:${Date.now()}`] };
        if (await enviarAPersona({ x, rifa, jid, toca, cfg, etiqueta: 'enviado a todos desde Reservas', tibio }) !== 'enviado') continue;
        await registrar({ ...base, estado: 'enviado' });
        await pausaEnvio(tibio, cfg);
      } catch (e) {
        console.error(`❌ [Recordatorios] ${jid}:`, e.message);
        await registrar({ ...base, estado: 'error', error: e.message });
        if (/Límite/i.test(e.message) || !t?.conectado()) break;
      }
    }
  })().catch((e) => console.error('❌ [Recordatorios]', e.message)).finally(() => enCurso.delete(rifaId));
  return { ok: true, total: personas.length };
}

// ── Recordatorio manual (botón "Recordar" en Reservas) ───────
// ids: apartados de UN cliente en una rifa. Sale ya, a cualquier hora, porque lo pide el dueño.
// Lanza un error claro si no se puede (WhatsApp desconectado, sin teléfono, tope de chats nuevos…).
async function recordarAhora(ids) {
  await opciones.esquemaListo;
  if (!t?.conectado()) throw new Error('WhatsApp no está conectado.');
  const filas = await pool.query(
    `SELECT id, rifa_id, telefono, wa_jid FROM reservas_cliente WHERE id = ANY($1) AND estado = 'apartado'`, [ids]);
  const f = filas.rows[0];
  if (!f) throw new Error('Esos números ya no están apartados.');
  const jid = filas.rows.find((x) => x.wa_jid)?.wa_jid || jidDe(f.telefono);
  if (!jid) throw new Error('Este cliente no tiene un WhatsApp válido registrado.');
  // Todos sus apartados de esa rifa, con lo abonado y lo que falta
  const g = (await reservas.apartadosDe({ jid: f.wa_jid || null, telefono: f.telefono, rifaId: f.rifa_id }))
    .find((x) => x.ids.includes(f.id));
  if (!g) throw new Error('No se encontraron los números apartados de este cliente.');
  if (g.saldo - g.por_confirmar <= 0) throw new Error('Este cliente ya envió el pago de todo lo que debía; está por confirmarse en Abonos.');
  const cfg = await obtenerConfig();
  await enviarRecordatorio(jid, 'manual', g, cfg);
  await pool.query(
    `UPDATE reservas_cliente SET recordatorios = recordatorios || $2::jsonb, wa_jid = COALESCE(wa_jid, $3) WHERE id = ANY($1)`,
    [g.ids, JSON.stringify([`manual:${Date.now()}`]), jid]);
  const chat = await chats.obtenerChat(jid);
  if (chat && (!chat.estado_compra?.paso || chat.estado_compra.diferido)) {
    await chats.actualizarChat(jid, { estado_compra: estadoDeApartado(g) });
  }
  await chats.guardarMensaje({ jid, deMi: true, autor: 'sistema', tipo: 'texto', estado: null,
    texto: `🔔 Recordatorio de pago enviado a mano · ${g.rifa.nombre} · números ${g.numeros.join(', ')}` });
  return { ok: true, numeros: g.numeros, saldo: g.saldo };
}

let revisando = false;
setInterval(() => {
  if (revisando) return;
  revisando = true;
  revisar().catch((e) => console.error('❌ [Recordatorios]', e.message)).finally(() => { revisando = false; });
}, 5 * 60000).unref();

module.exports = { init, revisar, recordarAhora, panel, guardarProgramados, enviarAhoraRifa, vincularApartados, estadoDeApartado, etapaQueToca, tocaCada, tocaProgramado, tocaDias, textoRecordatorio, mensajeRecordatorio };
