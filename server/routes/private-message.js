const express = require('express');
const router = express.Router();
const { queryOne, queryAll, getDb, saveDatabase } = require('../config/database');
const { isAuthenticated } = require('../middlewares/auth');
const { createNotification } = require('./community');

// 检查是否可以给目标用户发私信
function canSendMessage(db, senderId, targetUserId) {
  const settings = queryOne(db,
    'SELECT allow_from FROM user_message_settings WHERE user_id = ?',
    [targetUserId]
  );
  const allowFrom = settings ? settings.allow_from : 'all';

  if (allowFrom === 'all') return true;

  const iFollowTarget = queryOne(db,
    'SELECT id FROM user_follows WHERE follower_id = ? AND following_id = ?',
    [senderId, targetUserId]
  );
  const targetFollowsMe = queryOne(db,
    'SELECT id FROM user_follows WHERE follower_id = ? AND following_id = ?',
    [targetUserId, senderId]
  );

  if (allowFrom === 'following') {
    return Boolean(iFollowTarget);
  }
  if (allowFrom === 'mutual') {
    return Boolean(iFollowTarget) && Boolean(targetFollowsMe);
  }
  return false;
}

// 获取私信权限设置
router.get('/api/messages/settings', isAuthenticated, (req, res) => {
  const db = getDb();
  const settings = queryOne(db,
    'SELECT allow_from FROM user_message_settings WHERE user_id = ?',
    [req.session.user.id]
  );
  res.json({
    success: true,
    data: { allow_from: settings ? settings.allow_from : 'all' }
  });
});

// 更新私信权限设置
router.put('/api/messages/settings', isAuthenticated, (req, res) => {
  const db = getDb();
  const { allow_from } = req.body;
  if (!['all', 'following', 'mutual'].includes(allow_from)) {
    return res.status(400).json({ success: false, error: '无效的权限设置' });
  }

  const existing = queryOne(db, 'SELECT user_id FROM user_message_settings WHERE user_id = ?', [req.session.user.id]);
  if (existing) {
    db.run('UPDATE user_message_settings SET allow_from = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?',
      [allow_from, req.session.user.id]);
  } else {
    db.run('INSERT INTO user_message_settings (user_id, allow_from) VALUES (?, ?)',
      [req.session.user.id, allow_from]);
  }
  saveDatabase();
  res.json({ success: true, message: '设置已更新' });
});

// 获取/创建对话
router.post('/api/messages/conversations', isAuthenticated, (req, res) => {
  const db = getDb();
  const userId = req.session.user.id;
  const { target_user_id } = req.body;

  if (!target_user_id) {
    return res.status(400).json({ success: false, error: '缺少目标用户ID' });
  }

  if (userId === target_user_id) {
    return res.status(400).json({ success: false, error: '不能给自己发私信' });
  }

  // 检查目标用户是否存在
  const targetUser = queryOne(db, 'SELECT id FROM users WHERE id = ? AND status = ?', [target_user_id, 'active']);
  if (!targetUser) {
    return res.status(404).json({ success: false, error: '用户不存在' });
  }

  // 检查权限
  if (!canSendMessage(db, userId, target_user_id)) {
    return res.status(403).json({ success: false, error: '对方设置了私信权限，你无法发送私信' });
  }

  // 查找或创建对话
  const minId = Math.min(userId, target_user_id);
  const maxId = Math.max(userId, target_user_id);
  let conv = queryOne(db,
    'SELECT * FROM conversations WHERE user1_id = ? AND user2_id = ?',
    [minId, maxId]
  );

  if (!conv) {
    db.run('INSERT INTO conversations (user1_id, user2_id) VALUES (?, ?)', [minId, maxId]);
    saveDatabase();
    conv = queryOne(db,
      'SELECT * FROM conversations WHERE user1_id = ? AND user2_id = ?',
      [minId, maxId]
    );
  }

  res.json({ success: true, data: conv });
});

// 对话列表
router.get('/api/messages/conversations', isAuthenticated, (req, res) => {
  const db = getDb();
  const userId = req.session.user.id;

  const conversations = queryAll(db, `
    SELECT c.*,
      CASE WHEN c.user1_id = ? THEN c.user2_id ELSE c.user1_id END as other_user_id,
      u.username as other_username, u.nickname as other_nickname, u.avatar as other_avatar,
      (SELECT content FROM private_messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message,
      (SELECT sender_id FROM private_messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) as last_sender_id,
      (SELECT COUNT(*) FROM private_messages WHERE conversation_id = c.id AND is_read = 0 AND sender_id != ?) as unread_count
    FROM conversations c
    JOIN users u ON u.id = CASE WHEN c.user1_id = ? THEN c.user2_id ELSE c.user1_id END
    WHERE c.user1_id = ? OR c.user2_id = ?
    ORDER BY c.last_message_at DESC
  `, [userId, userId, userId, userId, userId]);

  res.json({ success: true, data: conversations || [] });
});

// 对话详情（消息列表）
router.get('/api/messages/conversations/:id', isAuthenticated, (req, res) => {
  const db = getDb();
  const userId = req.session.user.id;
  const convId = parseInt(req.params.id);
  const page = parseInt(req.query.page) || 1;
  const limit = Math.min(parseInt(req.query.limit) || 20, 50);
  const offset = (page - 1) * limit;

  // 验证用户属于此对话
  const conv = queryOne(db,
    'SELECT * FROM conversations WHERE id = ? AND (user1_id = ? OR user2_id = ?)',
    [convId, userId, userId]
  );
  if (!conv) {
    return res.status(404).json({ success: false, error: '对话不存在' });
  }

  const otherUserId = conv.user1_id === userId ? conv.user2_id : conv.user1_id;
  const otherUser = queryOne(db, 'SELECT id, username, nickname, avatar FROM users WHERE id = ?', [otherUserId]);

  const messages = queryAll(db, `
    SELECT pm.*, u.username as sender_username, u.nickname as sender_nickname, u.avatar as sender_avatar
    FROM private_messages pm
    JOIN users u ON pm.sender_id = u.id
    WHERE pm.conversation_id = ?
    ORDER BY pm.created_at DESC
    LIMIT ? OFFSET ?
  `, [convId, limit, offset]);

  res.json({
    success: true,
    data: {
      conversation: conv,
      other_user: otherUser,
      messages: messages.reverse(),
      pagination: { page, limit, hasMore: messages.length === limit }
    }
  });
});

// 发送消息
router.post('/api/messages/conversations/:id', isAuthenticated, (req, res) => {
  const db = getDb();
  const userId = req.session.user.id;
  const convId = parseInt(req.params.id);
  const { content } = req.body;

  if (!content || !content.trim()) {
    return res.status(400).json({ success: false, error: '消息内容不能为空' });
  }

  if (content.trim().length > 2000) {
    return res.status(400).json({ success: false, error: '消息内容不能超过2000字' });
  }

  const conv = queryOne(db,
    'SELECT * FROM conversations WHERE id = ? AND (user1_id = ? OR user2_id = ?)',
    [convId, userId, userId]
  );
  if (!conv) {
    return res.status(404).json({ success: false, error: '对话不存在' });
  }

  const targetUserId = conv.user1_id === userId ? conv.user2_id : conv.user1_id;

  // 检查权限
  if (!canSendMessage(db, userId, targetUserId)) {
    return res.status(403).json({ success: false, error: '对方设置了私信权限' });
  }

  db.run(
    'INSERT INTO private_messages (conversation_id, sender_id, content) VALUES (?, ?, ?)',
    [convId, userId, content.trim()]
  );
  db.run(
    'UPDATE conversations SET last_message_at = CURRENT_TIMESTAMP WHERE id = ?',
    [convId]
  );
  saveDatabase();

  // 创建通知
  createNotification(db, {
    userId: targetUserId,
    type: 'private_message',
    title: '新私信',
    content: `用户 ${req.session.user.username} 给你发了一条私信`,
    fromUserId: userId,
    targetType: 'conversation',
    targetId: String(convId)
  });

  const newMessage = queryOne(db,
    'SELECT pm.*, u.username as sender_username, u.nickname as sender_nickname, u.avatar as sender_avatar FROM private_messages pm JOIN users u ON pm.sender_id = u.id WHERE pm.conversation_id = ? ORDER BY pm.id DESC LIMIT 1',
    [convId]
  );

  res.json({ success: true, data: newMessage });
});

// 标记已读
router.patch('/api/messages/conversations/:id/read', isAuthenticated, (req, res) => {
  const db = getDb();
  const userId = req.session.user.id;
  const convId = parseInt(req.params.id);

  db.run(
    'UPDATE private_messages SET is_read = 1 WHERE conversation_id = ? AND sender_id != ? AND is_read = 0',
    [convId, userId]
  );
  saveDatabase();
  res.json({ success: true });
});

// 未读总数
router.get('/api/messages/unread-total', isAuthenticated, (req, res) => {
  const db = getDb();
  const userId = req.session.user.id;
  const count = queryOne(db, `
    SELECT COUNT(*) as count FROM private_messages pm
    JOIN conversations c ON pm.conversation_id = c.id
    WHERE (c.user1_id = ? OR c.user2_id = ?) AND pm.sender_id != ? AND pm.is_read = 0
  `, [userId, userId, userId]);
  res.json({ success: true, data: { count: count ? count.count : 0 } });
});

module.exports = router;
