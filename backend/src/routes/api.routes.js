/**
 * API Routes Module
 * 
 * Centralized definition of all backend REST API paths and handlers.
 * Kept in this single file for complete clarity and easy future modifications.
 */

const express = require("express");
const router = express.Router();

const { getRoomMessages, getDatabaseStatus, saveFcmToken } = require("../database/database");
const { getRoomMembers, getIO } = require("../socket");
const { sendPushNotification } = require("../services/fcmService");
const { checkRateLimit, verifyRoomCredentials } = require("../utils/security");

/**
 * All API endpoint paths defined in one single object
 */
const API_PATHS = {
  STATUS: "/status",
  DB_STATUS: "/db-status",
  FCM_REGISTER: "/fcm/register",
  FCM_TEST: "/fcm/test",
  RING: "/ring"
};

// -------------------------------------------------------------
// 1. Diagnostic Endpoints
// -------------------------------------------------------------

// GET /api/status - Server health & active socket connections
router.get(API_PATHS.STATUS, (req, res) => {
  const roomMembers = getRoomMembers();
  res.json({
    status: "ok",
    connectedUsers: roomMembers.size,
    roles: Array.from(roomMembers.keys()),
    timestamp: Date.now()
  });
});

// GET /api/db-status - Database connection & message statistics
router.get(API_PATHS.DB_STATUS, async (req, res) => {
  const dbStatus = getDatabaseStatus();
  const roomMembers = getRoomMembers();
  let totalCount = 0;
  try {
    const msgs = await getRoomMessages("0202", 1000);
    totalCount = msgs.length;
  } catch (e) {
    // Ignore db count errors in status report
  }

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

// -------------------------------------------------------------
// 2. FCM Push Notification Endpoints
// -------------------------------------------------------------

// POST /api/fcm/register - Register device FCM token
router.post(API_PATHS.FCM_REGISTER, async (req, res) => {
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

// POST /api/fcm/test - Test push notification endpoint
router.post(API_PATHS.FCM_TEST, async (req, res) => {
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

// -------------------------------------------------------------
// 3. Manual Ring Endpoint
// -------------------------------------------------------------

// POST /api/ring - Ring partner's phone with rate limiting & socket alert
router.post(API_PATHS.RING, async (req, res) => {
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

    const io = getIO();
    if (io) {
      io.to(targetRoomId).emit("incoming-ring", {
        fromRole: role,
        fromName: senderName,
        timestamp: Date.now()
      });
    }

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

module.exports = {
  router,
  API_PATHS
};
