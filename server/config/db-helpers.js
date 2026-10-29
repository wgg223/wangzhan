/**
 * 数据库查询辅助函数
 * 兼容 better-sqlite3 和 sql.js 两种驱动
 *
 * 优化：better-sqlite3 模式下缓存 prepared statement，
 *       相同 SQL 直接复用已编译语句，避免重复解析开销。
 *       缓存上限 500 条（LRU 淘汰），防止 SQL 模板爆炸时内存失控。
 */

let useNativeSql = false;

// better-sqlite3 prepared statement 缓存（Map<sql, Statement>）
// 使用 Map 的天然插入顺序：最近访问的条目删除后重新插入即移到末尾，
// 超限时删除最早的条目（FIFO 近似 LRU），无需额外链表。
const stmtCache = new Map();
const STMT_CACHE_MAX = 500;

/**
 * 获取缓存的 prepared statement（仅 better-sqlite3 模式使用）
 * @param {Object} dbInstance - better-sqlite3 数据库实例
 * @param {string} sql - SQL 查询语句
 * @returns {Object} prepared statement
 */
function getCachedStmt(dbInstance, sql) {
  let stmt = stmtCache.get(sql);
  if (stmt) {
    // 移到末尾（最近使用）
    stmtCache.delete(sql);
    stmtCache.set(sql, stmt);
    return stmt;
  }
  // 缓存未命中：编译新语句
  stmt = dbInstance.prepare(sql);
  if (stmtCache.size >= STMT_CACHE_MAX) {
    // 淘汰最早的条目
    const oldestKey = stmtCache.keys().next().value;
    stmtCache.delete(oldestKey);
  }
  stmtCache.set(sql, stmt);
  return stmt;
}

/**
 * 清空 prepared statement 缓存（数据库关闭/重建时调用）
 */
function clearStmtCache() {
  stmtCache.clear();
}

function setUseNativeSql(value) {
  useNativeSql = value;
  if (!value) {
    clearStmtCache(); // 切换到 sql.js 模式时清空缓存
  }
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
      return getCachedStmt(dbInstance, sql).get(params) || null;
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
      return getCachedStmt(dbInstance, sql).all(params);
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
 * 执行写操作（INSERT/UPDATE/DELETE），使用缓存的 prepared statement
 * @param {Object} dbInstance - 数据库实例
 * @param {string} sql - SQL 语句
 * @param {Array} params - 参数
 * @returns {Object} better-sqlite3 的 RunResult 或 sql.js 的变更结果
 */
function runStmt(dbInstance, sql, params = []) {
  try {
    if (useNativeSql) {
      return getCachedStmt(dbInstance, sql).run(params);
    } else {
      return dbInstance.run(sql, params);
    }
  } catch (err) {
    // duplicate column name 是迁移正常噪音，静默
    if (err.message && err.message.includes('duplicate column name')) {
      return null;
    }
    console.error('执行写操作失败:', err.message, 'SQL:', sql);
    throw err;
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
  // 使用事务包裹批量插入，减少 WAL 检查点开销
  if (useNativeSql && db.transaction) {
    const insertMany = db.transaction(() => {
      defaultPerms.forEach(perm => {
        runStmt(db, 'INSERT OR IGNORE INTO user_permissions (user_id, perm_key, granted_by) VALUES (?, ?, ?)',
          [userId, perm, grantedBy]);
      });
    });
    insertMany();
  } else {
    defaultPerms.forEach(perm => {
      db.run('INSERT OR IGNORE INTO user_permissions (user_id, perm_key, granted_by) VALUES (?, ?, ?)',
        [userId, perm, grantedBy]);
    });
  }
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
  // 使用事务包裹批量插入
  if (useNativeSql && db.transaction) {
    const insertMany = db.transaction(() => {
      adminDefaultPerms.forEach(perm => {
        runStmt(db, 'INSERT OR IGNORE INTO user_permissions (user_id, perm_key, granted_by) VALUES (?, ?, ?)',
          [userId, perm, grantedBy]);
      });
    });
    insertMany();
  } else {
    adminDefaultPerms.forEach(perm => {
      db.run('INSERT OR IGNORE INTO user_permissions (user_id, perm_key, granted_by) VALUES (?, ?, ?)',
        [userId, perm, grantedBy]);
    });
  }
}

module.exports = {
  setUseNativeSql,
  queryOne,
  queryAll,
  runStmt,
  clearStmtCache,
  generateUid,
  grantDefaultPermissions,
  grantAdminDefaultPermissions
};
