const express = require('express');
const router = express.Router();
const { isAuthenticated, isSuperAdmin } = require('../../middlewares/auth');
const { saveDatabase, queryAll, queryOne, getDb } = require('../../config/database');
const { logActivity } = require('../../config/activity');
const { settingsCache } = require('../../config/cache');

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

module.exports = router;
