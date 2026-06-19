const express = require('express');
const router = express.Router();
const { isAuthenticated, hasPermission, isAdminRole } = require('../../middlewares/auth');
const { saveDatabase, queryAll, queryOne } = require('../../config/database');
const { logActivity } = require('../../config/activity');

// ============ 文章管理 ============

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

router.get('/articles/new', isAuthenticated, hasPermission('articles.manage'), (req, res) => {
  res.render('admin/article-editor', {
    user: req.session.user,
    article: null,
    settings: res.locals.settings || {}
  });
});

router.get('/articles/edit/:id', isAuthenticated, hasPermission('articles.manage'), (req, res) => {
  const db = req.db;
  const article = queryOne(db, 'SELECT * FROM articles WHERE id = ?', [req.params.id]);

  if (!article) {
    return res.status(404).render('frontend/error', {
      message: '文章不存在',
      error: '',
      user: req.session.user,
      settings: res.locals.settings || {}
    });
  }

  if (!isAdminRole(req.session.user) && article.author_id !== req.session.user.id) {
    return res.status(403).render('frontend/error', {
      message: '权限不足',
      error: '您只能编辑自己的文章',
      user: req.session.user,
      settings: res.locals.settings || {}
    });
  }

  res.render('admin/article-editor', {
    user: req.session.user,
    article: article,
    settings: res.locals.settings || {}
  });
});

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

  if (id) {
    const existing = queryOne(db, 'SELECT author_id FROM articles WHERE id = ?', [id]);
    if (existing && !isAdminRole(req.session.user) && existing.author_id !== req.session.user.id) {
      return res.status(403).json({ error: '无权编辑此文章' });
    }
    try {
      db.run('UPDATE articles SET title=?, content=?, category=?, status=?, cover_image=?, location=?, updated_at=CURRENT_TIMESTAMP WHERE id=?',
        [title, content, category || '', status || 'published', cover_image || '', locationValue, id]);
    } catch (err) { throw err; }
  } else {
    try {
      db.run('INSERT INTO articles (title, content, category, status, cover_image, location, author_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [title, content, category || '', status || 'published', cover_image || '', locationValue, req.session.user.id]);
    } catch (err) { throw err; }
  }

  try { saveDatabase(); } catch (err) { throw err; }
  try {
    logActivity(db, { user_id: req.session.user.id, username: req.session.user.username, action: id ? 'update' : 'create', target_type: 'article', target_id: id || null, target_title: title, detail: (id ? '更新' : '创建') + '文章：' + title, ip: req.ip });
  } catch (err) { throw err; }
  res.redirect('/admin/articles');
});

router.post('/articles/delete/:id', isAuthenticated, hasPermission('articles.manage'), (req, res) => {
  const db = req.db;
  const article = queryOne(db, 'SELECT title, author_id FROM articles WHERE id = ?', [req.params.id]);

  if (!article) {
    return res.status(404).json({ error: '文章不存在' });
  }

  if (!isAdminRole(req.session.user) && article.author_id !== req.session.user.id) {
    return res.status(403).json({ error: '无权删除此文章' });
  }

  db.run('DELETE FROM articles WHERE id = ?', [req.params.id]);

  saveDatabase();
  logActivity(db, { user_id: req.session.user.id, username: req.session.user.username, action: 'delete', target_type: 'article', target_id: parseInt(req.params.id), target_title: article.title, detail: '删除文章：' + article.title, ip: req.ip });
  res.redirect('/admin/articles');
});

module.exports = router;
