// ============================================================
//  metodosPago.js — Fuente única de los datos de pago
//  La usan la pantalla del cliente (GET /api/publico/metodos-pago)
//  y el bot de WhatsApp, para que siempre digan exactamente lo mismo.
//  Las cuentas se guardan en la BD (tabla metodos_pago) y el dueño las
//  edita en el panel (Cuentas bancarias). METODOS_PAGO es la copia en
//  memoria de las cuentas ACTIVAS: se recarga al guardar y cada minuto.
//  Montos: los precios de las rifas están en pesos (COP); Pago Móvil
//  se cobra en Bs y Zelle en USD con las tasas de config_tasas.
// ============================================================
const pool = require('../config/db');

// Cuentas iniciales: con ellas se llena la tabla la primera vez
const INICIALES = {
  'Pago Móvil': {
    icono: '📱', moneda: 'VES', pais: '🇻🇪 Venezuela · Bolívares',
    campos: [
      { label: 'Banco',    valor: 'Banco de Venezuela' },
      { label: 'Teléfono', valor: '04129287210' },
      { label: 'Cédula',   valor: 'V-23542583' },
    ],
  },
  'Nequi': {
    icono: '💜', moneda: 'COP', pais: '🇨🇴 Colombia',
    campos: [
      { label: 'Número Nequi', valor: '3224012780' },
      { label: 'Titular',      valor: 'Carmen Rangel' },
    ],
    nota: '⚠️ Solo de Nequi a Nequi',
  },
  'Bancolombia': {
    icono: '🏦', moneda: 'COP', pais: '🇨🇴 Colombia',
    campos: [
      { label: 'Tipo',          valor: 'Cuenta de Ahorros' },
      { label: 'Nro de cuenta', valor: '08820968591' },
      { label: 'Titular',       valor: 'Jordyn Ramirez' },
    ],
    nota: '⚠️ Solo de Bancolombia a Bancolombia',
  },
  'Zelle': {
    icono: '💙', moneda: 'USD', pais: '🇺🇸 Estados Unidos · USD',
    campos: [
      { label: 'Correo', valor: 'angelespinosag00@gmail.com' },
      { label: 'Nombre', valor: 'Angel Espinosa' },
      { label: 'Mínimo', valor: 'Desde $10 USD' },
    ],
    nota: '⚠️ No colocar descripción ni concepto',
  },
  'Efectivo': {
    icono: '💵', moneda: 'COP', pais: '📍 Presencial',
    campos: [
      { label: 'Contacto', valor: 'Escríbenos por WhatsApp para coordinar' },
    ],
    presencial: true,   // no se puede cerrar por el bot: lo coordina una persona
  },
};

const MONEDAS = ['COP', 'VES', 'USD'];

// Cuentas activas, en el orden del panel. El objeto NO se reemplaza (otros módulos
// guardan la referencia): se vacía y se vuelve a llenar.
const METODOS_PAGO = { ...INICIALES };

const tablaLista = (async () => {
  try {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS metodos_pago (
         id          BIGSERIAL PRIMARY KEY,
         nombre      TEXT NOT NULL UNIQUE,
         icono       TEXT,
         color       VARCHAR(9),                          -- #rrggbb para la tarjeta del cliente (opcional)
         moneda      VARCHAR(3) NOT NULL DEFAULT 'COP',   -- COP | VES | USD: en qué se cobra
         pais        TEXT,
         campos      JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [{ label, valor }]
         nota        TEXT,
         presencial  BOOLEAN NOT NULL DEFAULT FALSE,      -- lo coordina una persona (el bot no cierra la venta)
         activo      BOOLEAN NOT NULL DEFAULT TRUE,
         orden       INTEGER NOT NULL DEFAULT 0,
         updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )`);
    // Logo de la cuenta (opcional): si no hay, se muestra el ícono
    await pool.query(`ALTER TABLE metodos_pago ADD COLUMN IF NOT EXISTS imagen_url TEXT`);
    // Pedir el nombre de quien envía el pago (el titular de la cuenta que paga). Nace activo en Zelle.
    const tenia = await pool.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'metodos_pago' AND column_name = 'pedir_titular'`);
    if (!tenia.rows.length) {
      await pool.query(`ALTER TABLE metodos_pago ADD COLUMN pedir_titular BOOLEAN NOT NULL DEFAULT FALSE`);
      await pool.query(`UPDATE metodos_pago SET pedir_titular = TRUE WHERE nombre ILIKE '%zelle%'`);
    }
    const hay = await pool.query(`SELECT 1 FROM metodos_pago LIMIT 1`);
    if (!hay.rows.length) {
      let orden = 0;
      for (const [nombre, m] of Object.entries(INICIALES)) {
        await pool.query(
          `INSERT INTO metodos_pago (nombre, icono, moneda, pais, campos, nota, presencial, orden)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (nombre) DO NOTHING`,
          [nombre, m.icono, m.moneda, m.pais, JSON.stringify(m.campos), m.nota || null, !!m.presencial, orden++]);
      }
    }
  } catch (e) { console.error('[metodosPago] esquema:', e.message); }
})();

let cargadoAt = 0;
// Recarga METODOS_PAGO desde la BD. Si falla, se queda con lo último que tenía.
async function recargar() {
  await tablaLista;
  try {
    const r = await pool.query(`SELECT * FROM metodos_pago WHERE activo ORDER BY orden, id`);
    for (const k of Object.keys(METODOS_PAGO)) delete METODOS_PAGO[k];
    for (const m of r.rows) {
      METODOS_PAGO[m.nombre] = {
        icono: m.icono || '💳', moneda: m.moneda, pais: m.pais || '',
        campos: Array.isArray(m.campos) ? m.campos : [],
        ...(m.nota ? { nota: m.nota } : {}),
        ...(m.color ? { color: m.color } : {}),
        ...(m.imagen_url ? { imagen: m.imagen_url } : {}),
        ...(m.presencial ? { presencial: true } : {}),
        ...(m.pedir_titular ? { pedir_titular: true } : {}),
      };
    }
    cargadoAt = Date.now();
  } catch (e) { console.error('[metodosPago] recargar:', e.message); }
  return METODOS_PAGO;
}
// Para las rutas: datos frescos sin consultar la BD en cada petición
async function metodosActivos() {
  if (Date.now() - cargadoAt > 30000) await recargar();
  return METODOS_PAGO;
}
recargar();
setInterval(() => recargar(), 60 * 1000).unref();

async function obtenerTasas() {
  const r = await pool.query(`SELECT clave, valor FROM config_tasas WHERE clave IN ('COP_POR_USD','BSD_POR_USD')`);
  const t = Object.fromEntries(r.rows.map((x) => [x.clave, parseFloat(x.valor)]));
  return { copUsd: t.COP_POR_USD || 4200, bsdUsd: t.BSD_POR_USD || 0 };
}

// Monto en la moneda del método, igual que calcularPrecioMetodo de la pantalla del cliente
function montoEnMetodo(totalCOP, metodo, tasas) {
  const m = METODOS_PAGO[metodo];
  const fmtCOP = (n) => `${Math.round(n).toLocaleString('es-CO')} pesos`;
  if (!m || m.moneda === 'COP') return { moneda: 'COP', valor: totalCOP, texto: fmtCOP(totalCOP) };
  const usd = totalCOP / tasas.copUsd;
  if (m.moneda === 'USD') return { moneda: 'USD', valor: +usd.toFixed(2), texto: `$${usd.toFixed(2)} USD` };
  if (!tasas.bsdUsd) return { moneda: 'COP', valor: totalCOP, texto: fmtCOP(totalCOP), sinTasa: true };
  const bs = usd * tasas.bsdUsd;
  return {
    moneda: 'VES', valor: +bs.toFixed(2),
    texto: `Bs. ${bs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
  };
}

// Normaliza lo que diga el cliente o la IA ("pago movil", "zelle"…) al nombre oficial
const plano = (txt) => String(txt || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
// Formas comunes de decir cada moneda, por si no nombran la cuenta
const ALIAS = [
  [/movil|pagomovil|bolivar|\bbs\b|venezuela/, (n, m) => /movil/.test(n) || m.moneda === 'VES'],
  [/zelle|dolar|usd/, (n, m) => /zelle/.test(n) || m.moneda === 'USD'],
  [/efectivo|cash|presencial/, (n, m) => /efectivo/.test(n) || m.presencial],
];
function normalizarMetodo(txt) {
  const t = plano(txt);
  if (!t) return null;
  const nombres = Object.keys(METODOS_PAGO);
  // 1) Por el nombre de la cuenta (exacto o contenido), el más largo primero
  const exacto = nombres.find((n) => plano(n) === t);
  if (exacto) return exacto;
  const contenido = [...nombres].sort((a, b) => b.length - a.length)
    .find((n) => t.includes(plano(n)) || t.replace(/ /g, '').includes(plano(n).replace(/ /g, '')));
  if (contenido) return contenido;
  // 2) Por alias, solo si esa cuenta existe y está activa
  for (const [re, coincide] of ALIAS) {
    if (!re.test(t)) continue;
    const n = nombres.find((x) => coincide(plano(x), METODOS_PAGO[x]));
    if (n) return n;
  }
  return null;
}

// ¿Ese método pide el nombre de quien envía el pago?
const pideTitular = (metodo) => !!METODOS_PAGO[metodo]?.pedir_titular;

// Mensaje exacto con los datos y el monto (lo envía el sistema, no la IA)
function mensajeDePago(metodo, monto, { numeros, rifa }) {
  const m = METODOS_PAGO[metodo];
  const lineas = m.campos.map((c) => `${c.label}: ${c.valor}`).join('\n');
  return `${m.icono} *${metodo}*\n${lineas}${m.nota ? `\n${m.nota}` : ''}\n\n` +
    `💰 Monto a pagar: *${monto.texto}*\n🎟️ ${rifa} · ${numeros.length > 1 ? 'números' : 'número'} ${numeros.join(', ')}\n\n` +
    '📸 Cuando pagues, envíame la captura del comprobante por aquí.';
}

module.exports = { METODOS_PAGO, MONEDAS, tablaLista, recargar, metodosActivos, obtenerTasas, montoEnMetodo, normalizarMetodo, mensajeDePago, pideTitular };
