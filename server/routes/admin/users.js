const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { isAuthenticated, hasPermission, ROLE_HIERARCHY } = require('../../middlewares/auth');
const { saveDatabase, queryAll, queryOne, generateUid } = require('../../config/database');
const { logActivity } = require('../../config/activity');
const { createNotification } = require('../community');

// ============ 用户管理 ============

router.get('/users', isAuthenticated, hasPermission('users.view'), (req, res) => {
  const db = req.db;
  const users = queryAll(db, 'SELECT id, uid, username, email, role, status, created_at FROM users ORDER BY created_at DESC');

  res.render('admin/users', {
    user: req.session.user,
    users: users,
    settings: res.locals.settings || {}
  });
});

router.post('/users/create', isAuthenticated, hasPermission('users.create'), (req, res) => {
  const db = req.db;
  const { username, email, password, role } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: '用户名和密码不能为空' });
  }

  if (username.length < 3) {
    return res.status(400).json({ error: '用户名至少3个字符' });
  }

  if (password.length < 6) {
    return res.status(400).json({ error: '密码至少6位' });
  }

  const existingUser = queryOne(db, 'SELECT id FROM users WHERE username = ?', [username]);
  if (existingUser) {
    return res.status(400).json({ error: '用户名已被使用' });
  }

  if (email) {
    const existingEmail = queryOne(db, "SELECT id FROM users WHERE email = ? AND email != ''", [email]);
    if (existingEmail) {
      return res.status(400).json({ error: '邮箱已被使用' });
    }
  }

  const hashedPassword = bcrypt.hashSync(password, 10);
  const userRole = role || 'user';
  const validRoles = ['user', 'visitor', 'admin'];
  if (!validRoles.includes(userRole)) {
    return res.status(400).json({ error: '无效的用户角色' });
  }

  const newUid = generateUid(db);
  db.run("INSERT INTO users (uid, username, password, email, role, status) VALUES (?, ?, ?, ?, ?, 'active')",
    [newUid, username, hashedPassword, email || '', userRole]);

  saveDatabase();
  logActivity(db, { user_id: req.session.user.id, username: req.session.user.username, action: 'create', target_type: 'user', target_id: null, target_title: username, detail: '手动创建账户：' + username + ' (角色: ' + userRole + ')', ip: req.ip });
  res.json({ success: true, message: '账户创建成功' });
});

router.post('/users/approve/:id', isAuthenticated, hasPermission('users.edit'), (req, res) => {
  const db = req.db;
  const targetUser = queryOne(db, 'SELECT username, status FROM users WHERE id = ?', [req.params.id]);
  db.run("UPDATE users SET status = 'active' WHERE id = ?", [req.params.id]);
  saveDatabase();
  if (targetUser) {
    logActivity(db, { user_id: req.session.user.id, username: req.session.user.username, action: 'approve', target_type: 'user', target_id: parseInt(req.params.id), target_title: targetUser.username, detail: '批准用户：' + targetUser.username, ip: req.ip });

    var notifTitle = targetUser.status === 'pending' ? '账号已通过审核' : '账号已启用';
    var notifContent = targetUser.status === 'pending' ? '您的账号已通过管理员审核，现在可以正常使用所有功能。' : '您的账号已被管理员重新启用。';
    createNotification(db, {
      userId: parseInt(req.params.id),
      type: 'account',
      title: notifTitle,
      content: notifContent,
      fromUserId: req.session.user.id,
      targetType: 'account',
      targetId: ''
    });
  }
  res.redirect('/admin/users');
});

router.post('/users/disable/:id', isAuthenticated, hasPermission('users.disable'), (req, res) => {
  const db = req.db;

  if (parseInt(req.params.id) === req.session.user.id) {
    return res.status(400).json({ error: '不能禁用当前登录的管理员账户' });
  }

  const targetUser = queryOne(db, 'SELECT username, role FROM users WHERE id = ?', [req.params.id]);
  if (!targetUser) {
    return res.status(404).json({ error: '用户不存在' });
  }

  const currentUserRoleVal = ROLE_HIERARCHY[req.session.user.role] || 0;
  const targetUserRoleVal = ROLE_HIERARCHY[targetUser.role] || 0;
  if (targetUserRoleVal >= currentUserRoleVal && req.session.user.role !== 'super_admin') {
    return res.status(403).json({ error: '权限不足：不能操作同级别或更高级别的用户' });
  }

  db.run("UPDATE users SET status = 'disabled' WHERE id = ?", [req.params.id]);
  saveDatabase();
  if (targetUser) {
    logActivity(db, { user_id: req.session.user.id, username: req.session.user.username, action: 'disable', target_type: 'user', target_id: parseInt(req.params.id), target_title: targetUser.username, detail: '禁用用户：' + targetUser.username, ip: req.ip });

    createNotification(db, {
      userId: parseInt(req.params.id),
      type: 'account',
      title: '账号已被禁用',
      content: '您的账号已被管理员禁用，如需恢复请联系管理员。',
      fromUserId: req.session.user.id,
      targetType: 'account',
      targetId: ''
    });
  }
  res.redirect('/admin/users');
});

router.post('/users/role/:id', isAuthenticated, hasPermission('users.role.edit'), (req, res) => {
  const db = req.db;
  const { role } = req.body;

  const targetUser = queryOne(db, 'SELECT username, role FROM users WHERE id = ?', [req.params.id]);
  if (!targetUser) {
    return res.status(404).json({ error: '用户不存在' });
  }

  const currentUserRoleVal = ROLE_HIERARCHY[req.session.user.role] || 0;
  const targetUserRoleVal = ROLE_HIERARCHY[targetUser.role] || 0;
  if (targetUserRoleVal >= currentUserRoleVal && req.session.user.role !== 'super_admin') {
    return res.status(403).json({ error: '权限不足：不能操作同级别或更高级别的用户' });
  }

  db.run('UPDATE users SET role = ? WHERE id = ?', [role, req.params.id]);
  saveDatabase();
  if (targetUser) {
    logActivity(db, { user_id: req.session.user.id, username: req.session.user.username, action: 'update', target_type: 'user_role', target_id: parseInt(req.params.id), target_title: targetUser.username, detail: '修改用户角色：' + targetUser.username + ' -> ' + role, ip: req.ip });
  }
  res.redirect('/admin/users');
});

router.post('/users/delete/:id', isAuthenticated, hasPermission('users.delete'), (req, res) => {
  const db = req.db;

  if (parseInt(req.params.id) === req.session.user.id) {
    return res.status(400).json({ error: '不能删除当前登录的管理员账户' });
  }

  const targetUser = queryOne(db, 'SELECT username, role FROM users WHERE id = ?', [req.params.id]);
  if (!targetUser) {
    return res.status(404).json({ error: '用户不存在' });
  }

  const currentUserRoleVal = ROLE_HIERARCHY[req.session.user.role] || 0;
  const targetUserRoleVal = ROLE_HIERARCHY[targetUser.role] || 0;
  if (targetUserRoleVal >= currentUserRoleVal && req.session.user.role !== 'super_admin') {
    return res.status(403).json({ error: '权限不足：不能操作同级别或更高级别的用户' });
  }

  db.run('DELETE FROM users WHERE id = ?', [req.params.id]);
  saveDatabase();
  if (targetUser) {
    logActivity(db, { user_id: req.session.user.id, username: req.session.user.username, action: 'delete', target_type: 'user', target_id: parseInt(req.params.id), target_title: targetUser.username, detail: '删除用户：' + targetUser.username, ip: req.ip });
  }
  res.redirect('/admin/users');
});

// ============ 批量导入用户 (CSV) ============
const multer = require('multer');
const csvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: function(req, file, cb) {
    if (file.mimetype === 'text/csv' || file.originalname.endsWith('.csv')) {
      cb(null, true);
    } else {
      cb(new Error('只支持 CSV 文件'));
    }
  }
});

router.post('/users/import-csv', isAuthenticated, hasPermission('users.create'), csvUpload.single('csv_file'), (req, res) => {
  const db = req.db;
  if (!req.file) {
    return res.status(400).json({ error: '请上传 CSV 文件' });
  }

  try {
    const content = req.file.buffer.toString('utf-8');
    const lines = content.split('\n').map(line => line.trim()).filter(Boolean);
    if (lines.length < 2) {
      return res.status(400).json({ error: 'CSV 文件至少需要包含表头和一行数据' });
    }

    // 解析表头
    const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
    const usernameIdx = headers.indexOf('username');
    const passwordIdx = headers.indexOf('password');
    const emailIdx = headers.indexOf('email');
    const roleIdx = headers.indexOf('role');

    if (usernameIdx === -1 || passwordIdx === -1) {
      return res.status(400).json({ error: 'CSV 文件必须包含 username 和 password 列' });
    }

    const results = { success: 0, failed: 0, errors: [] };
    const validRoles = ['user', 'visitor', 'admin'];

    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',').map(c => c.trim());
      const username = cols[usernameIdx];
      const password = cols[passwordIdx];
      const email = emailIdx !== -1 ? (cols[emailIdx] || '') : '';
      const role = roleIdx !== -1 && validRoles.includes(cols[roleIdx]) ? cols[roleIdx] : 'user';

      if (!username || username.length < 3) {
        results.failed++;
        results.errors.push(`第 ${i + 1} 行: 用户名无效 (至少3个字符)`);
        continue;
      }
      if (!password || password.length < 6) {
        results.failed++;
        results.errors.push(`第 ${i + 1} 行: 用户 "${username}" 密码无效 (至少6位)`);
        continue;
      }

      const existing = queryOne(db, 'SELECT id FROM users WHERE username = ?', [username]);
      if (existing) {
        results.failed++;
        results.errors.push(`第 ${i + 1} 行: 用户名 "${username}" 已存在`);
        continue;
      }

      if (email) {
        const existingEmail = queryOne(db, "SELECT id FROM users WHERE email = ? AND email != ''", [email]);
        if (existingEmail) {
          results.failed++;
          results.errors.push(`第 ${i + 1} 行: 邮箱 "${email}" 已存在`);
          continue;
        }
      }

      const hashedPassword = bcrypt.hashSync(password, 10);
      const csvUid = generateUid(db);
      db.run("INSERT INTO users (uid, username, password, email, role, status) VALUES (?, ?, ?, ?, ?, 'active')",
        [csvUid, username, hashedPassword, email, role]);
      results.success++;
    }

    saveDatabase();
    logActivity(db, {
      user_id: req.session.user.id,
      username: req.session.user.username,
      action: 'import',
      target_type: 'user',
      detail: `批量导入用户: 成功 ${results.success} 个, 失败 ${results.failed} 个`,
      ip: req.ip
    });

    res.json({
      success: true,
      message: `导入完成: 成功 ${results.success} 个', 失败 ${results.failed} 个`,
      results: results
    });
  } catch (err) {
    res.status(400).json({ error: 'CSV 解析失败: ' + err.message });
  }
});

module.exports = router;
