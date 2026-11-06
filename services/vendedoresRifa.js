// ============================================================
//  vendedoresRifa.js — Publicidad por ciudad y mensaje a los vendedores
//  Se guardan con la rifa (al crearla o editarla). Cada ciudad tiene tres
//  imágenes: "juega el sábado", "juega mañana" y "juega hoy"; según el día
//  se usa la que toca. Aquí solo se valida y se elige: lo usan rifaOpciones
//  (al guardar) y whatsapp/recordatoriosVendedores (al enviar).
// ============================================================
const MOMENTOS = ['dia', 'manana', 'hoy'];
const DEMAS = '*';   // "todas las demás ciudades"

const esPropia = (url) => {
  try { const u = new URL(String(url)); return u.protocol === 'https:' && u.hostname === 'res.cloudinary.com'; } catch { return false; }
};

function limpiarConfig(c) {
  const dias = [...new Set((Array.isArray(c?.dias) ? c.dias : []).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))].sort();
  const horas = [...new Set((Array.isArray(c?.horas) ? c.horas : []).filter((h) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(h))))].sort().slice(0, 4);
  // fechas: los días exactos del calendario (AAAA-MM-DD). Si hay, mandan sobre "dias" (de la semana, lo de antes)
  const fechas = [...new Set((Array.isArray(c?.fechas) ? c.fechas : []).map(String).filter((f) => /^\d{4}-\d{2}-\d{2}$/.test(f)))].sort().slice(0, 120);
  return { activo: c?.activo === true, fechas, dias, horas, mensaje: String(c?.mensaje || '').trim().slice(0, 1500) };
}

// [{ ubicacion, dia, manana, hoy, precio?, moneda?, premio? }]. Las guardadas antes con una sola
// imagen la usan como "dia". precio/moneda/premio: lo que vale el ticket y lo que se gana EN ESA
// CIUDAD (en Rubio cuesta y paga distinto que en San Cristóbal); sin ellos, los de la rifa.
function limpiarImagenes(lista) {
  const vistas = new Set();
  return (Array.isArray(lista) ? lista : [])
    .map((x) => {
      const fila = { ubicacion: String(x?.ubicacion || '').trim().slice(0, 80) };
      for (const m of MOMENTOS) {
        const url = String(x?.[m] || (m === 'dia' ? x?.imagen : '') || '').trim();
        if (esPropia(url)) fila[m] = url;
      }
      const precio = Number(String(x?.precio ?? '').replace(',', '.'));
      if (precio > 0 && precio < 1e9) {
        fila.precio = Math.round(precio * 100) / 100;
        fila.moneda = x?.moneda === 'USD' ? 'USD' : 'COP';
      }
      const premio = String(x?.premio || '').trim().slice(0, 80);
      if (premio) fila.premio = premio;
      return fila;
    })
    .filter((x) => {
      const k = clave(x.ubicacion);
      if (!x.ubicacion || vistas.has(k) || !(MOMENTOS.some((m) => x[m]) || x.precio || x.premio)) return false;
      vistas.add(k);
      return true;
    });
}

// 'hoy', 'manana' o 'dia' según cuánto falta para el sorteo
function momentoDe(fechaSorteo, hoy) {
  const dias = Math.round((new Date(`${String(fechaSorteo).slice(0, 10)}T12:00:00Z`) - new Date(`${hoy}T12:00:00Z`)) / 86400000);
  return dias <= 0 ? 'hoy' : dias === 1 ? 'manana' : 'dia';
}

// "SAN CRISTOBAL" y "San Cristóbal" son la misma ciudad
const clave = (x) => String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
const mismaCiudad = (a, b) => clave(a) === clave(b);
const igual = mismaCiudad;
const primera = (fila, momento) => fila && (fila[momento] || MOMENTOS.map((m) => fila[m]).find(Boolean));

// La de su ciudad para ese día; si falta, otra de su misma ciudad (trae su precio y su
// premio); luego la de "las demás" y por último la foto de la rifa.
function imagenDe(rifa, ubicacion, momento = 'dia') {
  const lista = rifa.imagenes_ubicacion || [];
  const suya = ubicacion ? lista.find((x) => igual(x.ubicacion, ubicacion)) : null;
  const demas = lista.find((x) => x.ubicacion === DEMAS);
  return (suya && primera(suya, momento)) || primera(demas, momento) || rifa.imagen_url || null;
}

// Precio y premio para un vendedor: los de su ciudad, luego los de "las demás", luego los de la rifa
function condicionesDe(rifa, ubicacion) {
  const lista = rifa.imagenes_ubicacion || [];
  const suya = ubicacion ? lista.find((x) => igual(x.ubicacion, ubicacion)) : null;
  const demas = lista.find((x) => x.ubicacion === DEMAS);
  const conPrecio = [suya, demas].find((f) => f?.precio);
  return {
    precio: conPrecio ? conPrecio.precio : Number(rifa.precio) || 0,
    moneda: conPrecio ? conPrecio.moneda : rifa.moneda,
    premio: [suya, demas].find((f) => f?.premio)?.premio || rifa.premio || '',
  };
}

module.exports = { MOMENTOS, DEMAS, limpiarConfig, limpiarImagenes, momentoDe, imagenDe, condicionesDe, mismaCiudad };
