const { queryOne, getDb } = require('../config/database');
const { findTokenRecord, touchToken } = require('../config/tokens');

/**
 * API Token 鉴权中间件（给原生 App 使用）
 * 校验 Authorization: Bearer <token>，成功后把用户注入 req.apiUser，
 * 同时写入 req.session.user，使现有 isAdmin 等中间件可以复用。
 * 失败时返回 JSON 401/403。
 */
function apiAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: '未登录' });
  }

  const db = getDb();
  if (!db) {
    return res.status(500).json({ error: '数据库未初始化' });
  }

  const record = findTokenRecord(db, token);
  if (!record) {
    return res.status(401).json({ error: '登录已过期，请重新登录' });
  }

  const user = queryOne(
    db,
    'SELECT id, uid, username, nickname, avatar, role, status, email, bio, image_no_review, password FROM users WHERE id = ?',
    [record.user_id]
  );
  if (!user) {
    return res.status(401).json({ error: '用户不存在' });
  }
  if (user.status !== 'active') {
    return res.status(403).json({ error: '账号已被禁用' });
  }

  touchToken(db, token);

  req.apiUser = user;
  req.session = req.session || {};
  req.session.user = user;
  req.session.userId = user.id;
  next();
}

/**
 * 管理员权限校验（API 版，失败返回 JSON 403 而非重定向）
 */
function apiRequireAdmin(req, res, next) {
  const user = req.apiUser;
  if (user && (user.role === 'admin' || user.role === 'super_admin')) {
    return next();
  }
  return res.status(403).json({ error: '需要管理员权限' });
}

module.exports = { apiAuth, apiRequireAdmin };
