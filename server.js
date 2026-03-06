require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 5000;

// ── Middlewares globales ───────────────────────────────────
app.use(cors({
  origin: process.env.FRONTEND_URL || 'https://rifas-jordyn-f.vercel.app',
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Logger de requests (desarrollo) ───────────────────────
if (process.env.NODE_ENV === 'development') {
  app.use((req, res, next) => {
    console.log(`[${new Date().toLocaleTimeString()}] ${req.method} ${req.path}`);
    next();
  });
}

// ── Rutas de la API ────────────────────────────────────────
app.use('/api/auth',       require('./routes/auth'));
app.use('/api/rifas',      require('./routes/rifas'));
app.use('/api/numeros',    require('./routes/numeros'));
app.use('/api/vendedores', require('./routes/vendedores'));
app.use('/api/reportes',   require('./routes/reportes'));
app.use('/api/caja',       require('./routes/caja'));

// ── Health check ───────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    app: '🎰 RIFAS JORDYN',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

// ── Manejo de rutas no encontradas ────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Ruta no encontrada: ${req.method} ${req.path}` });
});

// ── Manejo global de errores ───────────────────────────────
app.use((err, req, res, next) => {
  console.error('Error no manejado:', err);
  res.status(500).json({ error: 'Error interno del servidor' });
});

// ── Iniciar servidor ───────────────────────────────────────
app.listen(PORT, () => {
  console.log('');
  console.log('🎰  ══════════════════════════════════════');
  console.log('🎰       RIFAS JORDYN - Backend           ');
  console.log('🎰  ══════════════════════════════════════');
  console.log(`🚀  Servidor corriendo en: http://localhost:${PORT}`);
  console.log(`📡  Entorno: ${process.env.NODE_ENV || 'development'}`);
  console.log('');
  console.log('📋  Endpoints disponibles:');
  console.log(`    POST   /api/auth/login`);
  console.log(`    GET    /api/rifas`);
  console.log(`    GET    /api/numeros/verificar/:numero`);
  console.log(`    POST   /api/numeros/vender`);
  console.log(`    GET    /api/reportes/dashboard`);
  console.log('🎰  ══════════════════════════════════════');
  console.log('');
});

module.exports = app;