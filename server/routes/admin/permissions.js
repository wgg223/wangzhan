/**
 * 权限管理路由（后台）
 * 能力：
 *   GET  /admin/permissions            —— 权限管理页（权限点列表、用户权限矩阵、权限申请审核）
 *   POST /admin/permissions/grant      —— 授予权限（仅超管；权限键白名单校验；目标用户操作校验）
 *   POST /admin/permissions/revoke     —— 撤销权限（仅超管，与 grant 权限矩阵对称）
 *   POST /admin/permissions/approve    —— 批准权限申请（=授予，仅超管）
 *   POST /admin/permissions/reject     —— 拒绝权限申请（记录驳回原因）
 * 安全要点：授予/撤销/批准均校验 perm_key 真实存在、目标用户可操作
 *           （canOperateUser：不能操作自己/超管保护/同级不可动）。
 */

const express = require('express');
const router = express.Router();
const { isAuthenticated, hasPermission, canOperateUser } = require('../../middlewares/auth');
const { saveDatabase, queryAll, queryOne } = require('../../config/database');
const { logActivity } = require('../../config/activity');

// ============ 权限管理 ============

// 权限管理页：权限点 + 全部用户权限矩阵 + 待审/全部申请
router.get('/permissions', isAuthenticated, hasPermission('permissions.manage'), (req, res) => {
  const db = req.db;

  const allPermissions = queryAll(db, 'SELECT * FROM permissions ORDER BY id ASC');
  const users = queryAll(db, 'SELECT id, username, email, role, status FROM users ORDER BY created_at DESC');

  // 为每个用户查其权限键集合（N+1 查询，数据量小可接受）
  const userPerms = {};
  users.forEach(u => {
    const perms = queryAll(db, 'SELECT perm_key FROM user_permissions WHERE user_id = ?', [u.id]);
    userPerms[u.id] = perms.map(p => p.perm_key);
  });

  // 获取待审核的权限申请（关联申请人、权限名与描述）
  const pendingApplications = queryAll(db,
    `SELECT pa.*, u.username, u.email, p.perm_name, p.description 
     FROM permission_applications pa 
     LEFT JOIN users u ON pa.user_id = u.id 
     LEFT JOIN permissions p ON pa.perm_key = p.perm_key 
     WHERE pa.status = 'pending' 
     ORDER BY pa.created_at DESC`
  );

  // 获取所有申请记录（含审核人信息）
  const allApplications = queryAll(db,
    `SELECT pa.*, u.username, u.email, p.perm_name, p.description,
     r.username as reviewer_name
     FROM permission_applications pa 
     LEFT JOIN users u ON pa.user_id = u.id 
     LEFT JOIN permissions p ON pa.perm_key = p.perm_key 
     LEFT JOIN users r ON pa.reviewed_by = r.id
     ORDER BY pa.created_at DESC`
  );
  // 兼容旧数据库：确保 reject_reason 字段存在（旧库可能没有该列）
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

// 授予权限（仅超管）
router.post('/permissions/grant', isAuthenticated, hasPermission('permissions.manage'), (req, res) => {
  const db = req.db;
  const { user_id, perm_key } = req.body;

  if (!user_id || !perm_key) {
    return res.status(400).json({ error: '参数不完整' });
  }

  // 授予权限仅限超级管理员
  if (req.session.user.role !== 'super_admin') {
    return res.status(403).json({ error: '仅超级管理员可授予权限' });
  }

  // perm_key 必须真实存在于 permissions 表（防伪造权限键）
  const permExists = queryOne(db, 'SELECT id FROM permissions WHERE perm_key = ?', [perm_key]);
  if (!permExists) {
    return res.status(400).json({ error: '非法的权限项' });
  }

  const targetUser = queryOne(db, 'SELECT id, role, username FROM users WHERE id = ?', [user_id]);
  if (!targetUser) {
    return res.status(404).json({ error: '用户不存在' });
  }
  // 不能操作自己、非超管不能动超管、同级/高级不可动
  const check = canOperateUser(req.session.user, targetUser);
  if (!check.ok) {
    return res.status(403).json({ error: check.reason });
  }

  // 已拥有则跳过（幂等）
  const existing = queryOne(db, 'SELECT id FROM user_permissions WHERE user_id = ? AND perm_key = ?', [user_id, perm_key]);
  if (!existing) {
    db.run('INSERT INTO user_permissions (user_id, perm_key, granted_by) VALUES (?, ?, ?)',
      [user_id, perm_key, req.session.user.id]);
    saveDatabase();
    if (targetUser) {
      logActivity(db, { user_id: req.session.user.id, username: req.session.user.username, action: 'grant', target_type: 'permission', target_id: parseInt(user_id), target_title: targetUser.username, detail: '授予权限 ' + perm_key + ' 给用户：' + targetUser.username, ip: req.ip });
    }
  }

  res.redirect('/admin/permissions');
});

// 撤销权限（仅超管，与 grant 权限矩阵对齐）
router.post('/permissions/revoke', isAuthenticated, hasPermission('permissions.manage'), (req, res) => {
  const db = req.db;
  const { user_id, perm_key } = req.body;

  if (!user_id || !perm_key) {
    return res.status(400).json({ error: '参数不完整' });
  }

  // 撤销权限与 grant/approve 对齐，仅限超级管理员（修复权限矩阵不对称）
  if (req.session.user.role !== 'super_admin') {
    return res.status(403).json({ error: '仅超级管理员可撤销权限' });
  }

  // perm_key 必须真实存在于 permissions 表
  const permExists = queryOne(db, 'SELECT id FROM permissions WHERE perm_key = ?', [perm_key]);
  if (!permExists) {
    return res.status(400).json({ error: '非法的权限项' });
  }

  const targetUser = queryOne(db, 'SELECT id, role, username FROM users WHERE id = ?', [user_id]);
  if (!targetUser) {
    return res.status(404).json({ error: '用户不存在' });
  }
  // 不能操作自己、非超管不能动超管、同级/高级不可动
  const check = canOperateUser(req.session.user, targetUser);
  if (!check.ok) {
    return res.status(403).json({ error: check.reason });
  }

  db.run('DELETE FROM user_permissions WHERE user_id = ? AND perm_key = ?', [user_id, perm_key]);
  saveDatabase();
  if (targetUser) {
    logActivity(db, { user_id: req.session.user.id, username: req.session.user.username, action: 'revoke', target_type: 'permission', target_id: parseInt(user_id), target_title: targetUser.username, detail: '撤销权限 ' + perm_key + ' 从用户：' + targetUser.username, ip: req.ip });
  }
  res.redirect('/admin/permissions');
});

// 批准权限申请（授予权限，仅限超级管理员）
router.post('/permissions/approve', isAuthenticated, hasPermission('permissions.manage'), (req, res) => {
  const db = req.db;
  const { application_id } = req.body;

  if (!application_id) {
    return res.status(400).json({ error: '参数不完整' });
  }

  // 批准=授予，仅超级管理员可执行
  if (req.session.user.role !== 'super_admin') {
    return res.status(403).json({ error: '仅超级管理员可批准权限申请' });
  }

  // 只允许处理 pending 状态的申请
  const application = queryOne(db, 'SELECT * FROM permission_applications WHERE id = ? AND status = ?', [application_id, 'pending']);
  if (!application) {
    return res.status(404).json({ error: '申请不存在或已处理' });
  }

  // 授予权限（已存在则跳过）
  const existing = queryOne(db, 'SELECT id FROM user_permissions WHERE user_id = ? AND perm_key = ?', [application.user_id, application.perm_key]);
  if (!existing) {
    db.run('INSERT INTO user_permissions (user_id, perm_key, granted_by) VALUES (?, ?, ?)',
      [application.user_id, application.perm_key, req.session.user.id]);
  }

  // 更新申请状态为 approved，记录审核人
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

// 拒绝权限申请（记录驳回原因）
router.post('/permissions/reject', isAuthenticated, hasPermission('permissions.manage'), (req, res) => {
  const db = req.db;
  const { application_id, reason } = req.body;

  if (!application_id) {
    return res.status(400).json({ error: '参数不完整' });
  }

  const application = queryOne(db, 'SELECT * FROM permission_applications WHERE id = ? AND status = ?', [application_id, 'pending']);
  if (!application) {
    return res.status(404).json({ error: '申请不存在或已处理' });
  }

  // 更新申请状态为 rejected + 驳回原因
  db.run('UPDATE permission_applications SET status = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP, reject_reason = ? WHERE id = ?',
    ['rejected', req.session.user.id, reason || '', application_id]);
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
