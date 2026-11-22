/**
 * attachmentRelay.js - Dedicated Ephemeral Attachment & Picture Relay
 * 
 * STRICT PRIVACY & NO DATABASE STORAGE:
 * - Attachments (pictures, files, audio, video) are relayed in-memory via WebSockets.
 * - ZERO DATABASE WRITES: Never writes to PostgreSQL, SQLite, or chat_data.json.
 * - ZERO DISK STORAGE: Files are never saved to the server's filesystem.
 * - Ephemeral RAM buffer with 5-minute auto-expiry TTL in case of brief network reconnection.
 * - Memory is immediately freed once recipient acknowledges receipt.
 */

// Active in-memory transfers: Map<id, { meta, chunks, expiresAt, roomId, senderRole }>
const ephemeralTransfers = new Map();

// Max allowed file size: 25 MB
const MAX_ATTACHMENT_SIZE = 25 * 1024 * 1024;
// Transfer TTL: 5 minutes
const TRANSFER_TTL_MS = 5 * 60 * 1000;

// Periodic cleanup of expired in-memory transfers
setInterval(() => {
  const now = Date.now();
  for (const [id, item] of ephemeralTransfers.entries()) {
    if (now > item.expiresAt) {
      ephemeralTransfers.delete(id);
    }
  }
}, 60 * 1000);

/**
 * Registers attachment relay handlers for an authenticated socket.
 * 
 * @param {import("socket.io").Server} io 
 * @param {import("socket.io").Socket} socket 
 * @param {Map<string, string>} roomMembers 
 */
function initAttachmentRelay(io, socket, roomMembers) {

  function getAuthenticatedContext() {
    const role = socket.data.role;
    const roomId = socket.data.roomId || "0202";
    if (!role || (role !== "he" && role !== "she")) {
      return null;
    }
    return { role, roomId };
  }

  // 1. Start Attachment Transfer
  socket.on("attachment:start", (payload, reply = () => {}) => {
    const ctx = getAuthenticatedContext();
    if (!ctx) {
      return reply({ ok: false, error: "Unauthorized. Join room first." });
    }

    const { id, fileName, fileType, fileSize, totalChunks, isImage, iv, sentAt } = payload || {};

    if (!id || typeof id !== "string" || !fileName || typeof fileSize !== "number") {
      return reply({ ok: false, error: "Invalid attachment metadata." });
    }

    if (fileSize > MAX_ATTACHMENT_SIZE) {
      return reply({ ok: false, error: "File exceeds 25 MB limit for ephemeral transfer." });
    }

    const validTotalChunks = Math.max(1, parseInt(totalChunks, 10) || 1);

    ephemeralTransfers.set(id, {
      meta: {
        id,
        fileName: String(fileName).slice(0, 255),
        fileType: String(fileType || "application/octet-stream").slice(0, 100),
        fileSize,
        totalChunks: validTotalChunks,
        isImage: Boolean(isImage),
        iv: String(iv || ""),
        senderRole: ctx.role,
        sentAt: Number(sentAt) || Date.now()
      },
      chunks: new Map(),
      roomId: ctx.roomId,
      senderRole: ctx.role,
      expiresAt: Date.now() + TRANSFER_TTL_MS
    });

    console.log(`📎 [Attachment Relay] Transfer started: "${fileName}" (${(fileSize / (1024 * 1024)).toFixed(2)} MB) by ${ctx.role.toUpperCase()} in room ${ctx.roomId}.`);

    // Relay metadata to partner in the room
    socket.to(ctx.roomId).emit("attachment:start", {
      id,
      fileName,
      fileType,
      fileSize,
      totalChunks: validTotalChunks,
      isImage: Boolean(isImage),
      iv,
      senderRole: ctx.role,
      sentAt: Number(sentAt) || Date.now()
    });

    reply({ ok: true });
  });

  // 2. Relay Encrypted Attachment Chunk
  socket.on("attachment:chunk", (payload, reply = () => {}) => {
    const ctx = getAuthenticatedContext();
    if (!ctx) return;

    const { id, chunkIndex, totalChunks, data } = payload || {};
    if (!id || typeof chunkIndex !== "number" || !data) {
      return;
    }

    const transfer = ephemeralTransfers.get(id);
    if (transfer && transfer.roomId === ctx.roomId) {
      transfer.chunks.set(chunkIndex, data);
      transfer.expiresAt = Date.now() + TRANSFER_TTL_MS;
    }

    // Direct real-time relay to partner
    socket.to(ctx.roomId).emit("attachment:chunk", {
      id,
      chunkIndex,
      totalChunks,
      data
    });

    if (typeof reply === "function") {
      reply({ ok: true, chunkIndex });
    }
  });

  // 3. Complete Attachment Transfer
  socket.on("attachment:complete", (payload, reply = () => {}) => {
    const ctx = getAuthenticatedContext();
    if (!ctx) return;

    const { id } = payload || {};
    if (!id) return;

    const transfer = ephemeralTransfers.get(id);
    if (transfer && transfer.roomId === ctx.roomId) {
      transfer.isComplete = true;
      console.log(`✅ [Attachment Relay] Transfer completed: ${id} (${transfer.chunks.size}/${transfer.meta.totalChunks} chunks in RAM).`);
    }

    socket.to(ctx.roomId).emit("attachment:complete", {
      id,
      senderRole: ctx.role
    });

    if (typeof reply === "function") {
      reply({ ok: true });
    }
  });

  // 4. Recipient Acknowledges Receipt -> free RAM immediately
  socket.on("attachment:ack", (payload) => {
    const ctx = getAuthenticatedContext();
    if (!ctx) return;

    const { id } = payload || {};
    if (id && ephemeralTransfers.has(id)) {
      const transfer = ephemeralTransfers.get(id);
      if (transfer.roomId === ctx.roomId) {
        ephemeralTransfers.delete(id);
        console.log(`🧹 [Attachment Relay] RAM freed for attachment ${id} after recipient ack.`);
      }
    }
  });

  // 5. Cancel or Abort Transfer
  socket.on("attachment:cancel", (payload) => {
    const ctx = getAuthenticatedContext();
    if (!ctx) return;

    const { id } = payload || {};
    if (id && ephemeralTransfers.has(id)) {
      ephemeralTransfers.delete(id);
      socket.to(ctx.roomId).emit("attachment:cancelled", { id });
      console.log(`🚫 [Attachment Relay] Transfer ${id} cancelled and cleaned from RAM.`);
    }
  });
}

function clearRoomAttachments(roomId) {
  let count = 0;
  for (const [id, item] of ephemeralTransfers.entries()) {
    if (item.roomId === roomId) {
      ephemeralTransfers.delete(id);
      count++;
    }
  }
  if (count > 0) {
    console.log(`🧹 [Attachment Relay] Cleared ${count} in-memory attachments for room ${roomId}.`);
  }
}

module.exports = {
  initAttachmentRelay,
  clearRoomAttachments
};
