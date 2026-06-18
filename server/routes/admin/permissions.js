const express = require('express');
const router = express.Router();
const { isAuthenticated, hasPermission } = require('../../middlewares/auth');
const { saveDatabase, queryAll, queryOne } = require('../../config/database');
const { logActivity } = require('../../config/activity');

// ============ 权限管理 ============

router.get('/permissions', isAuthenticated, hasPermission('permissions.view'), (req, res) => {
  const db = req.db;

  const allPermissions = queryAll(db, 'SELECT * FROM permissions ORDER BY id ASC');
  const users = queryAll(db, 'SELECT id, username, email, role, status FROM users ORDER BY created_at DESC');

  const userPerms = {};
  users.forEach(u => {
    const perms = queryAll(db, 'SELECT perm_key FROM user_permissions WHERE user_id = ?', [u.id]);
    userPerms[u.id] = perms.map(p => p.perm_key);
  });

  // 获取待审核的权限申请
  const pendingApplications = queryAll(db,
    `SELECT pa.*, u.username, u.email, p.perm_name, p.description 
     FROM permission_applications pa 
     LEFT JOIN users u ON pa.user_id = u.id 
     LEFT JOIN permissions p ON pa.perm_key = p.perm_key 
     WHERE pa.status = 'pending' 
     ORDER BY pa.created_at DESC`
  );

  // 获取所有申请记录
  const allApplications = queryAll(db,
    `SELECT pa.*, u.username, u.email, p.perm_name, p.description,
     r.username as reviewer_name
     FROM permission_applications pa 
     LEFT JOIN users u ON pa.user_id = u.id 
     LEFT JOIN permissions p ON pa.perm_key = p.perm_key 
     LEFT JOIN users r ON pa.reviewed_by = r.id
     ORDER BY pa.created_at DESC`
  );
  // 兼容旧数据库：确保 reject_reason 字段存在
  allApplications.forEach(app => {
    if (app.reject_reason === undefined) app.reject_reason = '';
  });

  res.render('admin/permissions', {
    user: req.session.user,
    permissions: allPermissions,
    users: users,
    userPerms: userPerms,
    pendingApplications: pendingApplications,
    allApplications: allApplications,
    settings: res.locals.settings || {}
  });
});

router.post('/permissions/grant', isAuthenticated, hasPermission('permissions.view'), (req, res) => {
  const db = req.db;
  const { user_id, perm_key } = req.body;

  if (!user_id || !perm_key) {
    return res.status(400).json({ error: '参数不完整' });
  }

  const existing = queryOne(db, 'SELECT id FROM user_permissions WHERE user_id = ? AND perm_key = ?', [user_id, perm_key]);
  if (!existing) {
    const targetUser = queryOne(db, 'SELECT username FROM users WHERE id = ?', [user_id]);
    db.run('INSERT INTO user_permissions (user_id, perm_key, granted_by) VALUES (?, ?, ?)',
      [user_id, perm_key, req.session.user.id]);
    saveDatabase();
    if (targetUser) {
      logActivity(db, { user_id: req.session.user.id, username: req.session.user.username, action: 'grant', target_type: 'permission', target_id: parseInt(user_id), target_title: targetUser.username, detail: '授予权限 ' + perm_key + ' 给用户：' + targetUser.username, ip: req.ip });
    }
  }

  res.redirect('/admin/permissions');
});

router.post('/permissions/revoke', isAuthenticated, hasPermission('permissions.view'), (req, res) => {
  const db = req.db;
  const { user_id, perm_key } = req.body;

  if (!user_id || !perm_key) {
    return res.status(400).json({ error: '参数不完整' });
  }

  const targetUser = queryOne(db, 'SELECT username FROM users WHERE id = ?', [user_id]);
  db.run('DELETE FROM user_permissions WHERE user_id = ? AND perm_key = ?', [user_id, perm_key]);
  saveDatabase();
  if (targetUser) {
    logActivity(db, { user_id: req.session.user.id, username: req.session.user.username, action: 'revoke', target_type: 'permission', target_id: parseInt(user_id), target_title: targetUser.username, detail: '撤销权限 ' + perm_key + ' 从用户：' + targetUser.username, ip: req.ip });
  }
  res.redirect('/admin/permissions');
});

// 批准权限申请
router.post('/permissions/approve', isAuthenticated, hasPermission('permissions.view'), (req, res) => {
  const db = req.db;
  const { application_id } = req.body;

  if (!application_id) {
    return res.status(400).json({ error: '参数不完整' });
  }

  const application = queryOne(db, 'SELECT * FROM permission_applications WHERE id = ? AND status = ?', [application_id, 'pending']);
  if (!application) {
    return res.status(404).json({ error: '申请不存在或已处理' });
  }

  // 授予权限
  const existing = queryOne(db, 'SELECT id FROM user_permissions WHERE user_id = ? AND perm_key = ?', [application.user_id, application.perm_key]);
  if (!existing) {
    db.run('INSERT INTO user_permissions (user_id, perm_key, granted_by) VALUES (?, ?, ?)',
      [application.user_id, application.perm_key, req.session.user.id]);
  }

  // 更新申请状态
  db.run('UPDATE permission_applications SET status = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?',
    ['approved', req.session.user.id, application_id]);
  saveDatabase();

  const targetUser = queryOne(db, 'SELECT username FROM users WHERE id = ?', [application.user_id]);
  if (targetUser) {
    logActivity(db, {
      user_id: req.session.user.id,
      username: req.session.user.username,
      action: 'approve',
      target_type: 'permission_application',
      target_id: application_id,
      target_title: targetUser.username,
      detail: '批准权限申请: ' + application.perm_key + ' 给用户：' + targetUser.username,
      ip: req.ip
    });
  }

  res.json({ success: true, message: '已批准权限申请' });
});

// 拒绝权限申请
router.post('/permissions/reject', isAuthenticated, hasPermission('permissions.view'), (req, res) => {
  const db = req.db;
  const { application_id, reason } = req.body;

  if (!application_id) {
    return res.status(400).json({ error: '参数不完整' });
  }

  const application = queryOne(db, 'SELECT * FROM permission_applications WHERE id = ? AND status = ?', [application_id, 'pending']);
  if (!application) {
    return res.status(404).json({ error: '申请不存在或已处理' });
  }

  // 更新申请状态
  db.run('UPDATE permission_applications SET status = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP, reject_reason = ? WHERE id = ?',
    ['rejected', req.session.user.id, application_id, reason || '']);
  saveDatabase();

  const targetUser = queryOne(db, 'SELECT username FROM users WHERE id = ?', [application.user_id]);
  if (targetUser) {
    logActivity(db, {
      user_id: req.session.user.id,
      username: req.session.user.username,
      action: 'reject',
      target_type: 'permission_application',
      target_id: application_id,
      target_title: targetUser.username,
      detail: '拒绝权限申请: ' + application.perm_key + ' 用户：' + targetUser.username + (reason ? ' 原因：' + reason : ''),
      ip: req.ip
    });
  }

  res.json({ success: true, message: '已拒绝权限申请' });
});

module.exports = router;
