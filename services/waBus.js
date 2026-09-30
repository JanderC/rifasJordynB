// Bus de eventos en memoria para WhatsApp (chats en tiempo real, avisos al bot)
const EventEmitter = require('events');

const bus = new EventEmitter();
bus.setMaxListeners(100);   // una conexión SSE por pestaña abierta del panel

module.exports = bus;
