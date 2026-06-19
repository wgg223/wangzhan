const express = require('express');
const router = express.Router();
const { isAuthenticated, hasPermission } = require('../../middlewares/auth');
const { saveDatabase, queryAll, queryOne } = require('../../config/database');
const { logActivity } = require('../../config/activity');

// ============ 页面管理 ============

router.get('/pages', isAuthenticated, hasPermission('pages.manage'), (req, res) => {
  const db = req.db;
  const pages = queryAll(db, 'SELECT * FROM pages ORDER BY sort_order ASC, id ASC');

  res.render('admin/pages', {
    user: req.session.user,
    pages: pages,
    settings: res.locals.settings || {}
  });
});

router.get('/pages/new', isAuthenticated, hasPermission('pages.manage'), (req, res) => {
  res.render('admin/page-editor', {
    user: req.session.user,
    page: null,
    settings: res.locals.settings || {}
  });
});

router.get('/pages/edit/:id', isAuthenticated, hasPermission('pages.manage'), (req, res) => {
  const db = req.db;
  const page = queryOne(db, 'SELECT * FROM pages WHERE id = ?', [req.params.id]);

  if (!page) {
    return res.status(404).render('frontend/error', {
      message: '页面不存在',
      error: '',
      user: req.session.user,
      settings: res.locals.settings || {}
    });
  }

  res.render('admin/page-editor', {
    user: req.session.user,
    page: page,
    settings: res.locals.settings || {}
  });
});

router.post('/pages/save', isAuthenticated, hasPermission('pages.manage'), (req, res) => {
  const db = req.db;
  const { id, title, slug, content, type, status, parent_id, sort_order, font_color } = req.body;

  if (!title || !slug) {
    return res.status(400).json({ error: '标题和Slug不能为空' });
  }

  // 构建回传数据对象供slug冲突时使用
  const submittedData = {
    id: id || undefined,
    title: title || '',
    slug: slug || '',
    content: content || '',
    type: type || 'page',
    status: status || 'published',
    parent_id: parent_id || 0,
    sort_order: sort_order || 0,
    font_color: font_color || ''
  };

  // Slug唯一性检查（新建时查全表，更新时排除自身）
  const sql = id
    ? 'SELECT id FROM pages WHERE slug = ? AND id != ?'
    : 'SELECT id FROM pages WHERE slug = ?';
  const params = id ? [slug, id] : [slug];
  const existingSlug = queryOne(db, sql, params);

  if (existingSlug) {
    return res.status(400).render('admin/page-editor', {
      user: req.session.user,
      page: submittedData,
      settings: res.locals.settings || {},
      error: 'Slug已被使用，请更换'
    });
  }

  if (id) {
    db.run('UPDATE pages SET title=?, slug=?, content=?, type=?, status=?, parent_id=?, sort_order=?, font_color=?, updated_at=CURRENT_TIMESTAMP WHERE id=?',
      [title, slug, content, type || 'page', status || 'published', parent_id || 0, sort_order || 0, font_color || '', id]);
  } else {
    db.run('INSERT INTO pages (title, slug, content, type, status, parent_id, sort_order, font_color) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [title, slug, content, type || 'page', status || 'published', parent_id || 0, sort_order || 0, font_color || '']);
  }

  saveDatabase();
  logActivity(db, { user_id: req.session.user.id, username: req.session.user.username, action: id ? 'update' : 'create', target_type: 'page', target_id: id || null, target_title: title, detail: (id ? '更新' : '创建') + '页面：' + title, ip: req.ip });
  res.redirect('/admin/pages');
});

router.post('/pages/delete/:id', isAuthenticated, hasPermission('pages.manage'), (req, res) => {
  const db = req.db;
  const page = queryOne(db, 'SELECT * FROM pages WHERE id = ?', [req.params.id]);

  if (!page) {
    return res.status(404).json({ error: '页面不存在' });
  }

  const protectedSlugs = ['home'];
  if (protectedSlugs.includes(page.slug)) {
    return res.status(400).json({ error: '不能删除系统默认页面（首页）' });
  }

  db.run('DELETE FROM pages WHERE id = ?', [req.params.id]);

  saveDatabase();
  logActivity(db, { user_id: req.session.user.id, username: req.session.user.username, action: 'delete', target_type: 'page', target_id: page.id, target_title: page.title, detail: '删除页面：' + page.title, ip: req.ip });
  res.redirect('/admin/pages');
});

module.exports = router;
