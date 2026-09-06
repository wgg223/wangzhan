/**
 * 协议设置路由（后台）
 * 能力：
 *   GET  /admin/settings/agreement —— 协议设置页（用户协议/隐私政策/注销协议）
 *   POST /admin/settings/agreement —— 保存三项协议内容（AJAX 返回 JSON，普通提交重定向）
 * 安全：upsertSettings 只接受白名单键；操作写审计日志（safeLogActivity 容错）。
 */

const express = require('express');
const router = express.Router();
const { getSettings, upsertSettings } = require('../../utils/settings');
const { safeLogActivity } = require('../../utils/error-handler');

// 协议设置 - 仅管理员可访问（上层路由统一鉴权）

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
  // 从请求体取出三项协议文本（缺失则存空串）
  const {
    user_agreement, privacy_policy, delete_account_agreement
  } = req.body;

  upsertSettings(db, {
    user_agreement: user_agreement || '',
    privacy_policy: privacy_policy || '',
    delete_account_agreement: delete_account_agreement || ''
  });

  // 记录审计日志（失败不打断流程）
  safeLogActivity(db, {
    user_id: req.session.user.id,
    username: req.session.user.username,
    action: 'update_settings',
    target_type: 'settings',
    target_title: '协议设置',
    detail: `用户 ${req.session.user.username} 更新了用户协议/隐私政策`,
    ip: req.ip
  });

  // AJAX 请求返回 JSON，普通表单提交重定向回本页
  if (req.headers['x-requested-with'] === 'XMLHttpRequest') {
    return res.json({ success: true, message: '协议设置已保存' });
  }
  res.redirect('/admin/settings/agreement');
});

module.exports = router;
