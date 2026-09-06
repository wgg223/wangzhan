/**
 * 评论管理路由（后台）
 * 能力：
 *   GET  /admin/comments                          —— 文章评论 + 图片(媒体)评论 列表页
 *   POST /admin/comments/approve/:id              —— 批准文章评论
 *   POST /admin/comments/reject/:id               —— 驳回文章评论
 *   POST /admin/media-comments/approve/:id        —— 批准图片评论
 *   POST /admin/media-comments/reject/:id         —— 驳回图片评论
 *   POST /admin/media-comments/delete/:id         —— 删除图片评论
 *   GET  /admin/comments/pending-count            —— 待审评论总数（导航角标 AJAX）
 * 权限：评论操作均需 comments.manage 权限；全部写审计日志。
 */

const express = require('express');
const router = express.Router();
const { isAuthenticated, hasPermission } = require('../../middlewares/auth');
const { saveDatabase, queryAll, queryOne } = require('../../config/database');
const { logActivity } = require('../../config/activity');

// ============ 评论管理 ============

// 评论列表页：同时查询文章评论与媒体（图片）评论，前端分两个标签展示
router.get('/comments', isAuthenticated, hasPermission('comments.manage'), (req, res) => {
  const db = req.db;
  // 文章评论（关联文章标题与评论者用户名，标记 comment_type='article'）
  const comments = queryAll(db, `
    SELECT c.*, a.title as article_title, u.username as commenter_name, 'article' as comment_type
    FROM comments c
    LEFT JOIN articles a ON c.article_id = a.id
    LEFT JOIN users u ON c.user_id = u.id
    ORDER BY c.created_at DESC
  `);

  // 图片/媒体评论（关联媒体原名与评论者，标记 comment_type='media'）
  const mediaComments = queryAll(db, `
    SELECT mc.*, m.original_name as media_title, u.username as commenter_name, 'media' as comment_type
    FROM media_comments mc
    LEFT JOIN media m ON mc.media_id = m.id
    LEFT JOIN users u ON mc.user_id = u.id
    ORDER BY mc.created_at DESC
  `);

  res.render('admin/comments', {
    user: req.session.user,
    comments: comments,
    mediaComments: mediaComments,
    settings: res.locals.settings || {}
  });
});

// ===== 文章评论操作 =====

// 批准文章评论：状态置 approved
router.post('/comments/approve/:id', isAuthenticated, hasPermission('comments.manage'), (req, res) => {
  const db = req.db;
  const comment = queryOne(db, 'SELECT c.id, c.content, a.title as article_title FROM comments c LEFT JOIN articles a ON c.article_id = a.id WHERE c.id = ?', [req.params.id]);
  db.run("UPDATE comments SET status = 'approved' WHERE id = ?", [req.params.id]);
  saveDatabase();
  if (comment) {
    logActivity(db, { user_id: req.session.user.id, username: req.session.user.username, action: 'approve', target_type: 'comment', target_id: parseInt(req.params.id), target_title: (comment.article_title || '文章') + '的评论', detail: '批准文章评论', ip: req.ip });
  }
  res.redirect('/admin/comments');
});

// 驳回文章评论：状态置 rejected
router.post('/comments/reject/:id', isAuthenticated, hasPermission('comments.manage'), (req, res) => {
  const db = req.db;
  const comment = queryOne(db, 'SELECT c.id, c.content, a.title as article_title FROM comments c LEFT JOIN articles a ON c.article_id = a.id WHERE c.id = ?', [req.params.id]);
  db.run("UPDATE comments SET status = 'rejected' WHERE id = ?", [req.params.id]);
  saveDatabase();
  if (comment) {
    logActivity(db, { user_id: req.session.user.id, username: req.session.user.username, action: 'reject', target_type: 'comment', target_id: parseInt(req.params.id), target_title: (comment.article_title || '文章') + '的评论', detail: '驳回文章评论', ip: req.ip });
  }
  res.redirect('/admin/comments');
});

// ===== 图片评论（媒体评论）操作 =====

// 批准图片评论
router.post('/media-comments/approve/:id', isAuthenticated, hasPermission('comments.manage'), (req, res) => {
  const db = req.db;
  const comment = queryOne(db, 'SELECT mc.id, mc.content, m.original_name as media_title FROM media_comments mc LEFT JOIN media m ON mc.media_id = m.id WHERE mc.id = ?', [req.params.id]);
  db.run("UPDATE media_comments SET status = 'approved' WHERE id = ?", [req.params.id]);
  saveDatabase();
  if (comment) {
    logActivity(db, { user_id: req.session.user.id, username: req.session.user.username, action: 'approve', target_type: 'media_comment', target_id: parseInt(req.params.id), target_title: (comment.media_title || '图片') + '的评论', detail: '批准图片评论', ip: req.ip });
  }
  res.redirect('/admin/comments');
});

// 驳回图片评论
router.post('/media-comments/reject/:id', isAuthenticated, hasPermission('comments.manage'), (req, res) => {
  const db = req.db;
  const comment = queryOne(db, 'SELECT mc.id, mc.content, m.original_name as media_title FROM media_comments mc LEFT JOIN media m ON mc.media_id = m.id WHERE mc.id = ?', [req.params.id]);
  db.run("UPDATE media_comments SET status = 'rejected' WHERE id = ?", [req.params.id]);
  saveDatabase();
  if (comment) {
    logActivity(db, { user_id: req.session.user.id, username: req.session.user.username, action: 'reject', target_type: 'media_comment', target_id: parseInt(req.params.id), target_title: (comment.media_title || '图片') + '的评论', detail: '驳回图片评论', ip: req.ip });
  }
  res.redirect('/admin/comments');
});

// 删除图片评论（彻底删除记录）
router.post('/media-comments/delete/:id', isAuthenticated, hasPermission('comments.manage'), (req, res) => {
  const db = req.db;
  const comment = queryOne(db, 'SELECT mc.id, mc.content, m.original_name as media_title FROM media_comments mc LEFT JOIN media m ON mc.media_id = m.id WHERE mc.id = ?', [req.params.id]);
  db.run('DELETE FROM media_comments WHERE id = ?', [req.params.id]);
  saveDatabase();
  if (comment) {
    logActivity(db, { user_id: req.session.user.id, username: req.session.user.username, action: 'delete', target_type: 'media_comment', target_id: parseInt(req.params.id), target_title: (comment.media_title || '图片') + '的评论', detail: '删除图片评论', ip: req.ip });
  }
  res.redirect('/admin/comments');
});

// 待审评论总数（供后台导航栏红点提示）
router.get('/comments/pending-count', isAuthenticated, (req, res) => {
  const db = req.db;
  const articlePending = queryOne(db, "SELECT COUNT(*) as count FROM comments WHERE status = 'pending'");
  const mediaPending = queryOne(db, "SELECT COUNT(*) as count FROM media_comments WHERE status = 'pending'");
  const totalCount = (articlePending?.count || 0) + (mediaPending?.count || 0);
  res.json({ count: totalCount });
});

module.exports = router;
