const express = require('express');
const router = express.Router();
const { getSettings, upsertSettings } = require('../../utils/settings');
const { safeLogActivity } = require('../../utils/error-handler');

// 协议设置 - 仅管理员可访问

// GET - 协议设置页面
router.get('/', (req, res) => {
  const db = req.db;
  const settings = getSettings(db);

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

  upsertSettings(db, {
    user_agreement: user_agreement || '',
    privacy_policy: privacy_policy || '',
    delete_account_agreement: delete_account_agreement || ''
  });

  safeLogActivity(db, {
    user_id: req.session.user.id,
    username: req.session.user.username,
    action: 'update_settings',
    target_type: 'settings',
    target_title: '协议设置',
    detail: `用户 ${req.session.user.username} 更新了用户协议/隐私政策`,
    ip: req.ip
  });

  if (req.headers['x-requested-with'] === 'XMLHttpRequest') {
    return res.json({ success: true, message: '协议设置已保存' });
  }
  res.redirect('/admin/settings/agreement');
});

module.exports = router;
