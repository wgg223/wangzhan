const crypto = require('crypto');
const { queryOne, getDb } = require('./database');

const TOKEN_TTL_DAYS = 30;

// 数据库中只存 token 的 SHA-256 哈希，避免泄露
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// 为用户签发一个新 token（返回明文，仅此一次）
// 记录签发时的 token_version，改密后版本递增使旧 token 全部失效
function issueToken(db, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const user = queryOne(db, 'SELECT token_version FROM users WHERE id = ?', [userId]);
  const tokenVersion = (user && user.token_version) || 0;
  db.run(
    'INSERT INTO api_tokens (user_id, token_hash, expires_at, token_version) VALUES (?, ?, ?, ?)',
    [userId, hashToken(token), expiresAt, tokenVersion]
  );
  return token;
}

// 根据明文 token 查找记录（过期返回 null）
function findTokenRecord(db, token) {
  if (!token) return null;
  const row = queryOne(db, 'SELECT id, user_id, expires_at, token_version FROM api_tokens WHERE token_hash = ?', [hashToken(token)]);
  if (!row) return null;
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
    return null;
  }
  return row;
}

// 更新最后使用时间
function touchToken(db, token) {
  try {
    db.run('UPDATE api_tokens SET last_used_at = ? WHERE token_hash = ?', [new Date().toISOString(), hashToken(token)]);
  } catch (e) { /* 忽略 */ }
}

// 注销 token
function revokeToken(db, token) {
  if (!token) return;
  db.run('DELETE FROM api_tokens WHERE token_hash = ?', [hashToken(token)]);
}

// 清理过期 token（启动时调用）
function cleanupExpiredTokens() {
  try {
    const db = getDb();
    if (db) {
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
        if (!changes || changes === 0) break;
        deleted += changes;
      }
    }
  } catch (e) { /* 忽略 */ }
}

module.exports = { issueToken, findTokenRecord, touchToken, revokeToken, cleanupExpiredTokens, TOKEN_TTL_DAYS };
