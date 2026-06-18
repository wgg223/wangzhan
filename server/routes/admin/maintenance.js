const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const os = require('os');
const { isAuthenticated, isSuperAdmin } = require('../../middlewares/auth');
const { saveDatabase, queryAll, queryOne, getDb } = require('../../config/database');
const { logActivity } = require('../../config/activity');
const { settingsCache, queryCache, pageCache } = require('../../config/cache');

// Auto-initialize maintenance settings on first access
function ensureMaintenanceSettings(db) {
  const settings = [
    ['maintenance_mode', 'false'],
    ['maintenance_title', '系统维护中'],
    ['maintenance_message', '系统正在进行维护升级，请稍后再试。']
  ];

  for (const [key, value] of settings) {
    const existing = queryOne(db, `SELECT id FROM settings WHERE setting_key = '${key}'`);
    if (!existing) {
      db.run(`INSERT INTO settings (setting_key, setting_value) VALUES (${key}', '${value}')`);
    }
  }
  saveDatabase();
}

// GET - Maintenance page
router.get('/maintenance', isAuthenticated, isSuperAdmin, (req, res) => {
  const db = req.db;
  ensureMaintenanceSettings(db);

  const settings = {};
  const settingRows = queryAll(db, 'SELECT * FROM settings');
  settingRows.forEach(s => {
    settings[s.setting_key] = s.setting_value;
  });

  res.render('admin/maintenance', {
    user: req.session.user,
    userPermissions: res.locals.userPermissions || [],
    settings
  });
});

// POST - Update maintenance status
router.post('/maintenance/update', isAuthenticated, isSuperAdmin, (req, res) => {
  try {
    const db = req.db;
    const { enabled, title, message } = req.body;

    // Update or insert maintenance_mode setting
    const existingMode = queryOne(db, "SELECT id FROM settings WHERE setting_key = 'maintenance_mode'");
    if (existingMode) {
      db.run("UPDATE settings SET setting_value = ? WHERE setting_key = 'maintenance_mode'", [enabled ? 'true' : 'false']);
    } else {
      db.run("INSERT INTO settings (setting_key, setting_value) VALUES (maintenance_mode', ')", [enabled ? 'true' : 'false']);
    }

    // Update or insert maintenance_title
    const existingTitle = queryOne(db, "SELECT id FROM settings WHERE setting_key = 'maintenance_title'");
    if (existingTitle) {
      db.run("UPDATE settings SET setting_value = ? WHERE setting_key = 'maintenance_title'", [title || '系统维护中']);
    } else {
      db.run("INSERT INTO settings (setting_key, setting_value) VALUES (maintenance_title', ')", [title || '系统维护中']);
    }

    // Update or insert maintenance_message
    const existingMessage = queryOne(db, "SELECT id FROM settings WHERE setting_key = 'maintenance_message'");
    if (existingMessage) {
      db.run("UPDATE settings SET setting_value = ? WHERE setting_key = 'maintenance_message'", [message || '系统正在进行维护升级，请稍后再试。']);
    } else {
      db.run("INSERT INTO settings (setting_key, setting_value) VALUES (maintenance_message', ')", [message || '系统正在进行维护升级，请稍后再试。']);
    }

    saveDatabase();

    // Clear settings cache
    settingsCache.delete('settings');

    // Log activity
    try {
      logActivity(db, {
        user_id: req.session.user.id,
        username: req.session.user.username,
        action: enabled ? 'enable_maintenance' : 'disable_maintenance',
        target_type: 'system',
        target_title: '维护模式',
        detail: `用户 ${req.session.user.username} ${enabled ? '开启' : '关闭'}了维护模式`,
        ip: req.ip
      });
    } catch (logErr) {
      console.error('[maintenance] logActivity error:', logErr.message);
    }

    res.json({
      success: true,
      message: enabled ? '维护模式已开启' : '维护模式已关闭',
      status: {
        enabled,
        title: title || '系统维护中',
        message: message || '系统正在进行维护升级，请稍后再试。'
      }
    });
  } catch (err) {
    console.error('[maintenance] Update error:', err);
    res.status(500).json({ success: false, error: '更新维护状态失败: ' + err.message });
  }
});

// GET - Get current maintenance status
router.get('/maintenance/status', (req, res) => {
  try {
    const db = getDb();
    if (!db) {
      return res.json({ success: true, data: { enabled: false } });
    }

    const mode = queryOne(db, "SELECT setting_value FROM settings WHERE setting_key = 'maintenance_mode'");
    const title = queryOne(db, "SELECT setting_value FROM settings WHERE setting_key = 'maintenance_title'");
    const message = queryOne(db, "SELECT setting_value FROM settings WHERE setting_key = 'maintenance_message'");

    res.json({
      success: true,
      data: {
        enabled: mode?.setting_value === 'true',
        title: title?.setting_value || '系统维护中',
        message: message?.setting_value || '系统正在进行维护升级，请稍后再试。'
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST - Clear all caches
router.post('/maintenance/clear-cache', isAuthenticated, isSuperAdmin, (req, res) => {
  try {
    const statsBefore = {
      settings: settingsCache.getStats().size,
      query: queryCache.getStats().size,
      page: pageCache.getStats().size
    };

    settingsCache.flush();
    queryCache.flush();
    pageCache.flush();

    try {
      logActivity(req.db, {
        user_id: req.session.user.id,
        username: req.session.user.username,
        action: 'clear_cache',
        target_type: 'system',
        target_title: '清除缓存',
        detail: `用户 ${req.session.user.username} 清除了所有缓存（设置: ${statsBefore.settings}, 查询: ${statsBefore.query}, 页面: ${statsBefore.page}）`,
        ip: req.ip
      });
    } catch (logErr) {
      console.error('[maintenance] logActivity error:', logErr.message);
    }

    res.json({
      success: true,
      message: '缓存已清除',
      cleared: statsBefore
    });
  } catch (err) {
    console.error('[maintenance] Clear cache error:', err);
    res.status(500).json({ success: false, error: '清除缓存失败: ' + err.message });
  }
});

// GET - System info
router.get('/maintenance/system-info', isAuthenticated, isSuperAdmin, (req, res) => {
  try {
    const db = getDb();
    const projectRoot = path.resolve(__dirname, '../../..');

    // Database info
    let dbSize = 0;
    const dbPath = path.join(projectRoot, 'database.sqlite');
    if (fs.existsSync(dbPath)) {
      dbSize = fs.statSync(dbPath).size;
    }

    // Uploads directory size
    let uploadsSize = 0;
    const uploadsDir = path.join(projectRoot, 'public', 'uploads');
    if (fs.existsSync(uploadsDir)) {
      uploadsSize = getDirSize(uploadsDir);
    }

    // Backups directory size
    let backupsSize = 0;
    const backupsDir = path.join(projectRoot, 'backups');
    if (fs.existsSync(backupsDir)) {
      backupsSize = getDirSize(backupsDir);
    }

    // Temp files size
    let tempSize = 0;
    const tempDir = path.join(projectRoot, 'temp_update');
    if (fs.existsSync(tempDir)) {
      tempSize = getDirSize(tempDir);
    }

    // Database table stats
    const tableStats = {};
    if (db) {
      const tables = queryAll(db, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
      for (const table of tables) {
        try {
          const count = queryOne(db, `SELECT COUNT(*) as count FROM "${table.name}"`);
          tableStats[table.name] = count?.count || 0;
        } catch (e) {
          tableStats[table.name] = -1;
        }
      }
    }

    // Cache stats
    const cacheStats = {
      settings: settingsCache.getStats(),
      query: queryCache.getStats(),
      page: pageCache.getStats()
    };

    res.json({
      success: true,
      data: {
        server: {
          platform: os.platform(),
          arch: os.arch(),
          nodeVersion: process.version,
          uptime: process.uptime(),
          memoryUsage: process.memoryUsage(),
          totalMemory: os.totalmem(),
          freeMemory: os.freemem(),
          cpus: os.cpus().length,
          loadAverage: os.loadavg()
        },
        database: {
          path: dbPath,
          size: dbSize,
          sizeFormatted: formatSize(dbSize),
          tableStats
        },
        storage: {
          uploads: { size: uploadsSize, formatted: formatSize(uploadsSize) },
          backups: { size: backupsSize, formatted: formatSize(backupsSize) },
          temp: { size: tempSize, formatted: formatSize(tempSize) }
        },
        cache: cacheStats
      }
    });
  } catch (err) {
    console.error('[maintenance] System info error:', err);
    res.status(500).json({ success: false, error: '获取系统信息失败: ' + err.message });
  }
});

// POST - Clean temp files
router.post('/maintenance/clean-temp', isAuthenticated, isSuperAdmin, (req, res) => {
  try {
    const projectRoot = path.resolve(__dirname, '../../..');
    const tempDirs = ['temp_update', 'temp'];
    let totalCleaned = 0;

    for (const dir of tempDirs) {
      const tempPath = path.join(projectRoot, dir);
      if (fs.existsSync(tempPath)) {
        const size = getDirSize(tempPath);
        fs.rmSync(tempPath, { recursive: true, force: true });
        totalCleaned += size;
      }
    }

    // Clean old log files (older than 30 days)
    const logsDir = path.join(projectRoot, 'logs');
    if (fs.existsSync(logsDir)) {
      const now = Date.now();
      const thirtyDays = 30 * 24 * 60 * 60 * 1000;
      const files = fs.readdirSync(logsDir);
      for (const file of files) {
        const filePath = path.join(logsDir, file);
        const stat = fs.statSync(filePath);
        if (now - stat.mtimeMs > thirtyDays) {
          totalCleaned += stat.size;
          fs.unlinkSync(filePath);
        }
      }
    }

    try {
      logActivity(req.db, {
        user_id: req.session.user.id,
        username: req.session.user.username,
        action: 'clean_temp',
        target_type: 'system',
        target_title: '清理临时文件',
        detail: `用户 ${req.session.user.username} 清理了临时文件，释放 ${formatSize(totalCleaned)}`,
        ip: req.ip
      });
    } catch (logErr) {
      console.error('[maintenance] logActivity error:', logErr.message);
    }

    res.json({
      success: true,
      message: `临时文件已清理，释放 ${formatSize(totalCleaned)}`,
      cleaned: totalCleaned,
      cleanedFormatted: formatSize(totalCleaned)
    });
  } catch (err) {
    console.error('[maintenance] Clean temp error:', err);
    res.status(500).json({ success: false, error: '清理临时文件失败: ' + err.message });
  }
});

// POST - Clean activity logs
router.post('/maintenance/clean-logs', isAuthenticated, isSuperAdmin, (req, res) => {
  try {
    const db = req.db;
    const { days = 30 } = req.body;

    const countBefore = queryOne(db, 'SELECT COUNT(*) as count FROM activity_logs')?.count || 0;

    db.run(`DELETE FROM activity_logs WHERE created_at < datetime('now', '-${parseInt(days)} days')`);
    saveDatabase();

    const countAfter = queryOne(db, 'SELECT COUNT(*) as count FROM activity_logs')?.count || 0;
    const deleted = countBefore - countAfter;

    try {
      logActivity(db, {
        user_id: req.session.user.id,
        username: req.session.user.username,
        action: 'clean_logs',
        target_type: 'system',
        target_title: '清理日志',
        detail: `用户 ${req.session.user.username} 清理了 ${days} 天前的活动日志，删除 ${deleted} 条记录`,
        ip: req.ip
      });
    } catch (logErr) {
      console.error('[maintenance] logActivity error:', logErr.message);
    }

    res.json({
      success: true,
      message: `已清理 ${days} 天前的活动日志`,
      deleted,
      remaining: countAfter
    });
  } catch (err) {
    console.error('[maintenance] Clean logs error:', err);
    res.status(500).json({ success: false, error: '清理日志失败: ' + err.message });
  }
});

// POST - Optimize database
router.post('/maintenance/optimize-db', isAuthenticated, isSuperAdmin, (req, res) => {
  try {
    const db = req.db;
    const projectRoot = path.resolve(__dirname, '../../..');
    const dbPath = path.join(projectRoot, 'database.sqlite');

    const sizeBefore = fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0;

    // Run VACUUM to optimize database
    db.run('VACUUM');
    saveDatabase();

    const sizeAfter = fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0;
    const saved = sizeBefore - sizeAfter;

    try {
      logActivity(db, {
        user_id: req.session.user.id,
        username: req.session.user.username,
        action: 'optimize_db',
        target_type: 'system',
        target_title: '优化数据库',
        detail: `用户 ${req.session.user.username} 优化了数据库，释放 ${formatSize(saved)}`,
        ip: req.ip
      });
    } catch (logErr) {
      console.error('[maintenance] logActivity error:', logErr.message);
    }

    res.json({
      success: true,
      message: '数据库优化完成',
      sizeBefore: formatSize(sizeBefore),
      sizeAfter: formatSize(sizeAfter),
      saved: formatSize(saved)
    });
  } catch (err) {
    console.error('[maintenance] Optimize DB error:', err);
    res.status(500).json({ success: false, error: '优化数据库失败: ' + err.message });
  }
});

// Helper functions
function getDirSize(dirPath) {
  let size = 0;
  try {
    const items = fs.readdirSync(dirPath);
    for (const item of items) {
      const itemPath = path.join(dirPath, item);
      const stat = fs.statSync(itemPath);
      if (stat.isDirectory()) {
        size += getDirSize(itemPath);
      } else {
        size += stat.size;
      }
    }
  } catch (e) { /* ignore */ }
  return size;
}

function formatSize(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

module.exports = router;
