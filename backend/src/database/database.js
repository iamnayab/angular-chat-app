/**
 * Database Module for PostgreSQL (Render Cloud / Remote) & Local JSON File Fallback
 * 
 * Strict Security: Only stores AES-256 encrypted IV + Ciphertext. Never stores plaintext or passwords!
 */

const fs = require("fs");
const path = require("path");

let pgPool = null;
let usePostgres = false;
let lastDbError = null;

// Local fallback storage file
const LOCAL_DB_PATH = path.join(__dirname, "../chat_data.json");
let localDb = {
  messages: [],
  userStatus: {},
  fcmTokens: {}
};

function loadLocalDb() {
  if (fs.existsSync(LOCAL_DB_PATH)) {
    try {
      const content = fs.readFileSync(LOCAL_DB_PATH, "utf8");
      localDb = JSON.parse(content);
      if (!localDb.messages) localDb.messages = [];
      if (!localDb.userStatus) localDb.userStatus = {};
      if (!localDb.fcmTokens) localDb.fcmTokens = {};
    } catch (e) {
      console.warn("⚠️ Failed reading local db file, initializing fresh store:", e.message);
      localDb = { messages: [], userStatus: {}, fcmTokens: {} };
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

  const isExternalInitial = databaseUrl.includes(".render.com") || databaseUrl.includes("sslmode=require");

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

        // 2. Index
        try {
          await client.query(`CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_id, created_at)`);
        } catch (e) {}

        // 3. Seen columns
        try {
          await client.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS seen BOOLEAN DEFAULT FALSE`);
          await client.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS seen_at BIGINT`);
          await client.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS edited_at BIGINT`);
        } catch (e) {}

        // 4. User status table
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

        // 5. FCM tokens table
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

        console.log("✅ PostgreSQL Database connected & tables verified.");
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

async function saveEncryptedMessage({ id, roomId, iv, ciphertext, senderRole, sentAt = Date.now(), seen = false }) {
  const numericSentAt = Number(sentAt) || Date.now();
  const isSeen = Boolean(seen);
  const targetRoomId = String(roomId || "0202").trim();
  const messageId = id || `msg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

  if (usePostgres && pgPool) {
    try {
      await pgPool.query(
        `INSERT INTO messages (id, room_id, iv, ciphertext, sender_role, created_at, seen)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
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
    seen: isSeen
  };

  if (existingIdx >= 0) {
    localDb.messages[existingIdx] = { ...localDb.messages[existingIdx], ...item };
  } else {
    localDb.messages.push(item);
  }

  persistLocalDb();
  return { success: true, db: "local" };
}

async function getRoomMessages(roomId, limit = 500) {
  const targetRoomId = String(roomId || "0202").trim();

  if (usePostgres && pgPool) {
    try {
      const res = await pgPool.query(
        `SELECT id, room_id, iv, ciphertext, sender_role, created_at, seen, edited_at
         FROM messages
         WHERE room_id = $1
         ORDER BY created_at ASC
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
        editedAt: r.edited_at ? Number(r.edited_at) : undefined
      }));
    } catch (err) {
      console.error("❌ Postgres get messages error:", err.message);
    }
  }

  loadLocalDb();
  return (localDb.messages || [])
    .filter(m => String(m.roomId).trim() === targetRoomId)
    .sort((a, b) => (Number(a.sentAt) || 0) - (Number(b.sentAt) || 0))
    .slice(-limit);
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
      return { success: true, db: "postgres" };
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
    return { success: true, db: "local" };
  }
  return { success: false, error: "Message not found" };
}

async function markMessagesAsSeen(roomId, viewerRole) {
  const targetRoomId = String(roomId || "0202").trim();
  const now = Date.now();
  const senderToMark = viewerRole === "he" ? "she" : "he";

  if (usePostgres && pgPool) {
    try {
      await pgPool.query(
        `UPDATE messages
         SET seen = TRUE, seen_at = $1
         WHERE room_id = $2 AND sender_role = $3 AND (seen IS NULL OR seen = FALSE)`,
        [now, targetRoomId, senderToMark]
      );
      return { success: true, seenAt: now };
    } catch (err) {
      console.error("❌ Postgres mark seen error:", err.message);
    }
  }

  loadLocalDb();
  let changed = false;
  (localDb.messages || []).forEach(m => {
    if (String(m.roomId).trim() === targetRoomId && m.senderRole === senderToMark && !m.seen) {
      m.seen = true;
      m.seenAt = now;
      changed = true;
    }
  });

  if (changed) persistLocalDb();
  return { success: true, seenAt: now };
}

async function saveUserLastSeen(roomId, role, timestamp = Date.now()) {
  const targetRoomId = String(roomId || "0202").trim();
  const cleanRole = String(role).trim().toLowerCase();
  const ts = Number(timestamp) || Date.now();

  if (usePostgres && pgPool) {
    try {
      await pgPool.query(
        `INSERT INTO user_status (room_id, role, last_seen)
         VALUES ($1, $2, $3)
         ON CONFLICT (room_id, role) DO UPDATE SET last_seen = EXCLUDED.last_seen`,
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
    } catch (err) {
      console.error("❌ Postgres clear messages error:", err.message);
    }
  }

  loadLocalDb();
  localDb.messages = (localDb.messages || []).filter(m => String(m.roomId).trim() !== targetRoomId);
  persistLocalDb();
  return true;
}

async function saveFcmToken(roomId, role, token) {
  const targetRoomId = String(roomId || "0202").trim();
  const targetRole = String(role).trim().toLowerCase();
  const now = Date.now();

  if (usePostgres && pgPool) {
    try {
      await pgPool.query(
        `INSERT INTO fcm_tokens (room_id, role, token, updated_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (room_id, role) DO UPDATE SET token = EXCLUDED.token, updated_at = EXCLUDED.updated_at`,
        [targetRoomId, targetRole, token, now]
      );
      return true;
    } catch (err) {
      console.error("❌ Postgres save FCM token error:", err.message);
    }
  }

  loadLocalDb();
  if (!localDb.fcmTokens) localDb.fcmTokens = {};
  localDb.fcmTokens[`${targetRoomId}:${targetRole}`] = { token, updatedAt: now };
  persistLocalDb();
  return true;
}

async function getFcmToken(roomId, role) {
  const targetRoomId = String(roomId || "0202").trim();
  const targetRole = String(role).trim().toLowerCase();

  if (usePostgres && pgPool) {
    try {
      const res = await pgPool.query(
        `SELECT token FROM fcm_tokens WHERE room_id = $1 AND role = $2`,
        [targetRoomId, targetRole]
      );
      if (res.rows.length > 0 && res.rows[0].token) {
        return res.rows[0].token;
      }
    } catch (err) {
      console.error("❌ Postgres get FCM token error:", err.message);
    }
  }

  loadLocalDb();
  const key = `${targetRoomId}:${targetRole}`;
  if (localDb.fcmTokens && localDb.fcmTokens[key]) {
    return localDb.fcmTokens[key].token || null;
  }
  return null;
}

async function getAllFcmTokens(roomId) {
  const targetRoomId = String(roomId || "0202").trim();
  const tokens = {};

  if (usePostgres && pgPool) {
    try {
      const res = await pgPool.query(
        `SELECT role, token FROM fcm_tokens WHERE room_id = $1`,
        [targetRoomId]
      );
      for (const row of res.rows) {
        tokens[row.role] = row.token;
      }
      return tokens;
    } catch (err) {
      console.error("❌ Postgres getAllFcmTokens error:", err.message);
    }
  }

  loadLocalDb();
  if (localDb.fcmTokens) {
    for (const [key, data] of Object.entries(localDb.fcmTokens)) {
      if (key.startsWith(`${targetRoomId}:`)) {
        const role = key.split(":")[1];
        tokens[role] = data.token;
      }
    }
  }
  return tokens;
}

async function removeFcmToken(roomId, role) {
  const targetRoomId = String(roomId || "0202").trim();
  const targetRole = String(role).trim().toLowerCase();

  if (usePostgres && pgPool) {
    try {
      await pgPool.query(`DELETE FROM fcm_tokens WHERE room_id = $1 AND role = $2`, [targetRoomId, targetRole]);
    } catch (e) {}
  }

  loadLocalDb();
  if (localDb.fcmTokens) {
    delete localDb.fcmTokens[`${targetRoomId}:${targetRole}`];
    persistLocalDb();
  }
  return true;
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
  editEncryptedMessage,
  getRoomMessages,
  markMessagesAsSeen,
  saveUserLastSeen,
  getAllUserStatus,
  clearRoomMessages,
  getDatabaseStatus,
  saveFcmToken,
  getFcmToken,
  getAllFcmTokens,
  removeFcmToken
};
