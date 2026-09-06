/**
 * SMTP 邮件配置路由（后台）
 * 能力：
 *   GET  /admin/settings/smtp      —— SMTP 配置页（密码密文不回显）
 *   POST /admin/settings/smtp      —— 保存配置（smtp_pass 用 AES 加密后入库，空密码保留原密文）
 *   POST /admin/settings/smtp/test —— 用表单参数实测 SMTP 连接/发信（不保存）
 * 安全：密码经 crypto-secure 加密存储，数据库泄露也不会直接暴露明文；
 *       测试接口只校验必填项并捕获异常返回。
 */

const express = require('express');
const router = express.Router();
const { testSmtpConfig } = require('../../config/mailer');
const { encrypt } = require('../../config/crypto-secure');
const { getSettings, upsertSettings } = require('../../utils/settings');
const { safeLogActivity } = require('../../utils/error-handler');

// SMTP 配置 - 仅管理员可访问（上层路由统一鉴权）

// GET - SMTP配置页面
router.get('/', (req, res) => {
  const db = req.db;
  const settings = getSettings(db);

  res.render('admin/settings-smtp', {
    settings,
    user: req.session.user,
    userPermissions: res.locals.userPermissions || []
  });
});

// POST - 保存SMTP配置（密码仅在用户重新填写时才加密覆盖，否则保留原密文）
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
    smtp_from_name: smtp_from_name || '',
    smtp_from_email: smtp_from_email || ''
  };
  if (smtp_pass) {
    smtpSettings.smtp_pass = encrypt(smtp_pass);   // AES 加密存储
  }

  upsertSettings(db, smtpSettings);

  safeLogActivity(db, {
    user_id: req.session.user.id,
    username: req.session.user.username,
    action: 'update_settings',
    target_type: 'settings',
    target_title: 'SMTP配置',
    detail: `用户 ${req.session.user.username} 更新了SMTP邮件配置`,
    ip: req.ip
  });

  if (req.headers['x-requested-with'] === 'XMLHttpRequest') {
    return res.json({ success: true, message: 'SMTP配置已保存' });
  }
  res.redirect('/admin/settings/smtp');
});

// POST - 测试SMTP连接（用当前表单填写的参数实际发一封测试邮件，不落库）
router.post('/test', async (req, res) => {
  const { smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass } = req.body;

  // 必填项校验
  if (!smtp_host || !smtp_user || !smtp_pass) {
    return res.status(400).json({ success: false, error: '请填写完整的SMTP配置信息（服务器地址、用户名、密码）' });
  }

  try {
    const result = await testSmtpConfig({
      host: smtp_host,
      port: parseInt(smtp_port) || 465,
      secure: smtp_secure === 'true' || smtp_port === '465',   // 465 端口默认按 SSL 处理
      user: smtp_user,
      pass: smtp_pass
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

module.exports = router;
