/**
 * 基础设置路由（后台）
 * 能力：
 *   GET  /admin/settings/basic —— 基础设置页
 *   POST /admin/settings/basic —— 保存站点名称/描述/关键词/URL/Logo/备案号/页脚HTML/
 *                                 站点开关/注册开关/默认角色/评论与文章审核/验证码/
 *                                 语言时区/每页条数/主题 等 20+ 项设置
 * 安全：upsertSettings 只写白名单键；操作写审计日志；AJAX 与表单双响应支持。
 */

const express = require('express');
const router = express.Router();
const { getSettings, upsertSettings } = require('../../utils/settings');
const { safeLogActivity } = require('../../utils/error-handler');

// 基础设置 - 仅管理员可访问（上层路由统一鉴权）

// GET - 基础设置页面
router.get('/', (req, res) => {
  const db = req.db;
  const settings = getSettings(db);

  res.render('admin/settings-basic', {
    settings,
    user: req.session.user,
    userPermissions: res.locals.userPermissions || []
  });
});

// POST - 保存基础设置（逐项透传到 upsertSettings，缺失字段保留原值）
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

  upsertSettings(db, {
    site_name, site_description, site_keywords, site_url,
    site_logo, site_favicon, icp_beian, police_beian,
    footer_html, site_status, close_reason, allow_register,
    default_user_role, comment_audit, article_audit,
    comment_captcha_enabled, site_language, timezone,
    date_format, posts_per_page, theme
  });

  safeLogActivity(db, {
    user_id: req.session.user.id,
    username: req.session.user.username,
    action: 'update_settings',
    target_type: 'settings',
    target_title: '基础设置',
    detail: `用户 ${req.session.user.username} 更新了基础设置`,
    ip: req.ip
  });

  if (req.headers['x-requested-with'] === 'XMLHttpRequest') {
    return res.json({ success: true, message: '基础设置已保存' });
  }
  res.redirect('/admin/settings/basic');
});

module.exports = router;
