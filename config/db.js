const { Pool } = require('pg');
require('dotenv').config();

// ── Conexión a la base de datos (pool de conexiones) ────────
// Si existe DATABASE_URL (Railway la entrega al enlazar el Postgres del
// proyecto) se usa esa; si no, las variables sueltas DB_HOST, DB_NAME, etc.
// Dentro de Railway la conexión va por la red privada, sin SSL. Para una
// conexión pública con SSL: DATABASE_SSL=true.
const conexion = process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL }
  : {
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT) || 5432,
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
    };

const pool = new Pool({
  ...conexion,
  ...(process.env.DATABASE_SSL === 'true' ? { ssl: { rejectUnauthorized: false } } : {}),
  max: Number(process.env.DB_POOL_MAX) || 15,   // conexiones abiertas a la vez como máximo
  idleTimeoutMillis: 30000,                     // una conexión sin uso se cierra a los 30 s
  connectionTimeoutMillis: 10000,               // si no hay conexión libre en 10 s, falla con error claro
  keepAlive: true,                              // evita que la red corte conexiones inactivas
});

// Una conexión inactiva puede caerse (reinicio de la base, corte de red): se
// registra y el pool abre otra sola. Sin este manejador el proceso se cae.
pool.on('error', (err) => {
  console.error('⚠️  [DB] Conexión inactiva perdida (el pool se recupera solo):', err.message);
});

// Test de conexión
pool.connect((err, client, release) => {
  if (err) {
    console.error('❌ Error conectando a PostgreSQL:', err.message);
  } else {
    client.query('SELECT current_database() AS db', (e, r) => {
      release();
      console.log(`✅ Conectado a PostgreSQL - Base de datos: ${e ? '?' : r.rows[0].db}`);
    });
  }
});

module.exports = pool;
