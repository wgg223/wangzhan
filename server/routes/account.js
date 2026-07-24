const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { isAuthenticated } = require('../middlewares/auth');
const { saveDatabase, queryOne, queryAll } = require('../config/database');
const { getSettings } = require('../utils/settings');

// 头像上传配置
const avatarStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = path.join(__dirname, '../../public/uploads/avatars');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, 'avatar-' + req.session.user.id + '-' + uniqueSuffix + ext);
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
  const { getEnabledProviders, initDefaultProviders, OAUTH_CONFIGS } = require('./oauth');
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

  res.render('frontend/account', {
    user: req.session.user,
    settings,
    userData,
    articles,
    comments,
    oauthBindings,
    providersWithBinding,
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

  if (new_password.length < 6) {
    return res.redirect('/account?error=新密码至少6位');
  }

  if (new_password !== confirm_password) {
    return res.redirect('/account?error=两次输入的密码不一致');
  }

  const user = queryOne(db, 'SELECT password FROM users WHERE id = ?', [userId]);
  if (!user || !bcrypt.compareSync(current_password, user.password)) {
    return res.redirect('/account?error=当前密码错误');
  }

  const hashedPassword = bcrypt.hashSync(new_password, 10);
  db.run('UPDATE users SET password = ? WHERE id = ?', [hashedPassword, userId]);
  saveDatabase();

  res.redirect('/account?success=密码修改成功');
});

// 上传头像
router.post('/account/avatar', isAuthenticated, avatarUpload.single('avatar'), (req, res) => {
  const db = req.db;
  const userId = req.session.user.id;

  if (!req.file) {
    return res.status(400).json({ success: false, error: '请选择要上传的图片' });
  }

  const avatarUrl = '/uploads/avatars/' + req.file.filename;

  // 删除旧头像
  const oldUser = queryOne(db, 'SELECT avatar FROM users WHERE id = ?', [userId]);
  if (oldUser && oldUser.avatar && !oldUser.avatar.includes('default-avatar')) {
    const oldAvatarPath = path.join(__dirname, '../../public', oldUser.avatar);
    if (fs.existsSync(oldAvatarPath)) {
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
