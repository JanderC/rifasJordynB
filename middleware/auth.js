const jwt = require('jsonwebtoken');
const pool = require('../config/db');

// ── Verificar token JWT ────────────────────────────────────
const authMiddleware = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Token no proporcionado' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Verificar que el usuario sigue activo en BD
    const result = await pool.query(
      'SELECT id, nombre, usuario, rol, activo FROM users WHERE id = $1',
      [decoded.id]
    );

    if (!result.rows[0] || !result.rows[0].activo) {
      return res.status(401).json({ error: 'Usuario no encontrado o inactivo' });
    }

    req.user = result.rows[0];
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expirado, inicia sesión nuevamente' });
    }
    return res.status(401).json({ error: 'Token inválido' });
  }
};

// ── Solo dueños ────────────────────────────────────────────
const soloDueno = (req, res, next) => {
  if (req.user.rol !== 'dueno') {
    return res.status(403).json({ error: 'Acceso restringido: solo el dueño puede realizar esta acción' });
  }
  next();
};

// ── Dueño o vendedor autenticado ───────────────────────────
const authVendedor = (req, res, next) => {
  if (!['dueno', 'vendedor'].includes(req.user.rol)) {
    return res.status(403).json({ error: 'Acceso no autorizado' });
  }
  next();
};

module.exports = { authMiddleware, soloDueno, authVendedor };