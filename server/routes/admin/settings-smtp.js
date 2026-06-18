const express = require('express');
const router = express.Router();
const { saveDatabase, queryAll, queryOne } = require('../../config/database');
const { logActivity } = require('../../config/activity');
const { testSmtpConfig } = require('../../config/mailer');
const { encrypt } = require('../../config/crypto-secure');

// SMTP 配置 - 仅管理员可访问

// GET - SMTP配置页面
router.get('/', (req, res) => {
  const db = req.db;
  const settings = {};
  const settingRows = queryAll(db, 'SELECT * FROM settings');
  settingRows.forEach(s => {
    settings[s.setting_key] = s.setting_value;
  });

  res.render('admin/settings-smtp', {
    settings,
    user: req.session.user,
    userPermissions: res.locals.userPermissions || []
  });
});

// POST - 保存SMTP配置
router.post('/', (req, res) => {
  const db = req.db;
  const {
    smtp_host, smtp_port, smtp_secure, smtp_user,
    smtp_pass, smtp_from_name, smtp_from_email
  } = req.body;

  const smtpSettings = {
    smtp_host: smtp_host || '',
    smtp_port: smtp_port || '465',
    smtp_secure: smtp_secure || 'true',
    smtp_user: smtp_user || '',
    smtp_pass: encrypt(smtp_pass || ''),
    smtp_from_name: smtp_from_name || '',
    smtp_from_email: smtp_from_email || ''
  };

  for (const [key, value] of Object.entries(smtpSettings)) {
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
      target_title: 'SMTP配置',
      detail: `用户 ${req.session.user.username} 更新了SMTP邮件配置`,
      ip: req.ip
    });
  } catch (logErr) {
    console.error('[settings-smtp] logActivity 错误:', logErr.message);
  }

  if (req.headers['x-requested-with'] === 'XMLHttpRequest') {
    return res.json({ success: true, message: 'SMTP配置已保存' });
  }
  res.redirect('/admin/settings/smtp');
});

// POST - 测试SMTP连接
router.post('/test', async (req, res) => {
  const { smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass } = req.body;

  if (!smtp_host || !smtp_user || !smtp_pass) {
    return res.status(400).json({ success: false, error: '请填写完整的SMTP配置信息（服务器地址、用户名、密码）' });
  }

  try {
    const result = await testSmtpConfig({
      host: smtp_host,
      port: parseInt(smtp_port) || 465,
      secure: smtp_secure === 'true' || smtp_port === '465',
      user: smtp_user,
      pass: smtp_pass
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

module.exports = router;
