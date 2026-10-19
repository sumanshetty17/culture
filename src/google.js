const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { OAuth2Client } = require('google-auth-library');
const { db, AVATAR_COLORS } = require('./db');

const clientId = process.env.GOOGLE_CLIENT_ID || '';
const client = clientId ? new OAuth2Client(clientId) : null;

const enabled = () => !!client;

// Verifies the ID token Google gave the browser (signature, expiry and that it was issued for OUR client id).
async function verifyCredential(credential) {
  const ticket = await client.verifyIdToken({ idToken: credential, audience: clientId });
  const p = ticket.getPayload();
  return { sub: p.sub, email: p.email, emailVerified: !!p.email_verified, name: p.name || (p.email || '').split('@')[0] };
}

function freeUsername(base) {
  const clean = String(base || '').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 14);
  for (let i = 0; i < 25; i++) {
    const candidate = i === 0 && clean.length >= 3 ? clean : (clean || 'user') + crypto.randomInt(100, 10000);
    if (!db.prepare('SELECT 1 FROM users WHERE username = ?').get(candidate)) return candidate;
  }
  return 'user' + crypto.randomBytes(6).toString('hex');
}

// Finds the account for a Google profile, links it to an existing account with the same
// (verified) email, or creates a brand new one that still has to complete onboarding.
function upsertGoogleUser({ sub, email, emailVerified, name }) {
  if (!sub || !email) throw Object.assign(new Error('Invalid Google profile'), { code: 'INVALID' });
  if (!emailVerified) throw Object.assign(new Error('Email not verified'), { code: 'UNVERIFIED_EMAIL' });
  const mail = email.trim().toLowerCase();

  const bySub = db.prepare('SELECT * FROM users WHERE google_id = ?').get(sub);
  if (bySub) return bySub;

  const byEmail = db.prepare('SELECT * FROM users WHERE email = ?').get(mail);
  if (byEmail) {
    db.prepare('UPDATE users SET google_id = ?, email_verified = 1 WHERE id = ?').run(sub, byEmail.id);
    return db.prepare('SELECT * FROM users WHERE id = ?').get(byEmail.id);
  }

  const username = freeUsername(mail.split('@')[0]);
  const color = AVATAR_COLORS[crypto.randomInt(AVATAR_COLORS.length)];
  // Google accounts get an unguessable password; they sign in through Google.
  const hash = bcrypt.hashSync(crypto.randomBytes(24).toString('hex'), 10);
  const info = db
    .prepare('INSERT INTO users (username, email, display_name, password_hash, avatar_color, google_id, password_set, email_verified) VALUES (?, ?, ?, ?, ?, ?, 0, 1)')
    .run(username, mail, String(name || username).trim().slice(0, 40) || username, hash, color, sub);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
}

module.exports = { enabled, verifyCredential, upsertGoogleUser };
