/**
 * 私信 API 路由（供 Flutter App 使用）
 * 接口：
 *   GET   /api/v1/conversations            —— 会话列表（含对方信息/最后一条消息/未读数）
 *   POST  /api/v1/conversations            —— 创建会话（或复用已有会话）
 *   GET   /api/v1/conversations/:id        —— 会话消息列表（分页）
 *   POST  /api/v1/conversations/:id        —— 发送消息
 *   PATCH /api/v1/conversations/:id/read   —— 标记会话消息已读
 *   GET   /api/v1/unread-total             —— 未读消息总数
 * 安全要点：
 *   - 所有会话操作先校验"当前用户是否是该会话成员"，防越权；
 *   - 消息内容经 html-sanitizer 纯文本净化（去除全部 HTML 标签）；
 *   - 尊重对方 user_message_settings 的私信接收设置。
 */

const express = require('express');
const { queryOne, queryAll, getDb, saveDatabase } = require('../../config/database');
const { apiAuth } = require('../../middlewares/api-auth');
const { sanitize } = require('../../utils/html-sanitizer');

const router = express.Router();

// ============ 会话列表 ============
// 通过 CASE WHEN 动态取"对方"的用户信息；附带最后一条消息与未读数
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
// 校验目标用户存在/激活、不能和自己聊、尊重对方消息设置；
// 已存在会话则直接复用返回。
router.post('/conversations', apiAuth, (req, res) => {
  const db = getDb();
  const userId = req.apiUser.id;
  const targetUserId = parseInt(req.body.user_id);

  if (targetUserId === userId) {
    return res.status(400).json({ error: '不能和自己聊天' });
  }
  const target = queryOne(db, 'SELECT id FROM users WHERE id = ? AND status = ?', [targetUserId, 'active']);
  if (!target) return res.status(404).json({ error: '用户不存在' });

  // 消息设置校验（allow_from 非 all 则拒绝接收私信）
  const settings = queryOne(db, 'SELECT allow_from FROM user_message_settings WHERE user_id = ?', [targetUserId]);
  if (settings && settings.allow_from !== 'all') {
    return res.status(403).json({ error: '对方不允许接收私信' });
  }

  // 双向查询避免重复创建会话（A-B 与 B-A 视为同一会话）
  const existing = queryOne(db,
    'SELECT id FROM conversations WHERE (user1_id = ? AND user2_id = ?) OR (user1_id = ? AND user2_id = ?)',
    [userId, targetUserId, targetUserId, userId]);
  if (existing) {
    return res.json({ id: existing.id });
  }

  // 创建新会话并返回其 ID
  db.run('INSERT INTO conversations (user1_id, user2_id) VALUES (?, ?)', [userId, targetUserId]);
  const created = queryOne(db,
    'SELECT id FROM conversations WHERE (user1_id = ? AND user2_id = ?) OR (user1_id = ? AND user2_id = ?)',
    [userId, targetUserId, targetUserId, userId]);
  saveDatabase();
  res.json({ id: created.id });
});

// ============ 消息列表 ============
// 越权防护：先校验当前用户是会话成员，再取消息（时间倒序分页）
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
// 内容净化（纯文本）+ 长度限制 + 会话成员校验 + 对方消息设置校验
router.post('/conversations/:id', apiAuth, (req, res) => {
  const db = getDb();
  const conversationId = parseInt(req.params.id);
  const userId = req.apiUser.id;
  const content = (req.body.content || '').trim();

  if (!content) return res.status(400).json({ error: '消息内容不能为空' });

  // 净化消息内容（纯文本，去除所有 HTML 标签）
  const safeContent = sanitize(content.trim(), { allowedTags: [], allowedAttributes: {} });
  if (safeContent.length > 2000) return res.status(400).json({ error: '消息过长' });

  // 会话成员校验（防向他人会话发消息）
  const conv = queryOne(db,
    'SELECT * FROM conversations WHERE id = ? AND (user1_id = ? OR user2_id = ?)',
    [conversationId, userId, userId]);
  if (!conv) return res.status(403).json({ error: '无权在该会话发送消息' });

  // 对方消息设置校验
  const otherId = conv.user1_id === userId ? conv.user2_id : conv.user1_id;
  const settings = queryOne(db, 'SELECT allow_from FROM user_message_settings WHERE user_id = ?', [otherId]);
  if (settings && settings.allow_from !== 'all') {
    return res.status(403).json({ error: '对方不允许接收私信' });
  }

  // 插入消息 + 更新会话最后消息时间
  db.run(
    'INSERT INTO private_messages (conversation_id, sender_id, content, is_read) VALUES (?, ?, ?, 0)',
    [conversationId, userId, safeContent]
  );
  db.run('UPDATE conversations SET last_message_at = ? WHERE id = ?', [new Date().toISOString(), conversationId]);
  saveDatabase();
  res.json({ success: true });
});

// ============ 标记已读 ============
// 仅标记"对方发给我的"未读消息为已读
router.patch('/conversations/:id/read', apiAuth, (req, res) => {
  const db = getDb();
  const conversationId = parseInt(req.params.id);
  const userId = req.apiUser.id;

  // 越权防护：仅会话成员可标记已读
  const conv = queryOne(db, 'SELECT id FROM conversations WHERE id = ? AND (user1_id = ? OR user2_id = ?)', [conversationId, userId, userId]);
  if (!conv) return res.status(403).json({ error: '无权操作此会话' });

  db.run(
    'UPDATE private_messages SET is_read = 1 WHERE conversation_id = ? AND sender_id != ? AND is_read = 0',
    [conversationId, userId]
  );
  saveDatabase();
  res.json({ success: true });
});

// ============ 未读总数 ============
// 统计当前用户在所有会话中的未读消息数（排除自己发的）
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
