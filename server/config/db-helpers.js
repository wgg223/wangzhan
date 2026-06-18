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

module.exports = {
  setUseNativeSql,
  queryOne,
  queryAll,
  generateUid
};
