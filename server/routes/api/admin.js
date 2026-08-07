const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { queryOne, queryAll, getDb, saveDatabase, getDbPath, generateUid } = require('../../config/database');
const { apiAuth, apiRequireAdmin } = require('../../middlewares/api-auth');
const { ROLE_WHITELIST, canOperateUser, ensureAtLeastOneActiveSuperAdmin } = require('../../middlewares/auth');
const { grantDefaultPermissions } = require('../../config/db-helpers');
const { logActivity } = require('../../config/activity');

const router = express.Router();
router.use(apiAuth, apiRequireAdmin);

const projectRoot = path.join(__dirname, '../../..');

function toInt(v, def = 0) {
  const n = parseInt(v);
  return isNaN(n) ? def : n;
}

// ============ 仪表盘 ============
router.get('/dashboard', (req, res) => {
  const db = getDb();
  const count = (sql, params = []) => queryOne(db, sql, params)?.count || 0;

  const imageCommentPending = count("SELECT COUNT(*) AS count FROM image_comments WHERE status = 'pending'");
  const commentPending = count("SELECT COUNT(*) AS count FROM comments WHERE status = 'pending'");
  const mediaCommentPending = count("SELECT COUNT(*) AS count FROM media_comments WHERE status = 'pending'");

  res.json({
    user_count: count('SELECT COUNT(*) AS count FROM users'),
    article_count: count("SELECT COUNT(*) AS count FROM articles WHERE status = 'published'"),
    image_count: count('SELECT COUNT(*) AS count FROM images'),
    novel_count: count('SELECT COUNT(*) AS count FROM novels'),
    comment_count: count("SELECT COUNT(*) AS count FROM comments WHERE status = 'approved'"),
    pending_images: count('SELECT COUNT(*) AS count FROM images WHERE status = 0'),
    pending_comments: commentPending + imageCommentPending + mediaCommentPending,
    today_visits: count("SELECT COUNT(*) AS count FROM activity_logs WHERE created_at >= date('now')"),
    uptime: (process.uptime() / 3600).toFixed(1) + ' 小时',
    db_size: formatSize(fs.existsSync(getDbPath()) ? fs.statSync(getDbPath()).size : 0),
  });
});

function formatSize(bytes) {
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return bytes + ' B';
}

// ============ 用户管理 ============
router.get('/users', (req, res) => {
  const db = getDb();
  const page = Math.max(1, toInt(req.query.page, 1));
  const limit = Math.min(100, Math.max(1, toInt(req.query.limit, 10)));
  const offset = (page - 1) * limit;
  const q = (req.query.q || '').trim();
  const role = (req.query.role || '').trim();

  let where = 'WHERE 1=1';
  const params = [];
  if (q) {
    where += ' AND (username LIKE ? OR nickname LIKE ?)';
    params.push(`%${q}%`, `%${q}%`);
  }
  if (role) {
    where += ' AND role = ?';
    params.push(role);
  }

  const total = queryOne(db, `SELECT COUNT(*) AS count FROM users ${where}`, params)?.count || 0;
  const rows = queryAll(db, `
    SELECT id, uid, username, nickname, avatar, role, status, email, bio, created_at,
      (SELECT COUNT(*) FROM user_follows f WHERE f.following_id = users.id) AS follower_count,
      (SELECT COUNT(*) FROM user_follows f WHERE f.follower_id = users.id) AS following_count,
      (SELECT COUNT(*) FROM articles a WHERE a.author_id = users.id AND a.status = 'published') AS article_count
    FROM users ${where}
    ORDER BY id ASC LIMIT ? OFFSET ?
  `, [...params, limit, offset]);

  res.json({ users: rows || [], total, page });
});

router.put('/users/:id', (req, res) => {
  const db = getDb();
  const id = toInt(req.params.id);
  const user = queryOne(db, 'SELECT * FROM users WHERE id = ?', [id]);
  if (!user) return res.status(404).json({ error: '用户不存在' });

  // 统一操作校验：不能操作自己、非超管不能动超管、同级/高级不可动
  const check = canOperateUser(req.apiUser, user);
  if (!check.ok) {
    return res.status(403).json({ error: check.reason });
  }

  const role = (req.body.role || '').trim();
  const status = (req.body.status || '').trim();
  // 角色修改仅限超级管理员，防止 admin 自我提权为 super_admin
  if (role) {
    if (req.apiUser.role !== 'super_admin') {
      return res.status(403).json({ error: '仅超级管理员可修改用户角色' });
    }
    if (!ROLE_WHITELIST.includes(role)) {
      return res.status(400).json({ error: '非法的角色值' });
    }
    // 降级超管前防管理端锁死
    if (user.role === 'super_admin' && role !== 'super_admin' &&
        !ensureAtLeastOneActiveSuperAdmin(db, user.id)) {
      return res.status(400).json({ error: '不能降级最后一个超级管理员' });
    }
    db.run('UPDATE users SET role = ? WHERE id = ?', [role, id]);
  }
  if (status) {
    if (!['active', 'disabled', 'pending'].includes(status)) {
      return res.status(400).json({ error: '非法的状态值' });
    }
    // 禁用超管前防管理端锁死
    if (status !== 'active' && user.role === 'super_admin' &&
        !ensureAtLeastOneActiveSuperAdmin(db, user.id)) {
      return res.status(400).json({ error: '不能禁用最后一个超级管理员' });
    }
    db.run('UPDATE users SET status = ? WHERE id = ?', [status, id]);
  }
  saveDatabase();
  res.json({ success: true });
});

// 创建用户（仅超级管理员，逻辑对齐 Web 版 /admin/users/create）
router.post('/users', (req, res) => {
  if (req.apiUser.role !== 'super_admin') {
    return res.status(403).json({ error: '仅超级管理员可创建用户' });
  }

  const db = getDb();
  const { username, email, password, role } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ error: '用户名和密码不能为空' });
  }
  if (username.length < 3) {
    return res.status(400).json({ error: '用户名至少3个字符' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: '密码至少8位' });
  }

  const existingUser = queryOne(db, 'SELECT id FROM users WHERE username = ?', [username]);
  if (existingUser) {
    return res.status(400).json({ error: '用户名已被使用' });
  }
  if (email) {
    const existingEmail = queryOne(db, "SELECT id FROM users WHERE email = ? AND email != ''", [email]);
    if (existingEmail) {
      return res.status(400).json({ error: '邮箱已被使用' });
    }
  }

  const userRole = role || 'user';
  const validRoles = ['user', 'visitor', 'admin'];
  if (!validRoles.includes(userRole)) {
    return res.status(400).json({ error: '无效的用户角色' });
  }

  const hashedPassword = bcrypt.hashSync(password, 10);
  const newUid = generateUid(db);
  db.run("INSERT INTO users (uid, username, password, email, role, status) VALUES (?, ?, ?, ?, ?, 'active')",
    [newUid, username, hashedPassword, email || '', userRole]);

  const newUser = queryOne(db, 'SELECT id FROM users WHERE username = ?', [username]);
  if (newUser) {
    grantDefaultPermissions(db, newUser.id, req.apiUser.id);
  }

  saveDatabase();
  logActivity(db, {
    user_id: req.apiUser.id,
    username: req.apiUser.username,
    action: 'create',
    target_type: 'user',
    target_id: newUser ? newUser.id : null,
    target_title: username,
    detail: 'API 创建账户：' + username + ' (角色: ' + userRole + ')',
    ip: req.ip,
    route: req.path,
    method: req.method
  });
  res.json({ success: true, message: '账户创建成功' });
});

// 重置用户密码（仅超级管理员，返回随机新密码，逻辑对齐 Web 版 /auth/admin-reset-password/:userId）
router.post('/users/:id/reset-password', (req, res) => {
  if (req.apiUser.role !== 'super_admin') {
    return res.status(403).json({ error: '仅超级管理员可重置密码' });
  }

  const db = getDb();
  const id = toInt(req.params.id);
  const user = queryOne(db, 'SELECT * FROM users WHERE id = ?', [id]);
  if (!user) {
    return res.status(404).json({ error: '用户不存在' });
  }

  // 统一操作校验：不能操作自己、非超管不能动超管、同级/高级不可动
  const check = canOperateUser(req.apiUser, user);
  if (!check.ok) {
    return res.status(403).json({ error: check.reason });
  }

  const newPassword = crypto.randomBytes(4).toString('hex');
  const hashedPassword = bcrypt.hashSync(newPassword, 10);
  db.run('UPDATE users SET password = ?, must_change_password = 1, reset_token = NULL, reset_token_expires = NULL WHERE id = ?',
    [hashedPassword, id]);
  saveDatabase();

  logActivity(db, {
    user_id: req.apiUser.id,
    username: req.apiUser.username,
    action: 'change_password',
    target_type: 'password',
    target_id: id,
    target_title: user.username,
    detail: '管理员 ' + req.apiUser.username + ' 重置了用户 ' + user.username + ' 的密码',
    ip: req.ip,
    route: req.path,
    method: req.method
  });

  res.json({ success: true, message: '密码已重置', new_password: newPassword });
});

router.delete('/users/:id', (req, res) => {
  const db = getDb();
  const id = toInt(req.params.id);
  const user = queryOne(db, 'SELECT * FROM users WHERE id = ?', [id]);
  if (!user) return res.status(404).json({ error: '用户不存在' });

  // 统一操作校验：不能操作自己、非超管不能动超管、同级/高级不可动
  const check = canOperateUser(req.apiUser, user);
  if (!check.ok) {
    return res.status(403).json({ error: check.reason });
  }
  // 删除超管前防管理端锁死
  if (user.role === 'super_admin' && !ensureAtLeastOneActiveSuperAdmin(db, user.id)) {
    return res.status(400).json({ error: '不能删除最后一个超级管理员' });
  }
  db.run('DELETE FROM users WHERE id = ?', [id]);
  saveDatabase();
  res.json({ success: true });
});

// ============ 文章管理 ============
router.get('/articles', (req, res) => {
  const db = getDb();
  const page = Math.max(1, toInt(req.query.page, 1));
  const limit = Math.min(100, Math.max(1, toInt(req.query.limit, 10)));
  const offset = (page - 1) * limit;
  const q = (req.query.q || '').trim();

  let where = 'WHERE 1=1';
  const params = [];
  if (q) {
    where += ' AND a.title LIKE ?';
    params.push(`%${q}%`);
  }
  const total = queryOne(db, `SELECT COUNT(*) AS count FROM articles a ${where}`, params)?.count || 0;
  const rows = queryAll(db, `
    SELECT a.id, a.title, a.cover_image, a.status, a.category, a.created_at, a.updated_at,
      u.username AS author_name, u.nickname AS author_nickname
    FROM articles a LEFT JOIN users u ON a.author_id = u.id
    ${where} ORDER BY a.created_at DESC LIMIT ? OFFSET ?
  `, [...params, limit, offset]);
  res.json({ articles: rows || [], total, page });
});

router.put('/articles/:id', (req, res) => {
  const db = getDb();
  const id = toInt(req.params.id);
  const status = (req.body.status || '').trim();
  if (!['published', 'draft', 'pending', 'trashed'].includes(status)) {
    return res.status(400).json({ error: '无效的状态' });
  }
  db.run('UPDATE articles SET status = ? WHERE id = ?', [status, id]);
  saveDatabase();
  res.json({ success: true });
});

router.delete('/articles/:id', (req, res) => {
  const db = getDb();
  const id = toInt(req.params.id);
  db.run('DELETE FROM articles WHERE id = ?', [id]);
  saveDatabase();
  res.json({ success: true });
});

// ============ 评论管理 ============
router.get('/comments', (req, res) => {
  const db = getDb();
  const page = Math.max(1, toInt(req.query.page, 1));
  const limit = Math.min(100, Math.max(1, toInt(req.query.limit, 10)));
  const offset = (page - 1) * limit;

  const total = queryOne(db, 'SELECT COUNT(*) AS count FROM comments')?.count || 0;
  const rows = queryAll(db, `
    SELECT c.id, c.article_id, c.content, c.status, c.parent_id, c.created_at,
      u.username, u.nickname, COALESCE(a.title, '') AS article_title
    FROM comments c
    LEFT JOIN users u ON c.user_id = u.id
    LEFT JOIN articles a ON c.article_id = a.id
    ORDER BY c.created_at DESC LIMIT ? OFFSET ?
  `, [limit, offset]);
  res.json({ comments: rows || [], total, page });
});

router.delete('/comments/:id', (req, res) => {
  const db = getDb();
  const id = toInt(req.params.id);
  db.run('DELETE FROM comments WHERE id = ?', [id]);
  saveDatabase();
  res.json({ success: true });
});

// ============ 图片管理 ============
router.get('/images', (req, res) => {
  const db = getDb();
  const page = Math.max(1, toInt(req.query.page, 1));
  const limit = Math.min(100, Math.max(1, toInt(req.query.limit, 10)));
  const offset = (page - 1) * limit;

  let where = 'WHERE 1=1';
  const params = [];
  const status = req.query.status;
  if (status !== undefined && status !== '') {
    where += ' AND i.status = ?';
    params.push(toInt(status));
  }

  const total = queryOne(db, `SELECT COUNT(*) AS count FROM images i ${where}`, params)?.count || 0;
  const rows = queryAll(db, `
    SELECT i.*, u.username, u.nickname, u.avatar AS user_avatar, c.name AS category_name
    FROM images i
    LEFT JOIN users u ON i.user_id = u.id
    LEFT JOIN image_categories c ON i.cate_id = c.id
    ${where} ORDER BY i.created_at DESC LIMIT ? OFFSET ?
  `, [...params, limit, offset]);
  res.json({ images: rows || [], total, page });
});

router.put('/images/:id', (req, res) => {
  const db = getDb();
  const id = toInt(req.params.id);
  const status = toInt(req.body.status, -1);
  if (status !== 0 && status !== 1) {
    return res.status(400).json({ error: '状态只能为 0（驳回）或 1（通过）' });
  }
  db.run('UPDATE images SET status = ? WHERE id = ?', [status, id]);
  saveDatabase();
  res.json({ success: true });
});

router.delete('/images/:id', (req, res) => {
  const db = getDb();
  const id = toInt(req.params.id);
  const img = queryOne(db, 'SELECT * FROM images WHERE id = ?', [id]);
  if (img && img.url) {
    const filePath = path.join(projectRoot, 'public', img.url);
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (e) { /* 忽略 */ }
  }
  db.run('DELETE FROM images WHERE id = ?', [id]);
  saveDatabase();
  res.json({ success: true });
});

// ============ 图片分类 ============
router.get('/categories', (req, res) => {
  const db = getDb();
  const rows = queryAll(db, 'SELECT * FROM image_categories ORDER BY sort ASC, id ASC');
  res.json({ categories: rows || [] });
});

router.post('/categories', (req, res) => {
  const db = getDb();
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: '分类名称不能为空' });
  const sort = toInt(req.body.sort, 0);
  db.run('INSERT INTO image_categories (name, sort, status) VALUES (?, ?, 1)', [name, sort]);
  saveDatabase();
  res.json({ success: true });
});

router.delete('/categories/:id', (req, res) => {
  const db = getDb();
  const id = toInt(req.params.id);
  db.run('DELETE FROM image_categories WHERE id = ?', [id]);
  db.run('UPDATE images SET cate_id = 0 WHERE cate_id = ?', [id]);
  saveDatabase();
  res.json({ success: true });
});

// ============ 小说管理 ============
router.get('/novels', (req, res) => {
  const db = getDb();
  const page = Math.max(1, toInt(req.query.page, 1));
  const limit = Math.min(100, Math.max(1, toInt(req.query.limit, 10)));
  const offset = (page - 1) * limit;
  const total = queryOne(db, 'SELECT COUNT(*) AS count FROM novels')?.count || 0;
  const rows = queryAll(db, `
    SELECT n.*, (SELECT COUNT(*) FROM novel_chapters c WHERE c.novel_id = n.id) AS chapter_count
    FROM novels n ORDER BY n.updated_at DESC, n.created_at DESC LIMIT ? OFFSET ?
  `, [limit, offset]);
  res.json({ novels: rows || [], total, page });
});

router.delete('/novels/:id', (req, res) => {
  const db = getDb();
  const id = toInt(req.params.id);
  db.run('DELETE FROM novels WHERE id = ?', [id]);
  saveDatabase();
  res.json({ success: true });
});

// ============ 设置 ============
router.get('/settings', (req, res) => {
  const db = getDb();
  const rows = queryAll(db, 'SELECT setting_key, setting_value FROM settings ORDER BY setting_key ASC');
  const settings = {};
  for (const r of rows || []) {
    settings[r.setting_key] = r.setting_value;
  }
  res.json({ settings });
});

router.put('/settings', (req, res) => {
  const db = getDb();
  const values = req.body.settings;
  if (!values || typeof values !== 'object') {
    return res.status(400).json({ error: '缺少设置数据' });
  }
  for (const [key, value] of Object.entries(values)) {
    if (!/^[a-zA-Z0-9_]{1,64}$/.test(key)) continue;
    const v = String(value ?? '').slice(0, 2000);
    const existing = queryOne(db, 'SELECT id FROM settings WHERE setting_key = ?', [key]);
    if (existing) {
      db.run('UPDATE settings SET setting_value = ? WHERE setting_key = ?', [v, key]);
    } else {
      db.run('INSERT INTO settings (setting_key, setting_value) VALUES (?, ?)', [key, v]);
    }
  }
  saveDatabase();
  try {
    const { settingsCache } = require('../../config/cache');
    settingsCache.delete('settings');
  } catch (e) { /* 忽略 */ }
  res.json({ success: true });
});

module.exports = router;
