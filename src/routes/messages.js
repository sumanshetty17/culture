const express = require('express');
const { db, toPublicUser, toMessage } = require('../db');
const { requireAuth, requireVerified } = require('../auth');

const router = express.Router();
router.use(requireAuth);
router.use(requireVerified);

// One row per person you have talked to, newest first, with unread counts.
router.get('/conversations', (req, res) => {
  const rows = db
    .prepare(
      `SELECT u.*, m.id AS m_id, m.sender_id AS m_sender, m.receiver_id AS m_receiver, m.body AS m_body,
              m.created_at AS m_created, m.read_at AS m_read,
              (SELECT COUNT(*) FROM messages x WHERE x.sender_id = u.id AND x.receiver_id = @me AND x.read_at IS NULL) AS unread
       FROM users u
       JOIN messages m ON m.id = (
         SELECT MAX(id) FROM messages
         WHERE (sender_id = @me AND receiver_id = u.id) OR (sender_id = u.id AND receiver_id = @me)
       )
       WHERE u.id != @me
       ORDER BY m.id DESC`
    )
    .all({ me: req.user.id });

  res.json({
    conversations: rows.map((r) => ({
      user: toPublicUser(r),
      unread: r.unread,
      lastMessage: toMessage({
        id: r.m_id, sender_id: r.m_sender, receiver_id: r.m_receiver, body: r.m_body, created_at: r.m_created, read_at: r.m_read,
      }),
    })),
  });
});

// History with one person. Use ?before=<messageId> to page backwards.
router.get('/messages/:userId', (req, res) => {
  const peer = Number(req.params.userId);
  const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
  const limit = 50;
  const rows = db
    .prepare(
      `SELECT * FROM messages
       WHERE id < @before AND ((sender_id = @me AND receiver_id = @peer) OR (sender_id = @peer AND receiver_id = @me))
       ORDER BY id DESC LIMIT @limit`
    )
    .all({ me: req.user.id, peer, before, limit });
  res.json({ messages: rows.reverse().map(toMessage), hasMore: rows.length === limit });
});

router.post('/messages/:userId/read', (req, res) => {
  const peer = Number(req.params.userId);
  const info = db
    .prepare("UPDATE messages SET read_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE sender_id = ? AND receiver_id = ? AND read_at IS NULL")
    .run(peer, req.user.id);
  if (info.changes) req.app.get('io').to(`user:${peer}`).emit('message:read', { by: req.user.id });
  res.json({ updated: info.changes });
});

module.exports = router;
