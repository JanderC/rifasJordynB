// ── Protección del login contra fuerza bruta ───────────────
// Cuenta los intentos FALLIDOS por IP y por usuario. Al pasar el límite,
// bloquea temporalmente. Un login exitoso limpia los contadores.
// En memoria: suficiente para una sola instancia (Railway); se reinicia con el servidor.

const VENTANA_MS   = 15 * 60 * 1000; // ventana de conteo
const BLOQUEO_MS   = 15 * 60 * 1000; // tiempo de bloqueo al superar el límite
const MAX_POR_IP   = 10;             // intentos fallidos por IP
const MAX_POR_USER = 5;              // intentos fallidos por usuario (protege la cuenta del dueño)

const intentos = new Map(); // clave -> { fallos, desde, bloqueadoHasta }

const claveIp   = (req) => `ip:${req.ip}`;
const claveUser = (req) => `user:${String(req.body?.usuario || '').trim().toLowerCase()}`;

const bloqueoRestante = (clave) => {
  const reg = intentos.get(clave);
  if (!reg || !reg.bloqueadoHasta) return 0;
  const restante = reg.bloqueadoHasta - Date.now();
  if (restante <= 0) {
    intentos.delete(clave);
    return 0;
  }
  return restante;
};

const sumarFallo = (clave, maximo) => {
  const ahora = Date.now();
  let reg = intentos.get(clave);
  if (!reg || ahora - reg.desde > VENTANA_MS) {
    reg = { fallos: 0, desde: ahora, bloqueadoHasta: 0 };
  }
  reg.fallos += 1;
  if (reg.fallos >= maximo) reg.bloqueadoHasta = ahora + BLOQUEO_MS;
  intentos.set(clave, reg);
};

// Middleware: rechaza con 429 si la IP o el usuario están bloqueados
const verificarBloqueoLogin = (req, res, next) => {
  const restante = Math.max(bloqueoRestante(claveIp(req)), bloqueoRestante(claveUser(req)));
  if (restante > 0) {
    const minutos = Math.ceil(restante / 60000);
    res.set('Retry-After', String(Math.ceil(restante / 1000)));
    return res.status(429).json({
      error: `Demasiados intentos fallidos. Intenta de nuevo en ${minutos} minuto${minutos === 1 ? '' : 's'}.`
    });
  }
  next();
};

const registrarLoginFallido = (req) => {
  sumarFallo(claveIp(req), MAX_POR_IP);
  sumarFallo(claveUser(req), MAX_POR_USER);
  console.warn(`[auth] Login fallido — usuario="${claveUser(req).slice(5)}" ip=${req.ip}`);
};

const registrarLoginExitoso = (req) => {
  intentos.delete(claveIp(req));
  intentos.delete(claveUser(req));
};

// Limpieza periódica para que el mapa no crezca sin control
setInterval(() => {
  const ahora = Date.now();
  for (const [clave, reg] of intentos) {
    const vencido = reg.bloqueadoHasta
      ? reg.bloqueadoHasta <= ahora
      : ahora - reg.desde > VENTANA_MS;
    if (vencido) intentos.delete(clave);
  }
}, 5 * 60 * 1000).unref();

module.exports = { verificarBloqueoLogin, registrarLoginFallido, registrarLoginExitoso };
