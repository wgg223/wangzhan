const crypto = require('crypto');
const { queryOne, getDb } = require('./database');

const TOKEN_TTL_DAYS = 30;

// 数据库中只存 token 的 SHA-256 哈希，避免泄露
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// 为用户签发一个新 token（返回明文，仅此一次）
function issueToken(db, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  db.run(
    'INSERT INTO api_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)',
    [userId, hashToken(token), expiresAt]
  );
  return token;
}

// 根据明文 token 查找记录（过期返回 null）
function findTokenRecord(db, token) {
  if (!token) return null;
  const row = queryOne(db, 'SELECT id, user_id, expires_at FROM api_tokens WHERE token_hash = ?', [hashToken(token)]);
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
    }
  } catch (e) { /* 忽略 */ }
}

module.exports = { issueToken, findTokenRecord, touchToken, revokeToken, cleanupExpiredTokens, TOKEN_TTL_DAYS };
