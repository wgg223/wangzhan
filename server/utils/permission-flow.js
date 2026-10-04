/**
 * 权限审批流共享工具
 * 供 server/routes/admin/permissions.js（后台审批）与
 *     server/routes/permission-applications.js（前台提交申请）
 * 复用，保证两条路径的高危判定与审批链解析口径一致。
 *
 * 流程设计（二级审批）：
 *   基础权限：用户申请 → 对应管理员（superior_id）审批 → 系统自动确认生效
 *   高危权限：用户申请 → 对应管理员审批 → 管理员的上级审批 → 生效
 *   链路缺失兜底：申请人未指定对应管理员（或审批人无上级）时，由超级管理员代为审批。
 */

const { queryOne, queryAll } = require('../config/db-helpers');

// 高危权限兜底清单（兼容旧库：permissions 表缺少 high_risk 标记或尚未被 seed 覆盖时仍生效）
const HIGH_RISK_PERMS = [
  'users.manage',
  'permissions.manage',
  'settings.manage',
  'data.manage'
];

// 超高危权限兜底清单（兼容旧库：permissions 表缺少 ultra_high_risk 标记或尚未被 seed 覆盖时仍生效）
// 超高危 = 账号/权限/设置/数据核心治理类：申请走三级审批链（对应管理员 → 上级管理员 → 超级管理员终审）
const ULTRA_HIGH_RISK_PERMS = [
  'users.manage',
  'users.role.manage',
  'users.delete',
  'users.create',
  'permissions.manage',
  'permissions.grant',
  'permissions.revoke',
  'settings.manage',
  'data.manage'
];

/**
 * 判定一次权限申请是否属于高危流程（表驱动 v2）。
 * 规则（任一命中即高危）：
 *  1. permissions 表 high_risk = 1（重建后的权限列表已为账号/权限/设置/数据/
 *     密钥类及可批量删除内容的权限点标记高危，见 db-seed defaultPermissions）
 *  2. 兜底清单 HIGH_RISK_PERMS 命中（旧库尚未标记时）
 *  3. 高危用户：管理员角色申请任何管理类权限（防止管理员自我扩权）
 * @param {object} db 数据库实例
 * @param {string} permKey 权限键
 * @param {string} applicantRole 申请人角色
 * @returns {boolean}
 */
function isHighRiskPerm(db, permKey, applicantRole) {
  if (!permKey) return false;
  if (HIGH_RISK_PERMS.includes(permKey)) return true;
  // 表驱动：优先读 permissions.high_risk 标记
  try {
    if (db) {
      const row = queryOne(db, 'SELECT high_risk FROM permissions WHERE perm_key = ?', [permKey]);
      if (row && Number(row.high_risk) === 1) return true;
    }
  } catch (e) {
    // 表结构不兼容时忽略，回退到角色规则与兜底清单
  }
  // 高危用户：管理员角色申请任何管理类权限（防止管理员自我扩权）
  if (applicantRole === 'admin' && typeof permKey === 'string' && permKey.endsWith('.manage')) return true;
  return false;
}

/**
 * 判定一次权限申请是否属于超高危流程（表驱动 + 兜底清单）。
 * 超高危权限的申请必须由超级管理员终审（三级链：对应管理员 → 上级管理员 → 超管）。
 * @param {object} db 数据库实例
 * @param {string} permKey 权限键
 * @returns {boolean}
 */
function isUltraHighRiskPerm(db, permKey) {
  if (!permKey) return false;
  if (ULTRA_HIGH_RISK_PERMS.includes(permKey)) return true;
  // 表驱动：优先读 permissions.ultra_high_risk 标记
  try {
    if (db) {
      const row = queryOne(db, 'SELECT ultra_high_risk FROM permissions WHERE perm_key = ?', [permKey]);
      if (row && Number(row.ultra_high_risk) === 1) return true;
    }
  } catch (e) {
    // 表结构不兼容时忽略，回退到兜底清单
  }
  return false;
}

/**
 * 行级数据权限：当前用户可见的用户 id 集合（用户管理 / 权限管理页数据范围）
 * 规则：
 *  - super_admin：全量可见（返回 null 表示不限制）
 *  - admin：仅可见自己 + 直接下级 + 递归再下级（其审批队列子树）；
 *           不可见同级管理员、上级、其他分支与孤立用户
 *  - 普通用户：仅可见自己
 * 实现：沿 superior_id 递归收集子树（防环：已访问集合）
 * @param {object} db 数据库实例
 * @param {object} user 当前用户（含 id / role）
 * @returns {Set<number>|null} null=全量；Set=允许的用户 id 集合
 */
function getVisibleUserIds(db, user) {
  if (!user) return new Set();
  if (user.role === 'super_admin') return null;
  const ids = new Set([user.id]);
  const queue = [user.id];
  while (queue.length) {
    const pid = queue.shift();
    const children = queryAll(db, 'SELECT id FROM users WHERE superior_id = ?', [pid]);
    (children || []).forEach(function (c) {
      if (!ids.has(c.id)) {
        ids.add(c.id);
        queue.push(c.id);
      }
    });
  }
  return ids;
}

/**
 * 查询全部在职超级管理员 id（链路缺失时的兜底审批人）
 * @returns {number[]}
 */
function getSuperAdminIds(db) {
  const rows = queryAll(db, "SELECT id FROM users WHERE role = 'super_admin' AND status = 'active'");
  return (rows || []).map(r => r.id);
}

/**
 * 解析申请当前阶段的审批人
 * @param {object} app permission_applications 行（需含 user_id / approval_stage / approved_by_admin）
 * @returns {{approverId: number|null, anySuperAdmin: boolean}}
 *   approverId 非空 → 仅该用户可审批；anySuperAdmin=true → 任意超级管理员可审批
 */
function getStageApprover(db, app) {
  const stage = app.approval_stage || 1;
  let approverId = null;

  if (stage === 1) {
    // 一级审批人 = 申请人的对应管理员
    const applicant = queryOne(db, 'SELECT superior_id FROM users WHERE id = ?', [app.user_id]);
    approverId = applicant ? (applicant.superior_id || null) : null;
  } else if (stage === 2) {
    // 二级审批人 = 一级审批人的上级
    const stage1 = queryOne(db, 'SELECT superior_id FROM users WHERE id = ?', [app.approved_by_admin]);
    approverId = stage1 ? (stage1.superior_id || null) : null;
  } else if (stage === 3) {
    // 三级审批人 = 任意超级管理员（超高危终审）
    return { approverId: null, anySuperAdmin: true };
  }

  if (approverId) {
    return { approverId: approverId, anySuperAdmin: false };
  }
  return { approverId: null, anySuperAdmin: true };
}

/**
 * 校验当前用户是否为申请当前阶段的合法审批人
 * @returns {{ok: boolean, reason?: string}}
 */
function canApproveApplication(db, currentUser, app) {
  if (!app || app.status !== 'pending') {
    return { ok: false, reason: '申请不存在或已处理' };
  }
  const stage = getStageApprover(db, app);
  if (stage.anySuperAdmin) {
    if (currentUser.role === 'super_admin') return { ok: true };
    return { ok: false, reason: '该申请需由超级管理员审批' };
  }
  if (currentUser.id === stage.approverId) return { ok: true };
  if (currentUser.role === 'super_admin') {
    // 超管可见全貌但不能越过指定审批链（保证二级审批语义）
    const st = app.approval_stage || 1;
    const stageName = st === 1 ? '对应管理员' : (st === 2 ? '上级管理员' : '超级管理员');
    return { ok: false, reason: '该申请需由申请人的' + stageName + '审批' };
  }
  return { ok: false, reason: '您不是该申请的指定审批人' };
}

/**
 * 授予申请的权限（幂等）
 * @returns {boolean} 本次是否真正插入
 */
function grantApplicationPermission(db, app, granterId) {
  const existing = queryOne(db, 'SELECT id FROM user_permissions WHERE user_id = ? AND perm_key = ?',
    [app.user_id, app.perm_key]);
  if (existing) return false;
  db.run('INSERT INTO user_permissions (user_id, perm_key, granted_by) VALUES (?, ?, ?)',
    [app.user_id, app.perm_key, granterId]);
  return true;
}

/**
 * 向申请当前阶段的审批人发送站内通知
 * @param {Function} createNotification 通知创建函数（server/routes/community.js 导出）
 */
function notifyStageApprover(db, createNotification, app, applicantName, permName, fromUserId) {
  const stage = getStageApprover(db, app);
  const st = app.approval_stage || 1;
  const stageLabel = st === 1 ? '对应管理员' : (st === 2 ? '上级管理员' : '超级管理员');
  const title = '有新的权限申请待您审批';
  const content = '用户「' + applicantName + '」申请权限「' + (permName || app.perm_key) + '」' +
    '，您是其' + stageLabel + '，请前往 后台 → 我的审批 处理。';

  const targets = stage.anySuperAdmin ? getSuperAdminIds(db) : [stage.approverId];
  targets.forEach(uid => {
    createNotification(db, {
      userId: uid, type: 'permission', title: title, content: content,
      fromUserId: fromUserId, targetType: 'permission_application', targetId: String(app.id)
    });
  });
}

/**
 * 通知申请人审批结果
 */
function notifyApplicant(db, createNotification, app, applicantId, permName, approved, reason, fromUserId) {
  const permText = permName || app.perm_key;
  const title = approved ? '权限申请已通过' : '权限申请已被拒绝';
  const content = approved
    ? '您申请的权限「' + permText + '」已审批通过并生效。'
    : '您申请的权限「' + permText + '」被拒绝。' + (reason ? '原因：' + reason : '');
  createNotification(db, {
    userId: applicantId, type: 'permission', title: title, content: content,
    fromUserId: fromUserId, targetType: 'permission_application', targetId: String(app.id)
  });
}

/**
 * 校验上级链路设置（超管指定上级 / 批量导入时使用）：
 * 上级必须存在、角色为管理员/超管、不能是自己、不能形成循环链
 * @returns {{ok: boolean, reason?: string}}
 */
function validateSuperior(db, targetUserId, superiorId) {
  if (!superiorId) return { ok: true };
  if (superiorId === targetUserId) {
    return { ok: false, reason: '不能将自己设为自己的上级' };
  }
  const superior = queryOne(db, 'SELECT id, username, role, superior_id FROM users WHERE id = ?', [superiorId]);
  if (!superior) {
    return { ok: false, reason: '指定的上级用户不存在' };
  }
  if (superior.role !== 'admin' && superior.role !== 'super_admin') {
    return { ok: false, reason: '上级必须是管理员或超级管理员角色' };
  }
  // 沿上级链向上查找，若回到目标用户则形成循环
  let cur = superior;
  const visited = new Set([targetUserId, superiorId]);
  while (cur && cur.superior_id) {
    if (cur.superior_id === targetUserId) {
      return { ok: false, reason: '设置该上级会形成循环审批链' };
    }
    if (visited.has(cur.superior_id)) break; // 防御：已有环则直接拦截
    visited.add(cur.superior_id);
    cur = queryOne(db, 'SELECT id, superior_id FROM users WHERE id = ?', [cur.superior_id]);
  }
  return { ok: true };
}

module.exports = {
  HIGH_RISK_PERMS,
  ULTRA_HIGH_RISK_PERMS,
  isHighRiskPerm,
  isUltraHighRiskPerm,
  getVisibleUserIds,
  getSuperAdminIds,
  getStageApprover,
  canApproveApplication,
  grantApplicationPermission,
  notifyStageApprover,
  notifyApplicant,
  validateSuperior
};
