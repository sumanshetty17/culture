const { db, toPublicUser, toMessage } = require('./db');
const { verify, getUserById, userForPayload, missingContact } = require('./auth');
const presence = require('./presence');

const MAX_MESSAGE = 2000;
const room = (id) => `user:${id}`;

module.exports = function attachSocket(io) {
  // userId -> { peer }  (an entry exists for both sides of a ringing or active call)
  const calls = new Map();
  const clearCall = (a, b) => { calls.delete(a); calls.delete(b); };

  io.use((socket, next) => {
    const payload = verify(socket.handshake.auth?.token);
    const user = userForPayload(payload);
    if (!user) return next(new Error('unauthorized'));
    if (missingContact(user)) return next(new Error('unverified'));
    socket.user = user;
    next();
  });

  io.on('connection', (socket) => {
    const me = socket.user.id;
    socket.join(room(me));
    if (presence.add(me)) socket.broadcast.emit('presence', { userId: me, online: true });
    socket.emit('presence:list', presence.list());

    // ---------- chat ----------
    socket.on('message:send', (payload, ack = () => {}) => {
      const to = Number(payload?.to);
      const body = String(payload?.body || '').trim();
      if (!body) return ack({ error: 'Message is empty.' });
      if (body.length > MAX_MESSAGE) return ack({ error: `Message is too long (max ${MAX_MESSAGE}).` });
      if (!to || to === me || !getUserById(to)) return ack({ error: 'Recipient not found.' });

      const info = db.prepare('INSERT INTO messages (sender_id, receiver_id, body) VALUES (?, ?, ?)').run(me, to, body);
      const message = toMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(info.lastInsertRowid));
      io.to(room(to)).to(room(me)).emit('message:new', message);
      ack({ ok: true });
    });

    socket.on('typing', ({ to, isTyping } = {}) => {
      if (to) io.to(room(Number(to))).emit('typing', { from: me, isTyping: !!isTyping });
    });

    // ---------- voice / video call signalling ----------
    socket.on('call:invite', ({ to, type } = {}, ack = () => {}) => {
      to = Number(to);
      if (!to || to === me || !getUserById(to)) return ack({ error: 'User not found.' });
      if (!['audio', 'video'].includes(type)) return ack({ error: 'Invalid call type.' });
      if (!presence.isOnline(to)) return ack({ error: 'This person is offline right now.' });
      if (calls.has(me)) return ack({ error: 'You are already in a call.' });
      if (calls.has(to)) return ack({ error: 'This person is busy on another call.' });
      calls.set(me, { peer: to });
      calls.set(to, { peer: me });
      io.to(room(to)).emit('call:incoming', { from: toPublicUser(socket.user), type });
      ack({ ok: true });
    });

    socket.on('call:accept', ({ from } = {}) => {
      from = Number(from);
      if (calls.get(me)?.peer !== from) return;
      socket.to(room(me)).emit('call:handled'); // dismiss ringing on my other tabs
      io.to(room(from)).emit('call:accepted', { by: me });
    });

    socket.on('call:reject', ({ from } = {}) => {
      from = Number(from);
      if (calls.get(me)?.peer !== from) return;
      clearCall(me, from);
      socket.to(room(me)).emit('call:handled');
      io.to(room(from)).emit('call:rejected', { by: me });
    });

    socket.on('call:end', ({ to } = {}) => {
      to = Number(to);
      if (calls.get(me)?.peer !== to) return;
      clearCall(me, to);
      io.to(room(to)).emit('call:ended', { by: me });
    });

    socket.on('call:signal', ({ to, data } = {}) => {
      to = Number(to);
      if (calls.get(me)?.peer !== to || !data) return;
      io.to(room(to)).emit('call:signal', { from: me, data });
    });

    socket.on('disconnect', () => {
      if (!presence.remove(me)) return;
      const call = calls.get(me);
      if (call) {
        clearCall(me, call.peer);
        io.to(room(call.peer)).emit('call:ended', { by: me });
      }
      db.prepare("UPDATE users SET last_seen = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(me);
      io.emit('presence', { userId: me, online: false, lastSeen: new Date().toISOString() });
    });
  });
};
