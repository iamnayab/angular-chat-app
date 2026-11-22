require("dotenv").config();
const express = require("express");
const http = require("http");
const path = require("path");
const cors = require("cors");
const fs = require("fs");

const { initDatabase } = require("./database/database");
const { setupSocketIO } = require("./socket");
const { router: apiRouter } = require("./routes/api.routes");

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());

// Serve static build from Angular (if built)
const possibleStaticPaths = [
  path.join(__dirname, "../public"),
  path.join(__dirname, "../../frontend/dist/frontend/browser"),
  path.join(__dirname, "../../frontend/dist/frontend"),
  path.join(__dirname, "../dist")
];

let staticServed = false;
for (const p of possibleStaticPaths) {
  if (fs.existsSync(p)) {
    console.log(`📂 Serving static frontend assets from: ${p}`);
    app.use(express.static(p, {
      setHeaders(res) {
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Referrer-Policy", "no-referrer");
        res.setHeader("X-Frame-Options", "DENY");
      }
    }));
    staticServed = true;
    break;
  }
}

if (!staticServed) {
  console.warn("⚠️ [Static Assets] No compiled Angular frontend found in static paths. UI will not be served until the frontend is built!");
}

// Attach Socket.IO
setupSocketIO(server);

// --- ALL REST API ROUTES (Centralized in routes/api.routes.js) ---
app.use("/api", apiRouter);

// SPA fallback for Angular routing
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/") || req.path.startsWith("/socket.io/")) {
    return next();
  }
  for (const p of possibleStaticPaths) {
    const indexPath = path.join(p, "index.html");
    if (fs.existsSync(indexPath)) {
      return res.sendFile(indexPath);
    }
  }
  res.status(503).send(`
    <!DOCTYPE html>
    <html lang="en">
    <head><meta charset="UTF-8"><title>Frontend Build Missing</title></head>
    <body style="font-family: system-ui, sans-serif; background: #0b0f19; color: #e2e8f0; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0;">
      <div style="background: #1e293b; border: 1px solid #334155; padding: 2.5rem; border-radius: 12px; max-width: 500px; text-align: center; box-shadow: 0 10px 25px rgba(0,0,0,0.5);">
        <h2 style="color: #f43f5e; margin-top: 0;">⚠️ Frontend Not Built Yet</h2>
        <p style="color: #94a3b8; font-size: 0.95rem; line-height: 1.5;">The Node.js backend is running, but the Angular frontend assets were not found on this server.</p>
        <div style="background: #0f172a; padding: 1rem; border-radius: 8px; font-family: monospace; font-size: 0.85rem; color: #38bdf8; margin: 1.5rem 0; text-align: left;">
          Render Build Command: npm run build<br>
          Render Start Command: npm start
        </div>
        <p style="font-size: 0.8rem; color: #64748b; margin-bottom: 0;">Please trigger a manual deploy with cache cleared on Render after updating the Build Command.</p>
      </div>
    </body>
    </html>
  `);
});

const PORT = process.env.PORT || 3000;

if (require.main === module) {
  initDatabase().then(() => {
    server.listen(PORT, () => {
      console.log(`\n======================================================`);
      console.log(`🚀 Migrated Backend running on http://localhost:${PORT}`);
      console.log(`🔒 Dedicated Two-Person Encrypted Space (Harry & Elira)`);
      console.log(`⚡ Clean Architecture: Express REST + Separate Socket.IO`);
      console.log(`💾 PostgreSQL & Local JSON fallback ready`);
      console.log(`======================================================\n`);
    });
  });
}

module.exports = { app, server };
