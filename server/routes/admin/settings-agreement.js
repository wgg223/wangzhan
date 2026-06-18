const express = require('express');
const router = express.Router();
const { saveDatabase, queryAll, queryOne } = require('../../config/database');
const { logActivity } = require('../../config/activity');

// 协议设置 - 仅管理员可访问

// GET - 协议设置页面
router.get('/', (req, res) => {
  const db = req.db;
  const settings = {};
  const settingRows = queryAll(db, 'SELECT * FROM settings');
  settingRows.forEach(s => {
    settings[s.setting_key] = s.setting_value;
  });

  res.render('admin/settings-agreement', {
    settings,
    user: req.session.user,
    userPermissions: res.locals.userPermissions || []
  });
});

// POST - 保存协议设置
router.post('/', (req, res) => {
  const db = req.db;
  const {
    user_agreement, privacy_policy, delete_account_agreement
  } = req.body;

  const agreementSettings = {
    user_agreement: user_agreement || '',
    privacy_policy: privacy_policy || '',
    delete_account_agreement: delete_account_agreement || ''
  };

  for (const [key, value] of Object.entries(agreementSettings)) {
    const existing = queryOne(db, 'SELECT id FROM settings WHERE setting_key = ?', [key]);
    if (existing) {
      db.run('UPDATE settings SET setting_value = ? WHERE setting_key = ?', [value, key]);
    } else {
      db.run('INSERT INTO settings (setting_key, setting_value) VALUES (, ?)', [key, value]);
    }
  }
  saveDatabase();

  try {
    logActivity(db, {
      user_id: req.session.user.id,
      username: req.session.user.username,
      action: 'update_settings',
      target_type: 'settings',
      target_title: '协议设置',
      detail: `用户 ${req.session.user.username} 更新了用户协议/隐私政策`,
      ip: req.ip
    });
  } catch (logErr) {
    console.error('[settings-agreement] logActivity 错误:', logErr.message);
  }

  if (req.headers['x-requested-with'] === 'XMLHttpRequest') {
    return res.json({ success: true, message: '协议设置已保存' });
  }
  res.redirect('/admin/settings/agreement');
});

module.exports = router;
