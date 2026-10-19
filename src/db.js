const path = require('path');
const Database = require('better-sqlite3');
const { dataDir } = require('./config');
const places = require('./places');

const db = new Database(path.join(dataDir, 'app.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  bio           TEXT NOT NULL DEFAULT '',
  avatar_color  TEXT NOT NULL DEFAULT '#6366f1',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen     TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  receiver_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  read_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_pair ON messages(sender_id, receiver_id, id);
CREATE INDEX IF NOT EXISTS idx_messages_receiver ON messages(receiver_id, read_at);
`);

// Profile / onboarding columns (added in place so existing databases keep working)
const existing = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
for (const [name, def] of [
  ['gender', 'TEXT'],
  ['interested_in', 'TEXT'],
  ['birth_date', 'TEXT'],
  ['city', "TEXT NOT NULL DEFAULT ''"],
  ['interests', "TEXT NOT NULL DEFAULT ''"],
  ['onboarded', 'INTEGER NOT NULL DEFAULT 0'],
  ['google_id', 'TEXT'],
  ['phone', 'TEXT'],
  ['place_id', 'TEXT'],
  ['avatar_file', 'TEXT'],
  ['state_id', 'TEXT'],
  ['email_verified', 'INTEGER NOT NULL DEFAULT 0'],
  ['password_set', 'INTEGER NOT NULL DEFAULT 1'],
  ['token_version', 'INTEGER NOT NULL DEFAULT 0'],
]) {
  if (!existing.includes(name)) db.exec(`ALTER TABLE users ADD COLUMN ${name} ${def}`);
}
db.exec('CREATE INDEX IF NOT EXISTS idx_users_discover ON users(onboarded, gender, place_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_users_state ON users(onboarded, gender, state_id)');

// Old accounts: "everyone" no longer exists (it is men / women / others now) and a place is required,
// so these members go through the short setup again (their answers are pre-filled).
db.exec("UPDATE users SET interested_in = NULL WHERE interested_in = 'everyone'");
db.exec("UPDATE users SET onboarded = 0 WHERE onboarded = 1 AND (place_id IS NULL OR interested_in IS NULL)");
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google ON users(google_id) WHERE google_id IS NOT NULL');

db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone ON users(phone) WHERE phone IS NOT NULL');

// Photos and videos on a member's profile (the files themselves live in data/uploads)
db.exec(`
CREATE TABLE IF NOT EXISTS media (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  file       TEXT NOT NULL,
  mime       TEXT NOT NULL,
  size       INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_media_user ON media(user_id, kind, id);
`);

// One-time codes (stored hashed, never in plain text)
db.exec(`
CREATE TABLE IF NOT EXISTS otps (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose     TEXT NOT NULL,
  channel     TEXT NOT NULL,
  destination TEXT NOT NULL,
  code_hash   TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_otps_lookup ON otps(user_id, purpose, destination, id);
`);
// Sign-ups that are not finished yet. Nothing here reserves a username, email or phone: the account is only
// created once BOTH the email code and the phone code have been entered correctly.
db.exec(`
CREATE TABLE IF NOT EXISTS pending_signups (
  id             TEXT PRIMARY KEY,
  display_name   TEXT NOT NULL,
  username       TEXT NOT NULL,
  email          TEXT NOT NULL,
  phone          TEXT NOT NULL,
  email_hash     TEXT, email_sent_at INTEGER, email_attempts INTEGER NOT NULL DEFAULT 0, email_verified INTEGER NOT NULL DEFAULT 0,
  phone_hash     TEXT, phone_sent_at INTEGER, phone_attempts INTEGER NOT NULL DEFAULT 0, phone_verified INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS send_log (destination TEXT NOT NULL, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_send_log ON send_log(destination, at);
`);
const cleanupOtps = () => {
  db.prepare('DELETE FROM otps WHERE created_at < ?').run(Date.now() - 24 * 3600 * 1000);
  db.prepare('DELETE FROM pending_signups WHERE created_at < ?').run(Date.now() - 3600 * 1000);
  db.prepare('DELETE FROM send_log WHERE at < ?').run(Date.now() - 3600 * 1000);
};
cleanupOtps();
setInterval(cleanupOtps, 3600 * 1000).unref();

const AVATAR_COLORS = ['#6366f1', '#ec4899', '#f59e0b', '#10b981', '#06b6d4', '#8b5cf6', '#ef4444', '#14b8a6', '#f97316', '#3b82f6'];

function ageFrom(birth) {
  if (!birth) return null;
  const b = new Date(birth + 'T00:00:00Z');
  if (Number.isNaN(b.getTime())) return null;
  const now = new Date();
  let age = now.getUTCFullYear() - b.getUTCFullYear();
  const m = now.getUTCMonth() - b.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < b.getUTCDate())) age--;
  return age;
}
const splitInterests = (s) => (s ? s.split(',').filter(Boolean) : []);

const toPublicUser = (u) => ({
  id: u.id,
  username: u.username,
  displayName: u.display_name,
  bio: u.bio,
  avatarColor: u.avatar_color,
  createdAt: u.created_at,
  lastSeen: u.last_seen,
  gender: u.gender,
  interestedIn: u.interested_in,
  avatarUrl: u.avatar_file ? '/media/' + u.avatar_file : null,
  avatarThumb: u.avatar_file ? '/media/' + u.avatar_file.replace(/\.webp$/, '_t.webp') : null,
  age: ageFrom(u.birth_date),
  place: u.place_id ? places.get(u.place_id) && (({ id, district, state, stateId, label }) => ({ id, district, state, stateId, label }))(places.get(u.place_id)) : null,
  interests: splitInterests(u.interests),
});

const toMessage = (m) => ({
  id: m.id,
  senderId: m.sender_id,
  receiverId: m.receiver_id,
  body: m.body,
  createdAt: m.created_at,
  readAt: m.read_at,
});

module.exports = { db, toPublicUser, toMessage, ageFrom, splitInterests, AVATAR_COLORS };
