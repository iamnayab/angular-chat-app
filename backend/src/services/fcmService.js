/**
 * Firebase Cloud Messaging Service
 * 
 * Sends high-priority push notifications for manual ring alerts and new chat messages.
 * Strict zero-knowledge payload: Never contains plaintext, ciphertexts, or passwords.
 */

const admin = require("firebase-admin");
const path = require("path");
const fs = require("fs");
const { getFcmToken, removeFcmToken } = require("../database/database");

let firebaseInitialized = false;

function initFirebase() {
  if (admin.apps.length > 0) {
    firebaseInitialized = true;
    return;
  }

  try {
    // 1. Raw JSON string in environment variable
    if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
      const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
      });
      firebaseInitialized = true;
      console.log("🔥 [FCM] Firebase Admin initialized via FIREBASE_SERVICE_ACCOUNT_JSON.");
      return;
    }

    // 2. File path in environment variable or local file
    const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || path.join(__dirname, "../../firebase-service-account.json");
    if (fs.existsSync(serviceAccountPath)) {
      const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, "utf8"));
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
      });
      firebaseInitialized = true;
      console.log(`🔥 [FCM] Firebase Admin initialized from ${serviceAccountPath}.`);
      return;
    }

    // 3. Individual environment variables
    if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n")
        })
      });
      firebaseInitialized = true;
      console.log("🔥 [FCM] Firebase Admin initialized via individual credentials.");
      return;
    }

    console.warn("⚠️ [FCM] Firebase credentials not found. Notifications will be paused until configured.");
  } catch (err) {
    console.error("❌ [FCM] Firebase initialization error:", err.message);
  }
}

async function sendPushNotification({ targetRole, roomId = "0202", type = "message", senderName = "Partner", senderRole = "", title, body }) {
  if (!firebaseInitialized) {
    return { ok: false, reason: "firebase_not_configured" };
  }

  try {
    const token = await getFcmToken(roomId, targetRole);
    if (!token) {
      return { ok: false, reason: "no_token_registered" };
    }

    const safeTitle = title || `New message from ${senderName}`;
    const safeBody = body || "Tap to open QuickChat";
    const websiteUrl = process.env.WEBSITE_URL || "https://elirakhan.onrender.com";

    // Strictly send metadata only. NEVER send private messages or passwords in payload.
    const message = {
      token,
      data: {
        type: String(type || "message"),
        sender: String(senderName),
        senderRole: String(senderRole),
        roomId: String(roomId),
        url: String(websiteUrl),
        timestamp: String(Date.now()),
        title: safeTitle,
        body: safeBody
      },
      notification: {
        title: safeTitle,
        body: safeBody
      },
      android: {
        priority: "high",
        ttl: 3600 * 1000,
        notification: {
          channelId: "chat_messages_channel",
          sound: "default",
          defaultVibrateTimings: true,
          clickAction: "OPEN_CHAT_WEBSITE"
        }
      }
    };

    const response = await admin.messaging().send(message);
    console.log(`📲 [FCM] High-priority ${type} notification sent to ${targetRole}: ${response}`);
    return { ok: true, messageId: response };
  } catch (err) {
    console.error(`❌ [FCM] Push error for ${targetRole}:`, err.message);
    if (
      err.code === "messaging/registration-token-not-registered" ||
      err.code === "messaging/invalid-registration-token"
    ) {
      console.warn(`⚠️ [FCM] Stale token for ${targetRole}. Removing from database...`);
      await removeFcmToken(roomId, targetRole);
    }
    return { ok: false, error: err.message };
  }
}

// Auto-init on module load
initFirebase();

module.exports = {
  initFirebase,
  sendPushNotification,
  isFirebaseInitialized: () => firebaseInitialized
};
