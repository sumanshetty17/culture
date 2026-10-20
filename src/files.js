// Where uploaded photos/videos live on disk, and how to delete them.
const fs = require('fs');
const path = require('path');
const { dataDir } = require('./config');
const { db } = require('./db');

const uploadDir = path.join(dataDir, 'uploads');
const tmpDir = path.join(dataDir, 'tmp');
fs.mkdirSync(uploadDir, { recursive: true });
fs.mkdirSync(tmpDir, { recursive: true });

// Leftovers from interrupted uploads are removed at start-up.
for (const f of fs.readdirSync(tmpDir)) fs.rm(path.join(tmpDir, f), { force: true }, () => {});

const thumbName = (file) => file.replace(/\.webp$/, '_t.webp');

// Deletes a stored file (and its small preview for images). Never throws.
function removeFile(file) {
  if (!file || !/^[a-f0-9]{32}(\.(webp|mp4|mov|webm))$/.test(file)) return;
  for (const name of [file, thumbName(file)]) fs.rm(path.join(uploadDir, name), { force: true }, () => {});
}

// Everything a member uploaded (used when an account is deleted).
function removeUserFiles(userId) {
  const user = db.prepare('SELECT avatar_file FROM users WHERE id = ?').get(userId);
  if (user) removeFile(user.avatar_file);
  for (const m of db.prepare('SELECT file FROM media WHERE user_id = ?').all(userId)) removeFile(m.file);
}

module.exports = { uploadDir, tmpDir, thumbName, removeFile, removeUserFiles };
