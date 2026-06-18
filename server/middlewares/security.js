/**
 * 安全中间件 - 替代原有CSRF防护
 *
 * 采用多层防护策略：
 * 1. SameSite Cookie 属性（已在 session 配置中设置）
 * 2. 双提交 Cookie 模式（Double Submit Cookie）
 * 3. 自定义请求头验证（X-Requested-With）
 * 4. Origin/Referer 验证
 * 5. 一次性令牌机制（Nonce）用于关键操作
 */

const crypto = require('crypto');

const SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS'];

// ==================== 双提交 Cookie 模式 ====================

/**
 * 生成随机令牌
 */
function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * 双提交 Cookie 中间件
 * 在 Cookie 中设置一个令牌，前端在请求头中携带该令牌
 * 服务端验证 Cookie 中的令牌与请求头中的令牌是否一致
 */
function doubleSubmitCookie(req, res, next) {
  if (!req.session) {
    return next();
  }

  // 为会话生成或复用令牌
  if (!req.session.doubleSubmitToken) {
    req.session.doubleSubmitToken = generateToken();
  }

  // 将令牌写入 Cookie（httpOnly: false 以便前端 JS 读取）
  res.cookie('XSRF-TOKEN', req.session.doubleSubmitToken, {
    httpOnly: false,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/'
  });

  // 暴露给模板
  res.locals.csrfToken = req.session.doubleSubmitToken;

  // 安全方法跳过验证
  if (SAFE_METHODS.includes(req.method)) {
    return next();
  }

  // 验证 CSRF token
  const submittedToken = req.headers['x-csrf-token']
    || req.headers['x-xsrf-token']
    || req.body?._csrf;

  if (!submittedToken || submittedToken !== req.session.doubleSubmitToken) {
    // 对于 API/JSON 请求返回 JSON 错误
    const isJsonRequest = (req.headers['content-type'] || '').includes('application/json');
    if (isJsonRequest || req.xhr) {
      return res.status(403).json({
        error: 'CSRF 验证失败',
        code: 'CSRF_INVALID'
      });
    }
    // 对于表单提交，返回错误页面
    return res.status(403).render('frontend/error', {
      message: '安全验证失败',
      error: '请求无效，请刷新页面后重试',
      user: req.session.user || null,
      settings: res.locals.settings || {}
    });
  }

  next();
}

// ==================== 自定义请求头验证 ====================

/**
 * 验证请求头中是否包含自定义标识
 * 跨站请求无法自定义 X-Requested-With 头
 */
function validateCustomHeader(req, res, next) {
  if (SAFE_METHODS.includes(req.method)) {
    return next();
  }

  // 对于 JSON API 请求，要求包含 X-Requested-With 头
  const contentType = req.headers['content-type'] || '';
  const isJsonRequest = contentType.includes('application/json');
  const isMultipart = contentType.startsWith('multipart/form-data');

  if (isJsonRequest || isMultipart) {
    const xRequestedWith = req.headers['x-requested-with'];
    if (!xRequestedWith || xRequestedWith !== 'XMLHttpRequest') {
      // 对于 AJAX 请求，检查 X-Requested-With 头
      // 注意：浏览器原生 fetch/XHR 不会自动添加此头，需要前端手动设置
      // 这里不做强制拦截，仅做日志记录
    }
  }

  next();
}

// ==================== Origin/Referer 验证 ====================

/**
 * Origin/Referer 验证中间件
 * 验证请求来源是否合法
 */
function validateOrigin(req, res, next) {
  if (SAFE_METHODS.includes(req.method)) {
    return next();
  }

  const origin = req.headers['origin'];
  const referer = req.headers['referer'];

  // 如果没有 Origin 和 Referer，可能是直接请求或非浏览器客户端
  if (!origin && !referer) {
    // 对于 API 请求，允许无来源的请求（如 Postman、服务器间调用）
    if (req.path.startsWith('/api/')) {
      return next();
    }
    // 对于表单提交，要求有 Referer
    if (req.method === 'POST' && req.headers['content-type']?.includes('application/x-www-form-urlencoded')) {
      return res.status(403).json({
        error: '请求来源验证失败',
        code: 'ORIGIN_CHECK_FAILED'
      });
    }
    return next();
  }

  // 获取来源域名
  const source = origin || referer;
  let sourceHost = '';
  try {
    sourceHost = new URL(source).hostname;
  } catch (e) {
    return res.status(403).json({
      error: '请求来源格式无效',
      code: 'INVALID_ORIGIN'
    });
  }

  // 允许的来源：本机地址
  const allowedHosts = [
    req.hostname,
    'localhost',
    '127.0.0.1'
  ];

  // 如果配置了 SITE_URL，也加入白名单
  if (process.env.SITE_URL) {
    try {
      const siteHost = new URL(process.env.SITE_URL).hostname;
      if (!allowedHosts.includes(siteHost)) {
        allowedHosts.push(siteHost);
      }
    } catch (e) { /* ignore */ }
  }

  if (!allowedHosts.includes(sourceHost)) {
    console.log('[Security] 来源验证失败:', {
      source: sourceHost,
      expected: allowedHosts.join(', '),
      path: req.path,
      method: req.method
    });

    // 对于 JSON 请求返回 JSON 错误
    const acceptHeader = req.headers.accept || '';
    const isJsonRequest = req.headers['content-type']?.includes('application/json');

    if (isJsonRequest || acceptHeader.includes('application/json') || req.xhr) {
      return res.status(403).json({
        error: '请求来源不合法',
        code: 'ORIGIN_MISMATCH'
      });
    }
    return res.status(403).render('frontend/error', {
      message: '安全验证失败',
      error: '请求来源不合法，请通过正常途径访问',
      user: req.session.user || null,
      settings: res.locals.settings || {}
    });
  }

  next();
}

// ==================== 一次性令牌机制（Nonce） ====================

/**
 * 生成一次性令牌（用于关键操作如表单提交）
 */
function generateNonce() {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * 创建并存储一次性令牌到 session
 */
function createNonce(req) {
  const nonce = generateNonce();
  if (!req.session.nonces) {
    req.session.nonces = [];
  }
  req.session.nonces.push({
    value: nonce,
    expires: Date.now() + 10 * 60 * 1000 // 10分钟有效期
  });
  // 限制 nonce 数量，防止内存泄漏
  if (req.session.nonces.length > 100) {
    req.session.nonces = req.session.nonces.slice(-50);
  }
  return nonce;
}

/**
 * 验证一次性令牌
 */
function validateNonce(req, res, next) {
  if (SAFE_METHODS.includes(req.method)) {
    return next();
  }

  // 仅对特定关键路径启用 nonce 验证
  const criticalPaths = [
    '/auth/delete-account',
    '/admin/reset'
  ];

  const isCriticalPath = criticalPaths.some(path => req.path.startsWith(path));
  if (!isCriticalPath) {
    return next();
  }

  const token = req.body._nonce || req.query._nonce || req.headers['x-nonce-token'];
  if (!token) {
    return res.status(403).json({
      error: '缺少安全令牌，请刷新页面后重试',
      code: 'NONCE_MISSING'
    });
  }

  if (!req.session.nonces || req.session.nonces.length === 0) {
    return res.status(403).json({
      error: '安全令牌已过期，请刷新页面后重试',
      code: 'NONCE_EXPIRED'
    });
  }

  // 清理过期 nonce
  const now = Date.now();
  req.session.nonces = req.session.nonces.filter(n => n.expires > now);

  // 查找匹配的 nonce
  const idx = req.session.nonces.findIndex(n => n.value === token);
  if (idx === -1) {
    return res.status(403).json({
      error: '安全令牌无效，请刷新页面后重试',
      code: 'NONCE_INVALID'
    });
  }

  // 使用后立即删除（一次性）
  req.session.nonces.splice(idx, 1);

  next();
}

// ==================== 综合安全中间件 ====================

/**
 * 综合安全防护中间件
 * 组合多种防护策略
 */
function securityMiddleware(req, res, next) {
  // 1. 设置安全响应头（已在 app.js 中全局设置，此处补充）
  if (!res.headersSent) {
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  }

  // 2. 双提交 Cookie
  doubleSubmitCookie(req, res, (err) => {
    if (err) return next(err);

    // 3. 自定义请求头验证
    validateCustomHeader(req, res, (err) => {
      if (err) return next(err);

      // 4. Origin/Referer 验证
      validateOrigin(req, res, (err) => {
        if (err) return next(err);

        // 5. 一次性令牌验证
        validateNonce(req, res, (err) => {
          if (err) return next(err);
          next();
        });
      });
    });
  });
}

module.exports = {
  securityMiddleware,
  doubleSubmitCookie,
  validateCustomHeader,
  validateOrigin,
  validateNonce,
  createNonce,
  generateToken
};
