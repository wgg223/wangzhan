/**
 * API 访问日志中间件
 * 记录原生 App（Flutter 客户端）通过 /api/v1 访问数据的日志：
 * 用户、方法、路径、状态码、IP、时间。
 * - 写操作（POST/PUT/PATCH/DELETE）全部记录
 * - GET 请求按 用户+路径 60 秒节流，避免高频轮询刷爆表
 * - 表行数超过上限时自动清理最旧记录
 */
const { getDb, queryOne, saveDatabase } = require('../config/database');

const MAX_ROWS = 20000;
const CLEAN_BATCH = 2000;
const GET_THROTTLE_MS = 60 * 1000;
const GET_THROTTLE_MAX = 5000;

const recentGets = new Map();

function shouldLog(req) {
  if (req.method !== 'GET') return true;
  const user = req.apiUser || req.session?.user || null;
  const key = (user ? user.id : 'anon') + ':' + req.path;
  const now = Date.now();
  const last = recentGets.get(key);
  if (last && now - last < GET_THROTTLE_MS) return false;
  recentGets.set(key, now);
  if (recentGets.size > GET_THROTTLE_MAX) {
    recentGets.clear();
  }
  return true;
}

function apiAccessLogger(req, res, next) {
  // 健康检查等内部探测不记录
  if (req.path === '/health') {
    return next();
  }

  res.on('finish', () => {
    if (!shouldLog(req)) return;

    try {
      const db = getDb();
      if (!db) return;

      const user = req.apiUser || req.session?.user || null;

      // 记录完整路径（含 /api/v1 前缀），避免子路由剥离前缀后路径歧义
      const fullPath = (req.originalUrl || req.url || '').split('?')[0];

      db.run(
        `INSERT INTO api_access_logs (user_id, username, method, path, status, ip, client, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'app', datetime('now', '+8 hours'))`,
        [user ? user.id : null, user ? (user.username || '') : '', req.method, fullPath, res.statusCode, req.ip || '']
      );

      // 保留策略：超过上限时删除最旧记录
      const count = queryOne(db, 'SELECT COUNT(*) AS count FROM api_access_logs')?.count || 0;
      if (count > MAX_ROWS) {
        db.run('DELETE FROM api_access_logs WHERE id IN (SELECT id FROM api_access_logs ORDER BY id ASC LIMIT ?)', [CLEAN_BATCH]);
      }

      saveDatabase();
    } catch (e) {
      console.error('[API访问日志] 记录失败:', e.message);
    }
  });

  next();
}

module.exports = { apiAccessLogger };
