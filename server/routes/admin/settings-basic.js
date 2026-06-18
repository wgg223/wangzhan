const express = require('express');
const router = express.Router();
const { saveDatabase, queryOne, queryAll } = require('../../config/database');
const { logActivity } = require('../../config/activity');
const { settingsCache } = require('../../config/cache');

// 基础设置 - 仅管理员可访问

// GET - 基础设置页面
router.get('/', (req, res) => {
  const db = req.db;
  const settings = {};
  const settingRows = queryAll(db, 'SELECT * FROM settings');
  settingRows.forEach(s => {
    settings[s.setting_key] = s.setting_value;
  });

  res.render('admin/settings-basic', {
    settings,
    user: req.session.user,
    userPermissions: res.locals.userPermissions || []
  });
});

// POST - 保存基础设置
router.post('/', (req, res) => {
  const db = req.db;
  const {
    site_name, site_description, site_keywords, site_url,
    site_logo, site_favicon, icp_beian, police_beian,
    footer_html, site_status, close_reason, allow_register,
    default_user_role, comment_audit, article_audit,
    comment_captcha_enabled, site_language, timezone,
    date_format, posts_per_page, theme
  } = req.body;

  const settingsMap = {
    site_name, site_description, site_keywords, site_url,
    site_logo, site_favicon, icp_beian, police_beian,
    footer_html, site_status, close_reason, allow_register,
    default_user_role, comment_audit, article_audit,
    comment_captcha_enabled, site_language, timezone,
    date_format, posts_per_page, theme
  };

  for (const [key, value] of Object.entries(settingsMap)) {
    if (value !== undefined) {
      const existing = queryOne(db, 'SELECT id FROM settings WHERE setting_key = ?', [key]);
      if (existing) {
        db.run('UPDATE settings SET setting_value = ? WHERE setting_key = ?', [value, key]);
      } else {
        db.run('INSERT INTO settings (setting_key, setting_value) VALUES (?, ?)', [key, value]);
      }
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
      target_title: '基础设置',
      detail: `用户 ${req.session.user.username} 更新了基础设置`,
      ip: req.ip
    });
  } catch (logErr) {
    console.error('[settings-basic] logActivity 错误:', logErr.message);
  }

  if (req.headers['x-requested-with'] === 'XMLHttpRequest') {
    return res.json({ success: true, message: '基础设置已保存' });
  }
  res.redirect('/admin/settings/basic');
});

module.exports = router;
