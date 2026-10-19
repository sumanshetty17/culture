const crypto = require('crypto');
const { db } = require('./db');
const { JWT_SECRET } = require('./config');

const TTL_MS = 10 * 60 * 1000;      // a code works for 10 minutes
const COOLDOWN_MS = 60 * 1000;      // one new code per minute per destination
const MAX_ATTEMPTS = 5;             // then the code is dead

const hash = (code, userId, purpose, destination) =>
  crypto.createHmac('sha256', JWT_SECRET).update(`${code}|${userId}|${purpose}|${destination}`).digest('hex');

const HOURLY_CAP = 6; // codes per phone number or email address per hour
function capCheck(destination) {
  const n = db.prepare('SELECT COUNT(*) AS c FROM send_log WHERE destination = ? AND at > ?').get(destination, Date.now() - 3600 * 1000).c;
  if (n >= HOURLY_CAP) throw Object.assign(new Error('Too many codes were requested for this number or address. Please try again in an hour.'), { code: 'LIMIT' });
}
const capRecord = (destination) => db.prepare('INSERT INTO send_log (destination, at) VALUES (?, ?)').run(destination, Date.now());

// Creates a fresh 6-digit code (older unused codes for the same purpose stop working).
function create({ userId, purpose, channel, destination }) {
  const now = Date.now();
  const last = db
    .prepare('SELECT created_at FROM otps WHERE user_id = ? AND purpose = ? AND destination = ? ORDER BY id DESC LIMIT 1')
    .get(userId, purpose, destination);
  if (last && now - last.created_at < COOLDOWN_MS) {
    throw Object.assign(new Error('Please wait before asking for another code.'), {
      code: 'COOLDOWN',
      retryAfter: Math.ceil((COOLDOWN_MS - (now - last.created_at)) / 1000),
    });
  }
  capCheck(destination);
  capRecord(destination);
  db.prepare('UPDATE otps SET used_at = ? WHERE user_id = ? AND purpose = ? AND used_at IS NULL').run(now, userId, purpose);
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  db.prepare('INSERT INTO otps (user_id, purpose, channel, destination, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(userId, purpose, channel, destination, hash(code, userId, purpose, destination), now + TTL_MS, now);
  return code;
}

// Checks a code. A correct code can be used only once; wrong guesses are counted.
function verify({ userId, purpose, destination, code }) {
  const row = db
    .prepare('SELECT * FROM otps WHERE user_id = ? AND purpose = ? AND destination = ? AND used_at IS NULL AND expires_at > ? ORDER BY id DESC LIMIT 1')
    .get(userId, purpose, destination, Date.now());
  if (!row || row.attempts >= MAX_ATTEMPTS) return null;

  const clean = String(code || '').replace(/\s/g, '');
  const given = Buffer.from(hash(/^\d{6}$/.test(clean) ? clean : '000000x', userId, purpose, destination), 'hex');
  const expected = Buffer.from(row.code_hash, 'hex');
  const match = /^\d{6}$/.test(clean) && given.length === expected.length && crypto.timingSafeEqual(given, expected);
  if (!match) {
    db.prepare('UPDATE otps SET attempts = attempts + 1 WHERE id = ?').run(row.id);
    return null;
  }
  db.prepare('UPDATE otps SET used_at = ? WHERE id = ?').run(Date.now(), row.id);
  return row;
}

module.exports = { create, verify, capCheck, capRecord };
