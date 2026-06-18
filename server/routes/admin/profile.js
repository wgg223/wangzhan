const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { isAuthenticated, canAccessAdmin } = require('../../middlewares/auth');
const { saveDatabase, queryOne } = require('../../config/database');
const logger = require('../../utils/logger');

// 头像上传配置
const avatarStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = path.join(__dirname, '../../../public/uploads/avatars');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'avatar-' + req.session.user.id + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const avatarUpload = multer({
  storage: avatarStorage,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
  fileFilter: function (req, file, cb) {
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('只支持 JPG、PNG、GIF、WebP 格式的图片'));
    }
  }
});

// ============ 账户设置 ============

router.get('/profile', isAuthenticated, canAccessAdmin, (req, res) => {
  const db = req.db;
  const userData = queryOne(db, 'SELECT id, username, email, role, status, created_at FROM users WHERE id = ?', [req.session.user.id]);

  res.render('admin/profile', {
    user: req.session.user,
    settings: res.locals.settings || {},
    userData: userData,
    success: req.query.success === '1',
    error: req.query.error || null
  });
});

router.post('/profile/update', isAuthenticated, (req, res) => {
  const db = req.db;
  const { username, email } = req.body;
  const userId = req.session.user.id;

  logger.debug('[profile/update] 开始更新用户资料', { userId, newUsername: username, newEmail: email, currentUsername: req.session.user.username });

  if (!username || username.length < 3) {
    logger.warn('[profile/update] 用户名太短', { username });
    return res.redirect('/admin/profile?error=用户名至少3个字符');
  }

  const existingUser = queryOne(db, 'SELECT id FROM users WHERE username = ? AND id != ?', [username, userId]);
  if (existingUser) {
    logger.warn('[profile/update] 用户名已被使用', { username, existingUserId: existingUser.id });
    return res.redirect('/admin/profile?error=用户名已被使用');
  }

  db.run('UPDATE users SET username = ?, email = ? WHERE id = ?', [username, email || '', userId]);
  saveDatabase();
  logger.debug('[profile/update] 数据库更新完成', { userId, newUsername: username, newEmail: email || '' });

  req.session.user.username = username;
  req.session.user.email = email || '';

  req.session.save(function(err) {
    if (err) {
      logger.error('[profile/update] 会话保存失败', err);
      return res.redirect('/admin/profile?error=会话更新失败，请重新登录');
    }
    logger.debug('[profile/update] 用户资料更新成功，会话已保存', { username, email });
    res.redirect('/admin/profile?success=1');
  });
});

router.post('/profile/password', isAuthenticated, (req, res) => {
  const db = req.db;
  const { current_password, new_password, confirm_password } = req.body;
  const userId = req.session.user.id;

  if (!current_password || !new_password || !confirm_password) {
    return res.redirect('/admin/profile?error=请填写所有密码字段');
  }

  if (new_password.length < 6) {
    return res.redirect('/admin/profile?error=新密码至少6位');
  }

  if (new_password !== confirm_password) {
    return res.redirect('/admin/profile?error=两次密码不一致');
  }

  const user = queryOne(db, 'SELECT password FROM users WHERE id = ?', [userId]);
  if (!user || !bcrypt.compareSync(current_password, user.password)) {
    return res.redirect('/admin/profile?error=当前密码错误');
  }

  const hashedPassword = bcrypt.hashSync(new_password, 10);
  db.run('UPDATE users SET password = ? WHERE id = ?', [hashedPassword, userId]);
  saveDatabase();

  res.redirect('/admin/profile?success=1');
});

// 头像上传
router.post('/profile/avatar', isAuthenticated, avatarUpload.single('avatar'), (req, res) => {
  const db = req.db;
  const userId = req.session.user.id;

  if (!req.file) {
    return res.status(400).json({ success: false, error: '请选择要上传的图片' });
  }

  const avatarUrl = '/uploads/avatars/' + req.file.filename;

  // 删除旧头像（如果不是默认头像）
  const oldUser = queryOne(db, 'SELECT avatar FROM users WHERE id = ?', [userId]);
  if (oldUser && oldUser.avatar && !oldUser.avatar.includes('default-avatar')) {
    const oldAvatarPath = path.join(__dirname, '../../../public', oldUser.avatar);
    if (fs.existsSync(oldAvatarPath)) {
      try { fs.unlinkSync(oldAvatarPath); } catch (e) { /* 忽略 */ }
    }
  }

  db.run('UPDATE users SET avatar = ? WHERE id = ?', [avatarUrl, userId]);
  saveDatabase();

  // 更新 session
  req.session.user.avatar = avatarUrl;
  req.session.save(function(err) {
    if (err) {
      logger.error('[profile/avatar] 会话保存失败', err);
      return res.status(500).json({ success: false, error: '上传失败' });
    }
    res.json({ success: true, avatar: avatarUrl });
  });
});

// 更新个人简介
router.post('/profile/bio', isAuthenticated, (req, res) => {
  const db = req.db;
  const userId = req.session.user.id;
  const { bio } = req.body;

  if (bio && bio.length > 200) {
    return res.status(400).json({ success: false, error: '简介不能超过200字' });
  }

  db.run('UPDATE users SET bio = ? WHERE id = ?', [bio || '', userId]);
  saveDatabase();

  res.json({ success: true });
});

module.exports = router;
