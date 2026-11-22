/**
 * Socket.IO Realtime Chat & WebRTC/Ephemeral Relay Controller
 * 
 * Separate module dedicated purely to Socket.IO communication.
 */

const { Server } = require("socket.io");
const crypto = require("crypto");
const { checkRateLimit, verifyRoomCredentials, EXPECTED_ROOM_HASH } = require("../utils/security");
const {
  saveEncryptedMessage,
  editEncryptedMessage,
  getRoomMessages,
  markMessagesAsSeen,
  saveUserLastSeen,
  getAllUserStatus,
  clearRoomMessages,
  saveFcmToken
} = require("../database/database");
const { sendPushNotification } = require("../services/fcmService");
const { initAttachmentRelay, clearRoomAttachments } = require("./attachmentRelay");

const uuidv4 = () => crypto.randomUUID();

// Active Members in Room: Map<role, socketId>
const roomMembers = new Map(); // 'he' -> socketId, 'she' -> socketId
const disconnectTimers = new Map(); // 'he' -> timer, 'she' -> timer (prevents mobile blip flickering)

let ioInstance = null;

function setupSocketIO(httpServer) {
  const io = new Server(httpServer, {
    maxHttpBufferSize: 50 * 1024 * 1024, // 50 MB buffer for real-time encrypted streaming
    cors: {
      origin: "*",
      methods: ["GET", "POST"]
    }
  });

  ioInstance = io;

  io.on("connection", (socket) => {
    // Register ephemeral attachment & picture relay (RAM only, zero DB writes)
    initAttachmentRelay(io, socket, roomMembers);

    /**
     * Room Join: Verifies hashed credentials and Role ('he' or 'she')
     */
    socket.on("join-room", async ({ roomId, role } = {}, reply = () => {}) => {
      try {
        const targetRoomId = String(roomId || "0202").trim();

        if (!verifyRoomCredentials(targetRoomId)) {
          return reply({ ok: false, error: "Access Denied" });
        }

        if (role !== "he" && role !== "she") {
          return reply({ ok: false, error: "Please select whether you are 'He' or 'She'." });
        }

        // Cancel any pending disconnect grace timer if role reconnects
        if (disconnectTimers.has(role)) {
          clearTimeout(disconnectTimers.get(role));
          disconnectTimers.delete(role);
        }

        // Seamless Reconnect: If this role was already active on an older socket, replace it
        const existingSocketId = roomMembers.get(role);
        if (existingSocketId && existingSocketId !== socket.id) {
          const oldSocket = io.sockets.sockets.get(existingSocketId);
          if (oldSocket) {
            console.log(`🔄 [Socket] ${role.toUpperCase()} reconnected. Replacing previous socket.`);
            oldSocket.leave(targetRoomId);
            oldSocket.disconnect(true);
          }
        }

        roomMembers.set(role, socket.id);
        socket.data.roomId = targetRoomId;
        socket.data.role = role;
        socket.join(targetRoomId);

        const now = Date.now();
        const partnerRole = role === "he" ? "she" : "he";
        const partnerOnline = Boolean(roomMembers.get(partnerRole));

        // Run independent DB queries in parallel for ultra-fast instant room entry
        const [userStatuses, seenResult, history] = await Promise.all([
          saveUserLastSeen(targetRoomId, role, now).then(() => getAllUserStatus(targetRoomId)),
          markMessagesAsSeen(targetRoomId, role),
          getRoomMessages(targetRoomId, 1000)
        ]);
        const seenAt = (seenResult && seenResult.seenAt) || now;

        console.log(`🟢 [Socket] ${role === "he" ? "Harry" : "Elira"} joined room ${targetRoomId}. Active: ${roomMembers.size}/2`);

        if (partnerOnline) {
          socket.to(targetRoomId).emit("messages-seen", { seenBy: role, at: seenAt });
        }

        // Notify partner presence badge in header
        socket.to(targetRoomId).emit("user-status", { role, isOnline: true, lastSeen: now });
        io.to(targetRoomId).emit("room-count", roomMembers.size);

        reply({
          ok: true,
          count: roomMembers.size,
          partnerOnline,
          partnerLastSeen: userStatuses[partnerRole],
          myLastSeen: userStatuses[role],
          history
        });
      } catch (err) {
        console.error("❌ join-room handler error:", err.message);
        reply({ ok: false, error: "Server error joining room." });
      }
    });

    /**
     * Encrypted Chat Relay & Permanent Database Persistence
     */
    socket.on("chat-message", async (payload, reply = () => {}) => {
      const role = socket.data.role || (payload && payload.senderRole);
      const roomId = socket.data.roomId || (payload && payload.roomId) || "0202";

      if (role && !socket.data.role) {
        socket.data.role = role;
        roomMembers.set(role, socket.id);
      }
      if (roomId && (!socket.data.roomId || !socket.rooms.has(roomId))) {
        socket.data.roomId = roomId;
        socket.join(roomId);
      }

      if (!role || !payload || typeof payload.iv !== "string" || typeof payload.ciphertext !== "string") {
        console.warn("⚠️ [Socket Message Rejected] Missing role or payload strings:", { role, roomId });
        if (typeof reply === "function") reply({ ok: false, error: "Invalid message payload or role not set." });
        return;
      }
      if (payload.iv.length > 100 || payload.ciphertext.length > 12_000) {
        if (typeof reply === "function") reply({ ok: false, error: "Payload exceeds size limits." });
        return;
      }

      const sentAt = Number(payload.sentAt) || Date.now();
      const messageId = payload.id || uuidv4();

      console.log(`📨 [Socket Message] Received from ${role} in room "${roomId}". Saving...`);

      // Persist encrypted payload permanently
      await saveEncryptedMessage({
        id: messageId,
        roomId,
        iv: payload.iv,
        ciphertext: payload.ciphertext,
        senderRole: role,
        sentAt,
        seen: false
      });

      // Update user's active timestamp in database
      saveUserLastSeen(roomId, role, sentAt);

      // Relay to partner
      socket.to(roomId).emit("chat-message", {
        id: messageId,
        iv: payload.iv,
        ciphertext: payload.ciphertext,
        senderRole: role,
        sentAt,
        seen: false
      });

      // Send high-priority FCM push notification to partner phone
      const partnerRole = role === "he" ? "she" : "he";
      const senderName = role === "he" ? "Harry" : "Elira";
      sendPushNotification({
        targetRole: partnerRole,
        roomId,
        type: "message",
        senderName,
        senderRole: role,
        title: `New message from ${senderName}`,
        body: "Tap to open QuickChat"
      }).catch(err => console.warn("Background FCM message push error:", err.message));

      if (typeof reply === "function") {
        reply({ ok: true, id: messageId, sentAt });
      }
    });

    /**
     * Edit Encrypted Message
     */
    socket.on("edit-message", async (payload, reply = () => {}) => {
      const role = socket.data.role || (payload && payload.senderRole);
      const roomId = socket.data.roomId || (payload && payload.roomId) || "0202";

      if (!role || !payload || !payload.id || typeof payload.iv !== "string" || typeof payload.ciphertext !== "string") {
        if (typeof reply === "function") reply({ ok: false, error: "Invalid edit payload." });
        return;
      }

      const editedAt = Number(payload.editedAt) || Date.now();

      await editEncryptedMessage({
        id: payload.id,
        roomId,
        iv: payload.iv,
        ciphertext: payload.ciphertext,
        senderRole: role,
        editedAt
      });

      // Relay edited message to partner
      socket.to(roomId).emit("message-edited", {
        id: payload.id,
        iv: payload.iv,
        ciphertext: payload.ciphertext,
        senderRole: role,
        editedAt
      });

      console.log(`✏️ [Socket] Message ${payload.id} edited by ${role} in room ${roomId}.`);

      if (typeof reply === "function") {
        reply({ ok: true, id: payload.id, editedAt });
      }
    });

    /**
     * WebRTC Audio & Video Calling Signaling
     */
    socket.on("webrtc:call-user", ({ toRole, offer, isVideo, callId } = {}) => {
      const fromRole = socket.data.role;
      const roomId = socket.data.roomId;
      if (!fromRole || !roomId) return;

      const targetRole = toRole || (fromRole === "he" ? "she" : "he");
      const targetSocketId = roomMembers.get(targetRole);

      if (targetSocketId) {
        console.log(`📞 [WebRTC] Call offer from ${fromRole.toUpperCase()} to ${targetRole.toUpperCase()} (Video: ${Boolean(isVideo)})`);
        io.to(targetSocketId).emit("webrtc:incoming-call", {
          fromRole,
          fromName: fromRole === "he" ? "Harry" : "Elira",
          offer,
          isVideo: Boolean(isVideo),
          callId: callId || uuidv4()
        });
      } else {
        console.log(`📞 [WebRTC] Call failed: ${targetRole.toUpperCase()} is offline.`);
        socket.emit("webrtc:call-failed", { reason: "partner_offline" });
      }
    });

    socket.on("webrtc:answer-call", ({ toRole, answer, callId } = {}) => {
      const fromRole = socket.data.role;
      const targetRole = toRole || (fromRole === "he" ? "she" : "he");
      const targetSocketId = roomMembers.get(targetRole);

      if (targetSocketId) {
        console.log(`📞 [WebRTC] Call answer from ${fromRole.toUpperCase()} to ${targetRole.toUpperCase()}`);
        io.to(targetSocketId).emit("webrtc:call-answered", {
          fromRole,
          answer,
          callId
        });
      }
    });

    socket.on("webrtc:ice-candidate", ({ toRole, candidate } = {}) => {
      const fromRole = socket.data.role;
      const targetRole = toRole || (fromRole === "he" ? "she" : "he");
      const targetSocketId = roomMembers.get(targetRole);

      if (targetSocketId && candidate) {
        io.to(targetSocketId).emit("webrtc:ice-candidate", {
          fromRole,
          candidate
        });
      }
    });

    socket.on("webrtc:end-call", ({ toRole, reason } = {}) => {
      const fromRole = socket.data.role;
      const targetRole = toRole || (fromRole === "he" ? "she" : "he");
      const targetSocketId = roomMembers.get(targetRole);

      if (targetSocketId) {
        console.log(`📞 [WebRTC] Call ended by ${fromRole.toUpperCase()} (${reason || "hangup"})`);
        io.to(targetSocketId).emit("webrtc:call-ended", {
          fromRole,
          reason: reason || "hangup"
        });
      }
    });

    socket.on("webrtc:reject-call", ({ toRole } = {}) => {
      const fromRole = socket.data.role;
      const targetRole = toRole || (fromRole === "he" ? "she" : "he");
      const targetSocketId = roomMembers.get(targetRole);

      if (targetSocketId) {
        console.log(`📞 [WebRTC] Call rejected by ${fromRole.toUpperCase()}`);
        io.to(targetSocketId).emit("webrtc:call-rejected", {
          fromRole
        });
      }
    });

    /**
     * Register FCM Token via Socket
     */
    socket.on("register-fcm", async ({ token } = {}, reply = () => {}) => {
      const role = socket.data.role;
      const roomId = socket.data.roomId || "0202";
      if (!role || !token) {
        if (typeof reply === "function") reply({ ok: false, error: "Role and token required." });
        return;
      }
      await saveFcmToken(roomId, role, token);
      if (typeof reply === "function") reply({ ok: true });
    });

    /**
     * Android Companion App Live Alert Listener
     */
    socket.on("listen-alerts", async ({ roomId, role, password } = {}, reply = () => {}) => {
      try {
        const targetRoomId = String(roomId || "0202").trim();
        const targetRole = String(role || "he").trim().toLowerCase();

        if (!verifyRoomCredentials(targetRoomId, password)) {
          if (typeof reply === "function") reply({ ok: false, error: "Access Denied" });
          return;
        }

        socket.join(targetRoomId);
        socket.data.companionRole = targetRole;
        socket.data.roomId = targetRoomId;
        console.log(`📱 [Companion App] Listening for live alerts in room "${targetRoomId}" (Role: ${targetRole.toUpperCase()})`);
        if (typeof reply === "function") reply({ ok: true, message: `Connected to live alerts for ${targetRole}.` });
      } catch (err) {
        if (typeof reply === "function") reply({ ok: false, error: err.message });
      }
    });


    /**
     * Realtime Typing Indicator Relay
     */
    socket.on("typing", ({ isTyping } = {}) => {
      const role = socket.data.role;
      const roomId = socket.data.roomId;
      if (!role || !roomId) return;
      socket.to(roomId).emit("typing", {
        role,
        isTyping: Boolean(isTyping)
      });
    });

    /**
     * Message Seen Notification
     */
    socket.on("mark-seen", async () => {
      const role = socket.data.role;
      const roomId = socket.data.roomId;
      if (!role || !roomId) return;

      const { seenAt } = await markMessagesAsSeen(roomId, role);
      socket.to(roomId).emit("messages-seen", {
        seenBy: role,
        at: seenAt
      });
    });

    /**
     * Clear Chat History for the Room
     */
    socket.on("clear-room", async (reply = () => {}) => {
      const roomId = socket.data.roomId;
      if (!roomId) return reply({ ok: false, error: "Not in room." });

      await clearRoomMessages(roomId);
      clearRoomAttachments(roomId);
      io.to(roomId).emit("chat-cleared");
      console.log(`🗑️ [Socket] Chat history cleared by ${socket.data.role}.`);
      reply({ ok: true });
    });

    /**
     * Disconnect handler with 10-second grace period
     */
    socket.on("disconnect", async () => {
      const role = socket.data.role;
      const roomId = socket.data.roomId;
      if (role && roomMembers.get(role) === socket.id) {
        const timer = setTimeout(async () => {
          disconnectTimers.delete(role);
          if (roomMembers.get(role) === socket.id) {
            roomMembers.delete(role);
            const lastSeen = Date.now();
            if (roomId) {
              await saveUserLastSeen(roomId, role, lastSeen);
              io.to(roomId).emit("user-status", { role, isOnline: false, lastSeen });
              io.to(roomId).emit("typing", { role, isTyping: false });
              io.to(roomId).emit("room-count", roomMembers.size);
            }
            console.log(`🔴 [Socket] ${role.toUpperCase()} went offline after grace period.`);
          }
        }, 10000);

        disconnectTimers.set(role, timer);
      }
    });
  });

  return io;
}

function getRoomMembers() {
  return roomMembers;
}

function getIO() {
  return ioInstance;
}

module.exports = {
  setupSocketIO,
  getRoomMembers,
  getIO
};
