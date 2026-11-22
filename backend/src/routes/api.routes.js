/**
 * API Routes Module
 * 
 * Centralized definition of all backend REST API paths and handlers.
 * Kept in this single file for complete clarity and easy future modifications.
 */

const express = require("express");
const router = express.Router();

const { getRoomMessages, getDatabaseStatus, saveFcmToken } = require("../database/database");
const { getRoomMembers } = require("../socket");
const { sendPushNotification } = require("../services/fcmService");
const { verifyRoomCredentials } = require("../utils/security");

/**
 * All API endpoint paths defined in one single object
 */
const API_PATHS = {
  STATUS: "/status",
  DB_STATUS: "/db-status",
  FCM_REGISTER: "/fcm/register",
  FCM_TEST: "/fcm/test"
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

// GET /api/db-status - Database (Supabase / PostgreSQL) connection & statistics
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
    activeDatabase: dbStatus.usePostgres ? "PostgreSQL (Supabase Cloud)" : "Local JSON File Fallback",
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
    const { roomId, roomPassword, role } = req.body || {};
    const targetRoomId = String(roomId || "0202").trim();
    const targetRole = String(role || "").trim().toLowerCase();

    if (!verifyRoomCredentials(targetRoomId, roomPassword)) {
      return res.status(401).json({ ok: false, error: "Access denied." });
    }

    const senderRole = targetRole === "he" ? "she" : "he";
    const senderName = senderRole === "he" ? "Harry" : "Elira";

    const result = await sendPushNotification({
      targetRole,
      roomId: targetRoomId,
      type: "message",
      senderName,
      senderRole,
      title: `Test Message from ${senderName}`,
      body: "Push notifications are working properly!"
    });

    res.json({ ok: result.ok, result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = {
  router,
  API_PATHS
};
