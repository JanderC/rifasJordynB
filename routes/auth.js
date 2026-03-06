const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const { authMiddleware, soloDueno } = require('../middleware/auth');

// ── POST /api/auth/login ───────────────────────────────────
router.post('/login', async (req, res) => {
  const { usuario, password } = req.body;

  if (!usuario || !password) {
    return res.status(400).json({ error: 'Usuario y contraseña son requeridos' });
  }

  try {
    const result = await pool.query(
      'SELECT * FROM users WHERE usuario = $1 AND activo = TRUE',
      [usuario.trim().toLowerCase()]
    );

    if (!result.rows[0]) {
      return res.status(401).json({ error: 'Credenciales incorrectas' });
    }

    const user = result.rows[0];
    const passwordValida = await bcrypt.compare(password, user.password);

    if (!passwordValida) {
      return res.status(401).json({ error: 'Credenciales incorrectas' });
    }

    const token = jwt.sign(
      { id: user.id, rol: user.rol },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '24h' }
    );

    res.json({
      token,
      user: {
        id: user.id,
        nombre: user.nombre,
        usuario: user.usuario,
        rol: user.rol
      }
    });
  } catch (err) {
    console.error('Error en login:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ── GET /api/auth/me ───────────────────────────────────────
router.get('/me', authMiddleware, (req, res) => {
  res.json({ user: req.user });
});

// ── POST /api/auth/register (solo dueño) ──────────────────
router.post('/register', authMiddleware, soloDueno, async (req, res) => {
  const { nombre, usuario, password, rol } = req.body;

  if (!nombre || !usuario || !password || !rol) {
    return res.status(400).json({ error: 'Todos los campos son requeridos' });
  }

  if (!['vendedor', 'dueno'].includes(rol)) {
    return res.status(400).json({ error: 'Rol inválido. Debe ser: vendedor o dueno' });
  }

  if (password.length < 6) {
    return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
  }

  try {
    const existe = await pool.query('SELECT id FROM users WHERE usuario = $1', [usuario.trim().toLowerCase()]);
    if (existe.rows[0]) {
      return res.status(409).json({ error: 'El nombre de usuario ya está en uso' });
    }

    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO users (nombre, usuario, password, rol)
       VALUES ($1, $2, $3, $4)
       RETURNING id, nombre, usuario, rol, activo, created_at`,
      [nombre.trim(), usuario.trim().toLowerCase(), hash, rol]
    );

    res.status(201).json({ message: 'Usuario creado exitosamente', user: result.rows[0] });
  } catch (err) {
    console.error('Error en registro:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ── PUT /api/auth/change-password ─────────────────────────
router.put('/change-password', authMiddleware, async (req, res) => {
  const { password_actual, password_nueva } = req.body;

  if (!password_actual || !password_nueva) {
    return res.status(400).json({ error: 'Ambas contraseñas son requeridas' });
  }

  if (password_nueva.length < 6) {
    return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 6 caracteres' });
  }

  try {
    const result = await pool.query('SELECT password FROM users WHERE id = $1', [req.user.id]);
    const valida = await bcrypt.compare(password_actual, result.rows[0].password);

    if (!valida) {
      return res.status(401).json({ error: 'Contraseña actual incorrecta' });
    }

    const hash = await bcrypt.hash(password_nueva, 10);
    await pool.query('UPDATE users SET password = $1 WHERE id = $2', [hash, req.user.id]);

    res.json({ message: 'Contraseña actualizada exitosamente' });
  } catch (err) {
    console.error('Error cambiando contraseña:', err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

module.exports = router;