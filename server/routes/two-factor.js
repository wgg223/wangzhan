/**
 * 双因素认证 (2FA/TOTP) 路由
 * 从 auth.js 拆分而来，负责 2FA 的状态查询、密钥生成、验证启用与关闭。
 * 接口路由：
 *   GET  /2fa/status   — 获取当前用户 2FA 启用状态
 *   POST /2fa/setup    — 生成 TOTP 密钥（开启第一步）
 *   POST /2fa/verify   — 验证 TOTP 令牌并正式启用 2FA
 *   POST /2fa/disable  — 校验 TOTP 令牌后关闭 2FA
 */
const express = require('express');
const router = express.Router();
const { generateSecret, generateTOTPUri, verifyTOTP } = require('../services/two-factor-auth');
const { saveDatabase, queryOne } = require('../config/database');
const { logActivity } = require('../config/activity');

// 获取 2FA 状态
router.get('/2fa/status', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: '未登录' });
  }
  const db = req.db;
  const user = queryOne(db, 'SELECT totp_secret, totp_enabled FROM users WHERE id = ?', [req.session.user.id]);
  res.json({
    enabled: user ? Boolean(user.totp_enabled) : false,
    hasSecret: user ? Boolean(user.totp_secret) : false
  });
});

// 生成 2FA 密钥 (开启第一步)
router.post('/2fa/setup', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: '未登录' });
  }
  const db = req.db;
  const secret = generateSecret();
  const uri = generateTOTPUri(secret, req.session.user.username, res.locals.settings?.site_name || 'MyWebsite');

  // 临时保存密钥，待验证后正式启用
  req.session.pendingTotpSecret = secret;

  res.json({
    secret: secret,
    uri: uri,
    qrcode: uri // 前端可用此生成二维码
  });
});

// 验证并启用 2FA
router.post('/2fa/verify', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: '未登录' });
  }
  const { token } = req.body;
  const secret = req.session.pendingTotpSecret;

  if (!token) {
    return res.status(400).json({ error: '请输入验证码' });
  }
  if (!secret) {
    return res.status(400).json({ error: '请先获取密钥' });
  }

  if (!verifyTOTP(token, secret)) {
    return res.status(400).json({ error: '验证码无效，请重试' });
  }

  const db = req.db;
  db.run('UPDATE users SET totp_secret = ?, totp_enabled = 1 WHERE id = ?', [secret, req.session.user.id]);
  saveDatabase();

  delete req.session.pendingTotpSecret;

  logActivity(db, {
    user_id: req.session.user.id,
    username: req.session.user.username,
    action: 'enable_2fa',
    target_type: 'auth',
    detail: '用户启用了双因素认证',
    ip: req.ip
  });

  res.json({ success: true, message: '双因素认证已启用' });
});

// 关闭 2FA
router.post('/2fa/disable', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: '未登录' });
  }
  const { token } = req.body;
  const db = req.db;
  const user = queryOne(db, 'SELECT totp_secret FROM users WHERE id = ?', [req.session.user.id]);

  if (!user || !user.totp_secret) {
    return res.status(400).json({ error: '双因素认证未启用' });
  }

  if (!token || !verifyTOTP(token, user.totp_secret)) {
    return res.status(400).json({ error: '验证码无效' });
  }

  db.run('UPDATE users SET totp_secret = NULL, totp_enabled = 0 WHERE id = ?', [req.session.user.id]);
  saveDatabase();

  logActivity(db, {
    user_id: req.session.user.id,
    username: req.session.user.username,
    action: 'disable_2fa',
    target_type: 'auth',
    detail: '用户关闭了双因素认证',
    ip: req.ip
  });

  res.json({ success: true, message: '双因素认证已关闭' });
});

module.exports = router;
