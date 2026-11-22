/**
 * Security & Validation Module
 */

const crypto = require("crypto");

// Default expected room hash (SHA-256 for "0202")
const EXPECTED_ROOM_HASH = process.env.ROOM_HASH || "3472adbbcb9677d1b45365d37d96d1c33217d745567577fd9bd5c2766a258320";

// Sliding window rate limiter for chat actions
const rateLimits = new Map();

function checkRateLimit(key, maxEvents = 10, windowMs = 5000) {
  const now = Date.now();
  let timestamps = rateLimits.get(key) || [];
  timestamps = timestamps.filter(ts => now - ts < windowMs);

  if (timestamps.length >= maxEvents) {
    const oldest = timestamps[0];
    const retryAfter = Math.ceil((oldest + windowMs - now) / 1000);
    return { allowed: false, retryAfterSeconds: Math.max(1, retryAfter) };
  }

  timestamps.push(now);
  rateLimits.set(key, timestamps);
  return { allowed: true };
}

function verifyRoomCredentials(roomId, password) {
  const targetRoomId = String(roomId || "").trim();
  const roomHash = crypto.createHash("sha256").update(targetRoomId).digest("hex");
  
  if (password !== undefined) {
    const passHash = crypto.createHash("sha256").update(String(password || "").trim()).digest("hex");
    return roomHash === EXPECTED_ROOM_HASH && passHash === EXPECTED_ROOM_HASH;
  }
  
  return roomHash === EXPECTED_ROOM_HASH;
}

module.exports = {
  EXPECTED_ROOM_HASH,
  checkRateLimit,
  verifyRoomCredentials
};
