// ============================================================
//   RIFAS JORDYN - Seed inicial
//   Crea el usuario dueño y 2 rifas de ejemplo
//   Ejecutar: node database/seed.js
// ============================================================

require('dotenv').config();
const pool = require('../config/db');
const bcrypt = require('bcryptjs');

async function seed() {
  const client = await pool.connect();

  try {
    console.log('🌱 Iniciando seed de RIFAS JORDYN...\n');

    await client.query('BEGIN');

    // ── 1. Crear usuario DUEÑO ──────────────────────────────
    const passwordDueno = await bcrypt.hash('admin123', 10);
    const dueno = await client.query(
      `INSERT INTO users (nombre, usuario, password, rol)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (usuario) DO UPDATE SET nombre = EXCLUDED.nombre
       RETURNING id, usuario`,
      ['Jordyn Admin', 'admin', passwordDueno, 'dueno']
    );
    console.log(`✅ Dueño creado: usuario=admin | password=admin123`);

    // ── 2. Crear 2 Rifas ───────────────────────────────────
    const rifa1 = await client.query(
      `INSERT INTO rifas (nombre, descripcion, premio, precio, fecha_sorteo, loteria_ref, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT DO NOTHING
       RETURNING id, nombre`,
      [
        'RIFA JORDYN #1',
        'Primera rifa del sistema JORDYN',
        'Premio Principal - Rifa 1',
        10000,
        '2024-12-31',
        'Lotería de Bogotá',
        dueno.rows[0].id
      ]
    );

    const rifa2 = await client.query(
      `INSERT INTO rifas (nombre, descripcion, premio, precio, fecha_sorteo, loteria_ref, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT DO NOTHING
       RETURNING id, nombre`,
      [
        'RIFA JORDYN #2',
        'Segunda rifa del sistema JORDYN',
        'Premio Principal - Rifa 2',
        15000,
        '2024-12-31',
        'Lotería del Meta',
        dueno.rows[0].id
      ]
    );

    console.log(`✅ Rifa 1 creada: ${rifa1.rows[0]?.nombre || 'ya existía'}`);
    console.log(`✅ Rifa 2 creada: ${rifa2.rows[0]?.nombre || 'ya existía'}`);

    // ── 3. Crear 2 vendedores de ejemplo ──────────────────
    const passVendedor = await bcrypt.hash('vendedor123', 10);

    const v1 = await client.query(
      `INSERT INTO users (nombre, usuario, password, rol)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (usuario) DO NOTHING
       RETURNING id, usuario`,
      ['Carlos Vendedor', 'carlos', passVendedor, 'vendedor']
    );

    const v2 = await client.query(
      `INSERT INTO users (nombre, usuario, password, rol)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (usuario) DO NOTHING
       RETURNING id, usuario`,
      ['María Vendedor', 'maria', passVendedor, 'vendedor']
    );

    console.log(`✅ Vendedor 1: usuario=carlos | password=vendedor123`);
    console.log(`✅ Vendedor 2: usuario=maria  | password=vendedor123`);

    await client.query('COMMIT');

    console.log('\n🎉 Seed completado exitosamente!');
    console.log('─────────────────────────────────');
    console.log('📋 CREDENCIALES DE ACCESO:');
    console.log('   Dueño:     admin / admin123');
    console.log('   Vendedor:  carlos / vendedor123');
    console.log('   Vendedor:  maria / vendedor123');
    console.log('─────────────────────────────────\n');

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Error en seed:', err.message);
  } finally {
    client.release();
    process.exit(0);
  }
}

seed();