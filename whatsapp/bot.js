// ============================================================
//  bot.js — Vendedor conversacional de WhatsApp
//
//  Ciclo de compra:
//   1. El cliente escribe → la IA conversa y consulta disponibilidad REAL
//      con herramientas (nunca inventa).
//   2. Con rifa + números + nombre (+ cédula) → preparar_compra: calcula el
//      total con ofertas y le da los datos de pago.
//   3. El cliente manda la foto del comprobante → se sube a Cloudinary, se
//      lee con visión (monto/referencia) y se crea la reserva pendiente.
//   4. El admin aprueba en Reservas → sale el ticket por WhatsApp, se registra
//      la venta (origen whatsapp, cuadra en Caja) y el ciclo vuelve a empezar.
//
//  El bot se calla si: está apagado, el chat lo tomó un humano, está fuera
//  de horario, el mensaje es viejo (backlog al reconectar) o detecta un bucle.
// ============================================================
const pool = require('../config/db');
const bus  = require('../services/waBus');
const chats = require('../services/waChats');
const reservas = require('../services/reservas');
const { obtenerConfig } = require('./botConfig');
const ia = require('./ia');
const metodosPago = require('../services/metodosPago');

let transporte = null;   // lo inyecta whatsappService: { enviarTexto, escribiendo, leer, conectado }
function init(t) { transporte = t; }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const azar = (a, b) => Math.floor(a + Math.random() * (b - a));

// ── Utilidades de fecha (hora Venezuela) ─────────────────────
function ahoraVE() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Caracas' }));
}
function dentroDeHorario(h) {
  if (!h?.activo) return true;
  const d = ahoraVE();
  if (Array.isArray(h.dias) && !h.dias.includes(d.getDay())) return false;
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return hhmm >= (h.desde || '00:00') && hhmm <= (h.hasta || '23:59');
}
const fmtMonto = (n, cfg) => `${Number(n || 0).toLocaleString('es-CO')} ${cfg.moneda || 'pesos'}`;
const fmtFechaVE = () => ahoraVE().toLocaleString('es-VE', { weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' });

// ── Estado en memoria (se reconstruye solo) ──────────────────
const pendientes = new Map();          // jid → { timer, items }
const respuestasRecientes = new Map(); // jid → [timestamps] (anti-bucle)
const avisosEnviados = new Map();      // `${tipo}|${jid}` → timestamp (no repetir avisos)
const procesando = new Set();          // jids con un turno en curso

function yaAvisado(tipo, jid, horas) {
  const k = `${tipo}|${jid}`;
  const t = avisosEnviados.get(k);
  if (t && Date.now() - t < horas * 3600 * 1000) return true;
  avisosEnviados.set(k, Date.now());
  return false;
}

// ─────────────────────────────────────────────────────────────
// ENTRADA: lo llama whatsappService por cada mensaje del cliente
//   item = { mensaje (fila guardada), chat, media?: { base64, mime } }
// ─────────────────────────────────────────────────────────────
async function alRecibir(item) {
  const cfg = await obtenerConfig();
  const { mensaje, chat } = item;
  if (!cfg.activo || !chat?.bot_activo) return;

  // Mensajes viejos (llegaron mientras estábamos desconectados): no contestar
  // en ráfaga —patrón típico de bot— sino dejarlos para una persona.
  const edadMin = (Date.now() - new Date(mensaje.created_at).getTime()) / 60000;
  if (edadMin > (cfg.antiban.ignorar_viejos_min || 10)) {
    await chats.actualizarChat(mensaje.jid, { necesita_humano: true, motivo_humano: 'Escribió mientras WhatsApp estaba desconectado' });
    return;
  }

  const jid = mensaje.jid;
  const e = pendientes.get(jid) || { timer: null, items: [], listo: false };
  e.items.push(item);
  e.listo = false;
  clearTimeout(e.timer);
  // Espera para juntar ráfagas ("hola" / "tienen rifas?" / "el 7?") en una sola respuesta
  e.timer = setTimeout(() => { e.listo = true; despachar(jid); }, cfg.antiban.agrupar_ms || 6000);
  pendientes.set(jid, e);
}

// Un solo turno a la vez por chat. Lo que llegue durante un turno espera a
// que termine y se atiende en UN turno siguiente (nunca turnos duplicados).
function despachar(jid) {
  const e = pendientes.get(jid);
  if (!e || !e.listo || procesando.has(jid)) return;
  pendientes.delete(jid);
  procesando.add(jid);
  procesar(jid, e.items)
    .catch((err) => console.error('❌ [Bot] Error procesando', jid, err))
    .finally(() => { procesando.delete(jid); despachar(jid); });
}

async function procesar(jid, items) {
  const cfg = await obtenerConfig();
  const chat = await chats.obtenerChat(jid);
  if (!cfg.activo || !chat?.bot_activo || !transporte?.conectado()) return;

  // Leer como una persona: un rato después, no al instante
  await sleep(azar(900, 2600));
  await transporte.leer(jid, items.map((i) => i.mensaje.wa_key).filter(Boolean)).catch(() => {});

  if (!dentroDeHorario(cfg.horario)) {
    if (!yaAvisado('fuera', jid, 6) && cfg.horario.mensaje_fuera) await responder(jid, cfg.horario.mensaje_fuera, cfg);
    return;
  }

  // Anti-bucle (p. ej. otro bot contestándonos)
  const recientes = (respuestasRecientes.get(jid) || []).filter((t) => Date.now() - t < 5 * 60000);
  if (recientes.length >= (cfg.antiban.max_respuestas_5min || 8)) {
    await chats.actualizarChat(jid, { bot_activo: false, necesita_humano: true, motivo_humano: 'Demasiados mensajes seguidos (posible bucle)' });
    return;
  }

  const imagen = [...items].reverse().find((i) => i.mensaje.tipo === 'imagen' && i.mensaje.media_url);
  const paso = chat.estado_compra?.paso;
  if (imagen && paso === 'esperando_comprobante') {
    await procesarComprobante(jid, chat, imagen, cfg);
    return;
  }
  if (imagen && (!paso || paso === 'comprobante_sin_compra')) {
    // Foto sin compra en curso: puede ser un comprobante enviado "antes de tiempo".
    // Se guarda para usarla apenas la IA prepare la compra.
    await chats.actualizarChat(jid, {
      estado_compra: { paso: 'comprobante_sin_compra', comprobante: { url: imagen.mensaje.media_url, mime: imagen.mensaje.media_mime, at: Date.now() } },
    });
    chat.estado_compra = (await chats.obtenerChat(jid)).estado_compra;
  }

  await turnoIA(jid, chat, items, cfg);
}

// ── Enviar respuesta como persona: "escribiendo…" y en partes ─
// Markdown → formato de WhatsApp (**negrita** no existe allá: es *negrita*)
function aFormatoWhatsApp(texto) {
  return String(texto)
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/__(.+?)__/g, '_$1_')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '$1: $2')
    .replace(/^\s*[-*]\s+/gm, '• ')
    .trim();
}

function dividir(texto) {
  const partes = String(texto).split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (partes.length <= 3) return partes;
  return [...partes.slice(0, 2), partes.slice(2).join('\n\n')];
}

// Un mensaje tal cual, sin partir en párrafos (p. ej. los datos de pago)
async function enviarBloque(jid, texto, cfg) {
  const cps = cfg.antiban.escribiendo_cps || 28;
  await transporte.escribiendo(jid, Math.min(5000, Math.max(900, (texto.length / (cps * 2)) * 1000)));
  await transporte.enviarTexto(jid, texto, { autor: 'bot' });
  const r = respuestasRecientes.get(jid) || [];
  r.push(Date.now());
  respuestasRecientes.set(jid, r.slice(-30));
}

async function responder(jid, texto, cfg) {
  const cps = cfg.antiban.escribiendo_cps || 28;
  const partes = dividir(aFormatoWhatsApp(texto));
  for (let i = 0; i < partes.length; i++) {
    const p = partes[i];
    const ms = Math.min(7000, Math.max(900, (p.length / cps) * 1000)) + azar(0, 600);
    await transporte.escribiendo(jid, ms);
    await transporte.enviarTexto(jid, p, { autor: 'bot' });
    const r = respuestasRecientes.get(jid) || [];
    r.push(Date.now());
    respuestasRecientes.set(jid, r.slice(-30));
    if (i < partes.length - 1) await sleep(azar(500, 1400));
  }
}

// ─────────────────────────────────────────────────────────────
// HERRAMIENTAS que la IA puede usar
// ─────────────────────────────────────────────────────────────
const HERRAMIENTAS = [
  {
    nombre: 'ver_rifas',
    descripcion: 'Lista las rifas activas en venta: premio, precio por número, ofertas, fecha del sorteo y cuántas cifras tienen los números.',
    parametros: { type: 'object', properties: {}, required: [] },
  },
  {
    nombre: 'consultar_numeros',
    descripcion: 'Verifica en la base de datos si uno o varios números están disponibles en una rifa. Úsala SIEMPRE antes de decir que un número está libre u ocupado.',
    parametros: {
      type: 'object',
      properties: {
        rifa_id: { type: 'string', description: 'id de la rifa (de ver_rifas)' },
        numeros: { type: 'array', items: { type: 'string' }, description: 'Números tal como los dijo el cliente, ej. ["7","045"]' },
      },
      required: ['rifa_id', 'numeros'],
    },
  },
  {
    nombre: 'numeros_disponibles',
    descripcion: 'Sugiere números libres al azar de una rifa, opcionalmente que terminen en ciertas cifras (ej. terminacion "7").',
    parametros: {
      type: 'object',
      properties: {
        rifa_id: { type: 'string' },
        cantidad: { type: 'integer', description: 'Cuántos sugerir (máx 20)' },
        terminacion: { type: 'string', description: 'Cifras finales deseadas, opcional' },
      },
      required: ['rifa_id'],
    },
  },
  {
    nombre: 'preparar_compra',
    descripcion: 'Aparta (bloquea) los números para el cliente cuando ya tienes rifa, números disponibles, nombre y cédula. Si ya sabes cómo va a pagar, pasa metodo_pago y el SISTEMA le envía solo los datos de pago y el monto exacto. Después el cliente manda la captura del comprobante.',
    parametros: {
      type: 'object',
      properties: {
        rifa_id: { type: 'string' },
        numeros: { type: 'array', items: { type: 'string' } },
        nombre: { type: 'string', description: 'Nombre y apellido del cliente' },
        cedula: { type: 'string', description: 'Cédula de identidad del cliente' },
        metodo_pago: { type: 'string', description: 'Pago Móvil, Nequi, Bancolombia o Zelle (opcional si aún no lo dijo)' },
      },
      required: ['rifa_id', 'numeros', 'nombre'],
    },
  },
  {
    nombre: 'elegir_metodo_pago',
    descripcion: 'Cuando el cliente dice con qué va a pagar (o cambia de método) en una compra ya apartada: el SISTEMA le envía los datos de pago y el monto exacto en la moneda de ese método.',
    parametros: {
      type: 'object',
      properties: { metodo_pago: { type: 'string', description: 'Pago Móvil, Nequi, Bancolombia o Zelle' } },
      required: ['metodo_pago'],
    },
  },
  {
    nombre: 'cancelar_compra',
    descripcion: 'Cancela la compra apartada y libera los números (cuando el cliente ya no la quiere o quiere cambiar los números).',
    parametros: { type: 'object', properties: {}, required: [] },
  },
  {
    nombre: 'mis_compras',
    descripcion: 'Muestra las compras/reservas de este cliente y su estado (pendiente de verificar, aprobada, rechazada).',
    parametros: { type: 'object', properties: {}, required: [] },
  },
  {
    nombre: 'pasar_a_humano',
    descripcion: 'Pasa la conversación a una persona del equipo. Úsala SOLO si: el cliente pide explícitamente hablar con una persona, quiere pagar en efectivo, reclama un pago o un premio que no puedes verificar, o pregunta algo que no puedes responder con tus herramientas ni con la información del negocio. No la uses por dudas normales ni porque el cliente esté impaciente.',
    parametros: {
      type: 'object',
      properties: { motivo: { type: 'string' } },
      required: ['motivo'],
    },
  },
];

async function rifaValida(rifaId) {
  const enVenta = await reservas.rifasEnVenta();
  return enVenta.find((r) => r.id === rifaId) || null;
}

// Envía los datos de pago y el monto EXACTOS (no los redacta la IA)
async function prepararPago(metodo, ec, efectos) {
  const tasas = await metodosPago.obtenerTasas();
  const monto = metodosPago.montoEnMetodo(ec.total, metodo, tasas);
  efectos.mensajePago = metodosPago.mensajeDePago(metodo, monto, { numeros: ec.numeros, rifa: ec.rifa_nombre });
  return monto;
}

const NOTA_PAGO_ENVIADO = (min) =>
  `El SISTEMA le envía ahora mismo, en un mensaje aparte, los datos de pago y el monto exacto. NO repitas datos bancarios ni montos: solo dile en una frase corta que le apartaste los números por ${min} minutos mientras paga.`;

// prueba=true: modo simulador del panel (no escribe nada en la BD)
function crearEjecutor(jid, chat, cfg, efectos, { prueba = false } = {}) {
  const minutos = cfg.apartado_minutos || 45;
  const nombresMetodos = Object.keys(metodosPago.METODOS_PAGO);
  return async (nombre, args) => {
    try {
      switch (nombre) {
        case 'ver_rifas': {
          const rifas = await reservas.rifasEnVenta();
          if (!rifas.length) return { rifas: [], nota: 'No hay rifas en venta ahora mismo.' };
          return {
            rifas: rifas.map((r) => ({
              rifa_id: r.id, nombre: r.nombre, premio: r.premio, precio_por_numero: fmtMonto(r.precio, cfg),
              ofertas: (r.ofertas || []).map((o) => `${o.cantidad} números por ${fmtMonto(o.precio_total, cfg)}`),
              sorteo: [r.fecha_sorteo, r.hora_sorteo?.slice(0, 5)].filter(Boolean).join(' ') || 'por anunciar',
              loteria: r.loteria_ref || null,
              numeros_van_de: `${'0'.repeat(r.cifras)} a ${'9'.repeat(r.cifras)}`,
            })),
          };
        }
        case 'consultar_numeros': {
          const rifa = await rifaValida(args.rifa_id);
          if (!rifa) return { error: 'Esa rifa no está en venta. Usa ver_rifas.' };
          const invalidos = [];
          const nums = [];
          for (const n of args.numeros || []) {
            const v = reservas.normalizarNumero(n, rifa.cifras);
            if (v) nums.push(v); else invalidos.push(String(n));
          }
          const occ = nums.length ? await reservas.ocupacionNumeros(pool, rifa, nums) : {};
          return {
            rifa: rifa.nombre,
            numeros: nums.map((n) => ({ numero: n, disponible: occ[n].disponible })),
            ...(invalidos.length ? { fuera_de_rango: invalidos, rango: `${'0'.repeat(rifa.cifras)}-${'9'.repeat(rifa.cifras)}` } : {}),
          };
        }
        case 'numeros_disponibles': {
          const rifa = await rifaValida(args.rifa_id);
          if (!rifa) return { error: 'Esa rifa no está en venta. Usa ver_rifas.' };
          const { libres, totalLibres } = await reservas.numerosLibres(pool, rifa, { cantidad: args.cantidad || 6, terminacion: args.terminacion });
          return { rifa: rifa.nombre, sugeridos: libres, total_libres: totalLibres };
        }
        case 'preparar_compra': {
          const rifa = await rifaValida(args.rifa_id);
          if (!rifa) return { error: 'Esa rifa no está en venta.' };
          const nombreCli = String(args.nombre || '').trim();
          if (nombreCli.length < 3) return { error: 'Falta el nombre completo del cliente. Pídeselo.' };
          const cedula = String(args.cedula || '').replace(/[^\dVEJvej-]/g, '');
          if (cfg.pedir_cedula && cedula.replace(/\D/g, '').length < 5) return { error: 'Falta la cédula del cliente. Pídesela.' };
          const nums = [...new Set((args.numeros || []).map((n) => reservas.normalizarNumero(n, rifa.cifras)).filter(Boolean))];
          if (!nums.length) return { error: 'No hay números válidos.' };
          if (nums.length > 20) return { error: 'Máximo 20 números por compra.' };
          const metodo = args.metodo_pago ? metodosPago.normalizarMetodo(args.metodo_pago) : null;
          if (args.metodo_pago && !metodo) return { error: `Método no reconocido. Opciones: ${nombresMetodos.join(', ')}.` };
          if (metodo && metodosPago.METODOS_PAGO[metodo].presencial) {
            return { error: 'El pago en efectivo lo coordina una persona.', instruccion: 'Usa pasar_a_humano con motivo "Quiere pagar en efectivo".' };
          }

          // Si ya tenía números apartados (cambió de idea), se liberan primero
          const ecPrevio = chat.estado_compra;
          const apartadoHasta = new Date(Date.now() + minutos * 60000);
          let idsApartados = [];
          if (prueba) {
            const occ = await reservas.ocupacionNumeros(pool, rifa, nums);
            const ocupados = nums.filter((n) => !occ[n].disponible);
            if (ocupados.length) return { error: 'Algunos números ya no están disponibles.', no_disponibles: ocupados };
          } else {
            if (ecPrevio?.paso === 'esperando_comprobante' && ecPrevio.reservas?.length) await reservas.liberarApartados(ecPrevio.reservas);
            // Apartar = BLOQUEAR: desde ya nadie más puede tomarlos (ni por la página ni por WhatsApp)
            const client = await pool.connect();
            try {
              await client.query('BEGIN');
              const r = await reservas.crearReservasTx(client, {
                rifa_id: rifa.id, numeros: nums, nombre_cliente: nombreCli, cedula, telefono: chat.telefono,
                metodo_pago: metodo, comprobanteUrl: null, origen: 'whatsapp', wa_jid: jid,
                estado: 'apartado', apartadoHasta,
              });
              if (!r.ok || r.conflictos.length) {
                await client.query('ROLLBACK');
                return { error: 'Algunos números ya no están disponibles.', no_disponibles: (r.conflictos || []).map((c) => c.numero) };
              }
              await client.query('COMMIT');
              idsApartados = r.reservas.map((x) => x.id);
            } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
          }

          const total = reservas.calcularPrecioReal(nums.length, rifa.ofertas, Number(rifa.precio));
          const previo = ecPrevio?.paso === 'comprobante_sin_compra' ? ecPrevio.comprobante : null;
          const estado = {
            paso: 'esperando_comprobante',
            rifa_id: rifa.id, rifa_nombre: rifa.nombre, numeros: nums,
            nombre: nombreCli, cedula: cedula || null, total, metodo,
            reservas: idsApartados, apartado_hasta: apartadoHasta.getTime(), desde: Date.now(),
          };
          if (metodo) estado.monto = await prepararPago(metodo, estado, efectos);
          if (!prueba) await chats.actualizarChat(jid, { estado_compra: estado });
          chat.estado_compra = estado;

          // El cliente ya había mandado el comprobante antes: registrarlo ya
          if (previo && Date.now() - previo.at < 60 * 60000) {
            efectos.comprobantePrevio = previo;
            delete efectos.mensajePago;
            return {
              ok: true, total_a_pagar: fmtMonto(total, cfg), numeros: nums,
              comprobante: 'El cliente YA envió una imagen de comprobante antes; el sistema la registrará automáticamente. Solo confírmale en una frase que ya la recibiste y que apenas se verifique el pago le llega su ticket.',
            };
          }
          if (metodo) {
            return { ok: true, numeros: nums, apartados_por_minutos: minutos, total: fmtMonto(total, cfg), monto_en_su_metodo: estado.monto.texto, nota: NOTA_PAGO_ENVIADO(minutos) };
          }
          return {
            ok: true, numeros: nums, apartados_por_minutos: minutos, total: fmtMonto(total, cfg),
            metodos_disponibles: nombresMetodos.filter((m) => !metodosPago.METODOS_PAGO[m].presencial),
            instruccion: 'Ya quedaron apartados. Pregúntale con qué método va a pagar y luego usa elegir_metodo_pago.',
          };
        }
        case 'elegir_metodo_pago': {
          const ec = chat.estado_compra;
          if (ec?.paso !== 'esperando_comprobante') return { error: 'No hay una compra apartada. Usa preparar_compra primero.' };
          const metodo = metodosPago.normalizarMetodo(args.metodo_pago);
          if (!metodo) return { error: `Método no reconocido. Opciones: ${nombresMetodos.join(', ')}.` };
          if (metodosPago.METODOS_PAGO[metodo].presencial) {
            return { error: 'El pago en efectivo lo coordina una persona.', instruccion: 'Usa pasar_a_humano con motivo "Quiere pagar en efectivo".' };
          }
          const monto = await prepararPago(metodo, ec, efectos);
          const nuevo = { ...ec, metodo, monto };
          if (!prueba) {
            await chats.actualizarChat(jid, { estado_compra: nuevo });
            if (ec.reservas?.length) await pool.query(`UPDATE reservas_cliente SET metodo_pago=$1 WHERE id = ANY($2)`, [metodo, ec.reservas]);
          }
          chat.estado_compra = nuevo;
          const quedan = Math.max(1, Math.round((ec.apartado_hasta - Date.now()) / 60000));
          return { ok: true, metodo, monto: monto.texto, nota: NOTA_PAGO_ENVIADO(quedan) };
        }
        case 'cancelar_compra': {
          if (!prueba) {
            if (chat.estado_compra?.reservas?.length) await reservas.liberarApartados(chat.estado_compra.reservas);
            await chats.actualizarChat(jid, { estado_compra: null });
          }
          chat.estado_compra = null;
          return { ok: true, nota: 'Números liberados.' };
        }
        case 'mis_compras': {
          const r = await pool.query(`
            SELECT rc.numero, rc.estado, rc.created_at::date AS fecha, r.nombre AS rifa
              FROM reservas_cliente rc JOIN rifas r ON r.id = rc.rifa_id
             WHERE rc.wa_jid = $1 OR ($2::text IS NOT NULL AND regexp_replace(rc.telefono, '\\D', '', 'g') = $2)
             ORDER BY rc.created_at DESC LIMIT 15`, [jid, chat.telefono || null]);
          return { compras: r.rows.map((x) => ({ ...x, numero: String(x.numero).trim() })) };
        }
        case 'pasar_a_humano': {
          if (!prueba) await chats.actualizarChat(jid, { bot_activo: false, necesita_humano: true, motivo_humano: String(args.motivo || 'Pidió hablar con una persona').slice(0, 200) });
          efectos.pasadoAHumano = true;
          return { ok: true, instruccion: 'Dile en una frase corta que ya lo atiende una persona del equipo.' };
        }
        default:
          return { error: `Herramienta desconocida: ${nombre}` };
      }
    } catch (err) {
      console.error(`❌ [Bot] Herramienta ${nombre}:`, err.message);
      return { error: 'Hubo un problema consultando el sistema.' };
    }
  };
}

// ── Prompt del sistema ───────────────────────────────────────
function describirEstado(ec, cfg) {
  if (!ec?.paso) return 'Sin compra en curso.';
  if (ec.paso === 'esperando_comprobante') {
    const quedan = ec.apartado_hasta ? Math.max(0, Math.round((ec.apartado_hasta - Date.now()) / 60000)) : null;
    return `Números APARTADOS esperando el comprobante: rifa "${ec.rifa_nombre}", números ${ec.numeros.join(', ')}, a nombre de ${ec.nombre}, total ${fmtMonto(ec.total, cfg)}` +
      (ec.metodo ? `, paga por ${ec.metodo} (${ec.monto?.texto}); los datos de pago ya se le enviaron` : ', todavía no dijo con qué método paga (pregúntale y usa elegir_metodo_pago)') +
      (quedan != null ? `. Le quedan ${quedan} minutos de apartado` : '') + '. Si pregunta, recuérdale que mande la captura del pago.';
  }
  if (ec.paso === 'esperando_confirmacion')
    return `Ya envió el comprobante (números ${(ec.numeros || []).join(', ')} de "${ec.rifa_nombre}"). Está pendiente de que el equipo verifique el pago; cuando se apruebe le llega el ticket. Si quiere comprar más números, puede hacerlo.`;
  if (ec.paso === 'comprobante_sin_compra')
    return 'Envió una foto (posible comprobante de pago) sin compra en curso. Pregúntale de forma natural para qué rifa y números es, y sus datos, para prepararle la compra.';
  return 'Sin compra en curso.';
}

function construirSistema(cfg, chat) {
  const nombreCliente = chat.nombre_guardado || chat.nombre;
  return `${cfg.personalidad}

Trabajas para "${cfg.nombre_negocio}". Los precios de los números están en ${cfg.moneda || 'pesos'}: nunca digas otra moneda (ni Bs ni USD) para los precios; el premio dilo tal como viene.${cfg.nombre_asistente ? ` Te llamas ${cfg.nombre_asistente}.` : ''}

CÓMO VENDER
- Cuando el cliente pregunte por rifas o números, consulta con tus herramientas antes de responder. Si hay una sola rifa en venta, asume esa sin preguntar.
- Si un número no está disponible, dilo sin rodeos y ofrece alternativas parecidas (numeros_disponibles, por ejemplo con la misma terminación).
- Para apartar necesitas: la rifa, los números, nombre y apellido${cfg.pedir_cedula ? ' y cédula' : ''}. Pídelos conversando, no como formulario, y solo lo que falte.
- Con todo listo usa preparar_compra: los números quedan bloqueados ${cfg.apartado_minutos || 45} minutos para el cliente. Si ya dijo cómo paga, pásalo en metodo_pago; si no, pregúntale y usa elegir_metodo_pago.
- Métodos de pago: ${Object.keys(metodosPago.METODOS_PAGO).filter((m) => !metodosPago.METODOS_PAGO[m].presencial).join(', ')} (efectivo lo coordina una persona).
- Los datos de pago y el monto exacto los envía el SISTEMA automáticamente. Tú nunca escribas números de cuenta, teléfonos de pago ni montos convertidos.
- Cuando el cliente manda la captura del pago, el sistema la guarda y la registra sola; tú solo acompañas.
- Tú resuelves todo lo de la compra. Usa pasar_a_humano solo en los casos que describe esa herramienta.
- Nunca menciones "series" ni detalles internos del sistema.

FORMA DE ESCRIBIR
- Mensajes cortos, máximo 2 o 3 frases. Si necesitas decir dos cosas distintas, sepáralas con una línea en blanco (cada párrafo se envía como un mensaje aparte).
- Nada de listas, viñetas ni títulos. Escribe como en un chat real, en frases.
- Si quieres resaltar algo usa *un asterisco* (así es la negrita en WhatsApp), máximo una vez por mensaje.
- Si hay varias rifas, menciónalas en una o dos frases con su premio y precio, sin fechas pasadas.
${cfg.info_extra ? `\nINFORMACIÓN DEL NEGOCIO\n${cfg.info_extra}\n` : ''}
CONTEXTO DE ESTA CONVERSACIÓN
- Fecha y hora en Venezuela: ${fmtFechaVE()}.
- Nombre del cliente en WhatsApp: ${nombreCliente || 'desconocido'}.
- Estado: ${describirEstado(chat.estado_compra, cfg)}`;
}

// Historial de la BD → mensajes para la IA (cliente=user; bot/humano/teléfono=assistant)
// hastaId: solo hasta el último mensaje de ESTE turno; lo que llegó después
// lo atiende el turno siguiente (así nunca se responde dos veces lo mismo).
async function historialParaIA(jid, hastaId) {
  const hist = await chats.historialReciente(jid, 24);
  const out = [];
  for (const m of hist) {
    if (hastaId && !m.de_mi && Number(m.id) > Number(hastaId)) continue;
    if (m.autor === 'sistema' && !m.de_mi) continue;
    const role = m.de_mi ? 'assistant' : 'user';
    let texto = m.texto || '';
    if (m.tipo === 'imagen') texto = `[envió una foto]${texto ? ' ' + texto : ''}`;
    else if (m.tipo === 'audio') texto = '[envió una nota de voz que no puedes escuchar; pídele que lo escriba]';
    else if (m.tipo !== 'texto') texto = `[envió un ${m.tipo}]${texto ? ' ' + texto : ''}`;
    if (!texto) continue;
    const ultimo = out[out.length - 1];
    if (ultimo && ultimo.role === role) ultimo.content += `\n${texto}`;
    else out.push({ role, content: texto });
  }
  while (out.length && out[0].role !== 'user') out.shift();   // debe empezar el cliente
  return out;
}

async function turnoIA(jid, chat, items, cfg) {
  const hastaId = Math.max(...items.map((i) => Number(i.mensaje.id) || 0));
  const mensajes = await historialParaIA(jid, hastaId || null);
  if (!mensajes.length || mensajes[mensajes.length - 1].role !== 'user') return;

  const efectos = {};
  let resultado;
  try {
    resultado = await ia.chatConHerramientas(cfg, {
      system: construirSistema(cfg, chat),
      mensajes,
      herramientas: HERRAMIENTAS,
      ejecutar: crearEjecutor(jid, chat, cfg, efectos),
      maxPasos: 5,
    });
  } catch (err) {
    console.error(`❌ [Bot] IA falló (${cfg.proveedor}):`, err.message);
    await chats.actualizarChat(jid, { necesita_humano: true, motivo_humano: `La IA no respondió: ${err.message}`.slice(0, 200) });
    if (cfg.mensaje_sin_ia && !yaAvisado('sin_ia', jid, 12)) await responder(jid, cfg.mensaje_sin_ia, cfg);
    return;
  }

  if (resultado.texto) await responder(jid, resultado.texto, cfg);

  // Datos de pago + monto exacto: los manda el sistema, en un solo mensaje
  if (efectos.mensajePago) {
    await sleep(azar(700, 1500));
    await enviarBloque(jid, efectos.mensajePago, cfg);
  }

  // Comprobante enviado antes de preparar la compra → registrarlo ahora
  if (efectos.comprobantePrevio) {
    const chatAct = await chats.obtenerChat(jid);
    await procesarComprobante(jid, chatAct, {
      mensaje: { media_url: efectos.comprobantePrevio.url, media_mime: efectos.comprobantePrevio.mime },
    }, cfg, { silencioso: true });
  }
}

// ─────────────────────────────────────────────────────────────
// COMPROBANTE → reserva pendiente
// ─────────────────────────────────────────────────────────────
async function descargarBase64(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer()).toString('base64');
}

async function procesarComprobante(jid, chat, imagen, cfg, { silencioso = false } = {}) {
  const ec = chat.estado_compra;
  const url = imagen.mensaje.media_url;
  const mime = imagen.mensaje.media_mime || 'image/jpeg';

  // Leer el comprobante con visión (si el proveedor/modelo lo permite)
  let datos = null;
  if (cfg.leer_comprobantes) {
    try { datos = await ia.leerComprobante(cfg, { base64: await descargarBase64(url), mime }); }
    catch (e) { console.warn('⚠️  [Bot] No se pudo leer el comprobante:', e.message); }
  }
  if (datos && datos.es_comprobante === false && !silencioso) {
    await responder(jid, 'Mmm esa imagen no parece un comprobante de pago 🤔\n\n¿Me mandas la captura del pago cuando puedas?', cfg);
    return;
  }
  // Lo que el sistema le pidió pagar queda junto al comprobante para revisarlo en Reservas
  datos = { ...(datos || {}), metodo: ec.metodo || null, monto_esperado: ec.monto?.texto || fmtMonto(ec.total, cfg) };
  if (Number(datos.monto) && ec.monto?.valor && ec.monto.moneda === (/usd|\$/i.test(datos.moneda || '') ? 'USD' : /bs|ves|bol/i.test(datos.moneda || '') ? 'VES' : 'COP')) {
    datos.diferencia = +(Number(datos.monto) - Number(ec.monto.valor)).toFixed(2);
  }
  const metodoPago = ec.metodo || (datos.banco ? `WhatsApp · ${datos.banco}` : 'WhatsApp');

  const client = await pool.connect();
  let r;
  try {
    await client.query('BEGIN');
    // 1) Los números apartados pasan a "pendiente" con la foto del comprobante
    const confirmadas = ec.reservas?.length
      ? await reservas.confirmarApartadoTx(client, ec.reservas, { comprobanteUrl: url, comprobante_datos: datos, metodo_pago: metodoPago })
      : [];
    r = { ok: true, reservas: confirmadas, conflictos: [] };
    // 2) Si el apartado venció (o no existía), se intenta reservar lo que falte
    const yaConfirmados = new Set(confirmadas.map((x) => String(x.numero).trim()));
    const faltan = ec.numeros.filter((n) => !yaConfirmados.has(n));
    if (faltan.length) {
      const r2 = await reservas.crearReservasTx(client, {
        rifa_id: ec.rifa_id, numeros: faltan, nombre_cliente: ec.nombre, cedula: ec.cedula,
        telefono: chat.telefono, metodo_pago: metodoPago,
        comprobanteUrl: url, comprobante_nombre: 'comprobante-whatsapp', comprobante_datos: datos,
        wa_jid: jid, origen: 'whatsapp',
      });
      r.reservas.push(...(r2.reservas || []));
      r.conflictos = r2.conflictos || [];
      if (!r2.ok && !r2.conflictos?.length) r.error = r2.error;
    }
    r.ok = r.reservas.length > 0;
    if (r.ok) await client.query('COMMIT'); else await client.query('ROLLBACK');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('❌ [Bot] Error creando reserva:', e.message);
    await chats.actualizarChat(jid, { necesita_humano: true, motivo_humano: 'Error registrando su comprobante' });
    await responder(jid, 'Recibí tu comprobante 🙌 dame un momento que lo reviso y te confirmo.', cfg);
    return;
  } finally { client.release(); }

  if (!r.ok) {
    const tomados = (r.conflictos || []).map((c) => c.numero);
    await chats.actualizarChat(jid, { estado_compra: { paso: 'comprobante_sin_compra', comprobante: { url, mime, at: Date.now() } } });
    await responder(jid, tomados.length
      ? `Uy, justo mientras tanto se ocuparon ${tomados.length > 1 ? 'los números' : 'el número'} ${tomados.join(', ')} 😕\n\n¿Quieres que te busque otro${tomados.length > 1 ? 's' : ''}? Tu comprobante ya lo tengo guardado.`
      : 'Recibí tu comprobante, pero no pude apartar los números. Ya le aviso a alguien del equipo para que te ayude.', cfg);
    if (!tomados.length) await chats.actualizarChat(jid, { necesita_humano: true, motivo_humano: r.error });
    return;
  }

  const numeros = r.reservas.map((x) => String(x.numero).trim());
  await chats.actualizarChat(jid, {
    estado_compra: {
      paso: 'esperando_confirmacion', rifa_id: ec.rifa_id, rifa_nombre: ec.rifa_nombre,
      numeros, nombre: ec.nombre, total: ec.total, reservas: r.reservas.map((x) => x.id), desde: Date.now(),
    },
  });
  bus.emit('wa:reserva', { jid, numeros, rifa: ec.rifa_nombre, nombre: ec.nombre, total: ec.total });
  await chats.guardarMensaje({
    jid, deMi: true, autor: 'sistema', tipo: 'texto', estado: null,
    texto: `🧾 Reserva creada: ${ec.rifa_nombre} · números ${numeros.join(', ')} · total ${fmtMonto(ec.total, cfg)}${datos?.referencia ? ` · ref ${datos.referencia}` : ''}. Pendiente de aprobar en Reservas.`,
  });

  if (!silencioso) {
    const extra = r.conflictos?.length ? `\n\nOjo: ${r.conflictos.map((c) => c.numero).join(', ')} se ocupó mientras tanto, así que quedó solo con ${numeros.join(', ')}.` : '';
    await responder(jid, `Listo ${ec.nombre.split(' ')[0]}, recibí tu comprobante ✅\n\nApenas verifiquemos el pago te llega tu ticket por aquí.${extra}`, cfg);
  }
}

// ─────────────────────────────────────────────────────────────
// AVISOS DESDE RESERVAS (aprobación / rechazo en el panel)
// ─────────────────────────────────────────────────────────────
async function chatDeReserva(reserva) {
  if (reserva.wa_jid) return chats.obtenerChat(reserva.wa_jid);
  return chats.chatPorTelefono(reserva.telefono);
}

bus.on('reservas:aprobadas', async (lista) => {
  const porChat = new Map();
  for (const rv of lista) {
    const chat = await chatDeReserva(rv).catch(() => null);
    if (!chat) continue;
    const e = porChat.get(chat.jid) || { chat, numeros: [] };
    e.numeros.push(String(rv.numero).trim());
    porChat.set(chat.jid, e);
  }
  for (const { chat, numeros } of porChat.values()) {
    // Vuelve a empezar el ciclo: el cliente puede comprar de nuevo
    if (['esperando_confirmacion', 'esperando_comprobante'].includes(chat.estado_compra?.paso)) {
      await chats.actualizarChat(chat.jid, { estado_compra: null });
    }
    await chats.guardarMensaje({ jid: chat.jid, deMi: true, autor: 'sistema', texto: `✅ Pago aprobado · números ${numeros.join(', ')}` });
  }
});

bus.on('reservas:rechazadas', async (lista) => {
  const cfg = await obtenerConfig();
  const porChat = new Map();
  for (const rv of lista) {
    const chat = await chatDeReserva(rv).catch(() => null);
    if (!chat) continue;
    const e = porChat.get(chat.jid) || { chat, numeros: [], nota: rv.nota_admin, nombre: rv.nombre_cliente, origen: rv.origen };
    e.numeros.push(String(rv.numero).trim());
    porChat.set(chat.jid, e);
  }
  for (const { chat, numeros, nota, nombre, origen } of porChat.values()) {
    await chats.actualizarChat(chat.jid, { estado_compra: null });
    await chats.guardarMensaje({ jid: chat.jid, deMi: true, autor: 'sistema', texto: `❌ Pago rechazado · números ${numeros.join(', ')}${nota ? ` · ${nota}` : ''}` });
    if (origen === 'whatsapp' && cfg.avisar_rechazo && transporte?.conectado()) {
      const primer = String(nombre || '').split(' ')[0];
      await responder(chat.jid,
        `Hola${primer ? ' ' + primer : ''}, no pudimos verificar tu pago de ${numeros.length > 1 ? 'los números' : 'el número'} ${numeros.join(', ')} 😕${nota && !/^auto-rechazado/i.test(nota) ? `\n\n${nota}` : ''}\n\nSi crees que es un error, escríbeme por aquí y lo revisamos.`, cfg).catch(() => {});
    }
  }
});

// ─────────────────────────────────────────────────────────────
// APARTADOS VENCIDOS: si no llegó el comprobante a tiempo se liberan
// los números y se le avisa al cliente (una sola vez, con amabilidad).
// ─────────────────────────────────────────────────────────────
async function revisarApartadosVencidos() {
  const liberadas = await reservas.liberarApartadosVencidos();
  if (!liberadas.length) return;
  const cfg = await obtenerConfig();
  const porChat = new Map();
  for (const rv of liberadas) {
    if (!rv.wa_jid) continue;
    const e = porChat.get(rv.wa_jid) || { numeros: [], nombre: rv.nombre_cliente, ids: [] };
    e.numeros.push(String(rv.numero).trim());
    e.ids.push(rv.id);
    porChat.set(rv.wa_jid, e);
  }
  for (const [jid, { numeros, nombre, ids }] of porChat) {
    const chat = await chats.obtenerChat(jid);
    if (!chat) continue;
    const ec = chat.estado_compra;
    if (ec?.paso === 'esperando_comprobante' && (ec.reservas || []).some((id) => ids.includes(id))) {
      await chats.actualizarChat(jid, { estado_compra: null });
    }
    await chats.guardarMensaje({ jid, deMi: true, autor: 'sistema', texto: `⌛ Apartado vencido sin comprobante · números ${numeros.join(', ')} liberados` });
    if (cfg.activo && chat.bot_activo && transporte?.conectado()) {
      const primer = String(nombre || '').split(' ')[0];
      await responder(jid, `Hola${primer ? ' ' + primer : ''}, como no me llegó el comprobante liberé ${numeros.length > 1 ? 'los números' : 'el número'} ${numeros.join(', ')} 🙏

Si todavía lo quieres, avísame y lo reviso de nuevo.`, cfg).catch(() => {});
    }
  }
}
setInterval(() => revisarApartadosVencidos().catch((e) => console.error('❌ [Bot] Apartados vencidos:', e.message)), 60 * 1000).unref();

// ── Probar el bot desde el panel (no envía nada ni escribe en la BD) ─
// estadoPrevio: el estado de compra de la simulación anterior (lo guarda el panel)
async function probarConversacion(mensajesPrueba, estadoPrevio = null) {
  const cfg = await obtenerConfig({ fresca: true });
  const chatFalso = { jid: 'prueba@panel', nombre: 'Cliente de prueba', telefono: null, estado_compra: estadoPrevio };
  const llamadas = [];
  const efectos = {};
  const ejecutarReal = crearEjecutor(chatFalso.jid, chatFalso, cfg, efectos, { prueba: true });
  const ejecutar = async (nombre, args) => {
    const r = nombre === 'mis_compras' ? { compras: [], nota: 'modo prueba' } : await ejecutarReal(nombre, args);
    llamadas.push({ nombre, args, resultado: r });
    return r;
  };
  const { texto } = await ia.chatConHerramientas(cfg, {
    system: construirSistema(cfg, chatFalso),
    mensajes: mensajesPrueba,
    herramientas: HERRAMIENTAS,
    ejecutar,
    maxPasos: 5,
  });
  const partes = dividir(aFormatoWhatsApp(texto || ''));
  if (efectos.mensajePago) partes.push(efectos.mensajePago);
  return { respuesta: texto, partes, llamadas, estado_compra: chatFalso.estado_compra };
}

module.exports = { init, alRecibir, probarConversacion, revisarApartadosVencidos, HERRAMIENTAS };
