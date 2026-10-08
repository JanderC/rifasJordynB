// ============================================================
//  recordatorios.js — Recordatorios de pago de números apartados
//
//  En las rifas con "pago diferido" el cliente aparta sin pagar y tiene
//  hasta unas horas antes del sorteo. El bot le recuerda por WhatsApp:
//    - la víspera del sorteo (10:00 a. m.)
//    - el día del sorteo (9:00 a. m.)
//    - el aviso final, unas horas antes de que venza el plazo
//  o, si el dueño lo configura así, cada X horas (más el aviso final).
//  El texto puede ser uno propio (con variables) y llevar la foto de la rifa.
//  Solo se manda el recordatorio que toca (nunca varios seguidos), de día,
//  uno por cliente y rifa, y por la cola anti-bloqueo.
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
const soloDigitos = (x) => String(x || '').replace(/\D/g, '');

function horaVE() {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Caracas' }));
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
const deDia = () => { const h = horaVE(); return h >= '08:00' && h < '21:30'; };

function jidDe(telefono) {
  let n = soloDigitos(telefono);
  if (n.startsWith('0')) n = '58' + n.slice(1);
  return n.length >= 10 ? `${n}@s.whatsapp.net` : null;
}

// Estado de compra del chat para un grupo de apartados (el mismo que deja preparar_compra):
// con esto, cuando el cliente manda la captura, el sistema la registra sola.
function estadoDeApartado(g) {
  return {
    paso: 'esperando_comprobante', diferido: true,
    rifa_id: g.rifa.id, rifa_nombre: g.rifa.nombre, numeros: g.numeros,
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
  const pesos = (n) => `${Math.round(n).toLocaleString('es-CO')} ${cfg.moneda || 'pesos'}`;
  // Con abonos se le recuerda lo que FALTA, no el precio completo
  const abonado = Number(g.abonado) || 0;
  const total = pesos(g.saldo ?? g.total);
  const cuenta = abonado > 0 ? `Llevas abonado ${pesos(abonado)}. Te falta: *${total}*` : null;
  const limite = opciones.fmtLimite(g.limite);
  const metodos = Object.keys(metodosPago.METODOS_PAGO).filter((m) => !metodosPago.METODOS_PAGO[m].presencial);
  const comoPagar = `¿Con qué vas a pagar? ${metodos.length ? `Tenemos ${metodos.join(', ')}. ` : ''}Dime y te paso los datos 👇`;
  const hora = g.limite.toLocaleTimeString('es-VE', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/Caracas' });
  if (etapa === 'final') {
    return `⏰ ${nombre ? `${nombre}, te` : 'Te'} quedan *${duracion(g.limite.getTime() - Date.now())}* para pagar ${nums} de *${g.rifa.nombre}*.\n\n` +
      (abonado > 0
        ? `${cuenta}. El plazo vence a las ${hora} 🙏\n\n${comoPagar}`
        : `Total: *${total}*. Después de las ${hora} ${varios ? 'se liberan y los puede tomar' : 'se libera y lo puede tomar'} otra persona 🙏\n\n${comoPagar}`);
  }
  // Recordatorio pedido a mano desde Reservas o el de "cada X horas": sin "mañana/hoy es el sorteo"
  if (etapa === 'manual' || etapa === 'cada') {
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
  const pesos = (n) => `${Math.round(n).toLocaleString('es-CO')} ${cfg.moneda || 'pesos'}`;
  const metodos = Object.keys(metodosPago.METODOS_PAGO).filter((m) => !metodosPago.METODOS_PAGO[m].presencial);
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

// ── Revisión periódica ───────────────────────────────────────
const fallos = new Map();   // clave → cuándo reintentar (si no se pudo enviar)

async function revisar() {
  await opciones.esquemaListo;
  const cfg = await obtenerConfig();
  const rc = cfg.recordatorios_apartado || {};
  if (!cfg.activo || rc.activo === false || !t?.conectado() || !deDia()) return;
  const finalHoras = Math.min(12, Math.max(1, Number(rc.final_horas) || 2));
  const cadaHoras = rc.frecuencia === 'cada' ? Math.min(72, Math.max(1, Number(rc.cada_horas) || 12)) : 0;

  const r = await pool.query(`
    SELECT rifa_id,
           COALESCE(NULLIF(RIGHT(regexp_replace(COALESCE(telefono, ''), '\\D', '', 'g'), 10), ''), wa_jid) AS persona,
           ARRAY_AGG(id ORDER BY created_at) AS ids, ARRAY_AGG(TRIM(numero) ORDER BY created_at) AS numeros,
           (ARRAY_AGG(nombre_cliente ORDER BY created_at))[1] AS nombre, (ARRAY_AGG(cedula ORDER BY created_at))[1] AS cedula,
           (ARRAY_AGG(telefono ORDER BY created_at))[1] AS telefono, MAX(wa_jid) AS wa_jid,
           MIN(apartado_hasta) AS limite, MIN(created_at) AS creado,
           (SELECT COALESCE(JSONB_AGG(DISTINCT e), '[]'::jsonb) FROM reservas_cliente x, JSONB_ARRAY_ELEMENTS(x.recordatorios) e
             WHERE x.id = ANY(ARRAY_AGG(rc.id))) AS enviados
      FROM reservas_cliente rc
     WHERE estado = 'apartado' AND pago_diferido AND (apartado_hasta > NOW() OR tiene_abono)
     GROUP BY rifa_id, persona
     ORDER BY MIN(apartado_hasta)
     LIMIT 200`);

  let enviadosAhora = 0;
  for (const x of r.rows) {
    if (enviadosAhora >= 12) break;   // el resto, en la próxima revisión
    const rifa = await reservas.infoRifa(pool, x.rifa_id);
    if (!rifa) continue;
    const limite = new Date(x.limite);
    const datos = { rifa, limite, creado: new Date(x.creado), enviados: x.enviados || [], finalHoras, cadaHoras };
    const toca = cadaHoras ? tocaCada(datos) : etapaQueToca(datos);
    if (!toca) continue;
    const jid = x.wa_jid || jidDe(x.telefono);
    if (!jid) continue;
    const clave = `${x.rifa_id}|${x.persona}|${toca.etapa}`;
    if ((fallos.get(clave) || 0) > Date.now()) continue;

    const total = reservas.calcularPrecioReal(x.numeros.length, rifa.ofertas, Number(rifa.precio));
    const ab = await pool.query(
      `SELECT COALESCE(SUM(monto) FILTER (WHERE estado = 'aprobado'), 0) AS abonado,
              COALESCE(SUM(monto) FILTER (WHERE estado = 'pendiente'), 0) AS por_confirmar
         FROM reserva_abonos WHERE reserva_ids && $1::uuid[] AND NOT aplicado`, [x.ids]);
    const abonado = Number(ab.rows[0].abonado), porConfirmar = Number(ab.rows[0].por_confirmar);
    // Ya mandó el pago de todo lo que falta y está por confirmarse: no se le recuerda
    if (total - abonado - porConfirmar <= 0) continue;
    const g = {
      rifa, ids: x.ids, numeros: x.numeros, nombre: x.nombre, cedula: x.cedula, telefono: x.telefono, limite,
      total, abonado, por_confirmar: porConfirmar, saldo: Math.max(total - abonado, 0),
    };
    try {
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
        texto: `🔔 Recordatorio de pago (${{ final: 'aviso final', dia: 'día del sorteo', vispera: 'víspera' }[toca.etapa] || `cada ${cadaHoras} h`}) · ${rifa.nombre} · números ${x.numeros.join(', ')}` });
      enviadosAhora++;
      await sleep(20000 + Math.random() * 20000);   // de a poco (anti-bloqueo)
    } catch (e) {
      console.error(`❌ [Recordatorios] ${jid}:`, e.message);
      fallos.set(clave, Date.now() + 60 * 60000);   // reintentar en una hora
      // Tope diario de chats nuevos o de mensajes: no seguir intentando en esta vuelta
      if (/Límite/i.test(e.message)) break;
    }
  }
  if (fallos.size > 2000) fallos.clear();
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
}, 10 * 60000).unref();

module.exports = { init, revisar, recordarAhora, vincularApartados, estadoDeApartado, etapaQueToca, tocaCada, textoRecordatorio, mensajeRecordatorio };
