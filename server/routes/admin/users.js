/**
 * 用户管理路由（后台）
 * 能力：
 *   GET  /admin/users               —— 用户列表（非超管只读；支持关键词/角色/状态过滤+分页）
 *   POST /admin/users/create        —— 手动创建账户（仅超管；用户名/邮箱查重；密码≥8位提示）
 *   POST /admin/users/approve/:id   —— 批准/启用账户（并发送站内通知）
 *   POST /admin/users/disable/:id   —— 禁用账户（不可禁用自己/同级或更高；不可禁用最后一名超管）
 *   POST /admin/users/role/:id      —— 修改角色（白名单校验；晋升 admin 时授予全部权限点）
 *   POST /admin/users/delete/:id    —— 删除账户（同样受锁死保护）
 *   POST /admin/users/set-superior/:id —— 指定/清除用户对应上级管理员（仅超管；防自指/防循环链）
 *   POST /admin/users/batch          —— 批量管理（仅超管；批准/禁用/删除/改角色/设上级，
 *                                       复用单用户全部保护逻辑，分块让出事件循环，逐项返回结果）
 *   POST /admin/users/import        —— 批量导入用户（仅超管；支持 CSV/Excel；两段式写入支持同文件指定上级）
 *   GET  /admin/users/import-template —— 下载导入模板（CSV / XLSX）
 * 安全要点：全程 isSuperAdmin；操作前 canOperateUser / ROLE_HIERARCHY / ensureAtLeastOneActiveSuperAdmin
 *           三重保护，防止权限越级与管理端锁死。
 */

const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { isAuthenticated, hasPermission, isSuperAdmin, ROLE_HIERARCHY, ROLE_WHITELIST, canOperateUser, ensureAtLeastOneActiveSuperAdmin, validatePassword } = require('../../middlewares/auth');
const { saveDatabase, queryAll, queryOne, generateUid } = require('../../config/database');
const { grantDefaultPermissions } = require('../../config/db-helpers');
const { logActivity } = require('../../config/activity');
const { createNotification } = require('../community');
const { cleanupUserDependencies } = require('../../utils/user-deps');
const fsSafe = require('../../utils/fs-safe');
const { validateSuperior } = require('../../utils/permission-flow');
const { parseImportFile } = require('../../utils/spreadsheet-import');
const { runBatchUserAction, MAX_ERRORS } = require('../../services/batch-user-ops');

// ============ 用户管理 ============

// 用户列表页（非超管只读：前端按 readOnly 隐藏操作按钮）
// 支持关键词（用户名/邮箱）、角色、状态过滤与分页（每页 50 条）
router.get('/users', isAuthenticated, hasPermission('users.manage'), (req, res) => {
  const db = req.db;

  const keyword = (req.query.keyword || '').trim();
  const roleFilter = req.query.role || '';
  const statusFilter = req.query.status || '';
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const pageSize = 50;

  let where = '1=1';
  const params = [];
  if (keyword) {
    where += ' AND (u.username LIKE ? OR u.email LIKE ?)';
    params.push('%' + keyword + '%', '%' + keyword + '%');
  }
  if (roleFilter) {
    where += ' AND u.role = ?';
    params.push(roleFilter);
  }
  if (statusFilter) {
    where += ' AND u.status = ?';
    params.push(statusFilter);
  }

  const totalRow = queryOne(db, 'SELECT COUNT(*) AS count FROM users u WHERE ' + where, params);
  const total = totalRow ? totalRow.count : 0;
  const totalPages = Math.max(Math.ceil(total / pageSize), 1);
  const curPage = Math.min(page, totalPages);
  const offset = (curPage - 1) * pageSize;

  const users = queryAll(db,
    `SELECT u.id, u.uid, u.username, u.email, u.role, u.status, u.created_at, u.deactivated_at,
            s.id AS superior_id, s.username AS superior_username
     FROM users u LEFT JOIN users s ON u.superior_id = s.id
     WHERE ${where}
     ORDER BY u.created_at DESC
     LIMIT ? OFFSET ?`,
    params.concat([pageSize, offset]));

  // 超管附加数据：可指定的上级管理员候选、导入历史（最近 20 条）
  let adminCandidates = [];
  let importLogs = [];
  if (req.session.user.role === 'super_admin') {
    adminCandidates = queryAll(db,
      "SELECT id, username, role FROM users WHERE role IN ('admin', 'super_admin') AND status = 'active' ORDER BY role DESC, username ASC");
    importLogs = queryAll(db, 'SELECT * FROM user_import_logs ORDER BY created_at DESC LIMIT 20');
  }

  res.render('admin/users', {
    user: req.session.user,
    users: users,
    readOnly: req.session.user.role !== 'super_admin',
    error: req.query.error || null,
    filters: { keyword: keyword, role: roleFilter, status: statusFilter },
    pagination: { page: curPage, totalPages: totalPages, total: total },
    adminCandidates: adminCandidates,
    importLogs: importLogs,
    settings: res.locals.settings || {}
  });
});

// 手动创建账户（仅超管）
// 密码哈希使用异步 bcrypt，避免 hashSync 同步计算阻塞事件循环（单次约 60~100ms CPU）
router.post('/users/create', isAuthenticated, isSuperAdmin, async (req, res) => {
  try {
    const db = req.db;
    const { username, email, password, role } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: '用户名和密码不能为空' });
    }

    if (username.length < 3) {
      return res.status(400).json({ error: '用户名至少3个字符' });
    }

    // P0-3 口令策略统一：后台创建账户与注册入口一致（≥10位 + 至少3类字符 + 弱口令黑名单）
    const pwdCheck = validatePassword(password);
    if (!pwdCheck.ok) {
      return res.status(400).json({ error: pwdCheck.reason });
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

    const hashedPassword = await bcrypt.hash(password, 10);
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
  } catch (err) {
    console.error('创建用户失败:', err);
    return res.status(500).json({ error: '创建用户失败: ' + err.message });
  }
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

// 修改用户角色（仅超管；白名单 + 可操作校验 + 锁死保护 + 高危二次确认）
// P0-2 修复：改角色属于高危提权操作，要求操作者输入本人密码二次确认，
//           防止账号被他人登入后单点篡改角色；审计 detail 记录确认状态。
router.post('/users/role/:id', isAuthenticated, isSuperAdmin, (req, res) => {
  const db = req.db;
  const { role, confirm_password } = req.body;

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

  // 高危操作二次确认：校验操作者当前密码（防账号被盗后的单点提权/降级）
  if (!confirm_password) {
    return res.status(400).json({ error: '改角色属于高危操作，请输入您的登录密码进行二次确认' });
  }
  const operator = queryOne(db, 'SELECT password FROM users WHERE id = ?', [req.session.user.id]);
  if (!operator || !bcrypt.compareSync(confirm_password, operator.password)) {
    logActivity(db, { user_id: req.session.user.id, username: req.session.user.username, action: 'update', target_type: 'user_role', target_id: parseInt(req.params.id), target_title: targetUser.username, detail: '修改用户角色失败（二次确认密码错误）：' + targetUser.username + ' -> ' + role, ip: req.ip });
    return res.status(403).json({ error: '二次确认密码错误，操作已记录并中止' });
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
    logActivity(db, { user_id: req.session.user.id, username: req.session.user.username, action: 'update', target_type: 'user_role', target_id: parseInt(req.params.id), target_title: targetUser.username, detail: '修改用户角色（已二次确认）：' + targetUser.username + ' -> ' + role, ip: req.ip });
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

// ============ 指定上级管理员（审批链） ============

// 指定/清除用户对应上级管理员（仅超管；superior_id=0 表示清除）
router.post('/users/set-superior/:id', isAuthenticated, isSuperAdmin, (req, res) => {
  const db = req.db;
  const targetId = parseInt(req.params.id, 10);
  const superiorId = parseInt(req.body.superior_id, 10) || 0;

  const targetUser = queryOne(db, 'SELECT id, username FROM users WHERE id = ?', [targetId]);
  if (!targetUser) {
    return res.status(404).json({ error: '用户不存在' });
  }

  if (superiorId) {
    const check = validateSuperior(db, targetId, superiorId);
    if (!check.ok) {
      return res.status(400).json({ error: check.reason });
    }
  }

  db.run('UPDATE users SET superior_id = ? WHERE id = ?', [superiorId || null, targetId]);
  saveDatabase();
  logActivity(db, {
    user_id: req.session.user.id,
    username: req.session.user.username,
    action: 'update',
    target_type: 'user_superior',
    target_id: targetId,
    target_title: targetUser.username,
    detail: superiorId
      ? '指定用户 ' + targetUser.username + ' 的对应上级管理员（用户ID ' + superiorId + '）'
      : '清除用户 ' + targetUser.username + ' 的对应上级管理员',
    ip: req.ip
  });
  res.json({ success: true, message: superiorId ? '已设置对应上级管理员' : '已清除对应上级管理员' });
});

// ============ 批量管理（勾选操作） ============

// 单次批量操作用户数上限（防止超长请求拖垮响应，规避 Nginx/Node 双端超时）
const MAX_BATCH_SIZE = 500;

// 批量操作动作 → 中文名（提示语与活动日志用）
const BATCH_ACTIONS = {
  approve: '批准/启用',
  disable: '禁用',
  delete: '删除',
  role: '修改角色',
  set_superior: '设置上级管理员'
};

// 批量管理（仅超管）：单请求内对多个用户执行同一种操作。
// 复用单用户路由的全部保护逻辑（见 services/batch-user-ops.js）：
//   - approve/disable/delete/role 均带 self 保护、ROLE_HIERARCHY 等级校验、
//     ensureAtLeastOneActiveSuperAdmin 防管理端锁死、deactivated_at 注销锁定；
//   - 每 20 个用户让出事件循环，批量期间站点其余请求不被阻塞；
//   - delete 的关联数据清理在每用户独立事务内完成，单用户失败不影响整批。
router.post('/users/batch', isAuthenticated, isSuperAdmin, async (req, res) => {
  try {
    const db = req.db;
    const { action, ids, role, superior_id } = req.body || {};

    if (!BATCH_ACTIONS[action]) {
      return res.status(400).json({ error: '无效的批量操作类型' });
    }
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: '请先勾选要操作的用户' });
    }

    // 全部 ID 必须为正整数，去重后执行
    const numericIds = [];
    for (const id of ids) {
      const n = parseInt(id, 10);
      if (!Number.isInteger(n) || n <= 0) {
        return res.status(400).json({ error: '包含无效的用户ID' });
      }
      numericIds.push(n);
    }
    const uniqIds = [...new Set(numericIds)];
    if (uniqIds.length > MAX_BATCH_SIZE) {
      return res.status(400).json({ error: '单次批量操作最多 ' + MAX_BATCH_SIZE + ' 个用户，请分批操作' });
    }

    const opts = {};
    if (action === 'role') {
      if (!ROLE_WHITELIST.includes(role)) {
        return res.status(400).json({ error: '非法的角色值' });
      }
      opts.role = role;
      // P0-2 高危二次确认：批量改角色前校验操作者本人密码（一次性校验，整批共享）
      const { confirm_password } = req.body || {};
      if (!confirm_password) {
        return res.status(400).json({ error: '批量改角色属于高危操作，请输入您的登录密码进行二次确认' });
      }
      const operatorRow = queryOne(db, 'SELECT password FROM users WHERE id = ?', [req.session.user.id]);
      if (!operatorRow || !bcrypt.compareSync(confirm_password, operatorRow.password)) {
        logActivity(db, {
          user_id: req.session.user.id,
          username: req.session.user.username,
          action: 'batch_role',
          target_type: 'user',
          target_id: null,
          target_title: '',
          detail: '批量修改角色被拒绝（二次确认密码错误，共 ' + uniqIds.length + ' 个目标）',
          ip: req.ip
        });
        return res.status(403).json({ error: '二次确认密码错误，操作已记录并中止' });
      }
      opts.confirmVerified = true;
    }
    if (action === 'set_superior') {
      opts.superiorId = parseInt(superior_id, 10) || 0;
    }

    const results = await runBatchUserAction(db, req.session.user, action, uniqIds, opts);

    logActivity(db, {
      user_id: req.session.user.id,
      username: req.session.user.username,
      action: 'batch_' + action,
      target_type: 'user',
      target_id: null,
      target_title: '',
      detail: '批量' + BATCH_ACTIONS[action] + '：成功 ' + results.success + ' 个, 失败 ' + results.failed + ' 个（共选择 ' + uniqIds.length + ' 个）',
      ip: req.ip
    });

    res.json({
      success: true,
      message: '批量' + BATCH_ACTIONS[action] + '完成：成功 ' + results.success + ' 个, 失败 ' + results.failed + ' 个',
      action: action,
      results: results
    });
  } catch (err) {
    console.error('批量用户操作失败:', err);
    return res.status(500).json({ error: '批量操作失败: ' + err.message });
  }
});

// ============ 批量导入用户（CSV / Excel） ============
const multer = require('multer');

// 导入文件上传配置（项目统一 10MB 导入上限）
const importUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: function(req, file, cb) {
    const ext = (file.originalname.split('.').pop() || '').toLowerCase();
    if (['csv', 'xlsx', 'xls'].includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('只支持 CSV 或 Excel（xlsx / xls）文件'));
    }
  }
});

// 单次导入行数上限（bcrypt 逐行加密较重，防止请求长时间阻塞）
const MAX_IMPORT_ROWS = 1000;

// 表头别名（英文小写 / 常见中文表头）
const IMPORT_HEADER_ALIASES = {
  username: ['username', '用户名', '账号'],
  password: ['password', '密码'],
  email: ['email', '邮箱', '电子邮件'],
  role: ['role', '角色'],
  superior: ['superior', '上级管理员', '对应管理员', '上级'],
  permissions: ['permissions', '权限', '权限列表', '权限集']
};

// 角色别名映射（导入文件可写英文或中文角色名）
const IMPORT_ROLE_ALIASES = {
  'user': 'user', '用户': 'user',
  'visitor': 'visitor', '访客': 'visitor',
  'admin': 'admin', '管理员': 'admin'
};

// 将表头数组映射为字段 → 列索引
function mapImportHeaders(headers) {
  const idx = { username: -1, password: -1, email: -1, role: -1, superior: -1, permissions: -1 };
  headers.forEach(function(h, i) {
    const name = String(h || '').trim().toLowerCase();
    Object.keys(IMPORT_HEADER_ALIASES).forEach(function(field) {
      if (idx[field] === -1 && IMPORT_HEADER_ALIASES[field].includes(name)) {
        idx[field] = i;
      }
    });
  });
  return idx;
}

// 导入模板下载（?format=csv|xlsx，默认 csv；CSV 带 UTF-8 BOM 便于 Excel 中文直开）
router.get('/users/import-template', isAuthenticated, isSuperAdmin, (req, res) => {
  const format = (req.query.format || 'csv').toLowerCase();
  const headers = ['username', 'password', 'email', 'role', 'superior', 'permissions'];
  const rows = [
    headers,
    ['zhangsan', 'Zs@12345678', 'zhangsan@example.com', 'user', 'siteadmin', 'articles.view, image-share.upload'],
    ['lisi', 'Ls@12345678', 'lisi@example.com', 'visitor', '', 'articles.view']
  ];

  if (format === 'xlsx') {
    const XLSX = require('xlsx');
    const ws = XLSX.utils.aoa_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '用户导入');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="users-import-template.xlsx"');
    return res.send(buf);
  }

  // 权限列含逗号时需引号包裹（CSV 标准转义；parseCSV 解析器支持引号字段）
  const csvEscape = function(v, i) {
    if (i === 5 && /[,，]/.test(String(v))) return '"' + String(v) + '"';
    return String(v);
  };
  const csv = '\uFEFF' + rows.map(r => r.map(csvEscape).join(',')).join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="users-import-template.csv"');
  res.send(csv);
});

// 批量导入用户（仅超管）：支持 CSV（UTF-8/GBK 自动识别）/ Excel；
// 表头必含 username/password，可选 email/role/superior（对应上级管理员用户名）/permissions（权限键，逗号或分号分隔，如 articles.view, image-share.upload）。
// 采用两段式写入：先创建全部用户（支持同文件内互相指定上级），再统一解析并校验上级链。
router.post('/users/import', isAuthenticated, isSuperAdmin, importUpload.single('file'), async (req, res) => {
  const db = req.db;
  if (!req.file) {
    return res.status(400).json({ error: '请选择要导入的 CSV 或 Excel 文件' });
  }

  let parsed;
  try {
    parsed = parseImportFile(req.file);
  } catch (err) {
    return res.status(400).json({ error: '文件解析失败: ' + (err.message || '格式错误') });
  }

  const colIdx = mapImportHeaders(parsed.headers);
  if (colIdx.username === -1 || colIdx.password === -1) {
    return res.status(400).json({ error: '文件必须包含 username（用户名）和 password（密码）列' });
  }
  if (parsed.dataRows.length === 0) {
    return res.status(400).json({ error: '文件中没有数据行' });
  }
  if (parsed.dataRows.length > MAX_IMPORT_ROWS) {
    return res.status(400).json({ error: '单次导入最多 ' + MAX_IMPORT_ROWS + ' 行，请分批导入' });
  }

  // 权限列校验集合（一次性加载全部权限键，防止逐行查询）
  const allPermKeys = new Set((queryAll(db, 'SELECT perm_key FROM permissions') || []).map(function(r) { return r.perm_key; }));

  const cell = function(row, i) {
    if (i === -1 || i >= row.length) return '';
    return String(row[i] == null ? '' : row[i]).trim();
  };

  const results = { success: 0, failed: 0, errors: [] };
  let importedPermCount = 0;
  const fail = function(rowNum, username, reason) {
    results.failed++;
    if (results.errors.length < 200) {
      results.errors.push({ row: rowNum, username: username || '', reason: reason });
    }
  };

  // ---------- 第一段：逐行校验并创建用户 ----------
  // pendingSuperiors: [{ row, username, superiorName }]（成功行才进入第二段）
  const pendingSuperiors = [];

  for (let i = 0; i < parsed.dataRows.length; i++) {
    const row = parsed.dataRows[i];
    const rowNum = i + 2 + (parsed.headerRowIdx || 0); // 含表头的真实行号
    const username = cell(row, colIdx.username);
    const password = cell(row, colIdx.password);
    const email = cell(row, colIdx.email);
    const roleRaw = cell(row, colIdx.role).toLowerCase();
    const superiorName = cell(row, colIdx.superior);
    const role = IMPORT_ROLE_ALIASES[roleRaw] || 'user';
    const permRaw = cell(row, colIdx.permissions);
    const permKeys = permRaw ? String(permRaw).split(/[，,;；、\s]+/).map(function(s) { return s.trim(); }).filter(Boolean) : [];
    const invalidPerms = permKeys.filter(function(k) { return !allPermKeys.has(k); });
    if (invalidPerms.length) {
      fail(rowNum, username, '权限不存在: ' + invalidPerms.join(', '));
      continue;
    }

    if (!username || username.length < 3) {
      fail(rowNum, username, '用户名无效（至少3个字符）');
      continue;
    }
    // P0-3 口令策略统一：导入账户与注册入口一致的强口令校验（≥10位 + 至少3类字符 + 弱口令黑名单）
    if (!password) {
      fail(rowNum, username, '密码不能为空');
      continue;
    }
    const pwdCheck = validatePassword(password);
    if (!pwdCheck.ok) {
      fail(rowNum, username, pwdCheck.reason);
      continue;
    }

    const existing = queryOne(db, 'SELECT id FROM users WHERE username = ?', [username]);
    if (existing) {
      fail(rowNum, username, '用户名已存在');
      continue;
    }
    if (email) {
      const existingEmail = queryOne(db, "SELECT id FROM users WHERE email = ? AND email != ''", [email]);
      if (existingEmail) {
        fail(rowNum, username, '邮箱 ' + email + ' 已被使用');
        continue;
      }
    }

    try {
      // 异步 bcrypt：bcryptjs 异步模式在轮次间让出事件循环，
      // 避免 1000 行 × ~80ms 的同步哈希将整个进程卡死（Nginx 侧表现为 502/504）
      const hashedPassword = await bcrypt.hash(password, 10);
      db.run("INSERT INTO users (uid, username, password, email, role, status) VALUES (?, ?, ?, ?, ?, 'active')",
        [generateUid(db), username, hashedPassword, email, role]);

      const newUser = queryOne(db, 'SELECT id FROM users WHERE username = ?', [username]);
      if (newUser) {
        if (role === 'admin') {
          // 与手动改角色对齐：晋升 admin 时授予全部权限点
          const allPerms = queryAll(db, 'SELECT perm_key FROM permissions');
          allPerms.forEach(p => {
            db.run('INSERT OR IGNORE INTO user_permissions (user_id, perm_key, granted_by) VALUES (?, ?, ?)',
              [newUser.id, p.perm_key, req.session.user.id]);
          });
        } else {
          grantDefaultPermissions(db, newUser.id, req.session.user.id);
          // 导入文件权限列：校验通过后逐项授予（导入仅超管，含高危权限合规；与分级授权同源校验）
          permKeys.forEach(function(pk) {
            db.run('INSERT OR IGNORE INTO user_permissions (user_id, perm_key, granted_by) VALUES (?, ?, ?)',
              [newUser.id, pk, req.session.user.id]);
          });
          importedPermCount += permKeys.length;
        }
      }

      results.success++;
      if (superiorName) {
        pendingSuperiors.push({ row: rowNum, username: username, superiorName: superiorName });
      }
    } catch (err) {
      fail(rowNum, username, '创建失败: ' + (err.message || '未知错误'));
    }

    // 分批处理：每处理 20 行让出事件循环，避免阻塞其他请求
    if (i > 0 && i % 20 === 0) {
      await new Promise(resolve => { setImmediate(resolve); });
    }
  }

  // ---------- 第二段：解析并写入上级管理员（此时同文件用户已全部建好） ----------
  pendingSuperiors.forEach(function(item) {
    const user = queryOne(db, 'SELECT id FROM users WHERE username = ?', [item.username]);
    const superior = queryOne(db, 'SELECT id FROM users WHERE username = ?', [item.superiorName]);
    if (!user || !superior) {
      fail(item.row, item.username, '上级管理员 "' + item.superiorName + '" 不存在');
      results.success--;
      return;
    }
    const check = validateSuperior(db, user.id, superior.id);
    if (!check.ok) {
      fail(item.row, item.username, check.reason);
      results.success--;
      return;
    }
    db.run('UPDATE users SET superior_id = ? WHERE id = ?', [superior.id, user.id]);
  });

  // ---------- 写入导入历史 ----------
  let logId = 0;
  try {
    db.run(
      'INSERT INTO user_import_logs (filename, file_type, total_count, success_count, failed_count, failed_details, operator_id, operator_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [req.file.originalname, parsed.format || 'csv', parsed.dataRows.length, results.success, results.failed,
        JSON.stringify(results.errors), req.session.user.id, req.session.user.username]);
    const logRow = queryOne(db, 'SELECT id FROM user_import_logs ORDER BY id DESC LIMIT 1');
    logId = logRow ? logRow.id : 0;
  } catch (err) {
    console.error('[用户导入] 写入导入历史失败:', err.message);
  }

  saveDatabase();
  logActivity(db, {
    user_id: req.session.user.id,
    username: req.session.user.username,
    action: 'import',
    target_type: 'user',
    target_id: logId,
    target_title: req.file.originalname,
    detail: '批量导入用户（' + (parsed.format || 'csv').toUpperCase() + '）: 成功 ' + results.success + ' 个, 失败 ' + results.failed + ' 个' + (importedPermCount > 0 ? ', 授予权限 ' + importedPermCount + ' 项' : ''),
    ip: req.ip
  });

  res.json({
    success: true,
    message: '导入完成: 成功 ' + results.success + ' 个, 失败 ' + results.failed + ' 个',
    results: results,
    logId: logId
  });
});

module.exports = router;
