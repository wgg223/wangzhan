/**
 * 全局操作日志中间件
 * 自动记录每个已登录用户在站点上的操作行为
 * 包括：页面访问、API请求、表单提交等
 */
const { logActivity } = require('../config/activity');
const { getDb } = require('../config/database');

// 需要记录的路由前缀映射（用于确定 target_type）
const ROUTE_TARGET_MAP = {
  '/admin': 'admin',
  '/auth': 'auth',
  '/chat': 'ai_chat',
  '/chat/rp-hub': 'rp_hub',
  '/home': 'frontend',
  '/articles': 'article',
  '/novels': 'novel',
  '/poem-game': 'poem_game',
  '/image-share': 'image_share',
  '/setup': 'setup',
  '/messages': 'message',
  '/profile': 'profile',
  '/search': 'search'
};

// 不需要记录的路径（静态资源、健康检查等）
const SKIP_PATHS = [
  '/css/', '/js/', '/uploads/', '/assets/',
  '/health', '/favicon.ico',
  '/rp-hub/', // RP-Hub SPA 静态资源
];

// 不需要记录的 GET 路径（纯静态页面或频繁轮询的接口）
const SKIP_GET_PATHS = [
  '/health',
  '/chat/api/conversations', // 轮询接口
  '/chat/api/messages',
];

/**
 * 判断路径是否需要跳过记录
 */
function shouldSkip(path, method) {
  // 静态资源跳过
  if (SKIP_PATHS.some(p => path.startsWith(p))) {
    return true;
  }

  // GET 请求的跳过列表
  if (method === 'GET' && SKIP_GET_PATHS.some(p => path.startsWith(p))) {
    return true;
  }

  // XHR/API 请求的 GET 方法跳过（避免记录大量轮询）
  if (method === 'GET' && (path.includes('/api/') || path.includes('/ajax/'))) {
    return true;
  }

  return false;
}

/**
 * 根据路径确定目标类型
 */
function determineTargetType(path) {
  // 按优先级从长到短匹配
  const sortedRoutes = Object.keys(ROUTE_TARGET_MAP).sort((a, b) => b.length - a.length);

  for (const prefix of sortedRoutes) {
    if (path.startsWith(prefix)) {
      return ROUTE_TARGET_MAP[prefix];
    }
  }

  return 'page';
}

/**
 * 根据路径和方法确定操作类型
 */
function determineAction(path, method) {
  if (method === 'GET') {
    return 'view';
  }

  if (method === 'POST') {
    if (path.includes('/delete') || path.includes('/remove')) return 'delete';
    if (path.includes('/save') || path.includes('/create') || path.includes('/new')) return 'create';
    if (path.includes('/update') || path.includes('/edit') || path.includes('/change')) return 'update';
    if (path.includes('/upload')) return 'upload';
    if (path.includes('/login')) return 'login';
    if (path.includes('/logout')) return 'logout';
    if (path.includes('/register')) return 'register';
    if (path.includes('/send')) return 'send';
    if (path.includes('/approve') || path.includes('/pass')) return 'approve';
    if (path.includes('/reject')) return 'reject';
    return 'submit';
  }

  if (method === 'PUT' || method === 'PATCH') {
    if (path.includes('/delete') || path.includes('/remove')) return 'delete';
    return 'update';
  }

  if (method === 'DELETE') {
    return 'delete';
  }

  return method.toLowerCase();
}

/**
 * 从路径中提取目标ID
 */
function extractTargetId(path) {
  // 匹配 /articles/123 或 /admin/users/456/edit 等模式
  const matches = path.match(/\/(\d+)(?:\/|$)/);
  return matches ? matches[1] : '';
}

/**
 * 从路径中提取目标标题（最后一段路径）
 */
function extractTargetTitle(path) {
  const segments = path.split('/').filter(Boolean);
  const last = segments[segments.length - 1];
  // 排除纯数字ID
  if (/^\d+$/.test(last)) return '';
  return last;
}

/**
 * 获取客户端IP地址
 */
function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || req.connection?.remoteAddress || '';
}

/**
 * 全局操作日志中间件
 * 记录每个已登录用户的操作行为
 */
function activityLogger(req, res, next) {
  // 跳过不需要记录的路径
  if (shouldSkip(req.path, req.method)) {
    return next();
  }

  // 只有已登录用户才记录
  if (!req.session || !req.session.user) {
    return next();
  }

  const user = req.session.user;
  const path = req.path;
  const method = req.method;
  const targetType = determineTargetType(path);
  const action = determineAction(path, method);
  const targetId = extractTargetId(path);
  const targetTitle = extractTargetTitle(path);
  const ip = getClientIp(req);

  // 构建详情
  let detail = '';
  if (method === 'GET') {
    detail = `访问页面: ${path}`;
  } else {
    detail = `${method} ${path}`;
    // 如果有查询参数，附加关键参数
    const queryKeys = Object.keys(req.query);
    if (queryKeys.length > 0) {
      const filteredQuery = {};
      queryKeys.forEach(key => {
        // 不记录敏感参数
        if (!['password', 'token', 'secret', 'api_key'].includes(key)) {
          filteredQuery[key] = req.query[key];
        }
      });
      if (Object.keys(filteredQuery).length > 0) {
        detail += ` [参数: ${JSON.stringify(filteredQuery)}]`;
      }
    }
  }

  // 异步记录日志，不阻塞请求
  setImmediate(() => {
    try {
      const db = getDb();
      if (db) {
        logActivity(db, {
          user_id: user.id,
          username: user.username,
          action: action,
          target_type: targetType,
          target_id: targetId,
          target_title: targetTitle,
          detail: detail,
          ip: ip,
          route: path,
          method: method
        });
      }
    } catch (err) {
      // 静默失败，不影响用户体验
      console.error('[活动日志] 记录失败:', err.message);
    }
  });

  next();
}

module.exports = { activityLogger };
