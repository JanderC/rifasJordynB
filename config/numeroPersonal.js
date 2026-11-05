// ============================================================
//  config/numeroPersonal.js — El número personal de Jordyn
//
//  AQUÍ se cambia:
//   • NUMERO     — el único número que se puede vincular (código de país + número, sin + ni espacios)
//   • VISIBLE    — cómo se muestra en pantalla
//   • TERMINOS   — el texto que el dueño acepta antes de vincular
//   • AVISO      — el aviso de riesgo que va con los términos
//  El panel lo lee de aquí (GET /api/numero-personal), así que no hay que tocar el frontend.
// ============================================================

const NUMERO = '584129287210';
const VISIBLE = '+58 412-9287210';

const TERMINOS = [
  `El número ${VISIBLE} queda vinculado como dispositivo autorizado al sistema Resuelve tu Semana para enviar recordatorios de pago a sus clientes.`,
  'Los mensajes salen por la conexión cifrada de extremo a extremo de WhatsApp y respetan límites de envío para proteger la cuenta.',
  'El sistema solo envía: no lee, no guarda y no muestra sus conversaciones personales.',
  'Solo este número puede vincularse a este módulo. El titular puede desvincularlo en cualquier momento desde su teléfono (WhatsApp → Dispositivos vinculados) o desde este panel.',
];

const AVISO = 'Usar un número personal para envíos automáticos tiene algo de riesgo de que WhatsApp restrinja la cuenta. La cola anti-bloqueo de Resuelve tu Semana lo reduce, pero no lo elimina.';

module.exports = { NUMERO, VISIBLE, TERMINOS, AVISO };
