const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('./config');
const { db } = require('./db');
const notify = require('./notify');

// The token carries the user's token_version; bumping it in the database signs the user out everywhere.
const sign = (user) => jwt.sign({ id: user.id, tv: user.token_version || 0 }, JWT_SECRET, { expiresIn: '7d' });

function verify(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

const getUserById = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);

// Returns the user for a verified token payload, or null if the token was revoked.
function userForPayload(payload) {
  const user = payload && getUserById(payload.id);
  return user && (payload.tv || 0) === user.token_version ? user : null;
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const payload = token && verify(token);
  const user = userForPayload(payload);
  if (!user) return res.status(401).json({ error: 'Please log in again.' });
  req.user = user;
  req.tokenIat = payload.iat; // when this login happened (seconds)
  req.rawToken = token;
  next();
}

// <img> and <video> tags cannot send an Authorization header, so the same login token is also kept in a
// HttpOnly cookie that is only ever sent to /media/... (the protected photo and video files).
function issueMediaCookie(req, res, token) {
  res.cookie('cm', token, { httpOnly: true, sameSite: 'lax', path: '/media', maxAge: 7 * 24 * 3600 * 1000, secure: req.secure });
}
function clearMediaCookie(res) { res.clearCookie('cm', { path: '/media' }); }
function readCookie(req, name) {
  const part = (req.headers.cookie || '').split(';').map((s) => s.trim()).find((s) => s.startsWith(name + '='));
  try { return part ? decodeURIComponent(part.slice(name.length + 1)) : null; } catch { return null; }
}

// What is still missing before an account may use the site: a confirmed email and a phone number.
// (If this server cannot send email or text messages at all, requiring a code would lock everyone out, so it is skipped.)
function missingContact(user) {
  if (!user.email_verified && notify.emailAvailable()) return 'email_unverified';
  if (!user.phone && notify.smsAvailable()) return 'phone_required';
  return null;
}
function requireVerified(req, res, next) {
  const why = missingContact(req.user);
  if (!why) return next();
  res.status(403).json({ error: why === 'phone_required' ? 'Please add your phone number first.' : 'Please verify your email first.', code: why });
}

module.exports = { sign, verify, requireAuth, requireVerified, missingContact, getUserById, userForPayload, issueMediaCookie, clearMediaCookie, readCookie };
