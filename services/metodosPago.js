// ============================================================
//  metodosPago.js — Fuente única de los datos de pago
//  La usan la pantalla del cliente (GET /api/publico/metodos-pago)
//  y el bot de WhatsApp, para que siempre digan exactamente lo mismo.
//  Montos: los precios de las rifas están en pesos (COP); Pago Móvil
//  se cobra en Bs y Zelle en USD con las tasas de config_tasas.
// ============================================================
const pool = require('../config/db');

const METODOS_PAGO = {
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
function normalizarMetodo(txt) {
  const t = String(txt || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (/movil|pagomovil|bolivar|\bbs\b|venezuela/.test(t)) return 'Pago Móvil';
  if (/nequi/.test(t)) return 'Nequi';
  if (/bancolombia/.test(t)) return 'Bancolombia';
  if (/zelle|dolar|usd/.test(t)) return 'Zelle';
  if (/efectivo|cash|presencial/.test(t)) return 'Efectivo';
  return null;
}

// Mensaje exacto con los datos y el monto (lo envía el sistema, no la IA)
function mensajeDePago(metodo, monto, { numeros, rifa }) {
  const m = METODOS_PAGO[metodo];
  const lineas = m.campos.map((c) => `${c.label}: ${c.valor}`).join('\n');
  return `${m.icono} *${metodo}*\n${lineas}${m.nota ? `\n${m.nota}` : ''}\n\n` +
    `💰 Monto a pagar: *${monto.texto}*\n🎟️ ${rifa} · ${numeros.length > 1 ? 'números' : 'número'} ${numeros.join(', ')}\n\n` +
    '📸 Cuando pagues, envíame la captura del comprobante por aquí.';
}

module.exports = { METODOS_PAGO, obtenerTasas, montoEnMetodo, normalizarMetodo, mensajeDePago };
