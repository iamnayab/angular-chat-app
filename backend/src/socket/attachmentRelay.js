/**
 * attachmentRelay.js - Dedicated Attachment & Picture Relay with Supabase Storage Persistence
 * 
 * Flow:
 * 1. Chunks are relayed in real-time via WebSockets.
 * 2. On completion ("attachment:complete"), the full encrypted binary/base64 is saved 
 *    permanently in Supabase PostgreSQL (attachments table).
 * 3. Ephemeral RAM buffer is freed once transfer finishes or upon recipient ack.
 */

const { saveAttachment } = require("../database/database");

// Active in-memory transfers: Map<id, { meta, chunks, expiresAt, roomId, senderRole }>
const activeTransfers = new Map();

// Max allowed file size: 25 MB
const MAX_ATTACHMENT_SIZE = 25 * 1024 * 1024;
// Transfer TTL: 5 minutes for in-progress chunk streaming
const TRANSFER_TTL_MS = 5 * 60 * 1000;

// Periodic cleanup of stale in-progress transfers
setInterval(() => {
  const now = Date.now();
  for (const [id, item] of activeTransfers.entries()) {
    if (now > item.expiresAt) {
      activeTransfers.delete(id);
    }
  }
}, 60 * 1000);

/**
 * Registers attachment relay handlers for an authenticated socket.
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
      return reply({ ok: false, error: "File exceeds 25 MB limit." });
    }

    const validTotalChunks = Math.max(1, parseInt(totalChunks, 10) || 1);

    activeTransfers.set(id, {
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

    const transfer = activeTransfers.get(id);
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

  // 3. Complete Attachment Transfer & Save Permanently to Supabase Database
  socket.on("attachment:complete", async (payload, reply = () => {}) => {
    const ctx = getAuthenticatedContext();
    if (!ctx) return;

    const { id } = payload || {};
    if (!id) return;

    const transfer = activeTransfers.get(id);
    if (transfer && transfer.roomId === ctx.roomId) {
      transfer.isComplete = true;

      // Reconstruct the full base64 encoded encrypted payload
      let fullBase64 = "";
      for (let i = 0; i < transfer.meta.totalChunks; i++) {
        const chunk = transfer.chunks.get(i);
        if (chunk) fullBase64 += chunk;
      }

      // Save permanently to Supabase PostgreSQL Database!
      try {
        await saveAttachment({
          id: transfer.meta.id,
          roomId: transfer.roomId,
          senderRole: transfer.senderRole,
          fileName: transfer.meta.fileName,
          fileType: transfer.meta.fileType,
          fileSize: transfer.meta.fileSize,
          totalChunks: transfer.meta.totalChunks,
          isImage: transfer.meta.isImage,
          iv: transfer.meta.iv,
          data: fullBase64,
          createdAt: transfer.meta.sentAt
        });
        console.log(`💾 [Supabase Storage] Attachment "${transfer.meta.fileName}" (${id}) permanently stored in database.`);
      } catch (err) {
        console.error("❌ Failed to save attachment to database:", err.message);
      }
    }

    // Notify room partner that transfer is complete
    socket.to(ctx.roomId).emit("attachment:complete", {
      id,
      senderRole: ctx.role
    });

    if (typeof reply === "function") {
      reply({ ok: true });
    }
  });

  // 4. Recipient Acknowledges Receipt -> free RAM buffer
  socket.on("attachment:ack", (payload) => {
    const ctx = getAuthenticatedContext();
    if (!ctx) return;

    const { id } = payload || {};
    if (id && activeTransfers.has(id)) {
      const transfer = activeTransfers.get(id);
      if (transfer.roomId === ctx.roomId) {
        activeTransfers.delete(id);
        console.log(`🧹 [Attachment Relay] Stream RAM buffer freed for attachment ${id}.`);
      }
    }
  });

  // 5. Cancel or Abort Transfer
  socket.on("attachment:cancel", (payload) => {
    const ctx = getAuthenticatedContext();
    if (!ctx) return;

    const { id } = payload || {};
    if (id && activeTransfers.has(id)) {
      activeTransfers.delete(id);
      socket.to(ctx.roomId).emit("attachment:cancelled", { id });
      console.log(`🚫 [Attachment Relay] Transfer ${id} cancelled and cleaned from RAM.`);
    }
  });
}

function clearRoomAttachments(roomId) {
  let count = 0;
  for (const [id, item] of activeTransfers.entries()) {
    if (item.roomId === roomId) {
      activeTransfers.delete(id);
      count++;
    }
  }
  if (count > 0) {
    console.log(`🧹 [Attachment Relay] Cleared ${count} active stream buffers for room ${roomId}.`);
  }
}

module.exports = {
  initAttachmentRelay,
  clearRoomAttachments
};
