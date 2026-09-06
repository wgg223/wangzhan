/**
 * API Token 管理模块（原生 App / Flutter 客户端登录凭证）
 * 作用：
 *   - 签发/校验/注销 API Token（替代 session 的跨端登录凭证）；
 *   - 数据库中只保存 Token 的 SHA-256 哈希，数据库泄露也不会直接泄露有效 Token；
 *   - 记录签发时的 token_version，用户改密/强制下线后版本递增，旧 Token 全部失效；
 *   - 启动时清理过期 Token 与 90 天前的活动日志。
 */

const crypto = require('crypto');          // 加密模块（哈希/随机数）
const { queryOne, getDb } = require('./database');

const TOKEN_TTL_DAYS = 30;                 // Token 有效期：30 天

/**
 * 计算 Token 的 SHA-256 哈希
 * @param {string} token - 明文 Token
 * @returns {string} 十六进制哈希串
 * 说明：数据库仅存哈希，校验时对用户提交的 Token 重新哈希比对，
 *       即使数据库被拖走也无法反推出可用 Token。
 */
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * 为用户签发一个新 Token
 * @param {Object} db - 数据库实例
 * @param {number} userId - 用户ID
 * @returns {string} 明文 Token（仅此一次返回给客户端，之后不可再获取）
 * 说明：记录签发时的 token_version；之后用户改密会使 token_version 递增，
 *       旧 Token 在 apiAuth 校验时因版本不匹配而失效。
 */
function issueToken(db, userId) {
  const token = crypto.randomBytes(32).toString('hex');   // 256 位随机明文 Token
  const expiresAt = new Date(Date.now() + TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString(); // 30 天后过期
  const user = queryOne(db, 'SELECT token_version FROM users WHERE id = ?', [userId]);
  const tokenVersion = (user && user.token_version) || 0;
  db.run(
    'INSERT INTO api_tokens (user_id, token_hash, expires_at, token_version) VALUES (?, ?, ?, ?)',
    [userId, hashToken(token), expiresAt, tokenVersion]
  );
  return token;   // 明文只出现这一次
}

/**
 * 根据明文 Token 查找记录（过期返回 null）
 * @param {Object} db - 数据库实例
 * @param {string} token - 客户端提交的明文 Token
 * @returns {Object|null} token 记录 { id, user_id, expires_at, token_version } 或 null
 */
function findTokenRecord(db, token) {
  if (!token) return null;
  const row = queryOne(db, 'SELECT id, user_id, expires_at, token_version FROM api_tokens WHERE token_hash = ?', [hashToken(token)]);
  if (!row) return null;
  // 过期校验：过期时间已到则视为无效
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
    return null;
  }
  return row;
}

/**
 * 更新 Token 最后使用时间
 * @param {Object} db - 数据库实例
 * @param {string} token - 明文 Token
 * 说明：仅用于审计/活跃度统计，失败静默忽略。
 */
function touchToken(db, token) {
  try {
    db.run('UPDATE api_tokens SET last_used_at = ? WHERE token_hash = ?', [new Date().toISOString(), hashToken(token)]);
  } catch (e) { /* 忽略 */ }
}

/**
 * 注销 Token（登出时调用）
 * @param {Object} db - 数据库实例
 * @param {string} token - 明文 Token
 */
function revokeToken(db, token) {
  if (!token) return;
  db.run('DELETE FROM api_tokens WHERE token_hash = ?', [hashToken(token)]);
}

/**
 * 清理过期 Token 与超期活动日志（应用启动时调用）
 * 说明：
 *   - 删除所有已过期的 api_tokens；
 *   - 删除 90 天前的 activity_logs，分小批（每批 500 行）删除避免长事务锁库，
 *     最多清理 10000 行。
 */
function cleanupExpiredTokens() {
  try {
    const db = getDb();
    if (db) {
      // 删除过期 Token
      db.run('DELETE FROM api_tokens WHERE expires_at IS NOT NULL AND expires_at < ?', [new Date().toISOString()]);

      // 自动清理 90 天前的活动日志（分小批删除，避免长事务锁库；最多清理 10000 行）
      let deleted = 0;
      while (deleted < 10000) {
        const result = db.run("DELETE FROM activity_logs WHERE id IN (SELECT id FROM activity_logs WHERE created_at < datetime('now', '-90 days') LIMIT 500)");
        // better-sqlite3 的 run 返回 { changes }，sql.js 用 getRowsModified()
        let changes = result && typeof result.changes === 'number' ? result.changes : 0;
        if (!changes && typeof db.getRowsModified === 'function') {
          changes = db.getRowsModified();
        }
        if (!changes || changes === 0) break;   // 没有可删的行则结束
        deleted += changes;
      }
    }
  } catch (e) { /* 忽略 */ }
}

module.exports = { issueToken, findTokenRecord, touchToken, revokeToken, cleanupExpiredTokens, TOKEN_TTL_DAYS };
