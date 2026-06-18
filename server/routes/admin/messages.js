const express = require('express');
const router = express.Router();
const { isAuthenticated, hasPermission } = require('../../middlewares/auth');
const { saveDatabase, queryAll, queryOne } = require('../../config/database');
const { logActivity } = require('../../config/activity');

// ============ 站内信管理 ============

router.get('/messages', isAuthenticated, hasPermission('messages.admin.view'), (req, res) => {
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

router.get('/messages/send', isAuthenticated, hasPermission('messages.admin.send'), (req, res) => {
  const db = req.db;
  const users = queryAll(db, "SELECT id, username, nickname FROM users WHERE status = 'active' ORDER BY username ASC");

  res.render('admin/messages-send', {
    user: req.session.user,
    users: users,
    settings: res.locals.settings || {},
    prefill: {}
  });
});

router.post('/messages/send', isAuthenticated, hasPermission('messages.admin.send'), (req, res) => {
  const db = req.db;
  const { to_user_id, title, content, is_popup, broadcast } = req.body;

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

  if (broadcast === '1') {
    // 群发需要额外权限
    if (!req.session.user || (req.session.user.role !== 'super_admin' && req.session.user.role !== 'admin')) {
      const userPerms = queryAll(db, 'SELECT perm_key FROM user_permissions WHERE user_id = ?', [req.session.user.id]);
      if (!userPerms.some(p => p.perm_key === 'messages.admin.broadcast')) {
        return res.status(403).json({ error: '您没有群发消息的权限' });
      }
    }
    const allUsers = queryAll(db, "SELECT id FROM users WHERE status = 'active'");
    const stmt = db.prepare('INSERT INTO internal_messages (from_user_id, from_username, to_user_id, title, content, is_popup) VALUES (?, ?, ?, ?, ?, ?)');
    allUsers.forEach(u => {
      stmt.run([req.session.user.id, req.session.user.username, u.id, title, content, popup]);
    });
  } else {
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
      [req.session.user.id, req.session.user.username, to_user_id, title, content, popup]);
  }

  saveDatabase();
  logActivity(db, {
    user_id: req.session.user.id,
    username: req.session.user.username,
    action: 'send_message',
    target_type: 'message',
    target_title: title,
    detail: broadcast === '1' ? '群发站内信「' + title + '」' : '发送站内信「' + title + '」',
    ip: req.ip
  });
  res.redirect('/admin/messages?sent=1');
});

router.post('/messages/delete/:id', isAuthenticated, hasPermission('messages.admin.delete'), (req, res) => {
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

router.post('/messages/broadcast-delete', isAuthenticated, hasPermission('messages.admin.delete'), (req, res) => {
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
