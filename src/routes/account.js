const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { db } = require('../db');
const { requireAuth, sign, issueMediaCookie } = require('../auth');
const files = require('../files');
const { codesRequired } = require('../features');
const { privateUser } = require('./auth');
const otp = require('../otp');
const notify = require('../notify');
const { EMAIL_RE, MSG, normalizePhone, passwordError } = require('../validate');

const router = express.Router();
router.use(requireAuth);

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: Number(process.env.OTP_RATE_LIMIT) || 20, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many attempts. Try again later.' } });
const fresh = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);
const kickEveryone = (req) => req.app.get('io').in(`user:${req.user.id}`).disconnectSockets(true);

const wrongPassword = (res) => res.status(403).json({ error: 'Your current password is not correct.' });

// A login from the last 15 minutes counts as "it is really you". Older sessions have to prove it again:
// with the password, or (for members without a password) with a code sent to their phone / email.
const RECENT_SECONDS = 15 * 60;
const recent = (req) => !!req.tokenIat && Date.now() / 1000 - req.tokenIat < RECENT_SECONDS;
const reauthNeeded = (res) => res.status(403).json({ error: 'For your security, confirm it is you with a code first.', code: 'reauth_required' });

// Changing the phone or email: recent login, or the right password.
function quickConfirm(req, res) {
  const given = req.body?.currentPassword;
  if (req.user.password_set && given) return bcrypt.compareSync(String(given), req.user.password_hash) || (wrongPassword(res), false);
  if (recent(req)) return true;
  if (req.user.password_set) { res.status(403).json({ error: 'Please enter your current password.', code: 'password_required' }); return false; }
  reauthNeeded(res); return false;
}

// Changing the password or deleting the account: the password, or (without one) a recent login.
function strictConfirm(req, res) {
  if (req.user.password_set) return bcrypt.compareSync(String(req.body?.currentPassword || ''), req.user.password_hash) || (wrongPassword(res), false);
  if (recent(req)) return true;
  reauthNeeded(res); return false;
}

router.post('/password', limiter, (req, res) => {
  if (!strictConfirm(req, res)) return;
  const err = passwordError(req.body?.newPassword);
  if (err) return res.status(400).json({ error: err });
  db.prepare('UPDATE users SET password_hash = ?, password_set = 1, token_version = token_version + 1 WHERE id = ?')
    .run(bcrypt.hashSync(String(req.body.newPassword), 10), req.user.id);
  kickEveryone(req);
  const user = fresh(req.user.id);
  notify.sendEmail(user.email, 'Your Connectly password was changed', 'Your password was just changed. If this was not you, reset it right away.').catch(() => {});
  const token = sign(user); issueMediaCookie(req, res, token);
  res.json({ token, user: privateUser(user) });
});

// ----- recovery phone: add (send code, verify code) / remove -----
router.post('/phone/send', limiter, async (req, res) => {
  if (!notify.smsAvailable()) return res.status(503).json({ error: 'Text messages are not available right now.' });
  if (!quickConfirm(req, res)) return;
  const phone = normalizePhone(req.body?.phone);
  if (!phone) return res.status(400).json({ error: MSG.phoneInvalid });
  if (phone === req.user.phone && req.user.phone_verified) return res.status(400).json({ error: 'That is already your phone number.' });
  if (db.prepare('SELECT 1 FROM users WHERE phone = ? AND id != ?').get(phone, req.user.id)) return res.status(409).json({ error: MSG.phoneTaken });
  try {
    const code = otp.create({ userId: req.user.id, purpose: 'phone_verify', channel: 'sms', destination: phone });
    await notify.sendSms(phone, notify.codeMessage(code));
    res.json({ ok: true, retryAfter: 60 });
  } catch (e) {
    if (e.code === 'COOLDOWN') return res.status(429).json({ error: e.message, retryAfter: e.retryAfter });
    console.error(e.message);
    res.status(502).json({ error: 'We could not send the text message. Check the number and try again.' });
  }
});

router.post('/phone/verify', limiter, (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  const row = phone && otp.verify({ userId: req.user.id, purpose: 'phone_verify', destination: phone, code: req.body?.code });
  if (!row) return res.status(400).json({ error: 'That code is wrong or has expired.' });
  if (db.prepare('SELECT 1 FROM users WHERE phone = ? AND id != ?').get(phone, req.user.id)) return res.status(409).json({ error: MSG.phoneTaken });
  db.prepare('UPDATE users SET phone = ?, phone_verified = 1 WHERE id = ?').run(phone, req.user.id);
  notify.sendEmail(req.user.email, 'Your Connectly phone number was changed', `The phone number on your account was changed to ${phone}. If this was not you, reset your access right away.`).catch(() => {});
  res.json({ user: privateUser(fresh(req.user.id)) });
});

// ----- change email: the code goes to the NEW address -----
router.post('/email/send', limiter, async (req, res) => {
  if (!notify.emailAvailable()) return res.status(503).json({ error: 'Email is not available right now.' });
  if (!quickConfirm(req, res)) return;
  const email = String(req.body?.newEmail || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 120) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (email === req.user.email) return res.status(400).json({ error: 'That is already your email address.' });
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) return res.status(409).json({ error: MSG.emailTaken });
  try {
    const code = otp.create({ userId: req.user.id, purpose: 'email_change', channel: 'email', destination: email });
    await notify.sendEmail(email, 'Confirm your new Connectly email', notify.codeMessage(code));
    res.json({ ok: true, retryAfter: 60 });
  } catch (e) {
    if (e.code === 'COOLDOWN') return res.status(429).json({ error: e.message, retryAfter: e.retryAfter });
    console.error(e.message);
    res.status(502).json({ error: 'We could not send the email. Check the address and try again.' });
  }
});

router.post('/email/verify', limiter, (req, res) => {
  const email = String(req.body?.newEmail || '').trim().toLowerCase();
  const row = EMAIL_RE.test(email) && otp.verify({ userId: req.user.id, purpose: 'email_change', destination: email, code: req.body?.code });
  if (!row) return res.status(400).json({ error: 'That code is wrong or has expired.' });
  if (db.prepare('SELECT 1 FROM users WHERE email = ? AND id != ?').get(email, req.user.id)) return res.status(409).json({ error: MSG.emailTaken });
  db.prepare('UPDATE users SET email = ?, email_verified = 1 WHERE id = ?').run(email, req.user.id); // the code proves the new address works
  notify.sendEmail(req.user.email, 'Your Connectly email was changed', `The email on your account was changed to ${email}. If this was not you, contact support right away.`).catch(() => {});
  res.json({ user: privateUser(fresh(req.user.id)) });
});

// ----- confirm the email the user signed up with (also lets them spot a typo) -----
router.post('/email/confirm/send', limiter, async (req, res) => {
  if (req.user.email_verified) return res.status(400).json({ error: 'Your email is already verified.' });
  if (!notify.emailAvailable()) return res.status(503).json({ error: 'Email is not available right now.' });
  try {
    const code = otp.create({ userId: req.user.id, purpose: 'email_verify', channel: 'email', destination: req.user.email });
    await notify.sendEmail(req.user.email, 'Confirm your Connectly email', notify.codeMessage(code));
    res.json({ ok: true, retryAfter: 60 });
  } catch (e) {
    if (e.code === 'COOLDOWN') return res.status(429).json({ error: 'A code was already sent a moment ago.', retryAfter: e.retryAfter });
    console.error(e.message);
    res.status(502).json({ error: 'We could not send the email. Is the address correct?' });
  }
});

router.post('/email/confirm', limiter, (req, res) => {
  const row = otp.verify({ userId: req.user.id, purpose: 'email_verify', destination: req.user.email, code: req.body?.code });
  if (!row) return res.status(400).json({ error: 'That code is wrong or has expired.' });
  db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(req.user.id);
  res.json({ user: privateUser(fresh(req.user.id)) });
});

// ----- "confirm it is you": a code to the current phone (or email) gives a fresh login -----
const reauthTarget = (user) => (user.phone && notify.smsAvailable() ? { channel: 'sms', destination: user.phone } : { channel: 'email', destination: user.email });

router.post('/reauth/send', limiter, async (req, res) => {
  const t = reauthTarget(req.user);
  try {
    const code = otp.create({ userId: req.user.id, purpose: 'reauth', channel: t.channel, destination: t.destination });
    if (t.channel === 'sms') await notify.sendSms(t.destination, notify.codeMessage(code));
    else await notify.sendEmail(t.destination, 'Confirm it is you on Connectly', notify.codeMessage(code));
    res.json({ ok: true, retryAfter: 60, channel: t.channel });
  } catch (e) {
    if (e.code === 'COOLDOWN') return res.status(429).json({ error: e.message, retryAfter: e.retryAfter });
    if (e.code === 'LIMIT') return res.status(429).json({ error: e.message });
    console.error(e.message); res.status(502).json({ error: 'We could not send the code. Please try again.' });
  }
});

router.post('/reauth/verify', limiter, (req, res) => {
  const t = reauthTarget(req.user);
  if (!otp.verify({ userId: req.user.id, purpose: 'reauth', destination: t.destination, code: req.body?.code })) return res.status(400).json({ error: 'That code is wrong or has expired.' });
  const user = fresh(req.user.id);
  const token = sign(user); issueMediaCookie(req, res, token); // a brand new login time; other devices stay signed in
  res.json({ token, user: privateUser(user) });
});

// ----- change phone / email directly (only while verification codes are switched off; the password is needed) -----
router.put('/contact', limiter, (req, res) => {
  if (codesRequired()) return res.status(403).json({ error: 'Changes need a verification code.' });
  if (!strictConfirm(req, res)) return;
  const fields = {}; const updates = {};
  const wantsPhone = req.body?.phone !== undefined && String(req.body.phone).trim() !== '';
  const wantsEmail = req.body?.email !== undefined && String(req.body.email).trim() !== '';
  if (wantsPhone) {
    const p = normalizePhone(req.body.phone);
    if (!p) fields.phone = MSG.phoneInvalid;
    else if (p === req.user.phone) fields.phone = 'That is already your phone number.';
    else if (db.prepare('SELECT 1 FROM users WHERE phone = ? AND id != ?').get(p, req.user.id)) fields.phone = MSG.phoneTaken;
    else updates.phone = p;
  }
  if (wantsEmail) {
    const e = String(req.body.email).trim().toLowerCase();
    if (!EMAIL_RE.test(e) || e.length > 120) fields.email = MSG.emailInvalid;
    else if (e === req.user.email) fields.email = 'That is already your email address.';
    else if (db.prepare('SELECT 1 FROM users WHERE email = ? AND id != ?').get(e, req.user.id)) fields.email = MSG.emailTaken;
    else updates.email = e;
  }
  if (Object.keys(fields).length) return res.status(/already has/.test(Object.values(fields).join(' ')) ? 409 : 400).json({ error: Object.values(fields)[0], fields });
  if (!Object.keys(updates).length) return res.status(400).json({ error: 'Enter a new phone number or email.' });
  if (updates.phone) db.prepare('UPDATE users SET phone = ?, phone_verified = 0 WHERE id = ?').run(updates.phone, req.user.id);
  if (updates.email) db.prepare('UPDATE users SET email = ?, email_verified = 0 WHERE id = ?').run(updates.email, req.user.id);
  res.json({ user: privateUser(fresh(req.user.id)) });
});

// ----- sessions and deletion -----
router.post('/logout-all', (req, res) => {
  db.prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ?').run(req.user.id);
  kickEveryone(req);
  const user = fresh(req.user.id);
  const token = sign(user); issueMediaCookie(req, res, token);
  res.json({ token, user: privateUser(user) }); // this device stays signed in
});

router.delete('/', limiter, (req, res) => {
  if (String(req.body?.confirm || '').trim().toLowerCase() !== req.user.username.toLowerCase()) return res.status(400).json({ error: 'Type your username to confirm.' });
  if (!strictConfirm(req, res)) return;
  files.removeUserFiles(req.user.id); // photos, videos and profile picture
  db.prepare('DELETE FROM users WHERE id = ?').run(req.user.id); // messages and codes go with it
  kickEveryone(req);
  res.json({ ok: true });
});

module.exports = router;
