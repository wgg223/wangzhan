/**
 * 文章管理路由（后台）
 * 能力：
 *   GET  /admin/articles           —— 文章列表（管理员看全部，普通作者只看自己的）
 *   GET  /admin/articles/new       —— 新建文章编辑器
 *   GET  /admin/articles/edit/:id  —— 编辑文章（非作者非管理员 403）
 *   POST /admin/articles/save      —— 保存文章（新建/更新；富文本 XSS 净化；越权编辑拦截）
 *   POST /admin/articles/delete/:id —— 删除文章（连带删除附件文件；越权删除拦截）
 * 安全要点：
 *   - 正文经 html-sanitizer 白名单净化（防存储型 XSS）；
 *   - 编辑/删除均校验文章归属（普通用户只能动自己的文章）；
 *   - 数组型表单字段（重复字段）防御性取首元素，防参数混淆。
 */

const express = require('express');
const router = express.Router();
const { isAuthenticated, hasPermission, isAdminRole } = require('../../middlewares/auth');
const { saveDatabase, queryAll, queryOne } = require('../../config/database');
const { logActivity } = require('../../config/activity');
const { renderError } = require('../../utils/response');
const { sanitize } = require('../../utils/html-sanitizer');

// ============ 文章管理 ============

// 文章列表：管理员可见全部，普通作者仅见自己的
router.get('/articles', isAuthenticated, hasPermission('articles.manage'), (req, res) => {
  const db = req.db;
  let articles;
  if (isAdminRole(req.session.user)) {
    articles = queryAll(db, 'SELECT a.*, u.username as author_name FROM articles a LEFT JOIN users u ON a.author_id = u.id ORDER BY a.created_at DESC');
  } else {
    articles = queryAll(db, 'SELECT a.*, u.username as author_name FROM articles a LEFT JOIN users u ON a.author_id = u.id WHERE a.author_id = ? ORDER BY a.created_at DESC', [req.session.user.id]);
  }

  res.render('admin/articles', {
    user: req.session.user,
    articles: articles,
    settings: res.locals.settings || {}
  });
});

// 新建文章（编辑器空状态）
router.get('/articles/new', isAuthenticated, hasPermission('articles.manage'), (req, res) => {
  res.render('admin/article-editor', {
    user: req.session.user,
    article: null,
    settings: res.locals.settings || {}
  });
});

// 编辑文章：先查文章，再校验归属（非管理员只能编辑自己的）
router.get('/articles/edit/:id', isAuthenticated, hasPermission('articles.manage'), (req, res) => {
  const db = req.db;
  const article = queryOne(db, 'SELECT * FROM articles WHERE id = ?', [req.params.id]);

  if (!article) {
    return renderError(res, 404, '文章不存在', req);
  }

  if (!isAdminRole(req.session.user) && article.author_id !== req.session.user.id) {
    return renderError(res, 403, '权限不足', req, '您只能编辑自己的文章');
  }

  res.render('admin/article-editor', {
    user: req.session.user,
    article: article,
    settings: res.locals.settings || {}
  });
});

// 保存文章（新建或更新）
router.post('/articles/save', isAuthenticated, hasPermission('articles.manage'), (req, res) => {
  const db = req.db;
  let { id, title, content, category, status, cover_image, location } = req.body;

  // 🔐 防御性处理：如果字段是数组（由重复表单字段导致），取第一个元素
  if (Array.isArray(content)) { content = content[0] || ''; }
  if (Array.isArray(title)) { title = title[0] || ''; }
  if (Array.isArray(category)) { category = category[0] || ''; }
  if (Array.isArray(status)) { status = status[0] || ''; }
  if (Array.isArray(cover_image)) { cover_image = cover_image[0] || ''; }
  if (Array.isArray(location)) { location = location[0] || ''; }

  if (!title) {
    return res.status(400).json({ error: '文章标题不能为空' });
  }

  const locationValue = location || 'home';
  // 净化富文本，防止存储型 XSS（前端 article-detail 页面原样输出正文）
  const safeContent = sanitize(content);
  let articleId = id;

  if (id) {
    // 更新：校验文章归属（非管理员只能改自己的）
    const existing = queryOne(db, 'SELECT author_id FROM articles WHERE id = ?', [id]);
    if (existing && !isAdminRole(req.session.user) && existing.author_id !== req.session.user.id) {
      return res.status(403).json({ error: '无权编辑此文章' });
    }
    db.run('UPDATE articles SET title=?, content=?, category=?, status=?, cover_image=?, location=?, updated_at=CURRENT_TIMESTAMP WHERE id=?',
      [title, safeContent, category || '', status || 'published', cover_image || '', locationValue, id]);
  } else {
    // 新建：插入后取回自增 id（按 标题+作者 倒序取最新一条）
    db.run('INSERT INTO articles (title, content, category, status, cover_image, location, author_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [title, safeContent, category || '', status || 'published', cover_image || '', locationValue, req.session.user.id]);
    const newArticle = queryOne(db, 'SELECT id FROM articles WHERE title = ? AND author_id = ? ORDER BY id DESC LIMIT 1',
      [title, req.session.user.id]);
    if (newArticle) articleId = newArticle.id;
  }

  saveDatabase();
  logActivity(db, { user_id: req.session.user.id, username: req.session.user.username, action: id ? 'update' : 'create', target_type: 'article', target_id: id || null, target_title: title, detail: (id ? '更新' : '创建') + '文章：' + title, ip: req.ip });

  // AJAX请求返回JSON（编辑器无刷新保存）
  if (req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest') {
    return res.json({ success: true, articleId: articleId });
  }

  res.redirect('/admin/articles');
});

// 删除文章（连带删除附件文件）
router.post('/articles/delete/:id', isAuthenticated, hasPermission('articles.manage'), (req, res) => {
  const db = req.db;
  const article = queryOne(db, 'SELECT title, author_id FROM articles WHERE id = ?', [req.params.id]);

  if (!article) {
    return res.status(404).json({ error: '文章不存在' });
  }

  // 越权删除拦截：非管理员只能删自己的
  if (!isAdminRole(req.session.user) && article.author_id !== req.session.user.id) {
    return res.status(403).json({ error: '无权删除此文章' });
  }

  // 删除关联的附件文件（file_path 以 /uploads/ 开头，拼接安全）
  const attachments = queryAll(db, 'SELECT file_path FROM article_attachments WHERE article_id = ?', [req.params.id]);
  const fs = require('fs');
  const path = require('path');
  attachments.forEach(function(att) {
    const filePath = path.join(__dirname, '../../../public', att.file_path);
    try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (e) { /* ignore */ }
  });
  db.run('DELETE FROM article_attachments WHERE article_id = ?', [req.params.id]);

  db.run('DELETE FROM articles WHERE id = ?', [req.params.id]);

  saveDatabase();
  logActivity(db, { user_id: req.session.user.id, username: req.session.user.username, action: 'delete', target_type: 'article', target_id: parseInt(req.params.id), target_title: article.title, detail: '删除文章：' + article.title, ip: req.ip });
  res.redirect('/admin/articles');
});

module.exports = router;
