/**
 * 批量用户操作核心逻辑（后台"勾选批量管理"复用）
 * 作用：将 approve / disable / delete / role / set_superior 的批量执行收敛到一处，
 *       与单用户路由共用同一套保护逻辑（self 保护 / ROLE_HIERARCHY / canOperateUser /
 *       ensureAtLeastOneActiveSuperAdmin / deactivated_at 注销锁定），
 *       避免批量为每行复制粘贴安全校验导致口径漂移。
 *
 * 性能设计（对应"减少 502"目标）：
 *   - 每处理 YIELD_EVERY 个用户通过 setImmediate 让出事件循环，
 *     使批量期间健康检查/其他请求仍能被处理，避免上游超时被 Nginx 判为 502；
 *   - delete 的关联数据清理在"每用户独立事务"内完成（文件删除在事务外异步执行），
 *     单用户失败只回滚该用户，不拖垮整批；
 *   - 错误信息上限 200 条，防止大额失败时响应体膨胀。
 *
 * @param {Object} db better-sqlite3 / sql.js 数据库实例
 * @param {Object} operator 当前操作者（req.session.user）
 * @param {string} action 批量动作：approve | disable | delete | role | set_superior
 * @param {number[]} ids 目标用户 ID 数组（已去重、已校验为正整数）
 * @param {Object} opts 附加参数：{ role?, superiorId? }
 * @returns {Promise<{success:number, failed:number, errors:Array}>}
 */
const { queryOne, queryAll, grantAdminDefaultPermissions } = require('../config/db-helpers');
const { ROLE_HIERARCHY, ROLE_WHITELIST, canOperateUser, ensureAtLeastOneActiveSuperAdmin } = require('../middlewares/auth');
const { createNotification } = require('../routes/community');
const { cleanupUserDependencies } = require('../utils/user-deps');
const { validateSuperior } = require('../utils/permission-flow');
const fsSafe = require('../utils/fs-safe');

const YIELD_EVERY = 20; // 每处理 20 个用户让出一次事件循环
const MAX_ERRORS = 200; // 失败明细上限

function yieldLoop() {
  return new Promise((resolve) => { setImmediate(resolve); });
}

/**
 * 单用户批准/启用（pending→active 或 disabled→active）
 */
function opApprove(db, operator, target) {
  db.run("UPDATE users SET status = 'active' WHERE id = ?", [target.id]);
  const title = target.status === 'pending' ? '账号已通过审核' : '账号已启用';
  const content = target.status === 'pending'
    ? '您的账号已通过管理员审核，现在可以正常使用所有功能。'
    : '您的账号已被管理员重新启用。';
  createNotification(db, {
    userId: target.id, type: 'account', title: title, content: content,
    fromUserId: operator.id, targetType: 'account', targetId: ''
  });
  return true;
}

/**
 * 单用户禁用（与单用户路由同一套保护）
 */
function opDisable(db, operator, target, opts, notif) {
  if (target.id === operator.id) return notif(null, '不能禁用当前登录的管理员账户');
  if (target.deactivated_at) return notif(null, '该账号已自行注销，仅可删除账号，无需禁用');

  const opLevel = ROLE_HIERARCHY[operator.role] || 0;
  const tgtLevel = ROLE_HIERARCHY[target.role] || 0;
  if (tgtLevel >= opLevel && operator.role !== 'super_admin') {
    return notif(null, '权限不足：不能操作同级别或更高级别的用户');
  }
  if (target.role === 'super_admin' && !ensureAtLeastOneActiveSuperAdmin(db, target.id)) {
    return notif(null, '不能禁用最后一个超级管理员');
  }

  db.run("UPDATE users SET status = 'disabled' WHERE id = ?", [target.id]);
  createNotification(db, {
    userId: target.id, type: 'account', title: '账号已被禁用',
    content: '您的账号已被管理员禁用，如需恢复请联系管理员。',
    fromUserId: operator.id, targetType: 'account', targetId: ''
  });
  return true;
}

/**
 * 单用户删除（每用户独立事务，返回待删除文件列表）
 */
function opDelete(db, operator, target, opts, notif) {
  if (target.id === operator.id) return notif(null, '不能删除当前登录的管理员账户');

  const opLevel = ROLE_HIERARCHY[operator.role] || 0;
  const tgtLevel = ROLE_HIERARCHY[target.role] || 0;
  if (tgtLevel >= opLevel && operator.role !== 'super_admin') {
    return notif(null, '权限不足：不能操作同级别或更高级别的用户');
  }
  if (target.role === 'super_admin' && !ensureAtLeastOneActiveSuperAdmin(db, target.id)) {
    return notif(null, '不能删除最后一个超级管理员');
  }

  let files = [];
  try {
    db.run('BEGIN');
    files = cleanupUserDependencies(db, target.id);
    db.run('DELETE FROM users WHERE id = ?', [target.id]);
    db.run('COMMIT');
  } catch (err) {
    try { db.run('ROLLBACK'); } catch (rollbackErr) { /* 忽略回滚异常 */ }
    return notif(null, '删除失败: ' + (err.message || '未知错误'));
  }
  return files;
}

/**
 * 单用户改角色（白名单 + 可操作校验 + 锁死保护 + 高危二次确认）
 * P0-2 修复：改角色属高危提权操作，调用方必须在 opts.confirmVerified 中提供
 *            "操作者密码二次确认已通过"标记（校验逻辑在路由层完成），否则拒绝执行。
 */
function opRole(db, operator, target, opts, notif) {
  const role = opts.role;
  if (!ROLE_WHITELIST.includes(role)) return notif(null, '非法的角色值');
  if (!opts.confirmVerified) {
    return notif(null, '改角色属于高危操作，必须通过操作者密码二次确认后执行');
  }

  const check = canOperateUser(operator, target);
  if (!check.ok) return notif(null, check.reason);

  if (target.role === 'super_admin' && role !== 'super_admin' &&
      !ensureAtLeastOneActiveSuperAdmin(db, target.id)) {
    return notif(null, '不能降级最后一个超级管理员');
  }

  db.run('UPDATE users SET role = ? WHERE id = ?', [role, target.id]);
  if (role === 'admin') {
    // 最小权限原则：批量晋升 admin 仅授予管理员最小权限集，其余权限（含高危/超高危）走申请流程
    grantAdminDefaultPermissions(db, target.id, operator.id);
  }
  return true;
}

/**
 * 单用户设置/清除上级管理员（superiorId=0 表示清除）
 */
function opSetSuperior(db, operator, target, opts, notif) {
  const superiorId = opts.superiorId || 0;
  if (superiorId) {
    const check = validateSuperior(db, target.id, superiorId);
    if (!check.ok) return notif(null, check.reason);
  }
  db.run('UPDATE users SET superior_id = ? WHERE id = ?', [superiorId || null, target.id]);
  return true;
}

const ACTION_HANDLERS = {
  approve: { handler: opApprove, needsOpts: false },
  disable: { handler: opDisable, needsOpts: false },
  delete: { handler: opDelete, needsOpts: false },
  role: { handler: opRole, needsOpts: true },
  set_superior: { handler: opSetSuperior, needsOpts: true }
};

/**
 * 执行批量用户操作
 * 说明：notif 回调统一收集失败；delete 的磁盘文件在全部用户处理完后统一删除。
 */
async function runBatchUserAction(db, operator, action, ids, opts) {
  const results = { success: 0, failed: 0, errors: [] };
  const pendingFiles = [];

  const fail = function(target, reason) {
    results.failed++;
    if (results.errors.length < MAX_ERRORS) {
      results.errors.push({
        id: target ? target.id : null,
        username: target ? target.username : '',
        reason: reason
      });
    }
  };

  const entry = ACTION_HANDLERS[action];
  if (!entry) {
    fail(null, '无效的批量操作类型: ' + action);
    return results;
  }

  for (let i = 0; i < ids.length; i++) {
    const userId = ids[i];
    const target = queryOne(db,
      'SELECT id, uid, username, role, status, deactivated_at, superior_id FROM users WHERE id = ?',
      [userId]);

    if (!target) {
      fail({ id: userId, username: '' }, '用户不存在');
    } else {
      try {
        const outcome = entry.handler(db, operator, target, opts || {}, fail);
        if (outcome === true) {
          results.success++;
        } else if (Array.isArray(outcome)) {
          // delete：事务已提交，收集待删除文件
          pendingFiles.push.apply(pendingFiles, outcome);
          results.success++;
        }
        // outcome 为 undefined 时说明 handler 内部已通过 notif 上报失败
      } catch (err) {
        console.error('[批量用户操作] ' + action + ' 用户 ' + userId + ' 失败:', err);
        fail(target, '操作失败: ' + (err.message || '未知错误'));
      }
    }

    // 每处理 YIELD_EVERY 个用户让出事件循环，保持服务响应
    // eslint-disable-next-line no-await-in-loop -- 主动让出事件循环是设计目标，非误用
    if ((i + 1) % YIELD_EVERY === 0) {
      await yieldLoop();
    }
  }

  // 文件删除不可回滚且不阻塞响应：全部事务提交后统一异步删除
  pendingFiles.forEach(filePath => {
    fsSafe.safeUnlink(filePath);
  });

  return results;
}

module.exports = { runBatchUserAction, YIELD_EVERY, MAX_ERRORS, ACTION_HANDLERS };
