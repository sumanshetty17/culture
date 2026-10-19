const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { db, toPublicUser } = require('../db');
const { requireAuth, requireVerified, verify, userForPayload, readCookie, missingContact } = require('../auth');
const { privateUser } = require('./auth');
const notify = require('../notify');
const files = require('../files');

const LIMITS = { photos: 12, videos: 4, imageBytes: 10 * 1024 * 1024, videoBytes: 50 * 1024 * 1024 };
const MIME = { webp: 'image/webp', mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm' };
const bad = (message, status = 400) => Object.assign(new Error(message), { status });

/* ---------- reading what was uploaded, safely ---------- */

// Takes ONE file from a multipart form into a temporary folder, with a size limit.
function takeFile(maxBytes) {
  const mw = multer({ dest: files.tmpDir, limits: { fileSize: maxBytes, files: 1 } }).single('file');
  return (req, res, next) => mw(req, res, (err) => {
    if (!err) return next();
    const tooBig = err.code === 'LIMIT_FILE_SIZE';
    res.status(tooBig ? 413 : 400).json({ error: tooBig ? `That file is too large (the limit is ${Math.round(maxBytes / 1048576)} MB).` : 'The upload could not be read.' });
  });
}
const cleanup = (req) => { if (req.file) fs.rm(req.file.path, { force: true }, () => {}); };

// Images are decoded and re-encoded, so whatever the file claimed to be, only a real picture gets through,
// and hidden data (like the GPS location inside phone photos) is removed.
async function saveImage(tmpPath, { square }) {
  const opts = { limitInputPixels: 60_000_000, failOn: 'error' };
  let meta;
  try { meta = await sharp(tmpPath, opts).metadata(); } catch { throw bad('That does not look like a valid image. Use a JPEG, PNG, WebP or GIF.'); }
  if (!['jpeg', 'png', 'webp', 'gif'].includes(meta.format)) throw bad('That does not look like a valid image. Use a JPEG, PNG, WebP or GIF.');
  const id = crypto.randomBytes(16).toString('hex');
  const base = () => sharp(tmpPath, opts).rotate(); // fixes phone-photo orientation; metadata is dropped on output
  try {
    if (square) {
      await base().resize(512, 512, { fit: 'cover' }).webp({ quality: 82 }).toFile(path.join(files.uploadDir, `${id}.webp`));
      await base().resize(160, 160, { fit: 'cover' }).webp({ quality: 78 }).toFile(path.join(files.uploadDir, `${id}_t.webp`));
    } else {
      await base().resize(1600, 1600, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toFile(path.join(files.uploadDir, `${id}.webp`));
      await base().resize(400, 400, { fit: 'cover' }).webp({ quality: 75 }).toFile(path.join(files.uploadDir, `${id}_t.webp`));
    }
  } catch { files.removeFile(`${id}.webp`); throw bad('That image could not be processed. Try a different one.'); }
  const size = fs.statSync(path.join(files.uploadDir, `${id}.webp`)).size;
  return { file: `${id}.webp`, size };
}

// Videos are not re-encoded (that needs extra software), so the file signature is checked instead.
function sniffVideo(tmpPath) {
  const buf = Buffer.alloc(12);
  const fd = fs.openSync(tmpPath, 'r');
  try { fs.readSync(fd, buf, 0, 12, 0); } finally { fs.closeSync(fd); }
  if (buf.subarray(4, 8).toString('latin1') === 'ftyp') return buf.subarray(8, 12).toString('latin1') === 'qt  ' ? 'mov' : 'mp4';
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'webm';
  return null;
}
function saveVideo(tmpPath) {
  const ext = sniffVideo(tmpPath);
  if (!ext) throw bad('That does not look like a video. Use MP4, MOV or WebM.');
  const file = `${crypto.randomBytes(16).toString('hex')}.${ext}`;
  fs.copyFileSync(tmpPath, path.join(files.uploadDir, file));
  return { file, ext, size: fs.statSync(path.join(files.uploadDir, file)).size };
}

const uploadLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: Number(process.env.UPLOAD_RATE_LIMIT) || 80, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many uploads. Try again later.' } });

const toItem = (m) => ({
  id: m.id, kind: m.kind, createdAt: m.created_at, mime: m.mime,
  url: '/media/' + m.file, thumb: m.kind === 'photo' ? '/media/' + files.thumbName(m.file) : null,
});

/* ---------- API (logged in + email confirmed) ---------- */
const router = express.Router();
const guard = [requireAuth, requireVerified]; // per route, so other /api paths (like /me before email is confirmed) are untouched

router.post('/me/avatar', guard, uploadLimiter, takeFile(LIMITS.imageBytes), async (req, res) => {
  try {
    if (!req.file) throw bad('Choose a picture first.');
    const { file } = await saveImage(req.file.path, { square: true });
    const old = db.prepare('SELECT avatar_file FROM users WHERE id = ?').get(req.user.id).avatar_file;
    db.prepare('UPDATE users SET avatar_file = ? WHERE id = ?').run(file, req.user.id);
    files.removeFile(old);
    res.json({ user: privateUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)) });
  } catch (e) { res.status(e.status || 500).json({ error: e.status ? e.message : 'Something went wrong.' }); }
  finally { cleanup(req); }
});

router.delete('/me/avatar', guard, (req, res) => {
  files.removeFile(req.user.avatar_file);
  db.prepare('UPDATE users SET avatar_file = NULL WHERE id = ?').run(req.user.id);
  res.json({ user: privateUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)) });
});

// ?kind=photo or ?kind=video
router.post('/me/media', guard, uploadLimiter, (req, res, next) => takeFile(req.query.kind === 'video' ? LIMITS.videoBytes : LIMITS.imageBytes)(req, res, next), async (req, res) => {
  try {
    const kind = req.query.kind === 'video' ? 'video' : 'photo';
    if (!req.file) throw bad('Choose a file first.');
    const count = db.prepare('SELECT COUNT(*) AS c FROM media WHERE user_id = ? AND kind = ?').get(req.user.id, kind).c;
    const max = kind === 'video' ? LIMITS.videos : LIMITS.photos;
    if (count >= max) throw bad(`You can have up to ${max} ${kind}s. Delete one to add another.`);
    let saved, mime;
    if (kind === 'photo') { saved = await saveImage(req.file.path, { square: false }); mime = MIME.webp; }
    else { saved = saveVideo(req.file.path); mime = MIME[saved.ext]; }
    const info = db.prepare('INSERT INTO media (user_id, kind, file, mime, size) VALUES (?, ?, ?, ?, ?)').run(req.user.id, kind, saved.file, mime, saved.size);
    res.status(201).json({ item: toItem(db.prepare('SELECT * FROM media WHERE id = ?').get(info.lastInsertRowid)) });
  } catch (e) { res.status(e.status || 500).json({ error: e.status ? e.message : 'Something went wrong.' }); }
  finally { cleanup(req); }
});

router.delete('/me/media/:id', guard, (req, res) => {
  const m = db.prepare('SELECT * FROM media WHERE id = ? AND user_id = ?').get(Number(req.params.id), req.user.id);
  if (!m) return res.status(404).json({ error: 'Not found.' });
  db.prepare('DELETE FROM media WHERE id = ?').run(m.id);
  files.removeFile(m.file);
  res.json({ ok: true });
});

// Anyone logged in can look at a member's photos and videos (newest first).
router.get('/users/:id/media', guard, (req, res) => {
  const rows = db.prepare('SELECT * FROM media WHERE user_id = ? ORDER BY id DESC').all(Number(req.params.id));
  res.json({ photos: rows.filter((m) => m.kind === 'photo').map(toItem), videos: rows.filter((m) => m.kind === 'video').map(toItem) });
});

/* ---------- the protected files themselves: GET /media/<name> ---------- */
function serve(req, res) {
  const name = String(req.params.file || '');
  if (!/^[a-f0-9]{32}(_t)?\.(webp|mp4|mov|webm)$/.test(name)) return res.status(404).end();
  const user = userForPayload(verify(readCookie(req, 'cm')));
  if (!user) return res.status(401).end();
  if (missingContact(user)) return res.status(403).end();
  const file = path.join(files.uploadDir, name);
  if (!fs.existsSync(file)) return res.status(404).end();
  res.set('Cache-Control', 'private, max-age=31536000, immutable'); // file names never change, so browsers may keep them
  res.sendFile(name, { root: files.uploadDir, dotfiles: 'deny' });
}

module.exports = router;
module.exports.serve = serve;
