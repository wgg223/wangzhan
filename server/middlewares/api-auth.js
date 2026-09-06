/**
 * API Token 鉴权中间件集（给原生 App / Flutter 客户端使用）
 * 职责：
 *   - apiAuth             ：校验 Authorization: Bearer <token>，注入 req.apiUser
 *   - apiRequireAdmin     ：要求管理员角色
 *   - apiRequirePermission：要求细粒度权限（支持通配符）
 *   - apiRequireSuperAdmin：要求超级管理员
 *   - apiAdminAudit       ：API 管理操作审计日志
 * 与 Web 端 session 鉴权不同，API 使用数据库中的 token 记录（见 config/tokens.js）。
 */
const { queryOne, queryAll, getDb } = require('../config/database');
const { findTokenRecord, touchToken } = require('../config/tokens');
const { logActivity } = require('../config/activity');

/**
 * API Token 鉴权中间件（给原生 App 使用）
 * 校验 Authorization: Bearer <token>，成功后把用户注入 req.apiUser，
 * 同时写入 req.session.user，使现有 isAdmin 等中间件可以复用。
 * 失败时返回 JSON 401/403。
 */
function apiAuth(req, res, next) {
  try {
    // 从 Authorization 头解析 Bearer Token
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) {
      return res.status(401).json({ error: '未登录' });
    }

    const db = getDb();
    if (!db) {
      return res.status(503).json({ error: '数据库暂时不可用' });
    }

    // 查 token 记录（含过期时间校验）
    const record = findTokenRecord(db, token);
    if (!record) {
      return res.status(401).json({ error: '登录已过期，请重新登录' });
    }

    // 查 token 对应的用户
    const user = queryOne(
      db,
      'SELECT id, uid, username, nickname, avatar, role, status, email, bio, image_no_review, token_version FROM users WHERE id = ?',
      [record.user_id]
    );
    if (!user) {
      return res.status(401).json({ error: '用户不存在' });
    }
    if (user.status !== 'active') {
      return res.status(403).json({ error: '账号已被禁用' });
    }

    // token 版本校验：改密/强制下线后版本递增，旧 token 一律失效
    if ((record.token_version || 0) !== (user.token_version || 0)) {
      return res.status(401).json({ error: '登录已失效，请重新登录' });
    }

    touchToken(db, token);   // 刷新 token 最近使用时间/过期时间

    // 注入用户信息：req.apiUser 供后续 API 中间件使用；
    // 同时写 req.session.user 复用现有 isAdmin 等依赖 session 的逻辑
    req.apiUser = user;
    req.session = req.session || {};
    req.session.user = user;
    req.session.userId = user.id;
    next();
  } catch (err) {
    console.error('[apiAuth] 鉴权异常:', err.message);
    return res.status(500).json({ error: '服务器内部错误' });
  }
}

/**
 * 管理员权限校验（API 版，失败返回 JSON 403 而非重定向）
 * @returns {Function} Express 中间件
 */
function apiRequireAdmin(req, res, next) {
  const user = req.apiUser;
  if (user && (user.role === 'admin' || user.role === 'super_admin')) {
    return next();
  }
  return res.status(403).json({ error: '需要管理员权限' });
}

/**
 * API 细粒度权限校验：super_admin 拥有所有权限；
 * 其他用户需在 user_permissions 表中被授予对应 perm_key。
 * 与 web 版 hasPermission 对齐，但返回 JSON 403 而非重定向。
 * 支持精确匹配与通配符匹配（articles.* 覆盖 articles.xxx）。
 * @param {string} permKey - 权限键，如 'articles.edit'
 * @returns {Function} Express 中间件
 */
function apiRequirePermission(permKey) {
  return (req, res, next) => {
    const user = req.apiUser;
    if (!user) {
      return res.status(401).json({ error: '未登录' });
    }
    // super_admin 拥有所有权限
    if (user.role === 'super_admin') {
      return next();
    }
    const db = getDb();
    if (!db) {
      return res.status(503).json({ error: '数据库暂时不可用' });
    }
    // 查该用户被授予的所有权限键
    const userPerms = queryAll(db, 'SELECT perm_key FROM user_permissions WHERE user_id = ?', [user.id]);
    const keys = (userPerms || []).map((p) => p.perm_key);
    // 精确匹配
    if (keys.includes(permKey)) {
      return next();
    }
    // 通配符匹配：articles.* 覆盖 articles.xxx
    const parts = permKey.split('.');
    if (keys.includes(parts[0] + '.*')) {
      return next();
    }
    return res.status(403).json({ error: '权限不足：需要 ' + permKey });
  };
}

/**
 * API 超级管理员校验（返回 JSON 403）
 * @returns {Function} Express 中间件
 */
function apiRequireSuperAdmin(req, res, next) {
  const user = req.apiUser;
  if (user && user.role === 'super_admin') {
    return next();
  }
  return res.status(403).json({ error: '需要超级管理员权限' });
}

/**
 * API 管理端审计中间件：在 apiAuth 之后挂载，
 * 对所有非 GET 请求记录操作日志（修复 API 管理操作审计全盲问题）。
 * 已显式调用 logActivity 的路由会产生一条额外的概览记录，不影响审计完整性。
 * @returns {Function} Express 中间件
 */
function apiAdminAudit(req, res, next) {
  // GET/HEAD/OPTIONS 不记录
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    return next();
  }
  const user = req.apiUser;
  if (!user) {
    return next();
  }

  // 按路径关键字推断目标类型与动作
  const reqPath = req.path;
  let targetType = 'system';
  let action = req.method.toLowerCase();

  if (reqPath.includes('/users')) {
    targetType = 'user';
    if (reqPath.includes('/reset-password')) action = 'reset_password';
    else if (reqPath.includes('/permissions')) action = 'update_permissions';
    else if (req.method === 'POST') action = 'create';
    else if (req.method === 'DELETE') action = 'delete';
    else if (req.method === 'PUT') action = 'update';
  } else if (reqPath.includes('/articles')) {
    targetType = 'article';
    if (req.method === 'DELETE') action = 'delete';
    else if (req.method === 'PUT') action = 'update_status';
  } else if (reqPath.includes('/comments')) {
    targetType = 'comment';
    if (req.method === 'DELETE') action = 'delete';
  } else if (reqPath.includes('/categories')) {
    targetType = 'image_category';
    if (req.method === 'DELETE') action = 'delete';
    else if (req.method === 'POST') action = 'create';
  } else if (reqPath.includes('/images')) {
    targetType = 'image';
    if (req.method === 'DELETE') action = 'delete';
    else if (req.method === 'PUT') action = 'update_status';
  } else if (reqPath.includes('/novels')) {
    targetType = 'novel';
    if (req.method === 'DELETE') action = 'delete';
  } else if (reqPath.includes('/media')) {
    targetType = 'media';
    if (req.method === 'DELETE') action = 'delete';
  } else if (reqPath.includes('/settings')) {
    targetType = 'setting';
    if (req.method === 'PUT') action = 'update';
  } else if (reqPath.includes('/backups')) {
    targetType = 'backup';
    if (req.method === 'POST') action = 'create';
    else if (req.method === 'DELETE') action = 'delete';
  } else if (reqPath.includes('/logs')) {
    targetType = 'audit_log';
    if (req.method === 'DELETE') action = 'delete';
  } else if (reqPath.includes('/maintenance')) {
    targetType = 'maintenance';
    if (req.method === 'POST') action = 'toggle';
  }

  // 从路径提取目标资源 ID
  const idMatch = reqPath.match(/\/(\d+)/);
  const targetId = idMatch ? idMatch[1] : '';

  try {
    const db = getDb();
    if (db) {
      logActivity(db, {
        user_id: user.id,
        username: user.username,
        action,
        target_type: targetType,
        target_id: targetId,
        target_title: '',
        detail: 'API ' + req.method + ' ' + reqPath,
        ip: req.ip,
        route: reqPath,
        method: req.method
      });
    }
  } catch (e) {
    console.error('[apiAdminAudit] 日志记录失败:', e.message);
  }

  next();
}

module.exports = { apiAuth, apiRequireAdmin, apiRequirePermission, apiRequireSuperAdmin, apiAdminAudit };
