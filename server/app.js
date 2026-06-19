require('dotenv').config();
const express = require('express');
const path = require('path');
const session = require('express-session');
const expressLayouts = require('express-ejs-layouts');
const multer = require('multer');
const fs = require('fs');
const os = require('os');
const cookieParser = require('cookie-parser');
const { queryAll, initDatabase, getDb, isSetupCompleted } = require('./config/database');
const { settingsCache, pageCache } = require('./config/cache');
const { monitor } = require('./config/monitor');
const { globalLimiter, loginLimiter } = require('./middlewares/rate-limiter');
const { maintenanceMiddleware } = require('./middlewares/maintenance');
const cdnConfig = require('../cdn-config');

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

app.set('trust proxy', 1);

app.use((req, res, next) => {
  monitor.recordRequest();
  next();
});

app.use(cookieParser());

app.use(express.json({
  limit: '10mb',
  strict: true
}));
app.use(express.urlencoded({
  extended: true,
  limit: '10mb',
  parameterLimit: 1000
}));

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

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  res.setHeader('X-Download-Options', 'noopen');

  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' cdnjs.cloudflare.com cdn.tailwindcss.com unpkg.com cdn.jsdelivr.net",
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

app.use(expressLayouts);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '../views'));
app.set('layout', 'frontend/layout');

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = path.join(__dirname, '../public/uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

function getCachedSettings(db) {
  const cacheKey = 'settings';
  let settings = settingsCache.get(cacheKey);
  if (!settings) {
    try {
      const settingsArray = queryAll(db, 'SELECT * FROM settings');
      settings = {};
      settingsArray.forEach(s => {
        settings[s.setting_key] = s.setting_value;
      });
      settingsCache.set(cacheKey, settings);
    } catch (err) {
      console.error('获取设置失败:', err.message);
      settings = {};
    }
  }
  return settings;
}

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
    return res.status(500).send('数据库未初始化');
  }

  res.locals.user = req.session.user || null;
  res.locals.settings = getCachedSettings(req.db);
  res.locals.navPages = getCachedNavPages(req.db);
  res.locals.csrfToken = '';
  res.locals.cdn = cdnConfig;

  // 使用 res.locals.layout 替代 app.set('layout') 避免并发竞态条件
  if (req.path.startsWith('/admin')) {
    res.locals.layout = 'admin/layout';
  } else if (req.path.startsWith('/novels/') && req.path.includes('/chapter/')) {
    res.locals.layout = false;
  } else if (req.path.startsWith('/poem-game')) {
    res.locals.layout = false;
  } else if (req.path.startsWith('/image-share')) {
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
const adminRoutes = require('./routes/admin/index');
const frontendRoutes = require('./routes/frontend');
const setupRoutes = require('./routes/setup');
const poemGameRoutes = require('./routes/poem-game');
const imageShareRoutes = require('./routes/image-share');
const communityRoutes = require('./routes/community');
const contentRoutes = require('./routes/content');
const permissionApplicationsRoutes = require('./routes/permission-applications');
const privateMessageRoutes = require('./routes/private-message');
app.use('/setup', setupRoutes);
app.use('/auth', globalLimiter, authRoutes);
app.use('/admin', globalLimiter, adminRoutes);
app.use('/', globalLimiter, permissionApplicationsRoutes);

// Maintenance mode middleware - only affects frontend routes
app.use(maintenanceMiddleware);

app.use('/poem-game', globalLimiter, poemGameRoutes);
app.use('/image-share', globalLimiter, imageShareRoutes);
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
  res.status(404).render('frontend/error', {
    message: '页面未找到',
    error: '您请求的页面不存在',
    user: req.session.user || null,
    settings: res.locals.settings || {}
  });
});

app.use((err, req, res, next) => {
  console.error('服务器错误:', err);
  monitor.recordError();

  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: '文件大小超出限制（最大50MB）' });
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

  res.status(500).render('frontend/error', {
    message: '服务器内部错误',
    error: process.env.NODE_ENV === 'production' ? '请稍后再试' : '发生错误，请查看服务器日志',
    user: req.session.user || null,
    settings: res.locals.settings || {}
  });
});

async function start() {
  try {
    await initDatabase();

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

    // 进程错误处理
    process.on('uncaughtException', (err) => {
      console.error('[FATAL] uncaughtException:', err);
      const { closeDatabase } = require('./config/database');
      closeDatabase();
      process.exit(1);
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
