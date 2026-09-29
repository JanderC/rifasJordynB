// ============================================================
//  migrar_base64_a_cloudinary.js
//  Extrae las imágenes base64 que quedaron guardadas en la BD,
//  las sube a Cloudinary y reemplaza el valor por la URL.
//
//  Uso:
//    node database/migrar_base64_a_cloudinary.js            → solo reporta (no toca nada)
//    node database/migrar_base64_a_cloudinary.js --ejecutar → sube y actualiza
//
//  Antes de actualizar guarda un respaldo JSON con los valores
//  originales en database/backups/. Se puede correr varias veces:
//  solo procesa lo que siga en base64.
// ============================================================
require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const pool = require('../config/db');
const {
  esDataUrl, subirSiEsBase64, reemplazarBase64EnJson, CARPETAS, TRANSFORM_RIFA,
} = require('../services/imagenes');

const EJECUTAR = process.argv.includes('--ejecutar');

// Comprobantes viejos pueden venir sin el prefijo "data:"
const normalizarComprobante = (v) =>
  esDataUrl(v) || /^https?:\/\//.test(v) ? v : `data:image/jpeg;base64,${v}`;

async function main() {
  const [rifasImg, rifasDesign, plantillas, global, comprobantes] = await Promise.all([
    pool.query(`SELECT id, nombre, imagen_url FROM rifas WHERE imagen_url LIKE 'data:%'`),
    pool.query(`SELECT id, nombre, ticket_design FROM rifas WHERE ticket_design::text LIKE '%data:image%'`),
    pool.query(`SELECT id, nombre, design FROM ticket_templates WHERE design::text LIKE '%data:image%'`),
    pool.query(`SELECT clave, valor FROM config_sistema WHERE clave='ticket_design_global' AND valor::text LIKE '%data:image%'`),
    // Agrupado: el mismo comprobante se repetía en cada número de la reserva
    pool.query(`
      SELECT comprobante_base64, array_agg(id::text) AS ids
      FROM reservas_cliente
      WHERE comprobante_base64 IS NOT NULL AND comprobante_base64 !~ '^https?://'
      GROUP BY comprobante_base64
    `),
  ]);

  const mb = (rows, col) => (rows.reduce((s, r) => s + JSON.stringify(r[col]).length, 0) / 1e6).toFixed(2);
  console.log('\nBase64 encontrado en la BD:');
  console.log(`  rifas.imagen_url             ${rifasImg.rowCount} filas  ${mb(rifasImg.rows, 'imagen_url')} MB`);
  console.log(`  rifas.ticket_design          ${rifasDesign.rowCount} filas  ${mb(rifasDesign.rows, 'ticket_design')} MB`);
  console.log(`  ticket_templates.design      ${plantillas.rowCount} filas  ${mb(plantillas.rows, 'design')} MB`);
  console.log(`  config_sistema (diseño glob) ${global.rowCount} filas  ${mb(global.rows, 'valor')} MB`);
  console.log(`  reservas_cliente.comprobante ${comprobantes.rowCount} comprobantes distintos  ${mb(comprobantes.rows, 'comprobante_base64')} MB`);

  if (!EJECUTAR) {
    console.log('\nModo simulación. Para migrar: node database/migrar_base64_a_cloudinary.js --ejecutar\n');
    return;
  }

  // ── Respaldo de los valores originales ──
  const dirBackup = path.join(__dirname, 'backups');
  fs.mkdirSync(dirBackup, { recursive: true });
  const archivo = path.join(dirBackup, `base64-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(archivo, JSON.stringify({
    rifas_imagen: rifasImg.rows, rifas_ticket_design: rifasDesign.rows,
    ticket_templates: plantillas.rows, config_sistema: global.rows,
    reservas_comprobantes: comprobantes.rows,
  }));
  console.log(`\nRespaldo guardado en ${archivo}`);

  let ok = 0, fallos = 0;
  const paso = async (etiqueta, fn) => {
    try { await fn(); ok++; console.log(`  ✔ ${etiqueta}`); }
    catch (e) { fallos++; console.error(`  ✘ ${etiqueta}: ${e.message}`); }
  };

  console.log('\nMigrando...');
  for (const r of rifasImg.rows) {
    await paso(`rifa "${r.nombre}" imagen`, async () => {
      const url = await subirSiEsBase64(r.imagen_url, { folder: CARPETAS.rifas, transformation: TRANSFORM_RIFA });
      await pool.query(`UPDATE rifas SET imagen_url=$1 WHERE id=$2`, [url, r.id]);
    });
  }
  for (const r of rifasDesign.rows) {
    await paso(`rifa "${r.nombre}" ticket_design`, async () => {
      const d = await reemplazarBase64EnJson(r.ticket_design, { folder: CARPETAS.ticketDesigns });
      await pool.query(`UPDATE rifas SET ticket_design=$1::jsonb WHERE id=$2`, [JSON.stringify(d), r.id]);
    });
  }
  for (const t of plantillas.rows) {
    await paso(`plantilla "${t.nombre}"`, async () => {
      const d = await reemplazarBase64EnJson(t.design, { folder: CARPETAS.ticketDesigns });
      await pool.query(`UPDATE ticket_templates SET design=$1::jsonb WHERE id=$2`, [JSON.stringify(d), t.id]);
    });
  }
  for (const g of global.rows) {
    await paso('diseño global de ticket', async () => {
      const d = await reemplazarBase64EnJson(g.valor, { folder: CARPETAS.ticketDesigns });
      await pool.query(`UPDATE config_sistema SET valor=$1::jsonb WHERE clave=$2`, [JSON.stringify(d), g.clave]);
    });
  }
  for (const c of comprobantes.rows) {
    await paso(`comprobante (${c.ids.length} reservas)`, async () => {
      const url = await subirSiEsBase64(normalizarComprobante(c.comprobante_base64), { folder: CARPETAS.comprobantes });
      await pool.query(`UPDATE reservas_cliente SET comprobante_base64=$1 WHERE id = ANY($2::uuid[])`, [url, c.ids]);
    });
  }

  console.log(`\nListo: ${ok} migrados, ${fallos} con error.`);
  if (fallos) console.log('Los que fallaron siguen en base64; puedes volver a correr el script.');

  // Verificación final
  const quedan = await pool.query(`
    SELECT (SELECT COUNT(*) FROM rifas WHERE imagen_url LIKE 'data:%' OR ticket_design::text LIKE '%data:image%')
         + (SELECT COUNT(*) FROM ticket_templates WHERE design::text LIKE '%data:image%') AS n
  `);
  console.log(`Registros con base64 restantes (rifas + plantillas): ${quedan.rows[0].n}\n`);
}

main()
  .catch(e => { console.error('Error en la migración:', e); process.exitCode = 1; })
  .finally(() => pool.end());
