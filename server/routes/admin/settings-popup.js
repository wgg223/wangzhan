const express = require('express');
const router = express.Router();
const { getSettings, upsertSettings } = require('../../utils/settings');
const { safeLogActivity } = require('../../utils/error-handler');

// 弹窗设置 - 仅管理员可访问

// GET - 弹窗设置页面
router.get('/', (req, res) => {
  const db = req.db;
  const settings = getSettings(db);

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

  // 站内信弹窗和欢迎弹窗需要特殊处理布尔值
  const messagePopupEnabled = req.body.message_popup_enabled === '1' ? '1' : '0';
  const welcomePopupEnabled = req.body.welcome_popup_enabled === '1' ? '1' : '0';

  upsertSettings(db, {
    message_popup_enabled: messagePopupEnabled,
    welcome_popup_enabled: welcomePopupEnabled,
    welcome_popup_title: req.body.welcome_popup_title || '欢迎访问',
    welcome_popup_content: req.body.welcome_popup_content || ''
  });

  safeLogActivity(db, {
    user_id: req.session.user.id,
    username: req.session.user.username,
    action: 'update_settings',
    target_type: 'settings',
    target_title: '弹窗设置',
    detail: `用户 ${req.session.user.username} 更新了弹窗设置`,
    ip: req.ip
  });

  if (req.headers['x-requested-with'] === 'XMLHttpRequest') {
    return res.json({ success: true, message: '弹窗设置已保存' });
  }
  res.redirect('/admin/settings/popup?success=1');
});

module.exports = router;
