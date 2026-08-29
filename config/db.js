const { Pool } = require('pg');
require('dotenv').config();
//conexión a la db 

const pool = new Pool({
  host: process.env.DB_HOST || '200.40.68.122',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'respaldo7',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'p4ng34t3ch',
});

// Test de conexión
pool.connect((err, client, release) => {
  if (err) {
    console.error('❌ Error conectando a PostgreSQL:', err.message);
  } else {
    console.log('✅ Conectado a PostgreSQL - Base de datos: rifas_jordyn');
    release();
  }
});

module.exports = pool;