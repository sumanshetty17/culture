const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// On a host with a persistent disk (like Render), set DATA_DIR to the disk's folder so accounts and uploads survive restarts.
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, '..', 'data');
try {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.accessSync(dataDir, fs.constants.W_OK);
} catch (e) {
  console.error(`\nERROR: the data folder "${dataDir}" cannot be used (${e.code}).`);
  if (process.env.DATA_DIR) {
    console.error('DATA_DIR is set, but that folder does not exist or is not writable.\n' +
      'On Render this means no Disk is attached at that mount path. Either attach a Disk (it needs a paid instance)\n' +
      'with the same mount path, or delete the DATA_DIR variable to use temporary storage (all data is lost on every restart).\n');
  }
  process.exit(1);
}

function loadSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const file = path.join(dataDir, '.jwt-secret');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const secret = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

function iceServers() {
  const servers = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  if (process.env.TURN_URL) {
    servers.push({
      urls: process.env.TURN_URL.split(',').map((s) => s.trim()),
      username: process.env.TURN_USERNAME || '',
      credential: process.env.TURN_CREDENTIAL || '',
    });
  }
  return servers;
}

module.exports = {
  PORT: Number(process.env.PORT) || 3000,
  dataDir,
  JWT_SECRET: loadSecret(),
  iceServers,
};
