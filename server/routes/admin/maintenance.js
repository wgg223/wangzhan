const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const http = require('http');
const { exec, spawn } = require('child_process');
const cron = require('node-cron');
const { isAuthenticated, isSuperAdmin } = require('../../middlewares/auth');
const { saveDatabase, queryAll, queryOne, getDb } = require('../../config/database');
const { logActivity } = require('../../config/activity');
const { settingsCache, queryCache, pageCache } = require('../../config/cache');
const { sendMail } = require('../../config/mailer');

const isWindows = process.platform === 'win32';
const projectRoot = path.resolve(__dirname, '../../..');
const backupDir = path.join(projectRoot, 'backups');

// Auto-update state
let autoUpdateState = {
  checking: false,
  hasUpdate: false,
  latestVersion: null,
  releaseBody: null,
  releaseName: null,
  publishedAt: null,
  downloadUrl: null,
  lastChecked: null,
  updateInstalled: false,
  notifiedUsers: new Set()
};

// Compare version numbers (returns 1 if v1 > v2, -1 if v1 < v2, 0 if equal)
function compareVersions(v1, v2) {
  const parts1 = v1.split('.').map(Number);
  const parts2 = v2.split('.').map(Number);
  
  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const num1 = parts1[i] || 0;
    const num2 = parts2[i] || 0;
    
    if (num1 > num2) return 1;
    if (num1 < num2) return -1;
  }
  
  return 0;
}

// Scheduled backup task
let scheduledBackupTask = null;

// GitHub repo config
const GITHUB_REPOS = {
  main: { owner: process.env.GITHUB_OWNER || 'wgg223', repo: process.env.GITHUB_REPO || 'wangzhan' },
  rphub: { owner: 'STA1N156', repo: 'RP-Hub' }
};

// Initialize scheduled backup from settings
function initScheduledBackup(db) {
  if (scheduledBackupTask) {
    scheduledBackupTask.stop();
    scheduledBackupTask = null;
  }

  const enabled = queryOne(db, "SELECT setting_value FROM settings WHERE setting_key = 'scheduled_backup_enabled'");
  const cronExpr = queryOne(db, "SELECT setting_value FROM settings WHERE setting_key = 'scheduled_backup_cron'");
  const backupType = queryOne(db, "SELECT setting_value FROM settings WHERE setting_key = 'scheduled_backup_type'");
  const notifyEmail = queryOne(db, "SELECT setting_value FROM settings WHERE setting_key = 'scheduled_backup_notify_email'");

  if (enabled?.setting_value === 'true' && cronExpr?.settingValue) {
    try {
      scheduledBackupTask = cron.schedule(cronExpr.setting_value, async () => {
        console.log('[scheduled-backup] Starting scheduled backup...');
        await performScheduledBackup(db, backupType?.setting_value || 'database', notifyEmail?.setting_value);
      });
      console.log('[scheduled-backup] Scheduled backup initialized:', cronExpr.setting_value);
    } catch (err) {
      console.error('[scheduled-backup] Failed to initialize:', err.message);
    }
  }
}

// Check for updates automatically
async function checkForUpdates() {
  if (autoUpdateState.checking) return;
  autoUpdateState.checking = true;

  try {
    const { owner: githubOwner, repo: githubRepo } = GITHUB_REPOS.main;
    const packageJsonPath = path.join(projectRoot, 'package.json');
    let currentVersion = '2.2.0';
    try {
      if (fs.existsSync(packageJsonPath)) {
        const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
        currentVersion = pkg.version || currentVersion;
      }
    } catch (e) { /* ignore */ }

    const githubApiUrl = `https://api.github.com/repos/${githubOwner}/${githubRepo}/releases/latest`;

    const response = await fetch(githubApiUrl, {
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'RP-Hub-Update-Checker'
      },
      signal: AbortSignal.timeout(10000)
    });

    if (!response.ok) {
      console.log('[auto-update] Failed to check updates:', response.status);
      return;
    }

    const releaseData = await response.json();
    const latestVersion = releaseData.tag_name?.replace(/^v/, '') || currentVersion;
    // Only consider it an update if latest version is greater than current version
    const hasUpdate = compareVersions(latestVersion, currentVersion) > 0;

    autoUpdateState = {
      ...autoUpdateState,
      hasUpdate,
      latestVersion,
      releaseBody: releaseData.body || '',
      releaseName: releaseData.name || '',
      publishedAt: releaseData.published_at || '',
      downloadUrl: releaseData.zipball_url || '',
      lastChecked: new Date().toISOString(),
      checking: false
    };

    if (hasUpdate) {
      console.log(`[auto-update] New version available: v${latestVersion} (current: v${currentVersion})`);
    } else {
      console.log('[auto-update] Already up to date');
    }
  } catch (err) {
    console.error('[auto-update] Check failed:', err.message);
    autoUpdateState.checking = false;
  }
}

// Perform auto-update
async function performAutoUpdate() {
  if (!autoUpdateState.hasUpdate || !autoUpdateState.downloadUrl) return false;

  try {
    console.log('[auto-update] Starting auto-update to v' + autoUpdateState.latestVersion);

    const tempDir = path.join(projectRoot, 'temp_update');
    const backupUpdateDir = path.join(projectRoot, 'backup_auto_' + Date.now());

    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const zipPath = path.join(tempDir, 'update.zip');

    // Download
    await new Promise((resolve, reject) => {
      const downloadFile = (url) => {
        const protocol = url.startsWith('https') ? https : http;
        const request = protocol.get(url, {
          headers: { 'User-Agent': 'RP-Hub-Updater', 'Accept': 'application/zip, application/octet-stream, */*' }
        }, (response) => {
          if (response.statusCode === 302 || response.statusCode === 301 || response.statusCode === 307) {
            downloadFile(response.headers.location);
            return;
          }
          if (response.statusCode !== 200) {
            reject(new Error(`Download failed, status: ${response.statusCode}`));
            return;
          }
          const file = fs.createWriteStream(zipPath);
          response.pipe(file);
          file.on('finish', () => { file.close(); resolve(); });
          file.on('error', (err) => { fs.unlink(zipPath, () => {}); reject(err); });
        });
        request.on('error', reject);
        request.setTimeout(60000, () => { request.destroy(); reject(new Error('Download timeout')); });
      };
      downloadFile(autoUpdateState.downloadUrl);
    });

    // Unzip
    const AdmZip = require('adm-zip');
    try {
      const zip = new AdmZip(zipPath);
      zip.extractAllTo(tempDir, true);
    } catch (zipError) {
      throw new Error('Unzip failed: ' + zipError.message);
    }

    const files = fs.readdirSync(tempDir).filter(f => f !== 'update.zip');
    const extractedDir = files.find(f => fs.statSync(path.join(tempDir, f)).isDirectory());
    const sourceDir = extractedDir ? path.join(tempDir, extractedDir) : tempDir;

    // Backup current files
    if (!fs.existsSync(backupUpdateDir)) fs.mkdirSync(backupUpdateDir, { recursive: true });
    const backupFiles = ['package.json', 'server', 'public', 'views'];
    for (const item of backupFiles) {
      const src = path.join(projectRoot, item);
      if (fs.existsSync(src)) {
        const stat = fs.statSync(src);
        if (stat.isDirectory()) {
          await copyDir(src, path.join(backupUpdateDir, item));
        } else {
          fs.copyFileSync(src, path.join(backupUpdateDir, item));
        }
      }
    }

    // Copy update files
    const updateItems = fs.readdirSync(sourceDir);
    for (const item of updateItems) {
      if (item === 'node_modules' || item === '.git' || item === 'temp_update') continue;
      const src = path.join(sourceDir, item);
      const dest = path.join(projectRoot, item);
      const stat = fs.statSync(src);
      if (stat.isDirectory()) {
        await copyDir(src, dest);
      } else {
        const destDir = path.dirname(dest);
        if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
        fs.copyFileSync(src, dest);
      }
    }

    // Cleanup
    fs.rmSync(tempDir, { recursive: true, force: true });

    autoUpdateState.updateInstalled = true;
    console.log('[auto-update] Update installed successfully');
    return true;
  } catch (err) {
    console.error('[auto-update] Update failed:', err.message);
    return false;
  }
}

// Initialize scheduled backup from settings
function initScheduledBackup(db) {
  if (scheduledBackupTask) {
    scheduledBackupTask.stop();
    scheduledBackupTask = null;
  }

  const enabled = queryOne(db, "SELECT setting_value FROM settings WHERE setting_key = 'scheduled_backup_enabled'");
  const cronExpr = queryOne(db, "SELECT setting_value FROM settings WHERE setting_key = 'scheduled_backup_cron'");
  const backupType = queryOne(db, "SELECT setting_value FROM settings WHERE setting_key = 'scheduled_backup_type'");
  const notifyEmail = queryOne(db, "SELECT setting_value FROM settings WHERE setting_key = 'scheduled_backup_notify_email'");

  if (enabled?.setting_value === 'true' && cronExpr?.setting_value) {
    try {
      scheduledBackupTask = cron.schedule(cronExpr.setting_value, async () => {
        console.log('[scheduled-backup] Starting scheduled backup...');
        await performScheduledBackup(db, backupType?.setting_value || 'database', notifyEmail?.setting_value);
      });
      console.log('[scheduled-backup] Scheduled backup initialized:', cronExpr.setting_value);
    } catch (err) {
      console.error('[scheduled-backup] Failed to initialize:', err.message);
    }
  }
}

// Perform scheduled backup
async function performScheduledBackup(db, type, notifyEmail) {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupName = `scheduled-${type}-${timestamp}`;
    const backupPath = path.join(backupDir, backupName);

    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }
    fs.mkdirSync(backupPath, { recursive: true });

    const itemsToBackup = [];

    if (type === 'full' || type === 'database') {
      const dbSrc = path.join(projectRoot, 'database.sqlite');
      if (fs.existsSync(dbSrc)) {
        fs.copyFileSync(dbSrc, path.join(backupPath, 'database.sqlite'));
        itemsToBackup.push('database.sqlite');
      }
    }

    if (type === 'full' || type === 'uploads') {
      const uploadsDir = path.join(projectRoot, 'public', 'uploads');
      if (fs.existsSync(uploadsDir)) {
        await copyDir(uploadsDir, path.join(backupPath, 'uploads'));
        itemsToBackup.push('uploads/');
      }
    }

    if (type === 'full' || type === 'config') {
      const configFiles = ['package.json', 'ecosystem.config.js', '.env'];
      for (const file of configFiles) {
        const src = path.join(projectRoot, file);
        if (fs.existsSync(src)) {
          fs.copyFileSync(src, path.join(backupPath, file));
          itemsToBackup.push(file);
        }
      }
    }

    // Create metadata
    const meta = {
      name: backupName,
      type: `scheduled-${type}`,
      createdAt: new Date().toISOString(),
      createdBy: '系统定时任务',
      items: itemsToBackup
    };
    fs.writeFileSync(path.join(backupPath, 'backup-meta.json'), JSON.stringify(meta, null, 2));

    // Calculate size
    const backupSize = getDirSize(backupPath);

    // Log activity
    try {
      logActivity(db, {
        user_id: 0,
        username: '系统',
        action: 'scheduled_backup',
        target_type: 'system',
        target_title: '定时备份',
        detail: `定时备份完成: ${backupName}，类型: ${type}，大小: ${formatSize(backupSize)}`,
        ip: ''
      });
    } catch (logErr) {
      console.error('[scheduled-backup] logActivity error:', logErr.message);
    }

    // Send email notification
    if (notifyEmail) {
      try {
        const siteName = queryOne(db, "SELECT setting_value FROM settings WHERE setting_key = 'site_name'")?.setting_value || '网站系统';
        await sendMail(db, {
          to: notifyEmail,
          subject: `[${siteName}] 定时备份成功通知`,
          html: buildBackupNotifyEmail(backupName, type, itemsToBackup, backupSize, siteName)
        });
        console.log('[scheduled-backup] Notification email sent to:', notifyEmail);
      } catch (emailErr) {
        console.error('[scheduled-backup] Failed to send notification email:', emailErr.message);
      }
    }

    console.log('[scheduled-backup] Backup completed:', backupName);
    return { success: true, backupName, size: backupSize };
  } catch (err) {
    console.error('[scheduled-backup] Backup failed:', err.message);

    // Send failure notification
    if (notifyEmail) {
      try {
        const siteName = queryOne(db, "SELECT setting_value FROM settings WHERE setting_key = 'site_name'")?.setting_value || '网站系统';
        await sendMail(db, {
          to: notifyEmail,
          subject: `[${siteName}] 定时备份失败通知`,
          html: `<div style="max-width:600px;margin:0 auto;padding:20px;font-family:Arial,sans-serif;">
            <h2 style="color:#dc3545;">定时备份失败</h2>
            <p>备份类型: ${type}</p>
            <p>错误信息: ${err.message}</p>
            <p>时间: ${new Date().toLocaleString('zh-CN')}</p>
          </div>`
        });
      } catch (emailErr) {
        console.error('[scheduled-backup] Failed to send failure email:', emailErr.message);
      }
    }

    return { success: false, error: err.message };
  }
}

// Build backup notification email
function buildBackupNotifyEmail(backupName, type, items, size, siteName) {
  const typeNames = { full: '完整备份', database: '数据库备份', uploads: '上传文件备份', config: '配置备份' };
  const year = new Date().getFullYear();
  return `<div style="max-width:600px;margin:0 auto;padding:20px;font-family:Arial,sans-serif;">
    <h2 style="color:#28a745;">定时备份成功</h2>
    <div style="background:#f8f9fa;padding:16px;border-radius:8px;margin:16px 0;">
      <p style="margin:8px 0;"><strong>备份名称：</strong>${backupName}</p>
      <p style="margin:8px 0;"><strong>备份类型：</strong>${typeNames[type] || type}</p>
      <p style="margin:8px 0;"><strong>备份大小：</strong>${formatSize(size)}</p>
      <p style="margin:8px 0;"><strong>包含内容：</strong>${items.join(', ')}</p>
      <p style="margin:8px 0;"><strong>完成时间：</strong>${new Date().toLocaleString('zh-CN')}</p>
    </div>
    <p style="color:#6c757d;font-size:13px;">此邮件由系统自动发送，请勿回复。</p>
    <p style="color:#6c757d;font-size:12px;">&copy; ${year} ${siteName}</p>
  </div>`;
}

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

// GET - Scheduled backup settings
router.get('/maintenance/scheduled-backup', isAuthenticated, isSuperAdmin, (req, res) => {
  try {
    const db = req.db;
    const settings = {};
    const keys = ['scheduled_backup_enabled', 'scheduled_backup_cron', 'scheduled_backup_type', 'scheduled_backup_notify_email'];
    for (const key of keys) {
      const row = queryOne(db, `SELECT setting_value FROM settings WHERE setting_key = '${key}'`);
      settings[key] = row?.setting_value || '';
    }

    res.json({
      success: true,
      data: {
        enabled: settings.scheduled_backup_enabled === 'true',
        cron: settings.scheduled_backup_cron || '0 3 * * *',
        type: settings.scheduled_backup_type || 'database',
        notifyEmail: settings.scheduled_backup_notify_email || ''
      }
    });
  } catch (err) {
    console.error('[maintenance] Get scheduled backup error:', err);
    res.status(500).json({ success: false, error: '获取定时备份设置失败: ' + err.message });
  }
});

// POST - Update scheduled backup settings
router.post('/maintenance/scheduled-backup', isAuthenticated, isSuperAdmin, (req, res) => {
  try {
    const db = req.db;
    const { enabled, cron: cronExpr, type, notifyEmail } = req.body;

    // Validate cron expression
    if (enabled && !cron.validate(cronExpr)) {
      return res.status(400).json({ success: false, error: '无效的 Cron 表达式' });
    }

    const settingsToUpdate = [
      { key: 'scheduled_backup_enabled', value: enabled ? 'true' : 'false' },
      { key: 'scheduled_backup_cron', value: cronExpr || '0 3 * * *' },
      { key: 'scheduled_backup_type', value: type || 'database' },
      { key: 'scheduled_backup_notify_email', value: notifyEmail || '' }
    ];

    for (const { key, value } of settingsToUpdate) {
      const existing = queryOne(db, `SELECT id FROM settings WHERE setting_key = '${key}'`);
      if (existing) {
        db.run(`UPDATE settings SET setting_value = ? WHERE setting_key = ?`, [value, key]);
      } else {
        db.run(`INSERT INTO settings (setting_key, setting_value) VALUES (?, ?)`, [key, value]);
      }
    }
    saveDatabase();
    settingsCache.delete('settings');

    // Reinitialize scheduled backup
    initScheduledBackup(db);

    try {
      logActivity(db, {
        user_id: req.session.user.id,
        username: req.session.user.username,
        action: 'update_scheduled_backup',
        target_type: 'system',
        target_title: '定时备份',
        detail: `用户 ${req.session.user.username} ${enabled ? '启用' : '禁用'}了定时备份，类型: ${type}，Cron: ${cronExpr}`,
        ip: req.ip
      });
    } catch (logErr) {
      console.error('[maintenance] logActivity error:', logErr.message);
    }

    res.json({
      success: true,
      message: enabled ? '定时备份已启用' : '定时备份已禁用'
    });
  } catch (err) {
    console.error('[maintenance] Update scheduled backup error:', err);
    res.status(500).json({ success: false, error: '更新定时备份设置失败: ' + err.message });
  }
});

// POST - Manual backup with options
router.post('/maintenance/backup-now', isAuthenticated, isSuperAdmin, async (req, res) => {
  try {
    const db = req.db;
    const { type = 'database', sendNotification = false } = req.body;

    const result = await performScheduledBackup(db, type, sendNotification ? (req.body.notifyEmail || '') : '');

    try {
      logActivity(db, {
        user_id: req.session.user.id,
        username: req.session.user.username,
        action: 'manual_backup',
        target_type: 'system',
        target_title: '手动备份',
        detail: `用户 ${req.session.user.username} 执行了手动备份，类型: ${type}`,
        ip: req.ip
      });
    } catch (logErr) {
      console.error('[maintenance] logActivity error:', logErr.message);
    }

    if (result.success) {
      res.json({
        success: true,
        message: `备份创建成功: ${result.backupName}`,
        backupName: result.backupName,
        size: formatSize(result.size)
      });
    } else {
      res.status(500).json({ success: false, error: '备份失败: ' + result.error });
    }
  } catch (err) {
    console.error('[maintenance] Backup now error:', err);
    res.status(500).json({ success: false, error: '备份失败: ' + err.message });
  }
});

// ==================== Server Update ====================

// GET - Get auto-update status (for admin dashboard notification)
router.get('/maintenance/update-status', isAuthenticated, isSuperAdmin, (req, res) => {
  const userId = req.session.user.id;
  const alreadyNotified = autoUpdateState.notifiedUsers.has(userId);

  res.json({
    success: true,
    data: {
      hasUpdate: autoUpdateState.hasUpdate,
      latestVersion: autoUpdateState.latestVersion,
      releaseName: autoUpdateState.releaseName,
      releaseBody: autoUpdateState.releaseBody,
      publishedAt: autoUpdateState.publishedAt,
      lastChecked: autoUpdateState.lastChecked,
      updateInstalled: autoUpdateState.updateInstalled,
      alreadyNotified
    }
  });
});

// POST - Mark update as notified for current user
router.post('/maintenance/mark-notified', isAuthenticated, isSuperAdmin, (req, res) => {
  autoUpdateState.notifiedUsers.add(req.session.user.id);
  res.json({ success: true });
});

// POST - Trigger auto-update
router.post('/maintenance/auto-update', isAuthenticated, isSuperAdmin, async (req, res) => {
  try {
    if (!autoUpdateState.hasUpdate) {
      return res.json({ success: true, message: '没有可用更新' });
    }

    const result = await performAutoUpdate();

    if (result) {
      try {
        logActivity(req.db, {
          user_id: req.session.user.id,
          username: req.session.user.username,
          action: 'auto_update',
          target_type: 'system',
          target_title: '自动更新',
          detail: `用户 ${req.session.user.username} 触发自动更新到 v${autoUpdateState.latestVersion}`,
          ip: req.ip
        });
      } catch (logErr) { /* ignore */ }

      res.json({
        success: true,
        message: `更新已安装到 v${autoUpdateState.latestVersion}，建议重启服务器`
      });
    } else {
      res.status(500).json({ success: false, error: '自动更新失败' });
    }
  } catch (err) {
    console.error('[maintenance] Auto-update error:', err);
    res.status(500).json({ success: false, error: '自动更新失败: ' + err.message });
  }
});

// GET - Check for updates
router.get('/maintenance/check-update', isAuthenticated, isSuperAdmin, async (req, res) => {
  try {
    const { owner: githubOwner, repo: githubRepo } = GITHUB_REPOS.main;
    const packageJsonPath = path.join(projectRoot, 'package.json');
    let currentVersion = '2.4.0';
    try {
      if (fs.existsSync(packageJsonPath)) {
        const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
        currentVersion = pkg.version || currentVersion;
      }
    } catch (e) { /* ignore */ }

    const githubApiUrl = `https://api.github.com/repos/${githubOwner}/${githubRepo}/releases/latest`;

    const response = await fetch(githubApiUrl, {
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'RP-Hub-Update-Checker'
      },
      signal: AbortSignal.timeout(10000)
    });

    if (!response.ok) {
      return res.json({
        success: true,
        data: {
          hasUpdate: false,
          currentVersion,
          latestVersion: currentVersion,
          message: '无法连接到 GitHub'
        }
      });
    }

    const releaseData = await response.json();
    const latestVersion = releaseData.tag_name?.replace(/^v/, '') || currentVersion;
    // Only consider it an update if latest version is greater than current version
    const hasUpdate = compareVersions(latestVersion, currentVersion) > 0;

    res.json({
      success: true,
      data: {
        hasUpdate,
        currentVersion,
        latestVersion,
        releaseName: releaseData.name || '',
        releaseBody: releaseData.body || '',
        releaseUrl: releaseData.html_url || '',
        publishedAt: releaseData.published_at || '',
        downloadUrl: releaseData.zipball_url || ''
      }
    });
  } catch (err) {
    console.error('[maintenance] Check update error:', err);
    res.status(500).json({ success: false, error: '检查更新失败: ' + err.message });
  }
});

// GET - Check RP-Hub updates
router.get('/maintenance/check-rphub-update', isAuthenticated, isSuperAdmin, async (req, res) => {
  try {
    const { owner: githubOwner, repo: githubRepo } = GITHUB_REPOS.rphub;
    
    const githubApiUrl = `https://api.github.com/repos/${githubOwner}/${githubRepo}/releases/latest`;

    const response = await fetch(githubApiUrl, {
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'RP-Hub-Update-Checker'
      },
      signal: AbortSignal.timeout(10000)
    });

    if (!response.ok) {
      return res.json({
        success: true,
        data: {
          hasUpdate: false,
          message: '无法连接到 GitHub'
        }
      });
    }

    const releaseData = await response.json();
    const latestVersion = releaseData.tag_name?.replace(/^v/, '') || '0.0.0';

    res.json({
      success: true,
      data: {
        latestVersion,
        releaseName: releaseData.name || '',
        releaseBody: releaseData.body || '',
        releaseUrl: releaseData.html_url || '',
        publishedAt: releaseData.published_at || '',
        downloadUrl: releaseData.zipball_url || ''
      }
    });
  } catch (err) {
    console.error('[maintenance] Check RP-Hub update error:', err);
    res.status(500).json({ success: false, error: '检查RP-Hub更新失败: ' + err.message });
  }
});

// POST - Download and install update
router.post('/maintenance/download-update', isAuthenticated, isSuperAdmin, async (req, res) => {
  try {
    const { downloadUrl, version } = req.body;
    if (!downloadUrl) {
      return res.status(400).json({ success: false, error: '缺少下载链接' });
    }

    // Check if target version is higher than current version
    const packageJsonPath = path.join(projectRoot, 'package.json');
    let currentVersion = '2.4.0';
    try {
      if (fs.existsSync(packageJsonPath)) {
        const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
        currentVersion = pkg.version || currentVersion;
      }
    } catch (e) { /* ignore */ }

    if (compareVersions(version, currentVersion) <= 0) {
      return res.status(400).json({ 
        success: false, 
        error: `无法降级：目标版本 v${version} 不高于当前版本 v${currentVersion}` 
      });
    }

    const tempDir = path.join(projectRoot, 'temp_update');
    const backupUpdateDir = path.join(projectRoot, 'backup_' + Date.now());

    // Log
    try {
      logActivity(req.db, {
        user_id: req.session.user.id,
        username: req.session.user.username,
        action: 'start_update',
        target_type: 'system',
        target_title: '系统更新',
        detail: `用户 ${req.session.user.username} 开始下载更新版本 ${version}`,
        ip: req.ip
      });
    } catch (logErr) { /* ignore */ }

    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const zipPath = path.join(tempDir, 'update.zip');

    // Download
    await new Promise((resolve, reject) => {
      const downloadFile = (url) => {
        const protocol = url.startsWith('https') ? https : http;
        const request = protocol.get(url, {
          headers: { 'User-Agent': 'RP-Hub-Updater', 'Accept': 'application/zip, application/octet-stream, */*' }
        }, (response) => {
          if (response.statusCode === 302 || response.statusCode === 301 || response.statusCode === 307) {
            downloadFile(response.headers.location);
            return;
          }
          if (response.statusCode !== 200) {
            reject(new Error(`下载失败，状态码: ${response.statusCode}`));
            return;
          }
          const file = fs.createWriteStream(zipPath);
          response.pipe(file);
          file.on('finish', () => { file.close(); resolve(); });
          file.on('error', (err) => { fs.unlink(zipPath, () => {}); reject(err); });
        });
        request.on('error', reject);
        request.setTimeout(30000, () => { request.destroy(); reject(new Error('下载超时')); });
      };
      downloadFile(downloadUrl);
    });

    // Unzip
    const AdmZip = require('adm-zip');
    try {
      const zip = new AdmZip(zipPath);
      zip.extractAllTo(tempDir, true);
    } catch (zipError) {
      throw new Error('解压失败: ' + zipError.message);
    }

    const files = fs.readdirSync(tempDir).filter(f => f !== 'update.zip');
    const extractedDir = files.find(f => fs.statSync(path.join(tempDir, f)).isDirectory());
    const sourceDir = extractedDir ? path.join(tempDir, extractedDir) : tempDir;

    // Backup current
    if (!fs.existsSync(backupUpdateDir)) fs.mkdirSync(backupUpdateDir, { recursive: true });
    const backupFiles = ['package.json', 'server', 'public', 'views'];
    for (const item of backupFiles) {
      const src = path.join(projectRoot, item);
      if (fs.existsSync(src)) {
        const stat = fs.statSync(src);
        if (stat.isDirectory()) {
          await copyDir(src, path.join(backupUpdateDir, item));
        } else {
          fs.copyFileSync(src, path.join(backupUpdateDir, item));
        }
      }
    }

    // Copy update files
    const updateItems = fs.readdirSync(sourceDir);
    for (const item of updateItems) {
      if (item === 'node_modules' || item === '.git' || item === 'temp_update') continue;
      const src = path.join(sourceDir, item);
      const dest = path.join(projectRoot, item);
      const stat = fs.statSync(src);
      if (stat.isDirectory()) {
        await copyDir(src, dest);
      } else {
        const destDir = path.dirname(dest);
        if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
        fs.copyFileSync(src, dest);
      }
    }

    // Cleanup
    fs.rmSync(tempDir, { recursive: true, force: true });

    try {
      logActivity(req.db, {
        user_id: req.session.user.id,
        username: req.session.user.username,
        action: 'complete_update',
        target_type: 'system',
        target_title: '系统更新',
        detail: `用户 ${req.session.user.username} 完成更新到版本 ${version}`,
        ip: req.ip
      });
    } catch (logErr) { /* ignore */ }

    res.json({
      success: true,
      message: '更新安装成功，建议重启服务器',
      backupPath: backupUpdateDir
    });
  } catch (err) {
    console.error('[maintenance] Download update error:', err);
    res.status(500).json({ success: false, error: '更新失败: ' + err.message });
  }
});

// POST - Restart server
router.post('/maintenance/restart', isAuthenticated, isSuperAdmin, (req, res) => {
  try {
    try {
      logActivity(req.db, {
        user_id: req.session.user.id,
        username: req.session.user.username,
        action: 'restart_server',
        target_type: 'system',
        target_title: '系统重启',
        detail: `用户 ${req.session.user.username} 重启了服务器`,
        ip: req.ip
      });
    } catch (logErr) { /* ignore */ }

    res.json({ success: true, message: '服务器将在3秒后重启...' });

    setTimeout(() => {
      if (process.env.PM2_HOME || process.env.pm_id) {
        exec('pm2 restart all', (error) => {
          if (error) {
            const child = spawn('npm', ['run', 'start'], { cwd: projectRoot, detached: true, stdio: 'ignore' });
            child.unref();
            process.exit(0);
          }
        });
      } else {
        const child = spawn('npm', ['run', 'start'], { cwd: projectRoot, detached: true, stdio: 'ignore' });
        child.unref();
        process.exit(0);
      }
    }, 3000);
  } catch (err) {
    res.status(500).json({ success: false, error: '重启失败: ' + err.message });
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

// Async copy directory helper
async function copyDir(src, dest) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }
  const items = fs.readdirSync(src);
  for (const item of items) {
    const srcPath = path.join(src, item);
    const destPath = path.join(dest, item);
    const stat = fs.statSync(srcPath);
    if (stat.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

module.exports = router;
module.exports.initScheduledBackup = initScheduledBackup;
module.exports.checkForUpdates = checkForUpdates;
