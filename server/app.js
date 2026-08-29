require('dotenv').config();
const express = require('express');
const path = require('path');
const session = require('express-session');
const expressLayouts = require('express-ejs-layouts');
const fs = require('fs');
const cookieParser = require('cookie-parser');
const { queryAll, initDatabase, getDb, isSetupCompleted } = require('./config/database');
const { settingsCache, pageCache } = require('./config/cache');
const { monitor } = require('./config/monitor');
const { globalLimiter, loginLimiter, apiLimiter } = require('./middlewares/rate-limiter');
const { maintenanceMiddleware } = require('./middlewares/maintenance');
const cdnConfig = require('../cdn-config');
const { getSettings } = require('./utils/settings');

const app = express();
const PORT = process.env.PORT || 3000;

if (process.env.NODE_ENV === 'production') {
  const requiredEnvVars = ['SESSION_SECRET'];
  const missing = requiredEnvVars.filter(v => !process.env[v]);
  if (missing.length > 0) {
    console.error('[安全错误] 生产环境缺少必要的环境变量:', missing.join(', '));
    console.error('请设置这些变量后再启动应用');
    process.exit(1);
  }
}

// 信任代理层数：Nginx/CDN 回源设为 1，直接暴露设为 0（防 X-Forwarded-For 伪造绕过限流/验证码）
// 安全默认：不设 TRUST_PROXY 时为 0（不信任任何代理），需在反代后部署时显式配置
app.set('trust proxy', process.env.TRUST_PROXY ? parseInt(process.env.TRUST_PROXY, 10) : 0);

app.use((req, res, next) => {
  monitor.recordRequest();
  next();
});

app.use(cookieParser());

app.use(express.json({
  limit: '5mb',
  strict: true
}));
app.use(express.urlencoded({
  extended: true,
  limit: '5mb',
  parameterLimit: 1000
}));

app.use(session({
  secret: process.env.SESSION_SECRET || (() => {
    console.error('[安全] 未设置 SESSION_SECRET 环境变量，使用随机密钥（重启后所有会话失效）');
    return require('crypto').randomBytes(32).toString('hex');
  })(),
  resave: false,
  saveUninitialized: false,
  rolling: true,
  name: 'connect.sid',
  cookie: {
    secure: 'auto',
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 24 * 60 * 60 * 1000
  }
}));

// CSP Nonce 中间件：每个请求生成随机 nonce，供模板内联脚本/样式使用
// 迁移完成后，CSP 中的 'unsafe-inline' 将替换为 'nonce-<%= nonce %>'
app.use((req, res, next) => {
  const crypto = require('crypto');
  res.locals.nonce = crypto.randomBytes(16).toString('base64');
  next();
});

// 安全响应头（必须位于 express.static 之前，确保静态资源/上传文件也携带 nosniff/CSP 等头）
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  res.setHeader('X-Download-Options', 'noopen');

  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' cdnjs.cloudflare.com cdn.tailwindcss.com unpkg.com cdn.jsdelivr.net static.cloudflareinsights.com",
    "style-src 'self' 'unsafe-inline' cdnjs.cloudflare.com cdn.tailwindcss.com unpkg.com cdn.jsdelivr.net",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data: cdnjs.cloudflare.com",
    "connect-src 'self' https:",
    "frame-src 'self' https:",
    "frame-ancestors 'self'",
    "form-action 'self'",
    "base-uri 'self'"
  ].join('; '));

  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  }
  next();
});

// 上传目录保护（拦截 /uploads/images、/uploads/ai-images 未授权直链，必须位于 express.static 之前）
const { protectUploads } = require('./middlewares/upload-protect');
app.use(protectUploads);

app.use(express.static(path.join(__dirname, '../public'), {
  maxAge: '30d',
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
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

app.use(expressLayouts);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '../views'));
app.set('layout', 'frontend/layout');

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

app.use((req, res, next) => {
  req.db = getDb();
  if (!req.db) {
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

  res.locals.user = req.session.user || null;
  res.locals.settings = getSettings(req.db);
  res.locals.navPages = getCachedNavPages(req.db);
  res.locals.csrfToken = '';
  res.locals.cdn = cdnConfig;

  // 使用 res.locals.layout 替代 app.set('layout') 避免并发竞态条件
  if (req.path.startsWith('/admin')) {
    res.locals.layout = 'admin/layout';
  } else if (req.path.startsWith('/share')) {
    res.locals.layout = false;
  } else if (req.path.startsWith('/novels/') && req.path.includes('/chapter/')) {
    res.locals.layout = false;
  } else if (req.path.startsWith('/poem-game')) {
    res.locals.layout = false;
  } else if (req.path.startsWith('/image-share')) {
    res.locals.layout = false;
  } else if (req.path.startsWith('/ai-prompts')) {
    res.locals.layout = false;
  } else if (req.path.startsWith('/auth/') && !req.path.startsWith('/auth/delete-account')) {
    res.locals.layout = false;
  } else if (req.path.startsWith('/setup')) {
    res.locals.layout = false;
  } else if (req.path.match(/^\/chat\/\d+$/)) {
    res.locals.layout = false;
  } else {
    res.locals.layout = 'frontend/layout';
  }

  next();
});

app.use((req, res, next) => {
  if (req.path.startsWith('/setup') ||
      req.path.startsWith('/health') ||
      req.path.startsWith('/api/') ||
      req.path.startsWith('/css/') ||
      req.path.startsWith('/js/') ||
      req.path.startsWith('/uploads/') ||
      req.xhr ||
      req.headers['x-requested-with'] === 'XMLHttpRequest') {
    return next();
  }

  if (!isSetupCompleted()) {
    return res.redirect('/setup');
  }

  next();
});

// 全局操作日志中间件 - 记录每个用户的操作行为
const { activityLogger } = require('./middlewares/activity-logger');
app.use(activityLogger);

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
app.use('/setup', setupRoutes);
app.use('/auth', globalLimiter, authRoutes);
app.use('/oauth', globalLimiter, oauthRoutes);
app.use('/', globalLimiter, accountRoutes);
app.use('/admin', globalLimiter, adminRoutes);
app.use('/', globalLimiter, permissionApplicationsRoutes);
app.use('/api/v1', globalLimiter, apiLimiter, apiAccessLogger, apiRoutes);

// Maintenance mode middleware - only affects frontend routes
app.use(maintenanceMiddleware);

app.use('/poem-game', globalLimiter, poemGameRoutes);
app.use('/image-share', globalLimiter, imageShareRoutes);
app.use('/share', globalLimiter, shareRoutes);
app.use('/', globalLimiter, frontendRoutes);
app.use('/', globalLimiter, communityRoutes);
app.use('/', globalLimiter, privateMessageRoutes);
app.use('/', globalLimiter, contentRoutes);

app.get('/health', (req, res) => {
  const db = getDb();
  let dbStatus = 'ok';
  try {
    db && db.run('SELECT 1');
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

app.use((err, req, res, next) => {
  console.error('服务器错误:', err);
  monitor.recordError();

  if (req.path.startsWith('/api/')) {
    const status = err.status || (err.code === 'LIMIT_FILE_SIZE' || err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE' ? 400 : 500);
    const message = err.code === 'LIMIT_FILE_SIZE' ? '文件大小超出限制' : (err.message || '服务器内部错误');
    return res.status(status).json({ error: message });
  }

  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: '文件大小超出该上传的限制' });
  }
  if (err.code === 'LIMIT_FILE_COUNT') {
    return res.status(413).json({ error: '文件数量超出限制（最多20个）' });
  }
  if (err.code === 'LIMIT_UNEXPECTED_FILE') {
    return res.status(400).json({ error: '意外的文件字段' });
  }

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
        ? (status === 404 ? '您请求的页面不存在' : '请稍后再试')
        : '发生错误，请查看服务器日志',
      user: req.session ? req.session.user : null,
      settings: res.locals ? (res.locals.settings || {}) : {}
    });
  } catch (renderErr) {
    console.error('[' + status + '] 错误模板渲染失败:', renderErr.message);
    res.status(status).send(status === 404 ? '<h1>404 - 页面未找到</h1>' : '<h1>500 - 服务器内部错误</h1>');
  }
});

async function start() {
  try {
    await initDatabase();
    const { cleanupExpiredTokens } = require('./config/tokens');
    cleanupExpiredTokens();

    console.log('数据库初始化成功');

    // 从数据库加载CDN配置
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

    // Initialize scheduled backup
    try {
      const { initScheduledBackup } = require('./routes/admin/maintenance');
      const db = getDb();
      if (db) {
        initScheduledBackup(db);
      }
    } catch (err) {
      console.error('[app] Failed to initialize scheduled backup:', err.message);
    }

    const server = app.listen(PORT, '0.0.0.0', () => {
      console.log(`服务器运行在 http://0.0.0.0:${PORT}`);
      console.log(`环境: ${process.env.NODE_ENV || 'development'}`);
      // 通知 PM2 应用已就绪（配合 ecosystem.config.js 中的 wait_ready: true）
      if (process.send) {
        process.send('ready');
      }
    });

    // 端口冲突检测
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`[错误] 端口 ${PORT} 已被占用，请更换端口（PORT环境变量）或关闭占用进程`);
        process.exit(1);
      }
    });

    // 请求超时保护（30秒）
    server.timeout = 30000;
    server.keepAliveTimeout = 65000;

    // 进程错误处理
    process.on('uncaughtException', (err) => {
      console.error('[FATAL] uncaughtException:', err);
      server.close(() => {
        const { closeDatabase } = require('./config/database');
        closeDatabase();
        setTimeout(() => process.exit(1), 2000);
      });
      setTimeout(() => process.exit(1), 10000);
    });

    process.on('unhandledRejection', (reason) => {
      console.error('[WARN] unhandledRejection:', reason);
    });

    // 优雅关闭
    const gracefulShutdown = (signal) => {
      console.log(`[INFO] ${signal} received, shutting down...`);
      server.close(() => {
        const { closeDatabase } = require('./config/database');
        closeDatabase();
        process.exit(0);
      });
      // 强制退出超时
      setTimeout(() => {
        console.error('[WARN] Forced shutdown after timeout');
        process.exit(1);
      }, 10000);
    };

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));

    if (global.gc) {
      global.gc();
    }

  } catch (err) {
    console.error('启动失败:', err);
    process.exit(1);
  }
}

start();

module.exports = app;
