const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { isAuthenticated, isSuperAdmin } = require('../../middlewares/auth');
const { queryAll, queryOne, saveDatabase } = require('../../config/database');
const { monitor } = require('../../config/monitor');
const { LOG_DIR, logFilePath } = require('../../utils/logger');

// ============ 服务器运行日志页面 ============

router.get('/server-logs', isAuthenticated, isSuperAdmin, (req, res) => {
  const db = req.db;

  // 预读运行日志尾部（最近 150 行）
  const runtimeLines = readRuntimeLog(150, true);

  // API 访问日志第一页
  const page = 1;
  const limit = 30;
  const accessLogs = queryAll(db,
    'SELECT * FROM api_access_logs ORDER BY id DESC LIMIT ? OFFSET ?',
    [limit, (page - 1) * limit]
  ) || [];
  const accessTotal = queryOne(db, 'SELECT COUNT(*) as count FROM api_access_logs')?.count || 0;

  // 日志文件列表
  const logFiles = listLogFiles();

  // 数据库文件大小
  const dbPath = require('../../config/database').getDbPath();
  let dbSizeText = '不存在';
  try {
    if (fs.existsSync(dbPath)) {
      dbSizeText = (fs.statSync(dbPath).size / 1024 / 1024).toFixed(2) + ' MB';
    }
  } catch (e) { /* 忽略 */ }

  res.render('admin/server-logs', {
    user: req.session.user,
    settings: res.locals.settings || {},
    runtimeLines: runtimeLines,
    accessLogs: accessLogs,
    accessTotal: accessTotal,
    accessPage: page,
    accessLimit: limit,
    logFiles: logFiles,
    systemInfo: monitor.getSystemInfo(),
    dbPath: dbPath,
    dbSizeText: dbSizeText,
    active: 'server-logs'
  });
});

// ============ API：运行日志 ============

router.get('/server-logs/api/runtime', isAuthenticated, isSuperAdmin, (req, res) => {
  const lines = parseInt(req.query.lines) || 200;
  const level = (req.query.level || '').toString();
  const keyword = (req.query.keyword || '').toString().trim();
  const file = (req.query.file || '').toString();

  let allLines = readRuntimeLog(file ? file : 0, true, file || null);
  if (level) {
    allLines = allLines.filter(l => l.includes(`[${level}]`));
  }
  if (keyword) {
    allLines = allLines.filter(l => l.toLowerCase().includes(keyword.toLowerCase()));
  }
  // 取尾部 N 行
  const tail = allLines.slice(-Math.min(lines, 2000));

  res.json({ success: true, lines: tail, total: allLines.length });
});

// ============ API：App 访问日志（分页） ============

router.get('/server-logs/api/access', isAuthenticated, isSuperAdmin, (req, res) => {
  const db = req.db;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(10, parseInt(req.query.limit) || 30));
  const offset = (page - 1) * limit;

  const conditions = [];
  const params = [];
  if (req.query.username) {
    conditions.push('username LIKE ?');
    params.push(`%${req.query.username}%`);
  }
  if (req.query.method) {
    conditions.push('method = ?');
    params.push(req.query.method);
  }
  if (req.query.keyword) {
    conditions.push('path LIKE ?');
    params.push(`%${req.query.keyword}%`);
  }
  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

  const total = queryOne(db, `SELECT COUNT(*) as count FROM api_access_logs ${where}`, params)?.count || 0;
  const logs = queryAll(db,
    `SELECT * FROM api_access_logs ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  ) || [];

  res.json({
    success: true,
    logs: logs,
    pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) }
  });
});

// ============ API：清空 App 访问日志 ============

router.post('/server-logs/api/access/clear', isAuthenticated, isSuperAdmin, (req, res) => {
  try {
    const db = req.db;
    const count = queryOne(db, 'SELECT COUNT(*) as count FROM api_access_logs')?.count || 0;
    db.run('DELETE FROM api_access_logs');
    saveDatabase();
    res.json({ success: true, deleted: count });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============ API：清空运行日志文件 ============

router.post('/server-logs/api/runtime/clear', isAuthenticated, isSuperAdmin, (req, res) => {
  try {
    const file = (req.body.file || '').toString();
    const target = file && /^[\w.-]+\.log(\.\d+)?$/.test(file)
      ? path.join(LOG_DIR, file)
      : logFilePath();
    if (!target.startsWith(LOG_DIR + path.sep)) {
      return res.status(400).json({ success: false, error: '非法文件名' });
    }
    fs.writeFileSync(target, '', 'utf8');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============ 辅助函数 ============

/**
 * 读取运行日志文件内容
 * @param {number} tail - 仅返回尾部 N 行（0 表示全部）
 * @param {boolean} asArray - 返回行数组
 * @param {string|null} customFile - 指定日志文件名（默认当天文件）
 */
function readRuntimeLog(tail = 0, asArray = false, customFile = null) {
  try {
    const file = customFile
      ? path.join(LOG_DIR, customFile)
      : logFilePath();
    if (!fs.existsSync(file)) {
      return asArray ? [] : '';
    }
    const content = fs.readFileSync(file, 'utf8');
    const lines = content.split('\n').filter(l => l.trim() !== '');
    if (!asArray && tail > 0) {
      return lines.slice(-tail).join('\n');
    }
    if (asArray && tail > 0) {
      return lines.slice(-tail);
    }
    return asArray ? lines : content;
  } catch (e) {
    return asArray ? [] : '';
  }
}

/**
 * 列出日志目录中的文件（含大小）
 */
function listLogFiles() {
  try {
    if (!fs.existsSync(LOG_DIR)) return [];
    return fs.readdirSync(LOG_DIR)
      .filter(f => /^runtime-.*\.log(\.\d+)?$/.test(f))
      .map(f => {
        const stat = fs.statSync(path.join(LOG_DIR, f));
        return { name: f, size: stat.size, mtime: stat.mtime };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch (e) {
    return [];
  }
}

module.exports = router;
