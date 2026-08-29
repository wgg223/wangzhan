const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { isAuthenticated } = require('../middlewares/auth');
const { saveDatabase, queryOne, queryAll } = require('../config/database');
const { getSettings } = require('../utils/settings');
const { sendMail } = require('../config/mailer');
const { logActivity } = require('../config/activity');
const { createRateLimiter } = require('../middlewares/rate-limiter');

const emailCodeLimiter = createRateLimiter({
  windowMs: 5 * 60 * 1000,
  max: 3,
  message: '验证码发送过于频繁，请5分钟后再试'
});

const ALLOWED_AVATAR_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
const AVATAR_DIR = path.join(__dirname, '../../public/uploads/avatars');

// 头像上传配置
const avatarStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    if (!fs.existsSync(AVATAR_DIR)) {
      fs.mkdirSync(AVATAR_DIR, { recursive: true });
    }
    cb(null, AVATAR_DIR);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname).toLowerCase();
    const safeExt = ALLOWED_AVATAR_EXTS.includes(ext) ? ext : '.jpg';
    cb(null, 'avatar-' + req.session.user.id + '-' + uniqueSuffix + safeExt);
  }
});

const avatarUpload = multer({
  storage: avatarStorage,
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: function (req, file, cb) {
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('只支持 JPG、PNG、GIF、WebP 格式的图片'));
    }
  }
});

// 个人账号管理主页
router.get('/account', isAuthenticated, (req, res) => {
  const db = req.db;
  const userId = req.session.user.id;
  const settings = getSettings(db);

  // 获取用户完整信息
  const userData = queryOne(db, 'SELECT * FROM users WHERE id = ?', [userId]);

  // 获取用户文章
  const articles = queryAll(db,
    'SELECT id, title, created_at, status FROM articles WHERE author_id = ? ORDER BY created_at DESC LIMIT 20',
    [userId]);

  // 获取用户评论
  const comments = queryAll(db,
    `SELECT c.id, c.content, c.created_at, c.status, a.title as article_title, a.id as article_id
     FROM comments c
     LEFT JOIN articles a ON c.article_id = a.id
     WHERE c.user_id = ?
     ORDER BY c.created_at DESC LIMIT 20`,
    [userId]);

  // 获取第三方登录绑定
  const oauthBindings = queryAll(db,
    'SELECT * FROM user_oauth_bindings WHERE user_id = ?',
    [userId]);

  // 获取可用的第三方登录提供商
  const { getEnabledProviders, initDefaultProviders } = require('./oauth');
  try { initDefaultProviders(db); } catch (e) { /* 忽略 */ }
  const enabledProviders = getEnabledProviders(db);

  // 合并绑定信息和可用提供商
  const providersWithBinding = enabledProviders.map(p => {
    const binding = oauthBindings.find(b => b.provider === p.provider);
    return {
      ...p,
      bound: Boolean(binding),
      binding: binding || null
    };
  });

  // AI 生图服务商与用户自填 Key 状态
  const { getUserProviderKeys } = require('../services/image-gen');
  const aiImageProviders = queryAll(db,
    'SELECT provider_key, name FROM ai_image_providers ORDER BY sort_order ASC, id ASC');
  const aiUserKeys = getUserProviderKeys(db, userId);

  // 生成/复用 CSRF 令牌（供解绑等 JSON POST 使用），layout 的 meta 标签自动读取
  if (!req.session.doubleSubmitToken) {
    req.session.doubleSubmitToken = crypto.randomBytes(32).toString('hex');
  }
  res.locals.csrfToken = req.session.doubleSubmitToken;

  res.render('frontend/account', {
    user: req.session.user,
    settings,
    userData,
    articles,
    comments,
    oauthBindings,
    providersWithBinding,
    aiImageProviders,
    aiUserKeys,
    success: req.query.success,
    error: req.query.error
  });
});

// 更新个人信息
router.post('/account/profile', isAuthenticated, (req, res) => {
  const db = req.db;
  const userId = req.session.user.id;
  const { nickname, bio } = req.body;

  if (nickname && nickname.length > 30) {
    return res.redirect('/account?error=昵称不能超过30个字符');
  }

  if (bio && bio.length > 200) {
    return res.redirect('/account?error=个人简介不能超过200个字符');
  }

  db.run('UPDATE users SET nickname = ?, bio = ? WHERE id = ?', [nickname || '', bio || '', userId]);
  saveDatabase();

  // 更新session
  req.session.user.nickname = nickname || req.session.user.username;
  req.session.save(function() {
    res.redirect('/account?success=个人信息已更新');
  });
});

// 修改密码
router.post('/account/password', isAuthenticated, (req, res) => {
  const db = req.db;
  const userId = req.session.user.id;
  const { current_password, new_password, confirm_password } = req.body;

  if (!current_password || !new_password || !confirm_password) {
    return res.redirect('/account?error=请填写所有密码字段');
  }

  if (new_password.length < 8) {
    return res.redirect('/account?error=新密码至少8位');
  }

  if (new_password !== confirm_password) {
    return res.redirect('/account?error=两次输入的密码不一致');
  }

  const user = queryOne(db, 'SELECT password FROM users WHERE id = ?', [userId]);
  if (!user || !bcrypt.compareSync(current_password, user.password)) {
    return res.redirect('/account?error=当前密码错误');
  }

  const hashedPassword = bcrypt.hashSync(new_password, 10);
  db.run('UPDATE users SET password = ?, token_version = token_version + 1 WHERE id = ?', [hashedPassword, userId]);
  saveDatabase();

  res.redirect('/account?success=密码修改成功');
});

// 修改用户名
router.post('/account/username', isAuthenticated, (req, res) => {
  const db = req.db;
  const userId = req.session.user.id;
  const { new_username, password } = req.body;

  if (!new_username || !password) {
    return res.redirect('/account?error=请填写所有字段#profile');
  }

  if (new_username.length < 3 || new_username.length > 20) {
    return res.redirect('/account?error=用户名长度应在3-20个字符之间#profile');
  }

  if (!/^[\u4e00-\u9fa5a-zA-Z0-9_]+$/.test(new_username)) {
    return res.redirect('/account?error=用户名只能包含中文、字母、数字和下划线#profile');
  }

  const user = queryOne(db, 'SELECT * FROM users WHERE id = ?', [userId]);
  if (!user) {
    return res.redirect('/account?error=用户不存在#profile');
  }

  if (!bcrypt.compareSync(password, user.password)) {
    return res.redirect('/account?error=密码错误#profile');
  }

  // 检查用户名是否已存在（排除自己）
  const existing = queryOne(db, 'SELECT id FROM users WHERE username = ? AND id != ?', [new_username, userId]);
  if (existing) {
    return res.redirect('/account?error=该用户名已被使用#profile');
  }

  db.run('UPDATE users SET username = ? WHERE id = ?', [new_username, userId]);
  saveDatabase();

  // 更新session
  req.session.user.username = new_username;
  req.session.save(function() {
    try {
      logActivity(db, {
        user_id: userId,
        username: new_username,
        action: 'update',
        target_type: 'user',
        target_id: userId,
        target_title: '修改用户名',
        detail: `用户 ${user.username} 修改用户名为 ${new_username}`,
        ip: req.ip
      });
    } catch (e) { /* 忽略 */ }
    res.redirect('/account?success=用户名已更新#profile');
  });
});

// 发送邮箱验证码
router.post('/account/email/send-code', isAuthenticated, emailCodeLimiter, async (req, res) => {
  const db = req.db;
  const userId = req.session.user.id;
  const { new_email } = req.body;

  if (!new_email) {
    return res.json({ success: false, error: '请输入邮箱地址' });
  }

  // 简单邮箱格式验证
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(new_email)) {
    return res.json({ success: false, error: '邮箱格式不正确' });
  }

  // 检查邮箱是否已被其他用户使用
  const existing = queryOne(db, 'SELECT id FROM users WHERE email = ? AND id != ?', [new_email, userId]);
  if (existing) {
    return res.json({ success: false, error: '该邮箱已被其他账号使用' });
  }

  // 生成6位验证码
  const code = crypto.randomBytes(3).toString('hex').toUpperCase();
  const expires = Date.now() + 10 * 60 * 1000; // 10分钟有效

  // 存储到session
  req.session.emailChange = {
    email: new_email,
    code: code,
    expires: expires
  };

  try {
    await sendMail(db, {
      to: new_email,
      subject: '邮箱验证码',
      html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:20px;">
        <h2 style="color:#333;">邮箱验证码</h2>
        <p>您正在修改账号绑定邮箱，验证码为：</p>
        <div style="background:#f5f5f5;padding:16px;border-radius:8px;text-align:center;margin:20px 0;">
          <span style="font-size:28px;font-weight:bold;letter-spacing:4px;color:#4f46e5;">${code}</span>
        </div>
        <p style="color:#666;font-size:13px;">验证码 10 分钟内有效。如果不是您本人操作，请忽略此邮件。</p>
      </div>`
    });
    res.json({ success: true, message: '验证码已发送到 ' + new_email });
  } catch (err) {
    res.json({ success: false, error: '邮件发送失败，请检查SMTP配置或稍后重试' });
  }
});

// 验证邮箱验证码并更新邮箱
router.post('/account/email/verify', isAuthenticated, (req, res) => {
  const db = req.db;
  const userId = req.session.user.id;
  const { code } = req.body;

  if (!code) {
    return res.json({ success: false, error: '请输入验证码' });
  }

  const emailChange = req.session.emailChange;
  if (!emailChange) {
    return res.json({ success: false, error: '请先发送验证码' });
  }

  if (Date.now() > emailChange.expires) {
    delete req.session.emailChange;
    return res.json({ success: false, error: '验证码已过期，请重新发送' });
  }

  if (code.toUpperCase() !== emailChange.code) {
    return res.json({ success: false, error: '验证码错误' });
  }

  // 验证通过，更新邮箱
  db.run('UPDATE users SET email = ? WHERE id = ?', [emailChange.email, userId]);
  saveDatabase();

  // 更新session
  req.session.user.email = emailChange.email;
  delete req.session.emailChange;
  req.session.save(function() {
    try {
      logActivity(db, {
        user_id: userId,
        username: req.session.user.username,
        action: 'update',
        target_type: 'user',
        target_id: userId,
        target_title: '修改邮箱',
        detail: `用户修改绑定邮箱为 ${emailChange.email}`,
        ip: req.ip
      });
    } catch (e) { /* 忽略 */ }
    res.json({ success: true, message: '邮箱已更新', email: emailChange.email });
  });
});

// 上传头像
router.post('/account/avatar', isAuthenticated, avatarUpload.single('avatar'), (req, res) => {
  const db = req.db;
  const userId = req.session.user.id;

  if (!req.file) {
    return res.status(400).json({ success: false, error: '请选择要上传的图片' });
  }

  const avatarUrl = '/uploads/avatars/' + req.file.filename;

  // 删除旧头像（校验路径必须在 uploads/avatars 目录内）
  const oldUser = queryOne(db, 'SELECT avatar FROM users WHERE id = ?', [userId]);
  if (oldUser && oldUser.avatar && !oldUser.avatar.includes('default-avatar')) {
    const oldAvatarPath = path.resolve(path.join(__dirname, '../../public', oldUser.avatar));
    const avatarDirResolved = path.resolve(AVATAR_DIR);
    if (oldAvatarPath.startsWith(avatarDirResolved) && fs.existsSync(oldAvatarPath)) {
      try { fs.unlinkSync(oldAvatarPath); } catch (e) { /* 忽略 */ }
    }
  }

  db.run('UPDATE users SET avatar = ? WHERE id = ?', [avatarUrl, userId]);
  saveDatabase();

  req.session.user.avatar = avatarUrl;
  req.session.save(function() {
    res.json({ success: true, avatar: avatarUrl });
  });
});

// 解除第三方绑定
router.post('/account/unbind/:provider', isAuthenticated, (req, res) => {
  // CSRF 校验（双提交 Cookie 模式）：请求头必须与会话令牌一致
  const submittedToken = req.headers['x-csrf-token'];
  if (!submittedToken || submittedToken !== req.session.doubleSubmitToken) {
    return res.status(403).json({ success: false, error: '安全验证失败，请刷新页面后重试' });
  }

  const db = req.db;
  const userId = req.session.user.id;
  const { provider } = req.params;

  // 检查是否有密码
  const user = queryOne(db, 'SELECT password FROM users WHERE id = ?', [userId]);
  const bindings = queryAll(db, 'SELECT * FROM user_oauth_bindings WHERE user_id = ?', [userId]);

  // 如果没有密码且只有一个绑定，不允许解绑
  const hasPassword = user.password && user.password.length > 6;
  if (!hasPassword && bindings.length <= 1) {
    return res.json({ success: false, error: '请先设置密码，否则解绑后将无法登录' });
  }

  db.run('DELETE FROM user_oauth_bindings WHERE user_id = ? AND provider = ?', [userId, provider]);
  saveDatabase();

  res.json({ success: true });
});

// 删除文章
router.post('/account/article/:id/delete', isAuthenticated, (req, res) => {
  const db = req.db;
  const userId = req.session.user.id;
  const articleId = req.params.id;

  // 验证文章属于当前用户
  const article = queryOne(db, 'SELECT * FROM articles WHERE id = ? AND author_id = ?', [articleId, userId]);
  if (!article) {
    return res.redirect('/account?error=文章不存在或无权删除');
  }

  db.run('DELETE FROM articles WHERE id = ?', [articleId]);
  saveDatabase();

  res.redirect('/account?success=文章已删除');
});

// 删除评论
router.post('/account/comment/:id/delete', isAuthenticated, (req, res) => {
  const db = req.db;
  const userId = req.session.user.id;
  const commentId = req.params.id;

  // 验证评论属于当前用户
  const comment = queryOne(db, 'SELECT * FROM comments WHERE id = ? AND user_id = ?', [commentId, userId]);
  if (!comment) {
    return res.redirect('/account?error=评论不存在或无权删除');
  }

  db.run('DELETE FROM comments WHERE id = ?', [commentId]);
  saveDatabase();

  res.redirect('/account?success=评论已删除');
});

module.exports = router;
