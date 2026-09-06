/**
 * 管理端 API 路由（供 Flutter App 的后台管理功能使用）
 * 整组路由统一鉴权：apiAuth（Token 登录）+ apiRequireAdmin（管理员）+ apiAdminAudit（审计日志）。
 * 模块：
 *   - 仪表盘统计、用户管理、文章管理、评论管理、图片管理、图片分类、小说管理、设置
 * 安全要点：
 *   - 用户操作统一走 canOperateUser（不能操作自己/超管保护/同级不可动）；
 *   - 角色修改/创建用户/重置密码仅限 super_admin；
 *   - 禁用/降级/删除超管前检查是否还剩至少一个激活超管（防管理端锁死）；
 *   - 动态 WHERE 全部参数化，防 SQL 注入。
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { queryOne, queryAll, getDb, saveDatabase, getDbPath, generateUid } = require('../../config/database');
const { apiAuth, apiRequireAdmin, apiRequirePermission, apiRequireSuperAdmin, apiAdminAudit } = require('../../middlewares/api-auth');
const { ROLE_WHITELIST, canOperateUser, ensureAtLeastOneActiveSuperAdmin, validatePassword } = require('../../middlewares/auth');
const { grantDefaultPermissions } = require('../../config/db-helpers');
const { logActivity } = require('../../config/activity');
const { cleanupUserDependencies } = require('../../utils/user-deps');
const fsSafe = require('../../utils/fs-safe');

const router = express.Router();
router.use(apiAuth, apiRequireAdmin, apiAdminAudit);   // 整组路由的全局鉴权

const projectRoot = path.join(__dirname, '../../..');  // 项目根目录（用于拼接文件路径）

/**
 * 安全转整数（NaN 时返回默认值）
 * @param {*} v - 输入值
 * @param {number} def - 默认值
 * @returns {number}
 */
function toInt(v, def = 0) {
  const n = parseInt(v);
  return isNaN(n) ? def : n;
}

// ============ 仪表盘 ============
// 汇总各类统计数字：用户/文章/图片/小说/评论/待审/今日访问/运行时长/数据库大小
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
    pending_comments: commentPending + imageCommentPending + mediaCommentPending,   // 三类待审评论合计
    today_visits: count("SELECT COUNT(*) AS count FROM activity_logs WHERE created_at >= date('now')"),
    uptime: (process.uptime() / 3600).toFixed(1) + ' 小时',
    db_size: formatSize(fs.existsSync(getDbPath()) ? fs.statSync(getDbPath()).size : 0),
  });
});

/**
 * 格式化文件大小为可读字符串
 * @param {number} bytes - 字节数
 * @returns {string}
 */
function formatSize(bytes) {
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return bytes + ' B';
}

// ============ 用户管理 ============
// 用户列表：支持关键词与角色筛选，附带粉丝/关注/文章数
router.get('/users', apiRequirePermission('users.manage'), (req, res) => {
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

// 修改用户角色/状态
router.put('/users/:id', apiRequirePermission('users.manage'), (req, res) => {
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

  // 基础校验：用户名/密码必填，密码走强度校验
  if (!username || !password) {
    return res.status(400).json({ error: '用户名和密码不能为空' });
  }
  if (username.length < 3) {
    return res.status(400).json({ error: '用户名至少3个字符' });
  }
  const pwdCheck = validatePassword(password);
  if (!pwdCheck.ok) {
    return res.status(400).json({ error: pwdCheck.reason });
  }

  // 用户名/邮箱唯一性校验
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

  // 角色白名单（不允许直接创建 super_admin，只能后续由超管提升）
  const userRole = role || 'user';
  const validRoles = ['user', 'visitor', 'admin'];
  if (!validRoles.includes(userRole)) {
    return res.status(400).json({ error: '无效的用户角色' });
  }

  const hashedPassword = bcrypt.hashSync(password, 10);
  const newUid = generateUid(db);
  db.run("INSERT INTO users (uid, username, password, email, role, status) VALUES (?, ?, ?, ?, ?, 'active')",
    [newUid, username, hashedPassword, email || '', userRole]);

  // 为新用户授予默认前台权限
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

  // 生成 8 位随机新密码（4 字节 hex），并强制用户下次登录修改
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

// 删除用户（含超管保护）
router.delete('/users/:id', apiRequirePermission('users.manage'), (req, res) => {
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

  // 事务内先清理关联数据，再删除用户，避免外键约束失败（FOREIGN KEY constraint failed）
  let filesToDelete = [];
  try {
    db.run('BEGIN');
    filesToDelete = cleanupUserDependencies(db, id);
    db.run('DELETE FROM users WHERE id = ?', [id]);
    db.run('COMMIT');
  } catch (err) {
    try { db.run('ROLLBACK'); } catch (rollbackErr) { /* 忽略回滚异常 */ }
    console.error('API 删除用户失败:', err);
    return res.status(500).json({ error: '删除用户失败: ' + err.message });
  }
  // 事务提交成功后删除图片文件（文件删除不可回滚，置于事务外；异步删除不阻塞响应）
  filesToDelete.forEach(filePath => {
    fsSafe.safeUnlink(filePath);
  });
  saveDatabase();
  res.json({ success: true });
});

// ============ 文章管理 ============
// 文章列表（标题搜索 + 分页）
router.get('/articles', apiRequirePermission('articles.manage'), (req, res) => {
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

// 修改文章状态（发布/草稿/待审/回收站）
router.put('/articles/:id', apiRequirePermission('articles.manage'), (req, res) => {
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

// 删除文章
router.delete('/articles/:id', apiRequirePermission('articles.manage'), (req, res) => {
  const db = getDb();
  const id = toInt(req.params.id);
  db.run('DELETE FROM articles WHERE id = ?', [id]);
  saveDatabase();
  res.json({ success: true });
});

// ============ 评论管理 ============
router.get('/comments', apiRequirePermission('comments.manage'), (req, res) => {
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

router.delete('/comments/:id', apiRequirePermission('comments.manage'), (req, res) => {
  const db = getDb();
  const id = toInt(req.params.id);
  db.run('DELETE FROM comments WHERE id = ?', [id]);
  saveDatabase();
  res.json({ success: true });
});

// ============ 图片管理 ============
// 图片列表（可按状态筛选）
router.get('/images', apiRequirePermission('image-share.manage'), (req, res) => {
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

// 审核图片（0=驳回，1=通过）
router.put('/images/:id', apiRequirePermission('image-share.manage'), (req, res) => {
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

// 删除图片（连带删除磁盘文件）
router.delete('/images/:id', apiRequirePermission('image-share.manage'), (req, res) => {
  const db = getDb();
  const id = toInt(req.params.id);
  const img = queryOne(db, 'SELECT * FROM images WHERE id = ?', [id]);
  if (img && img.url) {
    // 删除磁盘上的图片文件（url 以 /uploads/ 开头，拼接安全）
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
router.get('/categories', apiRequirePermission('image-share.manage'), (req, res) => {
  const db = getDb();
  const rows = queryAll(db, 'SELECT * FROM image_categories ORDER BY sort ASC, id ASC');
  res.json({ categories: rows || [] });
});

// 新建分类
router.post('/categories', apiRequirePermission('image-share.manage'), (req, res) => {
  const db = getDb();
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: '分类名称不能为空' });
  const sort = toInt(req.body.sort, 0);
  db.run('INSERT INTO image_categories (name, sort, status) VALUES (?, ?, 1)', [name, sort]);
  saveDatabase();
  res.json({ success: true });
});

// 删除分类（该分类下图片的 cate_id 置 0，避免孤儿数据）
router.delete('/categories/:id', apiRequirePermission('image-share.manage'), (req, res) => {
  const db = getDb();
  const id = toInt(req.params.id);
  db.run('DELETE FROM image_categories WHERE id = ?', [id]);
  db.run('UPDATE images SET cate_id = 0 WHERE cate_id = ?', [id]);
  saveDatabase();
  res.json({ success: true });
});

// ============ 小说管理 ============
router.get('/novels', apiRequirePermission('novels.manage'), (req, res) => {
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

router.delete('/novels/:id', apiRequirePermission('novels.manage'), (req, res) => {
  const db = getDb();
  const id = toInt(req.params.id);
  db.run('DELETE FROM novels WHERE id = ?', [id]);
  saveDatabase();
  res.json({ success: true });
});

// ============ 设置 ============
// 读取全部设置（键值对形式返回）
router.get('/settings', apiRequirePermission('settings.manage'), (req, res) => {
  const db = getDb();
  const rows = queryAll(db, 'SELECT setting_key, setting_value FROM settings ORDER BY setting_key ASC');
  const settings = {};
  for (const r of rows || []) {
    settings[r.setting_key] = r.setting_value;
  }
  res.json({ settings });
});

// 批量保存设置：键名校验（字母数字下划线）+ 值截断 2000 字符 + upsert
router.put('/settings', apiRequirePermission('settings.manage'), (req, res) => {
  const db = getDb();
  const values = req.body.settings;
  if (!values || typeof values !== 'object') {
    return res.status(400).json({ error: '缺少设置数据' });
  }
  for (const [key, value] of Object.entries(values)) {
    if (!/^[a-zA-Z0-9_]{1,64}$/.test(key)) continue;   // 键名白名单校验，防注入/防塞多余键
    const v = String(value ?? '').slice(0, 2000);       // 值截断
    const existing = queryOne(db, 'SELECT id FROM settings WHERE setting_key = ?', [key]);
    if (existing) {
      db.run('UPDATE settings SET setting_value = ? WHERE setting_key = ?', [v, key]);
    } else {
      db.run('INSERT INTO settings (setting_key, setting_value) VALUES (?, ?)', [key, v]);
    }
  }
  saveDatabase();
  // 清除设置缓存，使新值立即生效
  try {
    const { settingsCache } = require('../../config/cache');
    settingsCache.delete('settings');
  } catch (e) { /* 忽略 */ }
  res.json({ success: true });
});

module.exports = router;
