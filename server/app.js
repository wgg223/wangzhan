/**
 * ============================================================
 * 服务入口文件 server/app.js（npm start 实际启动的入口）
 * ============================================================
 * 职责总览：
 *   1. 加载 .env 环境变量，生产环境强制校验 SESSION_SECRET；
 *   2. 配置信任代理层数（防 X-Forwarded-For 伪造，默认 0 不信任任何代理）；
 *   3. 注入 req.siteBaseUrl（统一站点 BaseURL，支持反代部署）；
 *   4. 挂载中间件链：请求监控 → Cookie → JSON/表单解析 → Session →
 *      CSP Nonce → 安全响应头 → 上传目录保护 → 静态资源 → 全局上下文（db/settings/navPages/layout）→
 *      setup 引导拦截 → 活动日志 → 全部业务路由 → 维护模式 → 404 → 全局错误处理；
 *   5. 启动逻辑：初始化数据库 → 清理过期 token → 加载 CDN 配置 → 初始化定时备份 →
 *      HTTP 监听（含端口冲突/超时/进程级错误处理/优雅关闭）。
 */

// 加载 .env 环境变量到 process.env（SESSION_SECRET / SITE_URL / PORT 等）
require('dotenv').config();
const express = require('express');               // Web 框架
const path = require('path');                     // 路径处理
const session = require('express-session');       // 会话中间件（默认内存存储）
const expressLayouts = require('express-ejs-layouts'); // EJS 布局支持（layout.ejs 套壳）
const fs = require('fs');                         // 文件系统
const cookieParser = require('cookie-parser');    // Cookie 解析
// 数据库工具：queryAll/initDatabase/getDb/isSetupCompleted
const { queryAll, initDatabase, getDb, isSetupCompleted } = require('./config/database');
// 缓存：settingsCache（设置缓存）、pageCache（页面/导航缓存）
const { settingsCache, pageCache } = require('./config/cache');
// 系统监控：recordRequest/recordError/getSystemInfo
const { monitor } = require('./config/monitor');
// 限流器：全局 / 登录 / API 三档
const { globalLimiter, loginLimiter, apiLimiter } = require('./middlewares/rate-limiter');
// 维护模式中间件
const { maintenanceMiddleware } = require('./middlewares/maintenance');
// CDN 配置模块（静态资源域名分流）
const cdnConfig = require('../cdn-config');
// 设置读取工具（settings 表 → 键值对象）
const { getSettings } = require('./utils/settings');

// 创建 Express 应用实例；默认监听端口 3000（可用 PORT 环境变量覆盖）
const app = express();
const PORT = process.env.PORT || 3000;

// ============ 生产环境启动检查 ============
// 缺少 SESSION_SECRET 时直接拒绝启动，避免弱密钥会话
if (process.env.NODE_ENV === 'production') {
  const requiredEnvVars = ['SESSION_SECRET'];
  const missing = requiredEnvVars.filter(v => !process.env[v]);
  if (missing.length > 0) {
    console.error('[安全错误] 生产环境缺少必要的环境变量:', missing.join(', '));
    console.error('请设置这些变量后再启动应用');
    process.exit(1);
  }
}

// ============ 信任代理层数 ============
// Nginx/CDN 回源设为 1，直接暴露设为 0（防 X-Forwarded-For 伪造绕过限流/验证码）
// 安全默认：不设 TRUST_PROXY 时为 0（不信任任何代理），需在反代后部署时显式配置
app.set('trust proxy', process.env.TRUST_PROXY ? parseInt(process.env.TRUST_PROXY, 10) : 0);

// ============ 站点 BaseURL 中间件 ============
// 统一 req.siteBaseUrl：优先 SITE_URL 环境变量（反代后 req.protocol 可能为 http，导致回调/分享地址错误）
// 未配置时回退到 req.protocol + host（直连部署场景）
app.use((req, res, next) => {
  let baseUrl = process.env.SITE_URL || '';
  if (!baseUrl) {
    baseUrl = `${req.protocol}://${req.get('host')}`;
  }
  baseUrl = baseUrl.replace(/\/+$/, ''); // 去除末尾斜杠
  req.siteBaseUrl = baseUrl;             // 供服务端拼接绝对 URL
  res.locals.siteBaseUrl = baseUrl;      // 供模板直接使用
  next();
});

// ============ 请求监控 ============
// 每个请求计数（用于 /health 与 dashboard 的 QPS 统计）
app.use((req, res, next) => {
  monitor.recordRequest();
  next();
});

// ============ 基础解析中间件 ============
app.use(cookieParser()); // 解析 Cookie

// JSON 请求体解析：上限 5MB，strict 模式（只接受对象/数组顶层）
app.use(express.json({
  limit: '5mb',
  strict: true
}));
// 表单（x-www-form-urlencoded）解析：上限 5MB、最多 1000 个参数（防参数洪泛）
app.use(express.urlencoded({
  extended: true,
  limit: '5mb',
  parameterLimit: 1000
}));

// ============ 会话中间件 ============
// 优先使用 SQLite 会话存储（降低 V8 堆内存驻留 + 服务重启不掉线）；
// 仅在 better-sqlite3 原生模式下启用，失败时自动回退内存存储（默认行为）
const { SqliteSessionStore } = require('./config/session-store');
let sessionStore;
try {
  if (require('./config/database').isUsingNativeSql()) {
    sessionStore = new SqliteSessionStore(() => require('./config/database').getDb());
    console.log('[session] 使用 SQLite 会话存储');
  }
} catch (err) {
  console.error('[session] SQLite 会话存储初始化失败，回退内存存储:', err.message);
  sessionStore = undefined;
}

app.use(session({
  // 会话签名密钥：优先环境变量；未设置时生成随机密钥（重启后所有会话失效，仅限开发）
  secret: process.env.SESSION_SECRET || (() => {
    console.error('[安全] 未设置 SESSION_SECRET 环境变量，使用随机密钥（重启后所有会话失效）');
    return require('crypto').randomBytes(32).toString('hex');
  })(),
  store: sessionStore,          // undefined 时 express-session 使用默认内存存储
  resave: false,          // 会话未修改时不强制重存
  saveUninitialized: false, // 未初始化的会话不写 Cookie（减少无状态请求的存储）
  rolling: true,          // 每次响应刷新会话有效期（活跃用户不掉线）
  name: 'connect.sid',    // 会话 Cookie 名
  cookie: {
    secure: 'auto',       // 注意：字符串 'auto' 为真值 → 等同 secure:true（仅 HTTPS 下发送）
    httpOnly: true,       // 禁止 JS 读取（防 XSS 窃取会话）
    sameSite: 'lax',      // CSRF 基础防护（同站请求携带，跨站 POST 不带）
    path: '/',
    maxAge: 24 * 60 * 60 * 1000 // 24 小时有效
  }
}));

// ============ CSP Nonce 中间件 ============
// 每个请求生成随机 nonce，供模板内联脚本/样式使用
// 迁移完成后，CSP 中的 'unsafe-inline' 将替换为 'nonce-<%= nonce %>'
app.use((req, res, next) => {
  const crypto = require('crypto');
  res.locals.nonce = crypto.randomBytes(16).toString('base64');
  next();
});

// ============ 安全响应头中间件 ============
// 必须位于 express.static 之前，确保静态资源/上传文件也携带 nosniff/CSP 等头
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff'); // 禁止 MIME 类型嗅探
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');     // 禁止被 iframe 嵌入（防点击劫持）
  res.setHeader('X-XSS-Protection', '1; mode=block'); // 旧浏览器 XSS 过滤器
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin'); // 外链不泄露完整 URL
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  res.setHeader('X-Download-Options', 'noopen');      // IE 下载窗口不自动打开文件

  // CSP 内容安全策略：白名单式限制资源加载来源
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",                                       // 默认只允许同源
    "script-src 'self' 'unsafe-inline' cdnjs.cloudflare.com cdn.tailwindcss.com unpkg.com cdn.jsdelivr.net static.cloudflareinsights.com",
    "style-src 'self' 'unsafe-inline' cdnjs.cloudflare.com cdn.tailwindcss.com unpkg.com cdn.jsdelivr.net",
    "img-src 'self' data: blob: https:",                        // 图片允许同源/data/blob/任意 https
    "font-src 'self' data: cdnjs.cloudflare.com",
    "connect-src 'self' https:",                                // fetch/XHR 仅同源与 https
    "frame-src 'self' https:",
    "frame-ancestors 'self'",
    "form-action 'self'",
    "base-uri 'self'"
  ].join('; '));

  // 生产环境强制 HSTS（一年 + 子域 + 预加载列表）
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  }
  next();
});

// ============ 上传目录保护 ============
// 拦截 /uploads/images、/uploads/ai-images 未授权直链，必须位于 express.static 之前
const { protectUploads } = require('./middlewares/upload-protect');
app.use(protectUploads);

// ============ 静态资源服务 ============
app.use(express.static(path.join(__dirname, '../public'), {
  maxAge: '30d',        // 浏览器缓存 30 天
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    // 按文件类型设置 Content-Type 与更激进的缓存策略（指纹化文件名可 immutable）
    if (filePath.endsWith('.css')) {
      res.setHeader('Content-Type', 'text/css; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
    } else if (filePath.endsWith('.js')) {
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
    } else if (filePath.match(/\.(jpg|jpeg|png|gif|ico|svg|webp)$/)) {
      res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
    } else if (filePath.match(/\.(woff|woff2|ttf|eot)$/)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  }
}));

// exe（pkg）模式下，上传文件写入 exe 同目录的 public/，需额外挂载静态目录
if (process.pkg) {
  const { publicDir } = require('./config/app-root');
  app.use(express.static(publicDir));
}

// ============ 模板引擎 ============
app.use(expressLayouts);            // 启用 EJS 布局
app.set('view engine', 'ejs');      // 视图引擎 = EJS
app.set('views', path.join(__dirname, '../views')); // 视图目录
app.set('layout', 'frontend/layout');               // 默认布局（后续按路由覆盖）

// 导航页缓存：顶级已发布页面列表（导航菜单用），pageCache 缓存
function getCachedNavPages(db) {
  const cacheKey = 'nav_pages';
  let navPages = pageCache.get(cacheKey);
  if (!navPages) {
    try {
      navPages = queryAll(db, "SELECT * FROM pages WHERE status = 'published' AND parent_id = 0 ORDER BY sort_order ASC");
      pageCache.set(cacheKey, navPages);
    } catch (err) {
      navPages = [];
    }
  }
  return navPages;
}

// ============ 全局上下文中间件 ============
// 为每个请求注入 db 句柄、当前用户、站点设置、导航页、CSRF 占位、CDN 配置与布局选择
app.use((req, res, next) => {
  req.db = getDb(); // 当前数据库句柄（better-sqlite3 或 sql.js）
  if (!req.db) {
    // 数据库初始化中：API 返回 503 JSON，页面渲染 503 错误页
    if (req.path.startsWith('/api/')) {
      return res.status(503).json({ error: '服务暂时不可用，数据库正在初始化' });
    }
    return res.status(503).render('frontend/error', {
      message: '服务暂时不可用',
      error: '数据库正在初始化，请稍后刷新页面',
      user: null,
      settings: {}
    });
  }

  res.locals.user = req.session.user || null;   // 当前登录用户（模板可用）
  res.locals.settings = getSettings(req.db);    // 站点设置对象
  res.locals.navPages = getCachedNavPages(req.db); // 导航菜单页面
  res.locals.csrfToken = '';                    // CSRF 占位（具体路由内按需填充）
  res.locals.cdn = cdnConfig;                   // CDN 配置（模板生成资源 URL）

  // 按路径前缀选择布局模板（使用 res.locals.layout 替代 app.set 避免并发竞态）
  if (req.path.startsWith('/admin')) {
    res.locals.layout = 'admin/layout';         // 后台统一布局
  } else if (req.path.startsWith('/share')) {
    res.locals.layout = false;                  // 分享页无布局（独立页面）
  } else if (req.path.startsWith('/novels/') && req.path.includes('/chapter/')) {
    res.locals.layout = false;                  // 小说阅读页独立渲染
  } else if (req.path.startsWith('/poem-game')) {
    res.locals.layout = false;                  // 诗词游戏独立页面
  } else if (req.path.startsWith('/image-share')) {
    res.locals.layout = false;                  // 图片分享独立页面
  } else if (req.path.startsWith('/ai-prompts')) {
    res.locals.layout = false;                  // 提示词广场独立页面
  } else if (req.path.startsWith('/auth/') && !req.path.startsWith('/auth/delete-account')) {
    res.locals.layout = false;                  // 登录/注册等认证页独立
  } else if (req.path.startsWith('/setup')) {
    res.locals.layout = false;                  // 安装向导独立
  } else if (req.path.match(/^\/chat\/\d+$/)) {
    res.locals.layout = false;                  // AI 聊天页独立
  } else {
    res.locals.layout = 'frontend/layout';      // 默认前台布局
  }

  next();
});

// ============ Setup 引导拦截 ============
// 未完成安装（.setup_completed 不存在）时，除白名单路径外一律跳转 /setup
app.use((req, res, next) => {
  if (req.path.startsWith('/setup') ||
      req.path.startsWith('/health') ||
      req.path.startsWith('/api/') ||
      req.path.startsWith('/css/') ||
      req.path.startsWith('/js/') ||
      req.path.startsWith('/uploads/') ||
      req.xhr ||
      req.headers['x-requested-with'] === 'XMLHttpRequest') {
    return next(); // 白名单路径直接放行
  }

  if (!isSetupCompleted()) {
    return res.redirect('/setup');
  }

  next();
});

// ============ 全局操作日志中间件 ============
// 记录每个用户的操作行为（写 activity_logs 表）
const { activityLogger } = require('./middlewares/activity-logger');
app.use(activityLogger);

// ============ 路由挂载 ============
// 按域拆分：认证 / OAuth / 账户 / 后台 / 权限申请 / API / 诗词游戏 / 图片分享 / 分享 / 前台 / 社区 / 私信 / 内容
const authRoutes = require('./routes/auth');
const oauthRoutes = require('./routes/oauth').router;
const accountRoutes = require('./routes/account');
const adminRoutes = require('./routes/admin/index');
const frontendRoutes = require('./routes/frontend');
const setupRoutes = require('./routes/setup');
const poemGameRoutes = require('./routes/poem-game');
const imageShareRoutes = require('./routes/image-share');
const communityRoutes = require('./routes/community');
const contentRoutes = require('./routes/content');
const permissionApplicationsRoutes = require('./routes/permission-applications');
const privateMessageRoutes = require('./routes/private-message');
const shareRoutes = require('./routes/share');
const apiRoutes = require('./routes/api/index');
const { apiAccessLogger } = require('./middlewares/api-access-logger');

app.use('/setup', setupRoutes);                                            // 安装向导
app.use('/auth', globalLimiter, authRoutes);                               // 注册/登录/2FA（全局限流）
app.use('/oauth', globalLimiter, oauthRoutes);                             // 第三方登录
app.use('/', globalLimiter, accountRoutes);                                // 个人中心
app.use('/admin', globalLimiter, adminRoutes);                             // 后台管理
app.use('/', globalLimiter, permissionApplicationsRoutes);                 // 权限申请
app.use('/api/v1', globalLimiter, apiLimiter, apiAccessLogger, apiRoutes); // API（额外 API 限流 + 访问日志）

// Maintenance mode middleware - only affects frontend routes（维护模式开关，仅影响前台）
app.use(maintenanceMiddleware);

app.use('/poem-game', globalLimiter, poemGameRoutes);   // 诗词游戏
app.use('/image-share', globalLimiter, imageShareRoutes); // 图片分享站
app.use('/share', globalLimiter, shareRoutes);          // 分享页面
app.use('/', globalLimiter, frontendRoutes);            // 前台页面
app.use('/', globalLimiter, communityRoutes);           // 社区（动态/关注）
app.use('/', globalLimiter, privateMessageRoutes);      // 站内私信
app.use('/', globalLimiter, contentRoutes);             // 内容（文章/页面/评论）

// ============ 健康检查 ============
// 返回运行状态 + 数据库连通性 + 系统信息（uptime/内存等）
app.get('/health', (req, res) => {
  const db = getDb();
  let dbStatus = 'ok';
  try {
    db && db.run('SELECT 1'); // 实际执行一次查询验证数据库可用
  } catch (e) {
    dbStatus = 'error';
  }

  res.json({
    status: 'running',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    ...monitor.getSystemInfo(),
    db: dbStatus
  });
});

// ============ 404 处理 ============
// API 返回 JSON 404；页面返回渲染错误页（渲染失败则回退纯文本）
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: '接口不存在' });
  }
  try {
    res.status(404).render('frontend/error', {
      message: '页面未找到',
      error: '您请求的页面不存在',
      user: req.session.user || null,
      settings: res.locals.settings || {}
    });
  } catch (renderErr) {
    console.error('[404] 错误模板渲染失败:', renderErr.message);
    res.status(404).send('<h1>404 - 页面未找到</h1>');
  }
});

// ============ 全局错误处理中间件 ============
// 收集所有 next(err) / 抛出的异常；按 API/页面与 multer 错误码分类返回
app.use((err, req, res, next) => {
  console.error('服务器错误:', err);
  monitor.recordError(); // 记录错误到监控

  // API 路由：返回 JSON 错误（multer 文件限制映射为 400/413）
  if (req.path.startsWith('/api/')) {
    const status = err.status || (err.code === 'LIMIT_FILE_SIZE' || err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE' ? 400 : 500);
    const message = err.code === 'LIMIT_FILE_SIZE' ? '文件大小超出限制' : (err.message || '服务器内部错误');
    return res.status(status).json({ error: message });
  }

  // multer 常见错误码 → 友好提示
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: '文件大小超出该上传的限制' });
  }
  if (err.code === 'LIMIT_FILE_COUNT') {
    return res.status(413).json({ error: '文件数量超出限制（最多20个）' });
  }
  if (err.code === 'LIMIT_UNEXPECTED_FILE') {
    return res.status(400).json({ error: '意外的文件字段' });
  }

  // 自定义上传错误（不支持的类型 / MIME 校验失败）
  if (err.message && err.message.includes('不支持的文件类型')) {
    return res.status(400).json({ error: err.message });
  }
  if (err.message && err.message.includes('MIME')) {
    return res.status(400).json({ error: err.message });
  }

  // 非 API 路由：尊重中间件设置的 err.status（403/404 等），其余统一 500
  const status = err.status || 500;
  try {
    res.status(status).render('frontend/error', {
      message: status === 404 ? '页面未找到' : '服务器内部错误',
      error: process.env.NODE_ENV === 'production'
        ? (status === 404 ? '您请求的页面不存在' : '请稍后再试') // 生产不暴露堆栈
        : '发生错误，请查看服务器日志',
      user: req.session ? req.session.user : null,
      settings: res.locals ? (res.locals.settings || {}) : {}
    });
  } catch (renderErr) {
    // 错误页自身渲染失败时的最终兜底
    console.error('[' + status + '] 错误模板渲染失败:', renderErr.message);
    res.status(status).send(status === 404 ? '<h1>404 - 页面未找到</h1>' : '<h1>500 - 服务器内部错误</h1>');
  }
});

// ============ 启动函数 ============
async function start() {
  try {
    // 1. 初始化数据库（建表/迁移/种子）
    await initDatabase();
    // 2. 清理过期 API Token
    const { cleanupExpiredTokens } = require('./config/tokens');
    cleanupExpiredTokens();

    console.log('数据库初始化成功');

    // 3. 从数据库加载 CDN 配置（失败回退到 .env 配置）
    try {
      const db = getDb();
      if (db) {
        cdnConfig.loadFromDatabase(db);
        console.log('CDN配置加载成功:', cdnConfig.enabled ? '已启用' : '未启用');
      }
    } catch (err) {
      console.error('[app] Failed to load CDN config:', err.message);
      cdnConfig.loadFromEnv();
    }

    // 4. 初始化定时备份任务（从 settings 读取 cron 配置）
    try {
      const { initScheduledBackup } = require('./routes/admin/maintenance');
      const db = getDb();
      if (db) {
        initScheduledBackup(db);
      }
    } catch (err) {
      console.error('[app] Failed to initialize scheduled backup:', err.message);
    }

    // 5. 启动 HTTP 服务，监听所有网卡（0.0.0.0）
    const server = app.listen(PORT, '0.0.0.0', () => {
      console.log(`服务器运行在 http://0.0.0.0:${PORT}`);
      console.log(`环境: ${process.env.NODE_ENV || 'development'}`);
      // 通知 PM2 应用已就绪（配合 ecosystem.config.js 中的 wait_ready: true）
      if (process.send) {
        process.send('ready');
      }
    });

    // 端口冲突检测：EADDRINUSE 时明确报错并退出
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`[错误] 端口 ${PORT} 已被占用，请更换端口（PORT环境变量）或关闭占用进程`);
        process.exit(1);
      }
    });

    // 请求超时保护：单请求 30 秒；Keep-Alive 65 秒
    server.timeout = 30000;
    server.keepAliveTimeout = 65000;

    // 进程级错误处理
    process.on('uncaughtException', (err) => {
      // 未捕获异常：尝试优雅关闭服务 → 关库 → 退出
      console.error('[FATAL] uncaughtException:', err);
      server.close(() => {
        const { closeDatabase } = require('./config/database');
        closeDatabase();
        setTimeout(() => process.exit(1), 2000);
      });
      setTimeout(() => process.exit(1), 10000); // 10 秒兜底强制退出
    });

    process.on('unhandledRejection', (reason) => {
      // 未处理 Promise 拒绝：记录警告（不退出，保持服务可用）
      console.error('[WARN] unhandledRejection:', reason);
    });

    // 优雅关闭：SIGTERM/SIGINT → 停止接收新连接 → 关闭数据库 → 退出
    const gracefulShutdown = (signal) => {
      console.log(`[INFO] ${signal} received, shutting down...`);
      server.close(() => {
        const { closeDatabase } = require('./config/database');
        closeDatabase();
        process.exit(0);
      });
      // 强制退出超时（10 秒）
      setTimeout(() => {
        console.error('[WARN] Forced shutdown after timeout');
        process.exit(1);
      }, 10000);
    };

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));

    // 启动后主动触发一次 GC（--expose-gc 模式下生效）
    if (global.gc) {
      global.gc();
    }

  } catch (err) {
    console.error('启动失败:', err);
    process.exit(1);
  }
}

// 执行启动
start();

// 导出 app（供测试/PM2 引用）
module.exports = app;
