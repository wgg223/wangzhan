/**
 * 权限管理路由（后台）
 * 能力：
 *   GET  /admin/permissions            —— 权限管理页（权限点列表、用户权限矩阵、申请审核）
 *   POST /admin/permissions/grant      —— 授予权限（分级：持 permissions.manage 可授基础权限；高危权限仅超管；目标用户操作校验）
 *   POST /admin/permissions/revoke     —— 撤销权限（分级，与 grant 权限矩阵对称）
 *   POST /admin/permissions/approve   —— 审批通过（按审批链授权，见下方流程说明）
 *   POST /admin/permissions/reject     —— 拒绝权限申请（记录驳回原因；同样按审批链授权）
 *   GET  /admin/my-approvals           —— 我的审批页（当前用户作为指定审批人的待办列表）
 * 安全要点：授予/撤销/批准均校验 perm_key 真实存在、目标用户可操作
 *           （canOperateUser：不能操作自己/超管保护/同级不可动）。
 *
 * 二级审批流程（server/utils/permission-flow.js 共享逻辑）：
 *   基础权限：用户申请 → 对应管理员（superior_id）审批 → 系统自动确认生效
 *   高危权限：用户申请 → 对应管理员审批 → 管理员的上级审批 → 生效
 *   审批链缺失（未指定对应管理员/审批人无上级）时由超级管理员兜底审批；
 *   已指定审批人时超级管理员不可越级审批，保证二级审批语义。
 */

const express = require('express');
const router = express.Router();
const { isAuthenticated, hasPermission, canOperateUser } = require('../../middlewares/auth');
const { saveDatabase, queryAll, queryOne } = require('../../config/database');
const { logActivity } = require('../../config/activity');
const { createNotification } = require('../community');
const {
  canApproveApplication,
  grantApplicationPermission,
  notifyStageApprover,
  notifyApplicant
} = require('../../utils/permission-flow');

// ============ 权限管理 ============

// 权限管理页：权限点 + 全部用户权限矩阵 + 待审/全部申请
router.get('/permissions', isAuthenticated, hasPermission('permissions.manage'), (req, res) => {
  const db = req.db;

  const allPermissions = queryAll(db, 'SELECT * FROM permissions ORDER BY id ASC');

  // 单次聚合查询用户权限（替代逐用户 N+1 查询）
  const users = queryAll(db,
    `SELECT u.id, u.username, u.email, u.role, u.status, GROUP_CONCAT(up.perm_key) AS perms
     FROM users u
     LEFT JOIN user_permissions up ON up.user_id = u.id
     GROUP BY u.id
     ORDER BY u.created_at DESC`);
  const userPerms = {};
  users.forEach(u => {
    userPerms[u.id] = u.perms ? u.perms.split(',') : [];
  });

  // 获取待审核的权限申请（关联申请人、权限名、申请人对应管理员、一级审批人）
  const pendingApplications = queryAll(db,
    `SELECT pa.*, u.username, u.email, p.perm_name, p.description,
            s.username AS superior_name, a1.username AS admin_approver_name
     FROM permission_applications pa
     LEFT JOIN users u ON pa.user_id = u.id
     LEFT JOIN permissions p ON pa.perm_key = p.perm_key
     LEFT JOIN users s ON u.superior_id = s.id
     LEFT JOIN users a1 ON pa.approved_by_admin = a1.id
     WHERE pa.status = 'pending'
     ORDER BY pa.created_at DESC`
  );
  // 标注每条申请当前用户能否审批（用于前端按钮展示）
  pendingApplications.forEach(app => {
    const check = canApproveApplication(db, req.session.user, app);
    app.canApprove = check.ok;
    app.canApproveReason = check.ok ? '' : check.reason;
  });

  // 获取申请记录（含一级/二级审批人、系统确认时间；限最近 200 条）
  const allApplications = queryAll(db,
    `SELECT pa.*, u.username, u.email, p.perm_name, p.description,
     r.username as reviewer_name,
     a1.username as admin_approver_name,
     a2.username as superior_approver_name,
     s.username as superior_name
     FROM permission_applications pa
     LEFT JOIN users u ON pa.user_id = u.id
     LEFT JOIN permissions p ON pa.perm_key = p.perm_key
     LEFT JOIN users r ON pa.reviewed_by = r.id
     LEFT JOIN users a1 ON pa.approved_by_admin = a1.id
     LEFT JOIN users a2 ON pa.approved_by_superior = a2.id
     LEFT JOIN users s ON u.superior_id = s.id
     ORDER BY pa.created_at DESC
     LIMIT 200`
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
    highlightUserId: parseInt(req.query.user, 10) || 0,
    settings: res.locals.settings || {}
  });
});

// 我的审批页：当前用户作为指定审批人的待办申请（admin / super_admin 角色可访问）
router.get('/my-approvals', isAuthenticated, (req, res) => {
  const db = req.db;

  if (req.session.user.role !== 'admin' && req.session.user.role !== 'super_admin') {
    return res.redirect('/');
  }

  const pending = queryAll(db,
    `SELECT pa.*, u.username, u.email, p.perm_name, p.description
     FROM permission_applications pa
     LEFT JOIN users u ON pa.user_id = u.id
     LEFT JOIN permissions p ON pa.perm_key = p.perm_key
     WHERE pa.status = 'pending'
     ORDER BY pa.created_at DESC`
  );

  // 仅保留当前用户有权审批的申请（审批链命中，或链缺失时超管兜底）
  const myPending = pending.filter(app => canApproveApplication(db, req.session.user, app).ok);

  res.render('admin/my-approvals', {
    user: req.session.user,
    myPendingApplications: myPending,
    settings: res.locals.settings || {}
  });
});

// 授予权限（分级：基础权限需 permissions.manage 即可授予；高危权限仅超级管理员可授予）
router.post('/permissions/grant', isAuthenticated, hasPermission('permissions.manage'), (req, res) => {
  const db = req.db;
  const { user_id, perm_key } = req.body;

  if (!user_id || !perm_key) {
    return res.status(400).json({ error: '参数不完整' });
  }

  // perm_key 必须真实存在于 permissions 表（防伪造权限键），并读取高危标记
  const permRow = queryOne(db, 'SELECT id, high_risk FROM permissions WHERE perm_key = ?', [perm_key]);
  if (!permRow) {
    return res.status(400).json({ error: '非法的权限项' });
  }
  // 高危权限（账号/权限/设置/数据/批量删除类）仅超级管理员可授予；
  // 普通管理员（持 permissions.manage）可授予基础权限。
  if (permRow.high_risk === 1 && req.session.user.role !== 'super_admin') {
    return res.status(403).json({ error: '高危权限仅超级管理员可授予' });
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
      logActivity(db, { user_id: req.session.user.id, username: req.session.user.username, action: 'grant', target_type: 'permission', target_id: parseInt(user_id), target_title: targetUser.username, detail: '授予权限 ' + perm_key + ' 给用户：' + targetUser.username + (permRow.high_risk === 1 ? '（高危权限）' : ''), ip: req.ip });
    }
  }

  res.redirect('/admin/permissions');
});

// 撤销权限（分级：与 grant 对称，高危权限仅超级管理员可撤销）
router.post('/permissions/revoke', isAuthenticated, hasPermission('permissions.manage'), (req, res) => {
  const db = req.db;
  const { user_id, perm_key } = req.body;

  if (!user_id || !perm_key) {
    return res.status(400).json({ error: '参数不完整' });
  }

  // perm_key 必须真实存在于 permissions 表，并读取高危标记
  const permRow = queryOne(db, 'SELECT id, high_risk FROM permissions WHERE perm_key = ?', [perm_key]);
  if (!permRow) {
    return res.status(400).json({ error: '非法的权限项' });
  }
  // 高危权限仅超级管理员可撤销；普通管理员可撤销基础权限
  if (permRow.high_risk === 1 && req.session.user.role !== 'super_admin') {
    return res.status(403).json({ error: '高危权限仅超级管理员可撤销' });
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
    logActivity(db, { user_id: req.session.user.id, username: req.session.user.username, action: 'revoke', target_type: 'permission', target_id: parseInt(user_id), target_title: targetUser.username, detail: '撤销权限 ' + perm_key + ' 从用户：' + targetUser.username + (permRow.high_risk === 1 ? '（高危权限）' : ''), ip: req.ip });
  }
  res.redirect('/admin/permissions');
});

// 批准权限申请（按审批链推进：基础=管理员批准后系统确认生效；高危=管理员批准后转其上级终审）
router.post('/permissions/approve', isAuthenticated, hasPermission('permissions.manage'), (req, res) => {
  const db = req.db;
  const { application_id } = req.body;

  if (!application_id) {
    return res.status(400).json({ error: '参数不完整' });
  }

  // 只允许处理 pending 状态的申请
  const application = queryOne(db, 'SELECT * FROM permission_applications WHERE id = ? AND status = ?', [application_id, 'pending']);
  if (!application) {
    return res.status(404).json({ error: '申请不存在或已处理' });
  }

  // 按审批链校验当前用户是否为该阶段的合法审批人
  const check = canApproveApplication(db, req.session.user, application);
  if (!check.ok) {
    return res.status(403).json({ error: check.reason });
  }

  const applicant = queryOne(db, 'SELECT id, username FROM users WHERE id = ?', [application.user_id]);
  const perm = queryOne(db, 'SELECT perm_name FROM permissions WHERE perm_key = ?', [application.perm_key]);
  const permName = perm ? perm.perm_name : application.perm_key;
  const stage = application.approval_stage || 1;
  const highRisk = application.high_risk ? true : false;

  if (stage === 1 && highRisk) {
    // 高危流程一级审批通过 → 转交一级审批人的上级终审
    db.run(`UPDATE permission_applications
            SET approval_stage = 2, approved_by_admin = ?, approved_by_admin_at = CURRENT_TIMESTAMP
            WHERE id = ?`,
      [req.session.user.id, application_id]);
    saveDatabase();

    // 通知二级审批人（用推进后的申请对象解析审批人）
    const advanced = Object.assign({}, application, { approval_stage: 2, approved_by_admin: req.session.user.id });
    notifyStageApprover(db, createNotification, advanced, applicant ? applicant.username : '', permName, req.session.user.id);

    logActivity(db, {
      user_id: req.session.user.id,
      username: req.session.user.username,
      action: 'approve',
      target_type: 'permission_application',
      target_id: application_id,
      target_title: applicant ? applicant.username : '',
      detail: '一级审批通过(高危): ' + application.perm_key + '，已转交上级管理员终审',
      ip: req.ip
    });

    return res.json({ success: true, message: '一级审批已通过，已转交您的上级管理员终审' });
  }

  // 基础流程一级审批 → 系统自动确认生效；高危流程二级审批（上级终审）→ 生效
  const inserted = grantApplicationPermission(db, application, req.session.user.id);

  if (stage === 1) {
    db.run(`UPDATE permission_applications
            SET status = 'approved', reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP,
                approved_by_admin = ?, approved_by_admin_at = CURRENT_TIMESTAMP,
                system_confirmed_at = CURRENT_TIMESTAMP
            WHERE id = ?`,
      [req.session.user.id, req.session.user.id, application_id]);
  } else {
    db.run(`UPDATE permission_applications
            SET status = 'approved', reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP,
                approved_by_superior = ?, approved_by_superior_at = CURRENT_TIMESTAMP,
                system_confirmed_at = CURRENT_TIMESTAMP
            WHERE id = ?`,
      [req.session.user.id, req.session.user.id, application_id]);
  }
  saveDatabase();

  // 通知申请人审批通过
  if (applicant) {
    notifyApplicant(db, createNotification, application, applicant.id, permName, true, '', req.session.user.id);
  }

  logActivity(db, {
    user_id: req.session.user.id,
    username: req.session.user.username,
    action: 'approve',
    target_type: 'permission_application',
    target_id: application_id,
    target_title: applicant ? applicant.username : '',
    detail: (stage === 1 ? '审批通过并系统确认生效: ' : '二级审批通过(高危)并生效: ') +
      application.perm_key + (inserted ? '' : '（权限此前已存在）'),
    ip: req.ip
  });

  res.json({ success: true, message: '已批准权限申请，权限即时生效' });
});

// 拒绝权限申请（按审批链授权；记录驳回原因并通知申请人）
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

  // 按审批链校验当前用户是否为该阶段的合法审批人
  const check = canApproveApplication(db, req.session.user, application);
  if (!check.ok) {
    return res.status(403).json({ error: check.reason });
  }

  // 更新申请状态为 rejected + 驳回原因
  db.run('UPDATE permission_applications SET status = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP, reject_reason = ? WHERE id = ?',
    ['rejected', req.session.user.id, reason || '', application_id]);
  saveDatabase();

  const applicant = queryOne(db, 'SELECT id, username FROM users WHERE id = ?', [application.user_id]);
  const perm = queryOne(db, 'SELECT perm_name FROM permissions WHERE perm_key = ?', [application.perm_key]);
  if (applicant) {
    notifyApplicant(db, createNotification, application, applicant.id, perm ? perm.perm_name : application.perm_key, false, reason || '', req.session.user.id);
    logActivity(db, {
      user_id: req.session.user.id,
      username: req.session.user.username,
      action: 'reject',
      target_type: 'permission_application',
      target_id: application_id,
      target_title: applicant.username,
      detail: '拒绝权限申请: ' + application.perm_key + ' 用户：' + applicant.username + (reason ? ' 原因：' + reason : ''),
      ip: req.ip
    });
  }

  res.json({ success: true, message: '已拒绝权限申请' });
});

module.exports = router;
