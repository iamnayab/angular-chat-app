require("dotenv").config();
const express = require("express");
const http = require("http");
const path = require("path");
const cors = require("cors");
const fs = require("fs");

const { initDatabase, getRoomMessages, getDatabaseStatus, saveFcmToken } = require("./database/database");
const { setupSocketIO, getRoomMembers, getIO } = require("./socket");
const { sendPushNotification } = require("./services/fcmService");
const { checkRateLimit, verifyRoomCredentials, EXPECTED_ROOM_HASH } = require("./utils/security");

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

// Attach Socket.IO separately
const io = setupSocketIO(server);

// --- DIAGNOSTIC ENDPOINTS ---

app.get("/api/status", (req, res) => {
  const roomMembers = getRoomMembers();
  res.json({
    status: "ok",
    connectedUsers: roomMembers.size,
    roles: Array.from(roomMembers.keys()),
    timestamp: Date.now()
  });
});

app.get("/api/db-status", async (req, res) => {
  const dbStatus = getDatabaseStatus();
  const roomMembers = getRoomMembers();
  let totalCount = 0;
  try {
    const msgs = await getRoomMessages("0202", 1000);
    totalCount = msgs.length;
  } catch (e) {}

  res.json({
    activeDatabase: dbStatus.usePostgres ? "PostgreSQL (Render Cloud)" : "Local JSON File Fallback",
    hasDatabaseUrlConfigured: dbStatus.hasDatabaseUrl,
    usePostgres: dbStatus.usePostgres,
    lastDbError: dbStatus.lastDbError || null,
    totalMessagesInRoom0202: totalCount,
    connectedRoles: Array.from(roomMembers.keys()),
    timestamp: Date.now()
  });
});

// --- FCM REST API ENDPOINTS ---

// Register device FCM token
app.post("/api/fcm/register", async (req, res) => {
  try {
    const { roomId, roomPassword, role, token } = req.body || {};
    const targetRoomId = String(roomId || "0202").trim();
    const cleanRole = String(role || "").trim().toLowerCase();

    if (cleanRole !== "he" && cleanRole !== "she") {
      return res.status(400).json({ ok: false, error: "Role must be 'he' or 'she'." });
    }
    if (!token || typeof token !== "string" || token.length < 10) {
      return res.status(400).json({ ok: false, error: "Valid FCM registration token is required." });
    }

    if (!verifyRoomCredentials(targetRoomId, roomPassword)) {
      return res.status(401).json({ ok: false, error: "Invalid Room ID or Password. Access denied." });
    }

    await saveFcmToken(targetRoomId, cleanRole, token);
    console.log(`✅ [FCM API] Registered token for ${cleanRole.toUpperCase()} in room "${targetRoomId}".`);

    res.json({
      ok: true,
      message: `Token registered for ${cleanRole === "he" ? "Harry" : "Elira"}.`,
      role: cleanRole,
      roomId: targetRoomId
    });
  } catch (err) {
    console.error("❌ /api/fcm/register error:", err.message);
    res.status(500).json({ ok: false, error: "Server error registering device token." });
  }
});

// Test push notification endpoint
app.post("/api/fcm/test", async (req, res) => {
  try {
    const { roomId, roomPassword, role, type = "message" } = req.body || {};
    const targetRoomId = String(roomId || "0202").trim();
    const targetRole = String(role || "").trim().toLowerCase();

    if (!verifyRoomCredentials(targetRoomId, roomPassword)) {
      return res.status(401).json({ ok: false, error: "Access denied." });
    }

    const senderRole = targetRole === "he" ? "she" : "he";
    const senderName = senderRole === "he" ? "Harry" : "Elira";
    const isRing = (type === "ring");

    const result = await sendPushNotification({
      targetRole,
      roomId: targetRoomId,
      type: isRing ? "ring" : "message",
      senderName,
      senderRole,
      title: isRing ? `🔔 Test Ring from ${senderName}` : `Test Message from ${senderName}`,
      body: isRing ? "Testing incoming ring on your Android phone!" : "Push notifications are working properly!"
    });

    res.json({ ok: result.ok, result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Manual Ring HTTP endpoint
app.post("/api/ring", async (req, res) => {
  try {
    const { roomId, roomPassword, senderRole } = req.body || {};
    const targetRoomId = String(roomId || "0202").trim();
    const role = String(senderRole || "").trim().toLowerCase();

    if (role !== "he" && role !== "she") {
      return res.status(400).json({ ok: false, error: "senderRole must be 'he' or 'she'." });
    }

    if (!verifyRoomCredentials(targetRoomId, roomPassword)) {
      return res.status(401).json({ ok: false, error: "Access denied." });
    }

    const rateLimitCheck = checkRateLimit(`ring:${role}`, 1, 15000);
    if (!rateLimitCheck.allowed) {
      return res.status(429).json({ ok: false, error: `Please wait ${rateLimitCheck.retryAfterSeconds}s before ringing again.` });
    }

    const senderName = role === "he" ? "Harry" : "Elira";
    const partnerRole = role === "he" ? "she" : "he";
    const partnerName = role === "he" ? "Elira" : "Harry";

    io.to(targetRoomId).emit("incoming-ring", {
      fromRole: role,
      fromName: senderName,
      timestamp: Date.now()
    });

    const pushResult = await sendPushNotification({
      targetRole: partnerRole,
      roomId: targetRoomId,
      type: "ring",
      senderName,
      senderRole: role,
      title: `🔔 Incoming Ring from ${senderName}`,
      body: `${senderName} is ringing your phone. Tap to answer.`
    });

    res.json({
      ok: true,
      message: `Ringing ${partnerName}'s phone...`,
      pushDelivered: pushResult.ok
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

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
