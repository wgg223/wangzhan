const express = require('express');
const { queryOne, queryAll, getDb, saveDatabase } = require('../../config/database');
const { apiAuth } = require('../../middlewares/api-auth');
const { sanitize } = require('../../utils/html-sanitizer');

const router = express.Router();

// ============ 会话列表 ============
router.get('/conversations', apiAuth, (req, res) => {
  const db = getDb();
  const userId = req.apiUser.id;

  const rows = queryAll(db, `
    SELECT c.id, c.last_message_at,
      CASE WHEN c.user1_id = ? THEN c.user2_id ELSE c.user1_id END AS other_user_id,
      CASE WHEN c.user1_id = ? THEN u2.username ELSE u1.username END AS other_username,
      CASE WHEN c.user1_id = ? THEN u2.nickname ELSE u1.nickname END AS other_nickname,
      CASE WHEN c.user1_id = ? THEN u2.avatar ELSE u1.avatar END AS other_avatar,
      (SELECT content FROM private_messages pm WHERE pm.conversation_id = c.id ORDER BY pm.created_at DESC LIMIT 1) AS last_message,
      (SELECT COUNT(*) FROM private_messages pm WHERE pm.conversation_id = c.id AND pm.sender_id != ? AND pm.is_read = 0) AS unread_count
    FROM conversations c
    LEFT JOIN users u1 ON c.user1_id = u1.id
    LEFT JOIN users u2 ON c.user2_id = u2.id
    WHERE c.user1_id = ? OR c.user2_id = ?
    ORDER BY c.last_message_at DESC, c.created_at DESC
  `, [userId, userId, userId, userId, userId, userId, userId]);

  res.json({
    conversations: (rows || []).map((r) => ({
      ...r,
      other_name: r.other_nickname || r.other_username,
      other_user_name: r.other_username,
    })),
  });
});

// ============ 创建会话 ============
router.post('/conversations', apiAuth, (req, res) => {
  const db = getDb();
  const userId = req.apiUser.id;
  const targetUserId = parseInt(req.body.user_id);

  if (targetUserId === userId) {
    return res.status(400).json({ error: '不能和自己聊天' });
  }
  const target = queryOne(db, 'SELECT id FROM users WHERE id = ? AND status = ?', [targetUserId, 'active']);
  if (!target) return res.status(404).json({ error: '用户不存在' });

  // 消息设置校验
  const settings = queryOne(db, 'SELECT allow_from FROM user_message_settings WHERE user_id = ?', [targetUserId]);
  if (settings && settings.allow_from !== 'all') {
    return res.status(403).json({ error: '对方不允许接收私信' });
  }

  const existing = queryOne(db,
    'SELECT id FROM conversations WHERE (user1_id = ? AND user2_id = ?) OR (user1_id = ? AND user2_id = ?)',
    [userId, targetUserId, targetUserId, userId]);
  if (existing) {
    return res.json({ id: existing.id });
  }

  db.run('INSERT INTO conversations (user1_id, user2_id) VALUES (?, ?)', [userId, targetUserId]);
  const created = queryOne(db,
    'SELECT id FROM conversations WHERE (user1_id = ? AND user2_id = ?) OR (user1_id = ? AND user2_id = ?)',
    [userId, targetUserId, targetUserId, userId]);
  saveDatabase();
  res.json({ id: created.id });
});

// ============ 消息列表 ============
router.get('/conversations/:id', apiAuth, (req, res) => {
  const db = getDb();
  const conversationId = parseInt(req.params.id);
  const userId = req.apiUser.id;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
  const offset = (page - 1) * limit;

  const conv = queryOne(db,
    'SELECT id FROM conversations WHERE id = ? AND (user1_id = ? OR user2_id = ?)',
    [conversationId, userId, userId]);
  if (!conv) return res.status(403).json({ error: '无权查看该会话' });

  const rows = queryAll(db,
    'SELECT * FROM private_messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
    [conversationId, limit, offset]);
  const total = queryOne(db, 'SELECT COUNT(*) AS count FROM private_messages WHERE conversation_id = ?', [conversationId])?.count || 0;

  res.json({ messages: rows || [], total, page, has_more: offset + rows.length < total });
});

// ============ 发送消息 ============
router.post('/conversations/:id', apiAuth, (req, res) => {
  const db = getDb();
  const conversationId = parseInt(req.params.id);
  const userId = req.apiUser.id;
  const content = (req.body.content || '').trim();

  if (!content) return res.status(400).json({ error: '消息内容不能为空' });

  // 净化消息内容（纯文本，去除所有 HTML 标签）
  const safeContent = sanitize(content.trim(), { allowedTags: [], allowedAttributes: {} });
  if (safeContent.length > 2000) return res.status(400).json({ error: '消息过长' });

  const conv = queryOne(db,
    'SELECT * FROM conversations WHERE id = ? AND (user1_id = ? OR user2_id = ?)',
    [conversationId, userId, userId]);
  if (!conv) return res.status(403).json({ error: '无权在该会话发送消息' });

  const otherId = conv.user1_id === userId ? conv.user2_id : conv.user1_id;
  const settings = queryOne(db, 'SELECT allow_from FROM user_message_settings WHERE user_id = ?', [otherId]);
  if (settings && settings.allow_from !== 'all') {
    return res.status(403).json({ error: '对方不允许接收私信' });
  }

  db.run(
    'INSERT INTO private_messages (conversation_id, sender_id, content, is_read) VALUES (?, ?, ?, 0)',
    [conversationId, userId, safeContent]
  );
  db.run('UPDATE conversations SET last_message_at = ? WHERE id = ?', [new Date().toISOString(), conversationId]);
  saveDatabase();
  res.json({ success: true });
});

// ============ 标记已读 ============
router.patch('/conversations/:id/read', apiAuth, (req, res) => {
  const db = getDb();
  const conversationId = parseInt(req.params.id);
  const userId = req.apiUser.id;
  db.run(
    'UPDATE private_messages SET is_read = 1 WHERE conversation_id = ? AND sender_id != ? AND is_read = 0',
    [conversationId, userId]
  );
  saveDatabase();
  res.json({ success: true });
});

// ============ 未读总数 ============
router.get('/unread-total', apiAuth, (req, res) => {
  const db = getDb();
  const userId = req.apiUser.id;
  const count = queryOne(db, `
    SELECT COUNT(*) AS count FROM private_messages pm
    JOIN conversations c ON pm.conversation_id = c.id
    WHERE pm.sender_id != ? AND pm.is_read = 0 AND (c.user1_id = ? OR c.user2_id = ?)
  `, [userId, userId, userId])?.count || 0;
  res.json({ unread: count });
});

module.exports = router;
