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

// ==================== 安全事件告警 ====================

/**
 * 上报安全事件给全部管理员（同一类事件 10 分钟内只告警一次，避免被刷屏）
 * @param {object} req 请求对象
 * @param {string} throttleKey 节流键
 * @param {string} title 告警标题
 * @param {string} detail 告警正文
 * @param {string} reason 简短原因（写入邮件明细）
 */
function reportSecurityEvent(req, throttleKey, title, detail, reason) {
  if (!req || !req.db) return;
  try {
    const { alertAdminsOnce } = require('../services/notify');
    alertAdminsOnce(req.db, throttleKey, 10 * 60 * 1000, {
      title,
      content: detail,
      targetType: 'security_alert',
      emailDetails: [
        { label: '原因', value: reason || '' },
        { label: '来源 IP', value: req.ip || '未知' },
        { label: '请求路径', value: String(req.originalUrl || req.path || '/').split('?')[0] },
        { label: '请求方法', value: req.method || '' },
        { label: 'User-Agent', value: req.headers && req.headers['user-agent'] ? req.headers['user-agent'] : '' }
      ],
      emailActionPath: '/admin/activity-logs',
      emailActionText: '查看安全日志'
    });
  } catch (err) {
    // 告警失败不影响安全拦截本身
  }
}

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

  // 暴露给模板
  res.locals.csrfToken = req.session.doubleSubmitToken;

  // 安全方法跳过验证
  if (SAFE_METHODS.includes(req.method)) {
    return next();
  }

  // 验证 CSRF token
  // 兼容多种前端约定：X-CSRF-Token / CSRF-Token / X-XSRF-Token / body._csrf
  // multipart 请求在 multer 解析前 req.body 为 undefined（可选链自然跳过，只能走请求头）；
  // 解析后（如把本中间件放在 multer 回调内）原生表单的 _csrf 隐藏域同样可用。
  const submittedToken = req.headers['x-csrf-token']
    || req.headers['csrf-token']
    || req.headers['x-xsrf-token']
    || req.body?._csrf;

  // 时序安全比较：防止 timing attack 逐字符猜测 token
  const expected = req.session.doubleSubmitToken;
  let tokenValid = false;
  if (submittedToken && expected) {
    const submittedBuf = Buffer.from(String(submittedToken));
    const expectedBuf = Buffer.from(String(expected));
    if (submittedBuf.length === expectedBuf.length) {
      tokenValid = crypto.timingSafeEqual(submittedBuf, expectedBuf);
    }
  }

  if (!tokenValid) {
    reportSecurityEvent(
      req,
      'security:csrf',
      '安全告警：CSRF 校验失败',
      'IP ' + (req.ip || '未知') + ' 提交的请求未通过 CSRF 校验，已拦截。路径：' +
        String(req.originalUrl || req.path || '/').split('?')[0],
      'CSRF token 缺失或不匹配'
    );
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
      reportSecurityEvent(
        req,
        'security:origin',
        '安全告警：请求缺少来源',
        'IP ' + (req.ip || '未知') + ' 的表单请求既无 Origin 也无 Referer，已拦截。路径：' +
          String(req.originalUrl || req.path || '/').split('?')[0],
        '缺少 Origin / Referer'
      );
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
    reportSecurityEvent(
      req,
      'security:origin',
      '安全告警：请求来源格式异常',
      'IP ' + (req.ip || '未知') + ' 的请求来源无法解析，已拦截。路径：' +
        String(req.originalUrl || req.path || '/').split('?')[0],
      'Origin / Referer 格式无效'
    );
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
    reportSecurityEvent(
      req,
      'security:origin',
      '安全告警：请求来源不匹配',
      'IP ' + (req.ip || '未知') + ' 的请求来源 ' + sourceHost + ' 不在允许列表（' +
        allowedHosts.join(', ') + '）中，已拦截。路径：' +
        String(req.originalUrl || req.path || '/').split('?')[0],
      'Origin / Referer 域名不匹配'
    );

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
