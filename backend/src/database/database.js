/**
 * Database Module for PostgreSQL (Supabase / Render Cloud / Remote) & Local JSON File Fallback
 * 
 * Strict Security: Only stores AES-256 encrypted IV + Ciphertext/Binary.
 * Never stores plaintext or passwords!
 */

const fs = require("fs");
const path = require("path");
const dns = require("dns");

// Force IPv4 first to prevent ENETUNREACH on platforms like Render that lack IPv6
if (dns.setDefaultResultOrder) {
  dns.setDefaultResultOrder("ipv4first");
}

let pgPool = null;
let usePostgres = false;
let lastDbError = null;

// Local fallback storage file
const LOCAL_DB_PATH = path.join(__dirname, "../chat_data.json");
let localDb = {
  messages: [],
  attachments: [],
  userStatus: {},
  fcmTokens: {}
};

function loadLocalDb() {
  if (fs.existsSync(LOCAL_DB_PATH)) {
    try {
      const content = fs.readFileSync(LOCAL_DB_PATH, "utf8");
      localDb = JSON.parse(content);
      if (!localDb.messages) localDb.messages = [];
      if (!localDb.attachments) localDb.attachments = [];
      if (!localDb.userStatus) localDb.userStatus = {};
      if (!localDb.fcmTokens) localDb.fcmTokens = {};
    } catch (e) {
      console.warn("⚠️ Failed reading local db file, initializing fresh store:", e.message);
      localDb = { messages: [], attachments: [], userStatus: {}, fcmTokens: {} };
    }
  }
}

function persistLocalDb() {
  try {
    fs.writeFileSync(LOCAL_DB_PATH, JSON.stringify(localDb, null, 2), "utf8");
  } catch (e) {
    console.error("❌ Failed writing to local db:", e.message);
  }
}

// Pre-load local db immediately
loadLocalDb();

async function createPgPoolWithAutoSsl(databaseUrl) {
  const { Pool, types } = require("pg");

  // Parse PostgreSQL BIGINT (OID 20) as safe JavaScript integer
  types.setTypeParser(20, (val) => (val === null ? null : parseInt(val, 10)));

  const isExternalInitial = 
    databaseUrl.includes(".render.com") || 
    databaseUrl.includes("supabase.co") || 
    databaseUrl.includes("supabase.com") || 
    databaseUrl.includes("pooler.supabase.com") || 
    databaseUrl.includes("sslmode=require");

  try {
    console.log(`🔌 Initializing PostgreSQL connection (SSL: ${isExternalInitial ? "enabled" : "disabled"})...`);
    let pool = new Pool({
      connectionString: databaseUrl,
      ssl: isExternalInitial ? { rejectUnauthorized: false } : false,
      connectionTimeoutMillis: 10000
    });

    const client = await pool.connect();
    client.release();
    return pool;
  } catch (err1) {
    console.warn(`⚠️ PostgreSQL initial connection attempt failed (${err1.message}). Retrying with alternate SSL setting...`);

    try {
      const alternateSsl = !isExternalInitial ? { rejectUnauthorized: false } : false;
      let pool = new Pool({
        connectionString: databaseUrl,
        ssl: alternateSsl,
        connectionTimeoutMillis: 10000
      });

      const client = await pool.connect();
      client.release();
      console.log(`✅ Alternate SSL connection successful.`);
      return pool;
    } catch (err2) {
      throw new Error(`Both SSL and non-SSL connections failed: ${err1.message} | ${err2.message}`);
    }
  }
}

async function initDatabase() {
  const databaseUrl = process.env.DATABASE_URL;

  if (databaseUrl && (databaseUrl.startsWith("postgres://") || databaseUrl.startsWith("postgresql://"))) {
    try {
      pgPool = await createPgPoolWithAutoSsl(databaseUrl);

      const client = await pgPool.connect();
      try {
        // 1. Messages table
        await client.query(`
          CREATE TABLE IF NOT EXISTS messages (
            id VARCHAR(64) PRIMARY KEY,
            room_id VARCHAR(64) NOT NULL,
            iv TEXT NOT NULL,
            ciphertext TEXT NOT NULL,
            sender_role VARCHAR(32) NOT NULL,
            created_at BIGINT NOT NULL
          )
        `);

        // Index for messages
        try {
          await client.query(`CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_id, created_at)`);
        } catch (e) {}

        // Seen & edited columns
        try {
          await client.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS seen BOOLEAN DEFAULT FALSE`);
          await client.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS seen_at BIGINT`);
          await client.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS edited_at BIGINT`);
          await client.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_attachment BOOLEAN DEFAULT FALSE`);
        } catch (e) {}

        // 2. Attachments & Pictures Table (Saved permanently in Supabase)
        await client.query(`
          CREATE TABLE IF NOT EXISTS attachments (
            id VARCHAR(64) PRIMARY KEY,
            room_id VARCHAR(64) NOT NULL,
            sender_role VARCHAR(32) NOT NULL,
            file_name TEXT NOT NULL,
            file_type TEXT NOT NULL,
            file_size BIGINT NOT NULL,
            total_chunks INT NOT NULL,
            is_image BOOLEAN DEFAULT FALSE,
            iv TEXT NOT NULL,
            data TEXT NOT NULL,
            created_at BIGINT NOT NULL
          )
        `);

        try {
          await client.query(`CREATE INDEX IF NOT EXISTS idx_attachments_room ON attachments(room_id, created_at)`);
        } catch (e) {}

        // 3. User status table
        try {
          await client.query(`
            CREATE TABLE IF NOT EXISTS user_status (
              room_id VARCHAR(64) NOT NULL,
              role VARCHAR(32) NOT NULL,
              last_seen BIGINT NOT NULL,
              PRIMARY KEY (room_id, role)
            )
          `);
        } catch (e) {}

        // 4. FCM tokens table
        try {
          await client.query(`
            CREATE TABLE IF NOT EXISTS fcm_tokens (
              room_id VARCHAR(64) NOT NULL,
              role VARCHAR(32) NOT NULL,
              token TEXT NOT NULL,
              updated_at BIGINT NOT NULL,
              PRIMARY KEY (room_id, role)
            )
          `);
        } catch (e) {}

        console.log("✅ PostgreSQL (Supabase) Database connected & all tables verified.");
        usePostgres = true;
        lastDbError = null;
      } finally {
        client.release();
      }
      return;
    } catch (err) {
      lastDbError = err.message;
      console.error("❌ PostgreSQL connection failed:", err.message);
      console.warn("⚠️ Falling back to local storage (chat_data.json)");
      usePostgres = false;
    }
  }

  loadLocalDb();
  console.log("📁 Using Local File Database (chat_data.json). Free & zero-setup.");
}

/**
 * Save regular encrypted text message
 */
async function saveEncryptedMessage({ id, roomId, iv, ciphertext, senderRole, sentAt = Date.now(), seen = false }) {
  const numericSentAt = Number(sentAt) || Date.now();
  const isSeen = Boolean(seen);
  const targetRoomId = String(roomId || "0202").trim();
  const messageId = id || `msg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

  if (usePostgres && pgPool) {
    try {
      await pgPool.query(
        `INSERT INTO messages (id, room_id, iv, ciphertext, sender_role, created_at, seen, is_attachment)
         VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE)
         ON CONFLICT (id) DO UPDATE SET
           seen = EXCLUDED.seen,
           created_at = EXCLUDED.created_at`,
        [messageId, targetRoomId, iv, ciphertext, senderRole, numericSentAt, isSeen]
      );
      return { success: true, db: "postgres" };
    } catch (err) {
      lastDbError = err.message;
      console.error("❌ Postgres save message error:", err.message);
    }
  }

  // Local JSON fallback
  loadLocalDb();
  const existingIdx = (localDb.messages || []).findIndex(m => (m.id && messageId && m.id === messageId) || m.ciphertext === ciphertext);
  const item = {
    id: messageId,
    roomId: targetRoomId,
    iv,
    ciphertext,
    senderRole,
    sentAt: numericSentAt,
    seen: isSeen,
    isAttachment: false
  };

  if (existingIdx >= 0) {
    localDb.messages[existingIdx] = { ...localDb.messages[existingIdx], ...item };
  } else {
    localDb.messages.push(item);
  }

  persistLocalDb();
  return { success: true, db: "local" };
}

/**
 * Save encrypted attachment / picture permanently in Supabase
 */
async function saveAttachment({ id, roomId, senderRole, fileName, fileType, fileSize, totalChunks, isImage, iv, data, caption = "", createdAt = Date.now() }) {
  const targetRoomId = String(roomId || "0202").trim();
  const numericCreatedAt = Number(createdAt) || Date.now();
  const safeCaption = String(caption || "").trim();

  if (usePostgres && pgPool) {
    try {
      // 1. Insert into attachments table
      await pgPool.query(
        `INSERT INTO attachments (id, room_id, sender_role, file_name, file_type, file_size, total_chunks, is_image, iv, data, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`,
        [
          id,
          targetRoomId,
          senderRole,
          fileName,
          fileType || "application/octet-stream",
          fileSize || 0,
          totalChunks || 1,
          Boolean(isImage),
          iv,
          data,
          numericCreatedAt
        ]
      );

      // 2. Also register in messages timeline (stores caption in ciphertext column)
      await pgPool.query(
        `INSERT INTO messages (id, room_id, iv, ciphertext, sender_role, created_at, seen, is_attachment)
         VALUES ($1, $2, $3, $4, $5, $6, FALSE, TRUE)
         ON CONFLICT (id) DO UPDATE SET ciphertext = EXCLUDED.ciphertext`,
        [id, targetRoomId, iv, safeCaption, senderRole, numericCreatedAt]
      );

      return { success: true, db: "postgres" };
    } catch (err) {
      lastDbError = err.message;
      console.error("❌ Postgres save attachment error:", err.message);
    }
  }

  // Local JSON fallback
  loadLocalDb();
  if (!localDb.attachments) localDb.attachments = [];
  const existingAttIdx = localDb.attachments.findIndex(a => a.id === id);
  const attItem = {
    id,
    roomId: targetRoomId,
    senderRole,
    fileName,
    fileType,
    fileSize,
    totalChunks,
    isImage: Boolean(isImage),
    iv,
    data,
    caption: safeCaption,
    createdAt: numericCreatedAt
  };

  if (existingAttIdx >= 0) {
    localDb.attachments[existingAttIdx] = attItem;
  } else {
    localDb.attachments.push(attItem);
  }

  // Add to local messages list
  const existingMsgIdx = (localDb.messages || []).findIndex(m => m.id === id);
  const msgItem = {
    id,
    roomId: targetRoomId,
    iv,
    ciphertext: safeCaption,
    senderRole,
    sentAt: numericCreatedAt,
    seen: false,
    isAttachment: true
  };

  if (existingMsgIdx >= 0) {
    localDb.messages[existingMsgIdx] = msgItem;
  } else {
    localDb.messages.push(msgItem);
  }

  persistLocalDb();
  return { success: true, db: "local" };
}

/**
 * Retrieve messages and attachments joined together
 */
async function getRoomMessages(roomId, limit = 500) {
  const targetRoomId = String(roomId || "0202").trim();

  if (usePostgres && pgPool) {
    try {
      const res = await pgPool.query(
        `SELECT 
           m.id, m.room_id, m.iv, m.ciphertext, m.sender_role, m.created_at, m.seen, m.edited_at, m.is_attachment,
           a.file_name, a.file_type, a.file_size, a.total_chunks, a.is_image, a.iv AS att_iv, a.data AS att_data
         FROM messages m
         LEFT JOIN attachments a ON m.id = a.id
         WHERE m.room_id = $1
         ORDER BY m.created_at ASC
         LIMIT $2`,
        [targetRoomId, limit]
      );
      return res.rows.map(r => ({
        id: r.id,
        roomId: r.room_id,
        iv: r.iv,
        ciphertext: r.ciphertext,
        senderRole: r.sender_role,
        sentAt: Number(r.created_at),
        seen: Boolean(r.seen),
        editedAt: r.edited_at ? Number(r.edited_at) : undefined,
        isAttachment: Boolean(r.is_attachment),
        attachment: r.is_attachment && r.file_name ? {
          meta: {
            id: r.id,
            fileName: r.file_name,
            fileType: r.file_type,
            fileSize: Number(r.file_size),
            totalChunks: Number(r.total_chunks || 1),
            isImage: Boolean(r.is_image),
            iv: r.att_iv || r.iv,
            senderRole: r.sender_role,
            sentAt: Number(r.created_at)
          },
          data: r.att_data
        } : undefined
      }));
    } catch (err) {
      console.error("❌ Postgres get messages error:", err.message);
    }
  }

  loadLocalDb();
  const attMap = new Map((localDb.attachments || []).map(a => [a.id, a]));
  return (localDb.messages || [])
    .filter(m => String(m.roomId).trim() === targetRoomId)
    .sort((a, b) => (Number(a.sentAt) || 0) - (Number(b.sentAt) || 0))
    .slice(-limit)
    .map(m => {
      const att = attMap.get(m.id);
      return {
        id: m.id,
        roomId: m.roomId,
        iv: m.iv,
        ciphertext: m.ciphertext,
        senderRole: m.senderRole,
        sentAt: Number(m.sentAt),
        seen: Boolean(m.seen),
        editedAt: m.editedAt ? Number(m.editedAt) : undefined,
        isAttachment: Boolean(m.isAttachment),
        attachment: att ? {
          meta: {
            id: att.id,
            fileName: att.fileName,
            fileType: att.fileType,
            fileSize: att.fileSize,
            totalChunks: att.totalChunks,
            isImage: att.isImage,
            iv: att.iv,
            senderRole: att.senderRole,
            sentAt: att.createdAt
          },
          data: att.data
        } : undefined
      };
    });
}

async function editEncryptedMessage({ id, roomId, iv, ciphertext, senderRole, editedAt = Date.now() }) {
  const targetRoomId = String(roomId || "0202").trim();
  const numericEditedAt = Number(editedAt) || Date.now();

  if (usePostgres && pgPool) {
    try {
      await pgPool.query(
        `UPDATE messages
         SET iv = $1, ciphertext = $2, edited_at = $3
         WHERE id = $4 AND room_id = $5 AND sender_role = $6`,
        [iv, ciphertext, numericEditedAt, id, targetRoomId, senderRole]
      );
      return true;
    } catch (err) {
      console.error("❌ Postgres edit message error:", err.message);
    }
  }

  loadLocalDb();
  const msg = (localDb.messages || []).find(m => m.id === id && String(m.roomId).trim() === targetRoomId);
  if (msg) {
    msg.iv = iv;
    msg.ciphertext = ciphertext;
    msg.editedAt = numericEditedAt;
    persistLocalDb();
    return true;
  }
  return false;
}

async function markMessagesAsSeen(roomId, readerRole) {
  const targetRoomId = String(roomId || "0202").trim();
  const senderRole = readerRole === "he" ? "she" : "he";
  const now = Date.now();

  if (usePostgres && pgPool) {
    try {
      await pgPool.query(
        `UPDATE messages
         SET seen = TRUE, seen_at = $1
         WHERE room_id = $2 AND sender_role = $3 AND (seen IS FALSE OR seen IS NULL)`,
        [now, targetRoomId, senderRole]
      );
      return { success: true, seenAt: now };
    } catch (err) {
      console.error("❌ Postgres mark seen error:", err.message);
    }
  }

  loadLocalDb();
  let updated = false;
  for (const m of localDb.messages || []) {
    if (String(m.roomId).trim() === targetRoomId && m.senderRole === senderRole && !m.seen) {
      m.seen = true;
      m.seenAt = now;
      updated = true;
    }
  }
  if (updated) persistLocalDb();
  return { success: true, seenAt: now };
}

async function saveUserLastSeen(roomId, role, timestamp = Date.now()) {
  const targetRoomId = String(roomId || "0202").trim();
  const cleanRole = String(role || "he").trim().toLowerCase();
  const ts = Number(timestamp) || Date.now();

  if (usePostgres && pgPool) {
    try {
      await pgPool.query(
        `INSERT INTO user_status (room_id, role, last_seen)
         VALUES ($1, $2, $3)
         ON CONFLICT (room_id, role)
         DO UPDATE SET last_seen = EXCLUDED.last_seen`,
        [targetRoomId, cleanRole, ts]
      );
      return true;
    } catch (err) {
      console.error("❌ Postgres save last seen error:", err.message);
    }
  }

  loadLocalDb();
  if (!localDb.userStatus) localDb.userStatus = {};
  localDb.userStatus[`${targetRoomId}:${cleanRole}`] = ts;
  persistLocalDb();
  return true;
}

async function getAllUserStatus(roomId) {
  const targetRoomId = String(roomId || "0202").trim();
  const statuses = { he: null, she: null };

  if (usePostgres && pgPool) {
    try {
      const res = await pgPool.query(
        `SELECT role, last_seen FROM user_status WHERE room_id = $1`,
        [targetRoomId]
      );
      for (const row of res.rows) {
        statuses[row.role] = Number(row.last_seen);
      }
      return statuses;
    } catch (err) {
      console.error("❌ Postgres get user status error:", err.message);
    }
  }

  loadLocalDb();
  if (localDb.userStatus) {
    statuses.he = localDb.userStatus[`${targetRoomId}:he`] || null;
    statuses.she = localDb.userStatus[`${targetRoomId}:she`] || null;
  }
  return statuses;
}

async function clearRoomMessages(roomId) {
  const targetRoomId = String(roomId || "0202").trim();

  if (usePostgres && pgPool) {
    try {
      await pgPool.query(`DELETE FROM messages WHERE room_id = $1`, [targetRoomId]);
      await pgPool.query(`DELETE FROM attachments WHERE room_id = $1`, [targetRoomId]);
    } catch (err) {
      console.error("❌ Postgres clear messages error:", err.message);
    }
  }

  loadLocalDb();
  localDb.messages = (localDb.messages || []).filter(m => String(m.roomId).trim() !== targetRoomId);
  localDb.attachments = (localDb.attachments || []).filter(a => String(a.roomId).trim() !== targetRoomId);
  persistLocalDb();
  return true;
}

async function saveFcmToken(roomId, role, token) {
  const targetRoomId = String(roomId || "0202").trim();
  const cleanRole = String(role || "he").trim().toLowerCase();
  const ts = Date.now();

  if (usePostgres && pgPool) {
    try {
      await pgPool.query(
        `INSERT INTO fcm_tokens (room_id, role, token, updated_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (room_id, role)
         DO UPDATE SET token = EXCLUDED.token, updated_at = EXCLUDED.updated_at`,
        [targetRoomId, cleanRole, token, ts]
      );
      return true;
    } catch (err) {
      console.error("❌ Postgres save FCM token error:", err.message);
    }
  }

  loadLocalDb();
  if (!localDb.fcmTokens) localDb.fcmTokens = {};
  localDb.fcmTokens[`${targetRoomId}:${cleanRole}`] = { token, updatedAt: ts };
  persistLocalDb();
  return true;
}

async function getFcmToken(roomId, role) {
  const targetRoomId = String(roomId || "0202").trim();
  const cleanRole = String(role || "he").trim().toLowerCase();

  if (usePostgres && pgPool) {
    try {
      const res = await pgPool.query(
        `SELECT token FROM fcm_tokens WHERE room_id = $1 AND role = $2`,
        [targetRoomId, cleanRole]
      );
      return (res.rows[0] && res.rows[0].token) || null;
    } catch (err) {
      console.error("❌ Postgres get FCM token error:", err.message);
    }
  }

  loadLocalDb();
  const item = localDb.fcmTokens && localDb.fcmTokens[`${targetRoomId}:${cleanRole}`];
  return (item && item.token) || null;
}

function getDatabaseStatus() {
  return {
    usePostgres,
    hasDatabaseUrl: Boolean(process.env.DATABASE_URL),
    lastDbError
  };
}

module.exports = {
  initDatabase,
  saveEncryptedMessage,
  saveAttachment,
  getRoomMessages,
  editEncryptedMessage,
  markMessagesAsSeen,
  saveUserLastSeen,
  getAllUserStatus,
  clearRoomMessages,
  saveFcmToken,
  getFcmToken,
  getDatabaseStatus
};
