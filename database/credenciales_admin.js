// ============================================================
//  credenciales_admin.js
//  Cambia el usuario y la contraseña del DUEÑO (acceso administrativo)
//  y revisa que ningún usuario activo siga con una contraseña insegura.
//
//  Las credenciales NUNCA se escriben en el código: se pasan por
//  variables de entorno al ejecutarlo. En la BD solo queda el hash bcrypt.
//
//  Uso (PowerShell):
//    $env:NUEVO_USUARIO="usuario"; $env:NUEVA_PASSWORD="clave"; node database/credenciales_admin.js
//  Uso (bash):
//    NUEVO_USUARIO=usuario NUEVA_PASSWORD=clave node database/credenciales_admin.js
//
//  Si hay más de un dueño activo, indica cuál cambiar con USUARIO_ACTUAL=<usuario>.
//  Solo auditar contraseñas inseguras, sin cambiar nada:
//    node database/credenciales_admin.js --auditar
// ============================================================
require('dotenv').config();
const bcrypt = require('bcryptjs');
const pool = require('../config/db');

// Contraseñas del seed y otras triviales: ningún usuario activo debería tenerlas
const CLAVES_INSEGURAS = [
  'admin123', 'vendedor123', 'admin', '123456', '12345678', '123456789',
  'password', 'contraseña', 'qwerty', 'rifas123', 'jordyn123',
];

const auditarClavesInseguras = async () => {
  const { rows } = await pool.query(
    'SELECT id, usuario, rol, password FROM users WHERE activo = TRUE ORDER BY rol, id'
  );
  const inseguros = [];
  for (const u of rows) {
    for (const clave of CLAVES_INSEGURAS) {
      if (await bcrypt.compare(clave, u.password)) {
        inseguros.push({ id: u.id, usuario: u.usuario, rol: u.rol });
        break;
      }
    }
  }
  if (inseguros.length === 0) {
    console.log('✅ Ningún usuario activo tiene una contraseña insegura conocida.');
  } else {
    console.log('⚠️  Usuarios ACTIVOS con contraseña insegura (cámbiala o desactívalos):');
    console.table(inseguros);
  }
  return inseguros;
};

const cambiarCredencialesDueno = async () => {
  const nuevoUsuario = String(process.env.NUEVO_USUARIO || '').trim().toLowerCase();
  const nuevaPassword = String(process.env.NUEVA_PASSWORD || '');
  const usuarioActual = String(process.env.USUARIO_ACTUAL || '').trim().toLowerCase();

  if (!nuevoUsuario || !nuevaPassword) {
    throw new Error('Faltan NUEVO_USUARIO y/o NUEVA_PASSWORD (ver instrucciones al inicio del archivo)');
  }
  if (!/^[a-z0-9._-]{4,50}$/.test(nuevoUsuario)) {
    throw new Error('El usuario debe tener 4 a 50 caracteres: letras, números, punto, guion o guion bajo');
  }
  if (nuevaPassword.length < 8) {
    throw new Error('La contraseña debe tener al menos 8 caracteres');
  }
  if (CLAVES_INSEGURAS.includes(nuevaPassword.toLowerCase())) {
    throw new Error('Esa contraseña es demasiado común; elige otra');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Elegir el dueño a modificar
    const { rows: duenos } = await client.query(
      `SELECT id, nombre, usuario FROM users WHERE rol = 'dueno' AND activo = TRUE ORDER BY id`
    );
    let dueno;
    if (usuarioActual) {
      dueno = duenos.find(d => d.usuario === usuarioActual);
      if (!dueno) throw new Error(`No hay un dueño activo con usuario "${usuarioActual}"`);
    } else if (duenos.length === 1) {
      dueno = duenos[0];
    } else if (duenos.length === 0) {
      throw new Error('No hay ningún usuario dueño activo');
    } else {
      console.table(duenos.map(({ id, nombre, usuario }) => ({ id, nombre, usuario })));
      throw new Error('Hay varios dueños activos: indica cuál cambiar con USUARIO_ACTUAL=<usuario>');
    }

    // El nuevo usuario no puede pertenecer a otra persona
    const { rows: ocupado } = await client.query(
      'SELECT id FROM users WHERE usuario = $1 AND id <> $2', [nuevoUsuario, dueno.id]
    );
    if (ocupado.length) throw new Error(`El usuario "${nuevoUsuario}" ya lo usa otra cuenta`);

    const hash = await bcrypt.hash(nuevaPassword, 12);
    await client.query('UPDATE users SET usuario = $1, password = $2 WHERE id = $3', [nuevoUsuario, hash, dueno.id]);
    await client.query('COMMIT');

    console.log(`✅ Credenciales del dueño actualizadas (id ${dueno.id}): "${dueno.usuario}" → "${nuevoUsuario}"`);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
};

(async () => {
  try {
    if (!process.argv.includes('--auditar')) await cambiarCredencialesDueno();
    await auditarClavesInseguras();
  } catch (e) {
    console.error('❌', e.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
