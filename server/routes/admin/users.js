/**
 * 用户管理路由（后台）
 * 能力：
 *   GET  /admin/users               —— 用户列表（非超管只读）
 *   POST /admin/users/create        —— 手动创建账户（仅超管；用户名/邮箱查重；密码≥8位提示）
 *   POST /admin/users/approve/:id   —— 批准/启用账户（并发送站内通知）
 *   POST /admin/users/disable/:id   —— 禁用账户（不可禁用自己/同级或更高；不可禁用最后一名超管）
 *   POST /admin/users/role/:id      —— 修改角色（白名单校验；晋升 admin 时授予全部权限点）
 *   POST /admin/users/delete/:id    —— 删除账户（同样受锁死保护）
 *   POST /admin/users/import-csv    —— CSV 批量导入（校验+分批让出事件循环）
 * 安全要点：全程 isSuperAdmin；操作前 canOperateUser / ROLE_HIERARCHY / ensureAtLeastOneActiveSuperAdmin
 *           三重保护，防止权限越级与管理端锁死。
 */

const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { isAuthenticated, hasPermission, isSuperAdmin, ROLE_HIERARCHY, ROLE_WHITELIST, canOperateUser, ensureAtLeastOneActiveSuperAdmin } = require('../../middlewares/auth');
const { saveDatabase, queryAll, queryOne, generateUid } = require('../../config/database');
const { grantDefaultPermissions } = require('../../config/db-helpers');
const { logActivity } = require('../../config/activity');
const { createNotification } = require('../community');
const { cleanupUserDependencies } = require('../../utils/user-deps');
const fsSafe = require('../../utils/fs-safe');

// ============ 用户管理 ============

// 用户列表页（非超管只读：前端按 readOnly 隐藏操作按钮）
router.get('/users', isAuthenticated, hasPermission('users.manage'), (req, res) => {
  const db = req.db;
  const users = queryAll(db, 'SELECT id, uid, username, email, role, status, created_at, deactivated_at FROM users ORDER BY created_at DESC');

  res.render('admin/users', {
    user: req.session.user,
    users: users,
    readOnly: req.session.user.role !== 'super_admin',
    error: req.query.error || null,
    settings: res.locals.settings || {}
  });
});

// 手动创建账户（仅超管）
router.post('/users/create', isAuthenticated, isSuperAdmin, (req, res) => {
  const db = req.db;
  const { username, email, password, role } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: '用户名和密码不能为空' });
  }

  if (username.length < 3) {
    return res.status(400).json({ error: '用户名至少3个字符' });
  }

  if (password.length < 8) {
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

  // 为新用户授予默认权限
  const newUser = queryOne(db, 'SELECT id FROM users WHERE username = ?', [username]);
  if (newUser) {
    grantDefaultPermissions(db, newUser.id, req.session.user.id);
  }

  saveDatabase();
  logActivity(db, { user_id: req.session.user.id, username: req.session.user.username, action: 'create', target_type: 'user', target_id: null, target_title: username, detail: '手动创建账户：' + username + ' (角色: ' + userRole + ')', ip: req.ip });
  res.json({ success: true, message: '账户创建成功' });
});

// 批准账户（pending→active 或重新启用），并发送站内通知
// 已自行注销的账号（deactivated_at 非空）禁止重新启用，仅可删除
router.post('/users/approve/:id', isAuthenticated, isSuperAdmin, (req, res) => {
  const db = req.db;
  const targetUser = queryOne(db, 'SELECT username, status, deactivated_at FROM users WHERE id = ?', [req.params.id]);

  if (targetUser && targetUser.deactivated_at) {
    return res.redirect('/admin/users?error=' + encodeURIComponent('该账号已由用户自行注销，无法重新启用。如需移除，请直接删除该账号。'));
  }

  db.run("UPDATE users SET status = 'active' WHERE id = ?", [req.params.id]);
  saveDatabase();
  if (targetUser) {
    logActivity(db, { user_id: req.session.user.id, username: req.session.user.username, action: 'approve', target_type: 'user', target_id: parseInt(req.params.id), target_title: targetUser.username, detail: '批准用户：' + targetUser.username, ip: req.ip });

    // 按原状态生成不同文案的通知
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

// 禁用账户（多重保护：不能禁自己、不能禁同级/更高、不能禁最后一名超管）
router.post('/users/disable/:id', isAuthenticated, isSuperAdmin, (req, res) => {
  const db = req.db;

  if (parseInt(req.params.id) === req.session.user.id) {
    return res.status(400).json({ error: '不能禁用当前登录的管理员账户' });
  }

  const targetUser = queryOne(db, 'SELECT username, role, deactivated_at FROM users WHERE id = ?', [req.params.id]);
  if (!targetUser) {
    return res.status(404).json({ error: '用户不存在' });
  }

  // 已自行注销的账号（deactivated_at 非空）禁止再次禁用，仅可删除
  if (targetUser.deactivated_at) {
    return res.redirect('/admin/users?error=' + encodeURIComponent('该账号已由用户自行注销，仅可删除账号，无需禁用。'));
  }

  // 角色等级比较：非超管不能动同级或更高
  const currentUserRoleVal = ROLE_HIERARCHY[req.session.user.role] || 0;
  const targetUserRoleVal = ROLE_HIERARCHY[targetUser.role] || 0;
  if (targetUserRoleVal >= currentUserRoleVal && req.session.user.role !== 'super_admin') {
    return res.status(403).json({ error: '权限不足：不能操作同级别或更高级别的用户' });
  }

  // 禁用超管前防管理端锁死
  if (targetUser.role === 'super_admin' && !ensureAtLeastOneActiveSuperAdmin(db, targetUser.id)) {
    return res.status(400).json({ error: '不能禁用最后一个超级管理员' });
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

// 修改用户角色（仅超管；白名单 + 可操作校验 + 锁死保护）
router.post('/users/role/:id', isAuthenticated, isSuperAdmin, (req, res) => {
  const db = req.db;
  const { role } = req.body;

  const targetUser = queryOne(db, 'SELECT username, role FROM users WHERE id = ?', [req.params.id]);
  if (!targetUser) {
    return res.status(404).json({ error: '用户不存在' });
  }

  // 改角色白名单校验，非法值直接拒绝
  if (!ROLE_WHITELIST.includes(role)) {
    return res.status(400).json({ error: '非法的角色值' });
  }

  const check = canOperateUser(req.session.user, targetUser);
  if (!check.ok) {
    return res.status(403).json({ error: check.reason });
  }

  // 降级超管前防管理端锁死（目标本身仍是 active 超管且要被降级）
  if (targetUser.role === 'super_admin' && role !== 'super_admin' &&
      !ensureAtLeastOneActiveSuperAdmin(db, targetUser.id)) {
    return res.status(400).json({ error: '不能降级最后一个超级管理员' });
  }

  db.run('UPDATE users SET role = ? WHERE id = ?', [role, req.params.id]);
  // admin 角色权限由 user_permissions 表控制：晋升时授予全部权限（后续可单独撤销）
  if (role === 'admin') {
    const allPerms = queryAll(db, 'SELECT perm_key FROM permissions');
    allPerms.forEach(p => {
      db.run('INSERT OR IGNORE INTO user_permissions (user_id, perm_key, granted_by) VALUES (?, ?, ?)',
        [req.params.id, p.perm_key, req.session.user.id]);
    });
  }
  saveDatabase();
  if (targetUser) {
    logActivity(db, { user_id: req.session.user.id, username: req.session.user.username, action: 'update', target_type: 'user_role', target_id: parseInt(req.params.id), target_title: targetUser.username, detail: '修改用户角色：' + targetUser.username + ' -> ' + role, ip: req.ip });
  }
  res.redirect('/admin/users');
});

// 删除用户（与禁用同样的保护逻辑）
router.post('/users/delete/:id', isAuthenticated, isSuperAdmin, (req, res) => {
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

  // 删除超管前防管理端锁死
  if (targetUser.role === 'super_admin' && !ensureAtLeastOneActiveSuperAdmin(db, targetUser.id)) {
    return res.status(400).json({ error: '不能删除最后一个超级管理员' });
  }

  // 事务内先清理关联数据，再删除用户，避免外键约束失败（FOREIGN KEY constraint failed）
  let filesToDelete = [];
  try {
    db.run('BEGIN');
    filesToDelete = cleanupUserDependencies(db, parseInt(req.params.id, 10));
    db.run('DELETE FROM users WHERE id = ?', [req.params.id]);
    db.run('COMMIT');
  } catch (err) {
    try { db.run('ROLLBACK'); } catch (rollbackErr) { /* 忽略回滚异常 */ }
    console.error('删除用户失败:', err);
    return res.status(500).json({ error: '删除用户失败: ' + err.message });
  }
  // 事务提交成功后删除图片文件（文件删除不可回滚，置于事务外；异步删除不阻塞响应）
  filesToDelete.forEach(filePath => {
    fsSafe.safeUnlink(filePath);
  });
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

// CSV 批量导入（仅超管）：表头需含 username/password，可选 email/role
router.post('/users/import-csv', isAuthenticated, isSuperAdmin, csvUpload.single('csv_file'), async (req, res) => {
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

    // 解析表头（大小写不敏感）
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

    // 逐行校验并插入
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
      if (!password || password.length < 8) {
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

      // 为新用户授予默认权限
      const newUser = queryOne(db, 'SELECT id FROM users WHERE username = ?', [username]);
      if (newUser) {
        grantDefaultPermissions(db, newUser.id, req.session.user.id);
      }

      results.success++;

      // 分批处理：每处理 20 行让出事件循环，避免阻塞其他请求
      if (i % 20 === 0) {
        await new Promise(resolve => { setImmediate(resolve); });
      }
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
