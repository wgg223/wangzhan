/**
 * 数据库查询辅助函数
 * 兼容 better-sqlite3 和 sql.js 两种驱动
 */

let useNativeSql = false;

function setUseNativeSql(value) {
  useNativeSql = value;
}

/**
 * 查询单条记录
 * @param {Object} dbInstance - 数据库实例
 * @param {string} sql - SQL 查询语句
 * @param {Array} params - 查询参数
 * @returns {Object|null} 查询结果对象或 null
 */
function queryOne(dbInstance, sql, params = []) {
  try {
    if (useNativeSql) {
      return dbInstance.prepare(sql).get(params) || null;
    } else {
      const stmt = dbInstance.prepare(sql);
      if (params.length > 0) {
        stmt.bind(params);
      }
      if (stmt.step()) {
        const columns = stmt.getColumnNames();
        const values = stmt.get();
        stmt.free();
        const result = {};
        columns.forEach((col, index) => {
          result[col] = values[index];
        });
        return result;
      }
      stmt.free();
      return null;
    }
  } catch (err) {
    console.error('查询单条记录失败:', err.message, 'SQL:', sql);
    return null;
  }
}

/**
 * 查询多条记录
 * @param {Object} dbInstance - 数据库实例
 * @param {string} sql - SQL 查询语句
 * @param {Array} params - 查询参数
 * @returns {Array} 查询结果数组
 */
function queryAll(dbInstance, sql, params = []) {
  try {
    if (useNativeSql) {
      return dbInstance.prepare(sql).all(params);
    } else {
      const stmt = dbInstance.prepare(sql);
      if (params.length > 0) {
        stmt.bind(params);
      }
      const results = [];
      while (stmt.step()) {
        const columns = stmt.getColumnNames();
        const values = stmt.get();
        const row = {};
        columns.forEach((col, index) => {
          row[col] = values[index];
        });
        results.push(row);
      }
      stmt.free();
      return results;
    }
  } catch (err) {
    console.error('查询多条记录失败:', err.message, 'SQL:', sql);
    return [];
  }
}

/**
 * 生成唯一用户 ID
 * @param {Object} db - 数据库实例
 * @returns {string} 8位唯一ID
 */
function generateUid(db) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let uid;
  let attempts = 0;
  do {
    uid = '';
    for (let i = 0; i < 8; i++) {
      uid += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    const existing = queryOne(db, 'SELECT id FROM users WHERE uid = ?', [uid]);
    if (!existing) return uid;
    attempts++;
  } while (attempts < 100);
  return uid + Date.now().toString(36).slice(-4).toUpperCase();
}

/**
 * 为新用户授予默认权限（注册 / 后台创建 / 批量导入 / OAuth 登录统一入口）
 * 默认集（3 项基础访问，与 db-seed 收窄迁移一致）：
 *   - 主页访问 / 文章访问 / 图片分享访问
 * 不含：小说访问、详情/社区访问（如需由管理员在权限页授予）；
 * 不含 site_stats.view（站点统计仅授予管理员及以上，见 db-seed 回收迁移）。
 * @param {Object} db - 数据库实例
 * @param {number} userId - 用户ID
 * @param {number} grantedBy - 授权者ID
 */
function grantDefaultPermissions(db, userId, grantedBy) {
  const defaultPerms = [
    'homepage.access', 'articles.access', 'image-share.access'
  ];
  defaultPerms.forEach(perm => {
    db.run('INSERT OR IGNORE INTO user_permissions (user_id, perm_key, granted_by) VALUES (?, ?, ?)',
      [userId, perm, grantedBy]);
  });
}

/**
 * 管理员最小权限集：自动创建 / 晋升管理员时授予（最小化原则）
 * - 基础访问 3 项（与普通用户一致）：主页 / 文章 / 图片分享
 * - users.manage：用户管理核心职责（在行级数据范围内管理下级树）
 * - site_stats.view：站点统计（后台管理入口默认落点）
 * 其余权限（含高危 / 超高危）一律由管理员本人走权限申请流程（三级审批）。
 */
function grantAdminDefaultPermissions(db, userId, grantedBy) {
  const adminDefaultPerms = [
    'homepage.access', 'articles.access', 'image-share.access',
    'users.manage', 'site_stats.view'
  ];
  adminDefaultPerms.forEach(perm => {
    db.run('INSERT OR IGNORE INTO user_permissions (user_id, perm_key, granted_by) VALUES (?, ?, ?)',
      [userId, perm, grantedBy]);
  });
}

module.exports = {
  setUseNativeSql,
  queryOne,
  queryAll,
  generateUid,
  grantDefaultPermissions,
  grantAdminDefaultPermissions
};
