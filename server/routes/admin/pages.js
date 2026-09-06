/**
 * 页面管理路由（后台）
 * 能力：
 *   GET  /admin/pages               —— 页面列表
 *   GET  /admin/pages/new           —— 新建页面编辑器
 *   GET  /admin/pages/edit/:id      —— 编辑页面（不存在 404）
 *   POST /admin/pages/save          —— 保存页面（新建/更新；Slug 唯一性校验；冲突时回显错误）
 *   POST /admin/pages/delete/:id    —— 删除页面（保护系统默认页 home 不可删）
 * 权限：全部需 pages.manage 权限；写操作审计日志。
 */

const express = require('express');
const router = express.Router();
const { isAuthenticated, hasPermission } = require('../../middlewares/auth');
const { saveDatabase, queryAll, queryOne } = require('../../config/database');
const { logActivity } = require('../../config/activity');
const { renderError } = require('../../utils/response');

// ============ 页面管理 ============

// 页面列表（按排序值与 ID 升序）
router.get('/pages', isAuthenticated, hasPermission('pages.manage'), (req, res) => {
  const db = req.db;
  const pages = queryAll(db, 'SELECT * FROM pages ORDER BY sort_order ASC, id ASC');

  res.render('admin/pages', {
    user: req.session.user,
    pages: pages,
    settings: res.locals.settings || {}
  });
});

// 新建页面（传入空 page 对象，编辑器按新建模式渲染）
router.get('/pages/new', isAuthenticated, hasPermission('pages.manage'), (req, res) => {
  res.render('admin/page-editor', {
    user: req.session.user,
    page: null,
    settings: res.locals.settings || {}
  });
});

// 编辑页面（按 id 查页面，不存在则渲染 404）
router.get('/pages/edit/:id', isAuthenticated, hasPermission('pages.manage'), (req, res) => {
  const db = req.db;
  const page = queryOne(db, 'SELECT * FROM pages WHERE id = ?', [req.params.id]);

  if (!page) {
    return renderError(res, 404, '页面不存在', req);
  }

  res.render('admin/page-editor', {
    user: req.session.user,
    page: page,
    settings: res.locals.settings || {}
  });
});

// 保存页面（新建或更新；id 存在则更新）
router.post('/pages/save', isAuthenticated, hasPermission('pages.manage'), (req, res) => {
  const db = req.db;
  const { id, title, slug, content, type, status, parent_id, sort_order, font_color } = req.body;

  if (!title || !slug) {
    return res.status(400).json({ error: '标题和Slug不能为空' });
  }

  // 构建回传数据对象供slug冲突时使用（保留用户已填内容，避免重填）
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
    // 冲突：回到编辑器并显示错误（HTTP 400 + 渲染页面）
    return res.status(400).render('admin/page-editor', {
      user: req.session.user,
      page: submittedData,
      settings: res.locals.settings || {},
      error: 'Slug已被使用，请更换'
    });
  }

  if (id) {
    // 更新已有页面
    db.run('UPDATE pages SET title=?, slug=?, content=?, type=?, status=?, parent_id=?, sort_order=?, font_color=?, updated_at=CURRENT_TIMESTAMP WHERE id=?',
      [title, slug, content, type || 'page', status || 'published', parent_id || 0, sort_order || 0, font_color || '', id]);
  } else {
    // 新建页面
    db.run('INSERT INTO pages (title, slug, content, type, status, parent_id, sort_order, font_color) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [title, slug, content, type || 'page', status || 'published', parent_id || 0, sort_order || 0, font_color || '']);
  }

  saveDatabase();
  logActivity(db, { user_id: req.session.user.id, username: req.session.user.username, action: id ? 'update' : 'create', target_type: 'page', target_id: id || null, target_title: title, detail: (id ? '更新' : '创建') + '页面：' + title, ip: req.ip });
  res.redirect('/admin/pages');
});

// 删除页面（home 为系统默认页，禁止删除）
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
