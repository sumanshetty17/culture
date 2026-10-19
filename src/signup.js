// Sign-up in two steps: (1) details, then a code to the email AND a code to the phone; (2) when both codes are
// right, the account is created. Until then nothing is reserved, so nobody can squat on someone else's number.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { db, AVATAR_COLORS } = require('./db');
const { JWT_SECRET } = require('./config');
const otp = require('./otp');
const { EMAIL_RE, USERNAME_RE, MSG, normalizePhone } = require('./validate');

const CODE_TTL_MS = 10 * 60 * 1000;
const COOLDOWN_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;
const PENDING_TTL_MS = 60 * 60 * 1000;

const exists = (col, value) => !!db.prepare(`SELECT 1 FROM users WHERE ${col} = ?`).get(value);
const hash = (code, id, channel, destination) => crypto.createHmac('sha256', JWT_SECRET).update(`${code}|${id}|${channel}|${destination}`).digest('hex');
const fail = (message, status, extra = {}) => Object.assign(new Error(message), { status, ...extra });

// Checks one field; returns the red message to show, or null when it is fine.
const check = {
  displayName: (v) => (String(v || '').trim().length >= 1 && String(v).trim().length <= 40 ? null : MSG.nameInvalid),
  username: (v) => {
    const u = String(v || '').trim();
    if (!USERNAME_RE.test(u)) return MSG.usernameFormat;
    return exists('username', u) ? MSG.usernameTaken : null; // the column is case-insensitive: "Ana" and "ana" are the same
  },
  email: (v) => {
    const e = String(v || '').trim().toLowerCase();
    if (!EMAIL_RE.test(e) || e.length > 120) return MSG.emailInvalid;
    return exists('email', e) ? MSG.emailTaken : null;
  },
  phone: (v) => {
    const p = normalizePhone(v);
    if (!p) return MSG.phoneInvalid;
    return exists('phone', p) ? MSG.phoneTaken : null;
  },
};

// Live checks while typing (only the fields that were sent).
function availability(query) {
  const out = {};
  for (const field of ['username', 'email', 'phone']) {
    if (query[field] === undefined || query[field] === '') continue;
    const message = check[field](query[field]);
    out[field] = { ok: !message, message, ...(field === 'phone' && !message ? { normalized: normalizePhone(query[field]) } : {}) };
  }
  return out;
}

function issue(id, channel, destination) {
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  db.prepare(`UPDATE pending_signups SET ${channel}_hash = ?, ${channel}_sent_at = ?, ${channel}_attempts = 0 WHERE id = ?`)
    .run(hash(code, id, channel, destination), Date.now(), id);
  otp.capRecord(destination);
  return code;
}

// Step 1: validate everything, remember the details, and make one code for the email and one for the phone.
function start(input) {
  const fields = {};
  for (const f of ['displayName', 'username', 'email', 'phone']) { const m = check[f](input[f]); if (m) fields[f] = m; }
  if (Object.keys(fields).length) {
    const taken = Object.values(fields).some((m) => /already/.test(m));
    throw fail('Please fix the highlighted fields.', taken ? 409 : 400, { fields });
  }
  const values = { name: String(input.displayName).trim(), username: String(input.username).trim(), email: String(input.email).trim().toLowerCase(), phone: normalizePhone(input.phone) };
  otp.capCheck(values.email); otp.capCheck(values.phone);
  const id = crypto.randomBytes(16).toString('hex');
  db.prepare('DELETE FROM pending_signups WHERE email = ? OR phone = ?').run(values.email, values.phone); // a retry replaces the earlier attempt
  db.prepare('INSERT INTO pending_signups (id, display_name, username, email, phone, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, values.name, values.username, values.email, values.phone, Date.now());
  return { id, values, codes: { email: issue(id, 'email', values.email), phone: issue(id, 'phone', values.phone) } };
}

const pending = (id) => {
  const row = db.prepare('SELECT * FROM pending_signups WHERE id = ?').get(String(id || ''));
  if (!row || Date.now() - row.created_at > PENDING_TTL_MS) throw fail('This sign-up has expired. Please start again.', 410);
  return row;
};

function resend(id, channel) {
  const row = pending(id);
  const sentAt = row[`${channel}_sent_at`];
  if (sentAt && Date.now() - sentAt < COOLDOWN_MS) throw fail('Please wait a moment before asking for another code.', 429, { retryAfter: Math.ceil((COOLDOWN_MS - (Date.now() - sentAt)) / 1000) });
  const destination = row[channel];
  otp.capCheck(destination);
  return { code: issue(row.id, channel, destination), destination };
}

// Step 2: check one code. When the second one is right the account is created and returned.
function verify(id, channel, code) {
  const row = pending(id);
  const bad = { ok: false };
  if (!row[`${channel}_verified`]) {
    const clean = String(code || '').replace(/\s/g, '');
    const fresh = row[`${channel}_sent_at`] && Date.now() - row[`${channel}_sent_at`] < CODE_TTL_MS;
    if (!fresh || row[`${channel}_attempts`] >= MAX_ATTEMPTS) return bad;
    const expected = Buffer.from(row[`${channel}_hash`] || '', 'hex');
    const given = Buffer.from(hash(/^\d{6}$/.test(clean) ? clean : 'x', row.id, channel, row[channel]), 'hex');
    const match = /^\d{6}$/.test(clean) && expected.length === given.length && crypto.timingSafeEqual(expected, given);
    if (!match) { db.prepare(`UPDATE pending_signups SET ${channel}_attempts = ${channel}_attempts + 1 WHERE id = ?`).run(row.id); return bad; }
    db.prepare(`UPDATE pending_signups SET ${channel}_verified = 1 WHERE id = ?`).run(row.id);
  }
  const now = pending(id);
  if (!(now.email_verified && now.phone_verified)) return { ok: true, emailVerified: !!now.email_verified, phoneVerified: !!now.phone_verified };

  // both proven: create the account (re-checking, in case someone else took the name in the meantime)
  const again = {};
  for (const f of ['username', 'email', 'phone']) { const m = check[f](now[f]); if (m) again[f] = m; }
  if (Object.keys(again).length) { db.prepare('DELETE FROM pending_signups WHERE id = ?').run(now.id); throw fail('Something you chose was just taken. Please start again.', 409, { fields: again }); }
  const hashPw = bcrypt.hashSync(crypto.randomBytes(24).toString('hex'), 10); // no password yet; they log in with codes
  const info = db
    .prepare('INSERT INTO users (username, email, display_name, password_hash, avatar_color, phone, email_verified, password_set) VALUES (?, ?, ?, ?, ?, ?, 1, 0)')
    .run(now.username, now.email, now.display_name, hashPw, AVATAR_COLORS[crypto.randomInt(AVATAR_COLORS.length)], now.phone);
  db.prepare('DELETE FROM pending_signups WHERE id = ?').run(now.id);
  return { ok: true, user: db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid) };
}

module.exports = { availability, start, resend, verify };
