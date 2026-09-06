/**
 * 站内信管理路由（后台）
 * 能力：
 *   GET  /admin/messages                  —— 站内信列表（支持 ?sent=1 高亮发送成功）
 *   GET  /admin/messages/send             —— 发信页面（可选收件人）
 *   POST /admin/messages/send             —— 发送（单发或群发；群发需 super_admin/admin 或 messages.admin.broadcast 权限）
 *   POST /admin/messages/delete/:id       —— 删除单条
 *   POST /admin/messages/broadcast-delete —— 批量删除
 * 安全要点：标题截断 200 字；内容经 sanitize 纯文本化（去全部 HTML，防存储型 XSS）；
 *           群发权限二次校验；批量删除按单条逐删防注入。
 */

const express = require('express');
const router = express.Router();
const { isAuthenticated, hasPermission } = require('../../middlewares/auth');
const { saveDatabase, queryAll, queryOne } = require('../../config/database');
const { logActivity } = require('../../config/activity');
const { sanitize } = require('../../utils/html-sanitizer');

// ============ 站内信管理 ============

// 站内信列表（关联收件人用户名）
router.get('/messages', isAuthenticated, hasPermission('messages.manage'), (req, res) => {
  const db = req.db;
  const messages = queryAll(db, `
    SELECT m.*, u.username as to_username
    FROM internal_messages m
    LEFT JOIN users u ON m.to_user_id = u.id
    ORDER BY m.created_at DESC
  `);

  res.render('admin/messages', {
    user: req.session.user,
    messages: messages,
    settings: res.locals.settings || {},
    sent: req.query.sent === '1'
  });
});

// 发信页面：拉取全部激活用户作为可选收件人
router.get('/messages/send', isAuthenticated, hasPermission('messages.manage'), (req, res) => {
  const db = req.db;
  const users = queryAll(db, "SELECT id, username, nickname FROM users WHERE status = 'active' ORDER BY username ASC");

  res.render('admin/messages-send', {
    user: req.session.user,
    users: users,
    settings: res.locals.settings || {},
    prefill: {}
  });
});

// 发送站内信（单发或群发）
router.post('/messages/send', isAuthenticated, hasPermission('messages.manage'), (req, res) => {
  const db = req.db;
  const { to_user_id, title, content, is_popup, broadcast } = req.body;

  // 标题/内容必填校验（失败时回显已填内容）
  if (!title || !content) {
    const users = queryAll(db, "SELECT id, username, nickname FROM users WHERE status = 'active' ORDER BY username ASC");
    return res.render('admin/messages-send', {
      user: req.session.user,
      users: users,
      settings: res.locals.settings || {},
      prefill: req.body,
      error: '标题和内容不能为空'
    });
  }

  const popup = is_popup === '1' ? 1 : 0;

  // 站内信按纯文本处理（前端按文本展示），剥离所有 HTML 防止存储型 XSS
  const safeTitle = String(title || '').slice(0, 200);
  const safeContent = sanitize(String(content || ''), { allowedTags: [], allowedAttributes: {} });

  if (broadcast === '1') {
    // ===== 群发分支：需要额外权限（admin/super_admin 角色 或 messages.admin.broadcast 权限点） =====
    if (!req.session.user || (req.session.user.role !== 'super_admin' && req.session.user.role !== 'admin')) {
      const userPerms = queryAll(db, 'SELECT perm_key FROM user_permissions WHERE user_id = ?', [req.session.user.id]);
      if (!userPerms.some(p => p.perm_key === 'messages.admin.broadcast')) {
        return res.status(403).json({ error: '您没有群发消息的权限' });
      }
    }
    // 给全部激活用户逐条插入（预编译语句提升性能）
    const allUsers = queryAll(db, "SELECT id FROM users WHERE status = 'active'");
    const stmt = db.prepare('INSERT INTO internal_messages (from_user_id, from_username, to_user_id, title, content, is_popup) VALUES (?, ?, ?, ?, ?, ?)');
    allUsers.forEach(u => {
      stmt.run([req.session.user.id, req.session.user.username, u.id, safeTitle, safeContent, popup]);
    });
  } else {
    // ===== 单发分支：必须指定收件人 =====
    if (!to_user_id) {
      const users = queryAll(db, "SELECT id, username, nickname FROM users WHERE status = 'active' ORDER BY username ASC");
      return res.render('admin/messages-send', {
        user: req.session.user,
        users: users,
        settings: res.locals.settings || {},
        prefill: req.body,
        error: '请选择接收用户'
      });
    }
    db.run('INSERT INTO internal_messages (from_user_id, from_username, to_user_id, title, content, is_popup) VALUES (?, ?, ?, ?, ?, ?)',
      [req.session.user.id, req.session.user.username, to_user_id, safeTitle, safeContent, popup]);
  }

  saveDatabase();
  logActivity(db, {
    user_id: req.session.user.id,
    username: req.session.user.username,
    action: 'send_message',
    target_type: 'message',
    target_title: safeTitle,
    detail: broadcast === '1' ? '群发站内信「' + safeTitle + '」' : '发送站内信「' + safeTitle + '」',
    ip: req.ip
  });
  res.redirect('/admin/messages?sent=1');
});

// 删除单条站内信
router.post('/messages/delete/:id', isAuthenticated, hasPermission('messages.manage'), (req, res) => {
  const db = req.db;
  const msgId = req.params.id;
  const msg = queryOne(db, 'SELECT title FROM internal_messages WHERE id = ?', [msgId]);
  db.run('DELETE FROM internal_messages WHERE id = ?', [msgId]);
  saveDatabase();
  logActivity(db, {
    user_id: req.session.user.id,
    username: req.session.user.username,
    action: 'delete_message',
    target_type: 'message',
    target_id: msgId,
    target_title: msg ? msg.title : '未知',
    detail: '删除了站内信「' + (msg ? msg.title : '未知') + '」',
    ip: req.ip
  });
  res.redirect('/admin/messages');
});

// 批量删除站内信（ids 可为单个值或数组）
router.post('/messages/broadcast-delete', isAuthenticated, hasPermission('messages.manage'), (req, res) => {
  const db = req.db;
  const ids = req.body.ids;
  let deletedCount = 0;
  if (ids) {
    const idList = Array.isArray(ids) ? ids : [ids];
    idList.forEach(id => {
      db.run('DELETE FROM internal_messages WHERE id = ?', [id]);
      deletedCount++;
    });
  }
  saveDatabase();
  logActivity(db, {
    user_id: req.session.user.id,
    username: req.session.user.username,
    action: 'delete_message',
    target_type: 'message',
    detail: '批量删除了 ' + deletedCount + ' 条站内信',
    ip: req.ip
  });
  res.redirect('/admin/messages');
});

module.exports = router;
