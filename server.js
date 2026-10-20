const path = require('path');
const http = require('http');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Server } = require('socket.io');

const config = require('./src/config');
require('./src/db');
const { requireAuth } = require('./src/auth');
const notify = require('./src/notify');
const { codesRequired } = require('./src/features');
const places = require('./src/places');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.set('io', io);
// Behind a hosting proxy (Render sets RENDER=true) the real visitor address and https come from the proxy
if (process.env.TRUST_PROXY || process.env.RENDER) app.set('trust proxy', Number(process.env.TRUST_PROXY) || 1);

app.get('/healthz', (req, res) => res.type('text').send('ok')); // used by the host to check the site is alive

app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'script-src': ["'self'", 'https://accounts.google.com/gsi/client'],
        'frame-src': ["'self'", 'https://accounts.google.com/gsi/'],
        'media-src': ["'self'", 'blob:'],
        'connect-src': ["'self'", 'ws:', 'wss:', 'https://accounts.google.com/gsi/'],
        'upgrade-insecure-requests': null, // allow plain http on a LAN / localhost
      },
    },
    crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' }, // needed for the Google sign-in popup
    strictTransportSecurity: process.env.NODE_ENV === 'production', // browsers must use https once the site is live
  })
);
app.use(express.json({ limit: '10kb' }));

// public: tells the login page whether to show the Google button
app.get('/api/config', (req, res) => res.json({ googleClientId: process.env.GOOGLE_CLIENT_ID || '', emailEnabled: notify.emailAvailable(), smsEnabled: notify.smsAvailable(), codesRequired: codesRequired(), signupEnabled: !codesRequired() || (notify.emailAvailable() && notify.smsAvailable()) }));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many attempts. Try again later.' } });
app.use('/api/auth', authLimiter, require('./src/routes/auth'));
const mediaRoutes = require('./src/routes/media');
app.get('/media/:file', mediaRoutes.serve); // protected photos and videos (login cookie required)
app.use('/api/account', require('./src/routes/account'));
app.use('/api', mediaRoutes);
app.use('/api', require('./src/routes/users'));
app.use('/api', require('./src/routes/messages'));
// the list behind the place picker (about 80 KB, the browser caches it)
app.get('/api/places', requireAuth, (req, res) => {
  res.set('Cache-Control', 'private, max-age=86400');
  res.json({ places: places.all.map(({ id, district, state, label, aliases }) => ({ id, district, state, label, aliases })) });
});
app.get('/api/ice', requireAuth, (req, res) => res.json({ iceServers: config.iceServers() }));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

app.use(express.static(path.join(__dirname, 'public')));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.status && err.status < 500 ? err.message : 'Something went wrong.' });
});

require('./src/socket')(io);
if (!codesRequired()) console.log('Verification codes are OFF: sign-up and login use a password only. Set REQUIRE_CODES=true to turn them on.');
else {
  if (!notify.emailAvailable()) console.warn('WARNING: REQUIRE_CODES is on but email is not configured (SMTP_HOST).');
  if (!notify.smsAvailable()) console.warn('WARNING: REQUIRE_CODES is on but text messages are not configured (TWILIO_*).');
}

server.listen(config.PORT, () => console.log(`Connectly running at http://localhost:${config.PORT}`));
