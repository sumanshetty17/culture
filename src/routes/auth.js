const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { db, toPublicUser } = require('../db');
const google = require('../google');
const { sign, issueMediaCookie, clearMediaCookie } = require('../auth');
const otp = require('../otp');
const notify = require('../notify');
const signup = require('../signup');
const { normalizePhone, passwordError } = require('../validate');

const router = express.Router();

const privateUser = (u) => ({
  ...toPublicUser(u),
  email: u.email,
  birthDate: u.birth_date,
  interestedIn: u.interested_in,
  onboarded: !!u.onboarded,
  emailVerified: !!u.email_verified,
  phone: u.phone,
  hasPassword: !!u.password_set,
  googleLinked: !!u.google_id,
});

const limiter = (n) => rateLimit({ windowMs: 15 * 60 * 1000, limit: Number(process.env.OTP_RATE_LIMIT) || n, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many attempts. Try again later.' } });
const otpLimiter = limiter(20);
const checkLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: Number(process.env.CHECK_RATE_LIMIT) || 300, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many checks. Slow down a little.' } });

function startSession(req, res, user, status = 200) {
  const token = sign(user); issueMediaCookie(req, res, token);
  res.status(status).json({ token, user: privateUser(user) });
}
const smsOrEmailDown = (res, channel) => res.status(503).json({ error: channel === 'sms' ? 'Text-message codes are not available right now. Use your email instead.' : 'Email codes are not available right now.' });
const sendTo = (channel, destination, code, subject) => (channel === 'sms'
  ? notify.sendSms(destination, notify.codeMessage(code))
  : notify.sendEmail(destination, subject, notify.codeMessage(code)));

/* ---------------- sign-up: details -> code to email AND phone -> account ---------------- */

// Live "is it free?" checks for the red/green messages under the fields.
router.get('/availability', checkLimiter, (req, res) => res.json(signup.availability(req.query)));

router.post('/signup/start', otpLimiter, async (req, res) => {
  if (!notify.emailAvailable() || !notify.smsAvailable()) return res.status(503).json({ error: 'Sign-up is not available right now (email and text messages are not set up on this server).' });
  let s;
  try { s = signup.start(req.body || {}); }
  catch (e) {
    if (e.code === 'LIMIT') return res.status(429).json({ error: e.message });
    if (e.status) return res.status(e.status).json({ error: e.message, fields: e.fields });
    console.error(e); return res.status(500).json({ error: 'Something went wrong.' });
  }
  const results = await Promise.allSettled([
    notify.sendEmail(s.values.email, 'Your Connectly sign-up code', notify.codeMessage(s.codes.email)),
    notify.sendSms(s.values.phone, notify.codeMessage(s.codes.phone)),
  ]);
  const [mailRes, smsRes] = results;
  if (mailRes.status === 'rejected' || smsRes.status === 'rejected') {
    db.prepare('DELETE FROM pending_signups WHERE id = ?').run(s.id);
    const fields = {};
    if (mailRes.status === 'rejected') { fields.email = 'We could not send an email to this address. Check it and try again.'; console.error('signup email:', mailRes.reason.message); }
    if (smsRes.status === 'rejected') { fields.phone = 'We could not send a text to this number. Check it and try again.'; console.error('signup sms:', smsRes.reason.message); }
    return res.status(502).json({ error: 'The codes could not be sent.', fields });
  }
  res.json({ signupId: s.id, email: s.values.email, phone: s.values.phone, retryAfter: 60 });
});

router.post('/signup/resend', otpLimiter, async (req, res) => {
  const channel = req.body?.channel === 'phone' ? 'phone' : 'email';
  try {
    const r = signup.resend(String(req.body?.signupId || ''), channel);
    await sendTo(channel === 'phone' ? 'sms' : 'email', r.destination, r.code, 'Your Connectly sign-up code');
    res.json({ ok: true, retryAfter: 60 });
  } catch (e) {
    if (e.code === 'LIMIT') return res.status(429).json({ error: e.message });
    if (e.status) return res.status(e.status).json({ error: e.message, retryAfter: e.retryAfter });
    console.error(e.message); res.status(502).json({ error: 'We could not send the code. Please try again.' });
  }
});

router.post('/signup/verify', otpLimiter, (req, res) => {
  const channel = req.body?.channel === 'phone' ? 'phone' : 'email';
  try {
    const r = signup.verify(String(req.body?.signupId || ''), channel, req.body?.code);
    if (!r.ok) return res.status(400).json({ error: 'That code is wrong or has expired.' });
    if (r.user) return startSession(req, res, r.user, 201); // both proven: account created and logged in
    res.json({ done: false, emailVerified: r.emailVerified, phoneVerified: r.phoneVerified });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, fields: e.fields });
    console.error(e); res.status(500).json({ error: 'Something went wrong.' });
  }
});

/* ---------------- log in ---------------- */

// Which account does "username, phone number or email" mean, and where should the code go?
function resolveLogin(identifier) {
  const id = String(identifier || '').trim();
  if (!id) return null;
  if (id.includes('@')) {
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(id.toLowerCase());
    return { channel: 'email', user, destination: user && user.email };
  }
  const phone = /^[+\d][\d\s().-]{6,}$/.test(id) ? normalizePhone(id) : null;
  if (phone) {
    const user = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
    if (user) return { channel: 'sms', user, destination: phone };
  }
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(id);
  // a username code goes to the phone number on the account (or the email if there is no phone)
  if (user && user.phone && notify.smsAvailable()) return { channel: 'sms', user, destination: user.phone };
  return { channel: 'email', user, destination: user && user.email };
}

router.post('/login-code', otpLimiter, (req, res) => {
  const target = resolveLogin(req.body?.identifier);
  if (!target) return res.status(400).json({ error: 'Enter your username, phone number or email.' });
  if (target.channel === 'sms' && !notify.smsAvailable()) return smsOrEmailDown(res, 'sms');
  if (target.channel === 'email' && !notify.emailAvailable()) return smsOrEmailDown(res, 'email');
  if (target.user) {
    try {
      const code = otp.create({ userId: target.user.id, purpose: 'login', channel: target.channel, destination: target.destination });
      sendTo(target.channel, target.destination, code, 'Your Connectly login code').catch((e) => console.error('Could not send login code:', e.message)); // not awaited: same speed whether or not the account exists
    } catch (e) { if (e.code !== 'COOLDOWN' && e.code !== 'LIMIT') console.error(e); }
  }
  res.json({ ok: true, retryAfter: 60 }); // the same answer for every identifier, so it cannot be used to look people up
});

router.post('/login-verify', otpLimiter, (req, res) => {
  const target = resolveLogin(req.body?.identifier);
  const row = target && target.user && otp.verify({ userId: target.user.id, purpose: 'login', destination: target.destination, code: req.body?.code });
  if (!row) return res.status(400).json({ error: 'That code is wrong or has expired.' });
  if (target.channel === 'email' && !target.user.email_verified) db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(target.user.id);
  startSession(req, res, db.prepare('SELECT * FROM users WHERE id = ?').get(target.user.id));
});

// Optional: members who have a password can still use it.
router.post('/login', (req, res) => {
  const identifier = String(req.body?.identifier || '').trim();
  const password = String(req.body?.password || '');
  const user = db.prepare('SELECT * FROM users WHERE username = ? OR email = ? OR phone = ?').get(identifier, identifier, normalizePhone(identifier) || '-');
  if (!user || !user.password_set || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Wrong username, phone number, email or password.' });
  }
  startSession(req, res, user);
});

// "Continue with Google": the browser sends the Google ID token, we verify it with Google's keys.
router.post('/google', async (req, res) => {
  if (!google.enabled()) return res.status(503).json({ error: 'Google sign-in is not set up on this server.' });
  try {
    const profile = await google.verifyCredential(String(req.body?.credential || ''));
    startSession(req, res, google.upsertGoogleUser(profile));
  } catch (e) {
    const msg = e.code === 'UNVERIFIED_EMAIL' ? 'Your Google email address is not verified.' : 'Google sign-in failed. Please try again.';
    res.status(401).json({ error: msg });
  }
});

// ---------- forgot password: a code goes to the email or phone on the account ----------

// Works out which account and which channel an identifier (email, phone or username) refers to.
function resolveRecovery(identifier) {
  const id = String(identifier || '').trim();
  if (!id) return null;
  if (id.includes('@')) {
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(id.toLowerCase());
    return { channel: 'email', user, destination: user && user.email };
  }
  const phone = /^[+\d][\d\s().-]{6,}$/.test(id) ? normalizePhone(id) : null;
  if (phone) {
    const user = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
    return { channel: 'sms', user, destination: phone };
  }
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(id);
  return { channel: 'email', user, destination: user && user.email };
}

router.post('/forgot', otpLimiter, (req, res) => {
  const target = resolveRecovery(req.body?.identifier);
  if (!target) return res.status(400).json({ error: 'Enter your email, username or phone number.' });
  if (target.channel === 'sms' && !notify.smsAvailable()) return res.status(503).json({ error: 'Text-message codes are not available right now. Use your email instead.' });
  if (target.channel === 'email' && !notify.emailAvailable()) return res.status(503).json({ error: 'Email codes are not available right now.' });

  if (target.user) {
    try {
      const code = otp.create({ userId: target.user.id, purpose: 'reset', channel: target.channel, destination: target.destination });
      const send = target.channel === 'sms'
        ? notify.sendSms(target.destination, notify.codeMessage(code))
        : notify.sendEmail(target.destination, 'Your Connectly password reset code', notify.codeMessage(code));
      send.catch((e) => console.error('Could not send reset code:', e.message)); // not awaited: same response time whether or not the account exists
    } catch (e) {
      if (e.code !== 'COOLDOWN') console.error(e); // on cooldown we silently skip so nothing leaks
    }
  }
  // Same answer whether or not an account exists, so nobody can probe which emails/phones are registered.
  res.json({ ok: true, retryAfter: 60 });
});

router.post('/reset', otpLimiter, (req, res) => {
  const bad = () => res.status(400).json({ error: 'That code is wrong or has expired.' });
  const target = resolveRecovery(req.body?.identifier);
  const pwErr = passwordError(req.body?.newPassword);
  if (pwErr) return res.status(400).json({ error: pwErr });
  if (!target || !target.user) return bad();

  const row = otp.verify({ userId: target.user.id, purpose: 'reset', destination: target.destination, code: req.body?.code });
  if (!row) return bad();

  db.prepare('UPDATE users SET password_hash = ?, password_set = 1, token_version = token_version + 1, email_verified = CASE WHEN ? = 1 THEN 1 ELSE email_verified END WHERE id = ?')
    .run(bcrypt.hashSync(String(req.body.newPassword), 10), target.channel === 'email' ? 1 : 0, target.user.id);
  req.app.get('io').in(`user:${target.user.id}`).disconnectSockets(true); // sign out every other device
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(target.user.id);
  notify.sendEmail(user.email, 'Your Connectly password was changed', 'Your password was just reset. If this was not you, reset it again right away and review your account.')
    .catch(() => {});
  const token = sign(user); issueMediaCookie(req, res, token);
  res.json({ token, user: privateUser(user) }); // they are logged in straight away
});

router.post('/logout', (req, res) => { clearMediaCookie(res); res.json({ ok: true }); });

module.exports = router;
module.exports.privateUser = privateUser;
