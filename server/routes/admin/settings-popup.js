const express = require('express');
const router = express.Router();
const { saveDatabase, queryAll, queryOne } = require('../../config/database');
const { logActivity } = require('../../config/activity');
const { settingsCache } = require('../../config/cache');

// 弹窗设置 - 仅管理员可访问

// GET - 弹窗设置页面
router.get('/', (req, res) => {
  const db = req.db;
  const settings = {};
  const settingRows = queryAll(db, 'SELECT * FROM settings');
  settingRows.forEach(s => {
    settings[s.setting_key] = s.setting_value;
  });

  const success = req.query.success === '1';
  res.render('admin/settings-popup', {
    settings,
    user: req.session.user,
    userPermissions: res.locals.userPermissions || [],
    success
  });
});

// POST - 保存弹窗设置
router.post('/', (req, res) => {
  const db = req.db;

  // 站内信弹窗
  const messagePopupEnabled = req.body.message_popup_enabled === '1' ? '1' : '0';
  const existingMsg = queryOne(db, "SELECT id FROM settings WHERE setting_key = 'message_popup_enabled'");
  if (existingMsg) {
    db.run('UPDATE settings SET setting_value = ? WHERE setting_key = ?', [messagePopupEnabled, 'message_popup_enabled']);
  } else {
    db.run('INSERT INTO settings (setting_key, setting_value) VALUES (, ?)', ['message_popup_enabled', messagePopupEnabled]);
  }

  // 欢迎弹窗
  const welcomePopupEnabled = req.body.welcome_popup_enabled === '1' ? '1' : '0';
  const existingWelcome = queryOne(db, "SELECT id FROM settings WHERE setting_key = 'welcome_popup_enabled'");
  if (existingWelcome) {
    db.run('UPDATE settings SET setting_value = ? WHERE setting_key = ?', [welcomePopupEnabled, 'welcome_popup_enabled']);
  } else {
    db.run('INSERT INTO settings (setting_key, setting_value) VALUES (, ?)', ['welcome_popup_enabled', welcomePopupEnabled]);
  }

  const popupSettings = {
    welcome_popup_title: req.body.welcome_popup_title || '欢迎访问',
    welcome_popup_content: req.body.welcome_popup_content || ''
  };

  for (const [key, value] of Object.entries(popupSettings)) {
    const existing = queryOne(db, 'SELECT id FROM settings WHERE setting_key = ?', [key]);
    if (existing) {
      db.run('UPDATE settings SET setting_value = ? WHERE setting_key = ?', [value, key]);
    } else {
      db.run('INSERT INTO settings (setting_key, setting_value) VALUES (, ?)', [key, value]);
    }
  }

  saveDatabase();

  // 清除设置缓存，确保前端立即看到更新
  settingsCache.delete('settings');

  try {
    logActivity(db, {
      user_id: req.session.user.id,
      username: req.session.user.username,
      action: 'update_settings',
      target_type: 'settings',
      target_title: '弹窗设置',
      detail: `用户 ${req.session.user.username} 更新了弹窗设置`,
      ip: req.ip
    });
  } catch (logErr) {
    console.error('[settings-popup] logActivity 错误:', logErr.message);
  }

  if (req.headers['x-requested-with'] === 'XMLHttpRequest') {
    return res.json({ success: true, message: '弹窗设置已保存' });
  }
  res.redirect('/admin/settings/popup?success=1');
});

module.exports = router;
