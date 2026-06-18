const express = require('express');
const router = express.Router();
const { isAuthenticated, hasPermission } = require('../../middlewares/auth');
const { saveDatabase, queryAll, queryOne } = require('../../config/database');
const { logActivity } = require('../../config/activity');

// ============ 评论管理 ============

router.get('/comments', isAuthenticated, hasPermission('comments.view'), (req, res) => {
  const db = req.db;
  const comments = queryAll(db, `
    SELECT c.*, a.title as article_title, u.username as commenter_name, 'article' as comment_type
    FROM comments c
    LEFT JOIN articles a ON c.article_id = a.id
    LEFT JOIN users u ON c.user_id = u.id
    ORDER BY c.created_at DESC
  `);

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

router.post('/comments/approve/:id', isAuthenticated, hasPermission('comments.view'), (req, res) => {
  const db = req.db;
  const comment = queryOne(db, 'SELECT c.id, c.content, a.title as article_title FROM comments c LEFT JOIN articles a ON c.article_id = a.id WHERE c.id = ?', [req.params.id]);
  db.run("UPDATE comments SET status = 'approved' WHERE id = ?", [req.params.id]);
  saveDatabase();
  if (comment) {
    logActivity(db, { user_id: req.session.user.id, username: req.session.user.username, action: 'approve', target_type: 'comment', target_id: parseInt(req.params.id), target_title: (comment.article_title || '文章') + '的评论', detail: '批准文章评论', ip: req.ip });
  }
  res.redirect('/admin/comments');
});

router.post('/comments/reject/:id', isAuthenticated, hasPermission('comments.view'), (req, res) => {
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

router.post('/media-comments/approve/:id', isAuthenticated, hasPermission('comments.view'), (req, res) => {
  const db = req.db;
  const comment = queryOne(db, 'SELECT mc.id, mc.content, m.original_name as media_title FROM media_comments mc LEFT JOIN media m ON mc.media_id = m.id WHERE mc.id = ?', [req.params.id]);
  db.run("UPDATE media_comments SET status = 'approved' WHERE id = ?", [req.params.id]);
  saveDatabase();
  if (comment) {
    logActivity(db, { user_id: req.session.user.id, username: req.session.user.username, action: 'approve', target_type: 'media_comment', target_id: parseInt(req.params.id), target_title: (comment.media_title || '图片') + '的评论', detail: '批准图片评论', ip: req.ip });
  }
  res.redirect('/admin/comments');
});

router.post('/media-comments/reject/:id', isAuthenticated, hasPermission('comments.view'), (req, res) => {
  const db = req.db;
  const comment = queryOne(db, 'SELECT mc.id, mc.content, m.original_name as media_title FROM media_comments mc LEFT JOIN media m ON mc.media_id = m.id WHERE mc.id = ?', [req.params.id]);
  db.run("UPDATE media_comments SET status = 'rejected' WHERE id = ?", [req.params.id]);
  saveDatabase();
  if (comment) {
    logActivity(db, { user_id: req.session.user.id, username: req.session.user.username, action: 'reject', target_type: 'media_comment', target_id: parseInt(req.params.id), target_title: (comment.media_title || '图片') + '的评论', detail: '驳回图片评论', ip: req.ip });
  }
  res.redirect('/admin/comments');
});

router.post('/media-comments/delete/:id', isAuthenticated, hasPermission('comments.view'), (req, res) => {
  const db = req.db;
  const comment = queryOne(db, 'SELECT mc.id, mc.content, m.original_name as media_title FROM media_comments mc LEFT JOIN media m ON mc.media_id = m.id WHERE mc.id = ?', [req.params.id]);
  db.run('DELETE FROM media_comments WHERE id = ?', [req.params.id]);
  saveDatabase();
  if (comment) {
    logActivity(db, { user_id: req.session.user.id, username: req.session.user.username, action: 'delete', target_type: 'media_comment', target_id: parseInt(req.params.id), target_title: (comment.media_title || '图片') + '的评论', detail: '删除图片评论', ip: req.ip });
  }
  res.redirect('/admin/comments');
});

router.get('/comments/pending-count', isAuthenticated, (req, res) => {
  const db = req.db;
  const articlePending = queryOne(db, "SELECT COUNT(*) as count FROM comments WHERE status = 'pending'");
  const mediaPending = queryOne(db, "SELECT COUNT(*) as count FROM media_comments WHERE status = 'pending'");
  const totalCount = (articlePending?.count || 0) + (mediaPending?.count || 0);
  res.json({ count: totalCount });
});

module.exports = router;
