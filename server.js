require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { vendedoresRouter, categoriasGlobalesRouter } = require('./routes/vendedores');

const app = express();
const PORT = process.env.PORT || 5000;

// ── Middlewares globales ───────────────────────────────────
app.use(
  cors({
    origin: process.env.FRONTEND_URL || "https://rifas-jordyn-f.vercel.app",
    credentials: true,
  }),
);
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// ── Logger de requests (desarrollo) ───────────────────────
if (process.env.NODE_ENV === "development") {
  app.use((req, res, next) => {
    console.log(
      `[${new Date().toLocaleTimeString()}] ${req.method} ${req.path}`,
    );
    next();
  });
}

// ── Rutas de la API ────────────────────────────────────────
app.use("/api/auth",               require("./routes/auth"));
app.use("/api/rifas",              require("./routes/rifas"));
app.use("/api/numeros",            require("./routes/numeros"));   // numeros.js existente (vender, verificar)
app.use("/api/vendedores",         vendedoresRouter);
app.use("/api/reportes",           require("./routes/reportes"));
app.use("/api/caja",               require("./routes/caja"));
app.use("/api/publico",            require("./routes/Publico"));
app.use("/api/tasas",              require("./routes/tasas"));
app.use("/api/ticket-design",      require("./routes/ticketDesign"));
app.use("/api/ticket-templates",   require("./routes/ticketTemplates"));
app.use("/api/categorias-globales", categoriasGlobalesRouter);
app.use("api/ticket-templates", require("./routes/ticketTemplates"));
app.use("/api/upload", require("./routes/upload"));

// ── WhatsApp Business ──────────────────────────────────────
// IMPORTANTE: el webhook de Meta (GET verificación) debe estar
// ANTES de express.json() o al menos aceptar raw body.
// Como ya tenemos express.json() global arriba, funciona porque
// Meta envía JSON en el POST y text/plain en el GET.
app.use("/api/whatsapp",            require("./routes/wa-webhook"));
app.use("/api/whatsapp/config",     require("./routes/wa-config"));
app.use("/api/whatsapp/media",      require("./routes/wa-media"));
app.use("/api/whatsapp/plantillas", require("./routes/wa-plantillas"));
app.use("/api/whatsapp/flujo",      require("./routes/wa-flujo"));
// ── Health check ───────────────────────────────────────────
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    app: "🎰 RIFAS JORDYN",
    version: "2.0.0",
    timestamp: new Date().toISOString(),
  });
});

// ── Rutas no encontradas ───────────────────────────────────
app.use((req, res) => {
  res
    .status(404)
    .json({ error: `Ruta no encontrada: ${req.method} ${req.path}` });
});

// ── Error global ───────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error("Error no manejado:", err);
  res.status(500).json({ error: "Error interno del servidor" });
});

// ── Iniciar servidor ───────────────────────────────────────
app.listen(PORT, () => {
  console.log("");
  console.log("🎰  ══════════════════════════════════════");
  console.log("🎰       RIFAS JORDYN v2.0 — Backend     ");
  console.log("🎰  ══════════════════════════════════════");
  console.log(`🚀  http://localhost:${PORT}`);
  console.log(`📡  Entorno: ${process.env.NODE_ENV || "development"}`);
  console.log("");
  console.log("📋  Endpoints:");
  console.log(`    POST   /api/auth/login`);
  console.log(`    GET    /api/rifas`);
  console.log(`    GET    /api/numeros/verificar/:numero`);
  console.log(`    POST   /api/numeros/vender`);
  console.log(`    GET    /api/vendedores`);
  console.log(`    GET    /api/vendedores/:id`);
  console.log(`    GET    /api/categorias-globales`);
  console.log(`    POST   /api/categorias-globales`);
  console.log(`    POST   /api/categorias-globales/:id/vendedores/:vid/numeros`);
  console.log(`    POST   /api/categorias-globales/:id/vendedores/:vid/asignar`);
  console.log(`    GET    /api/reportes/dashboard`);
  console.log(`    GET    /api/publico/rifas              (público)`);
  console.log(`    POST   /api/publico/reservar           (público)`);
  console.log(`    GET    /api/whatsapp/webhook          (Meta verificación)`);
  console.log(`    POST   /api/whatsapp/webhook          (Meta mensajes)`);
  console.log(`    GET/POST /api/whatsapp/config         (Credenciales)`);
  console.log(`    GET/POST /api/whatsapp/plantillas     (Plantillas bot)`);
  console.log(`    GET/POST /api/whatsapp/flujo          (Guión bot)`);
  console.log("🎰  ══════════════════════════════════════");
});

module.exports = app;