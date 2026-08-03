const express = require('express');
const { queryOne, queryAll, getDb, saveDatabase } = require('../../config/database');
const { apiAuth } = require('../../middlewares/api-auth');

const router = express.Router();

// ============ 社区动态流（与网页端语义一致） ============
router.get('/community/feed', (req, res) => {
  const db = getDb();
  const userId = req.apiUser ? req.apiUser.id : null;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 10));
  const offset = (page - 1) * limit;

  let rows;
  if (userId) {
    rows = queryAll(db, `
      SELECT 'article' AS type, a.id, a.title AS content, a.cover_image, a.created_at,
        u.id AS user_id, u.username, u.nickname, u.avatar AS user_avatar
      FROM articles a
      JOIN users u ON a.author_id = u.id
      WHERE a.status = 'published' AND a.author_id IN (
        SELECT following_id FROM user_follows WHERE follower_id = ?
      )
      UNION ALL
      SELECT 'comment' AS type, c.id, substr(c.content, 1, 100) AS content, NULL AS cover_image, c.created_at,
        u.id AS user_id, u.username, u.nickname, u.avatar AS user_avatar
      FROM comments c
      JOIN users u ON c.user_id = u.id
      WHERE c.user_id IN (
        SELECT following_id FROM user_follows WHERE follower_id = ?
      ) AND c.status = 'approved'
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `, [userId, userId, limit, offset]);
  } else {
    rows = queryAll(db, `
      SELECT 'article' AS type, a.id, a.title AS content, a.cover_image, a.created_at,
        u.id AS user_id, u.username, u.nickname, u.avatar AS user_avatar
      FROM articles a
      JOIN users u ON a.author_id = u.id
      WHERE a.status = 'published'
      ORDER BY a.created_at DESC
      LIMIT ? OFFSET ?
    `, [limit, offset]);
  }

  const posts = (rows || []).map((r) => {
    const likeCount = queryOne(db,
      "SELECT COUNT(*) AS count FROM content_likes WHERE target_type = ? AND target_id = ?",
      [r.type, r.id])?.count || 0;
    const commentCount = r.type === 'article'
      ? (queryOne(db, "SELECT COUNT(*) AS count FROM comments WHERE article_id = ? AND status = 'approved'", [r.id])?.count || 0)
      : 0;
    return {
      ...r,
      user_name: r.nickname || r.username,
      target_type: r.type,
      target_id: r.id,
      target_title: r.content,
      like_count: likeCount,
      comment_count: commentCount,
      is_liked: userId ? Boolean(queryOne(db,
        "SELECT id FROM content_likes WHERE user_id = ? AND target_type = ? AND target_id = ?",
        [userId, r.type, r.id])) : false,
      images: r.cover_image ? [r.cover_image] : [],
    };
  });

  res.json({ posts, page, has_more: posts.length === limit });
});

// ============ 发布动态（动态写入 notifications 形式的活动记录） ============
router.post('/community/posts', apiAuth, (req, res) => {
  const db = getDb();
  const content = (req.body.content || '').trim();
  if (!content) return res.status(400).json({ error: '动态内容不能为空' });
  if (content.length > 500) return res.status(400).json({ error: '动态内容过长' });

  // 站内动态目前以「操作通知」形式记录；关注者通过 feed 聚合看到文章/评论动态
  db.run(
    'INSERT INTO notifications (user_id, type, title, content, from_user_id, target_type, target_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [req.apiUser.id, 'post', '发布动态', content, req.apiUser.id, 'post', String(Date.now())]
  );
  saveDatabase();
  res.json({ success: true, message: '发布成功' });
});

// ============ 关注 / 取消关注 ============
router.post('/users/:id/follow', apiAuth, (req, res) => {
  const db = getDb();
  const targetId = parseInt(req.params.id);
  const userId = req.apiUser.id;

  if (targetId === userId) {
    return res.status(400).json({ error: '不能关注自己' });
  }
  const target = queryOne(db, 'SELECT id FROM users WHERE id = ? AND status = ?', [targetId, 'active']);
  if (!target) return res.status(404).json({ error: '用户不存在' });

  const existing = queryOne(db, 'SELECT id FROM user_follows WHERE follower_id = ? AND following_id = ?', [userId, targetId]);
  if (existing) {
    db.run('DELETE FROM user_follows WHERE id = ?', [existing.id]);
  } else {
    db.run('INSERT INTO user_follows (follower_id, following_id) VALUES (?, ?)', [userId, targetId]);
  }
  saveDatabase();
  res.json({ following: !existing });
});

// ============ 通用点赞 ============
const VALID_LIKE_TYPES = ['article', 'comment', 'image', 'image_comment', 'novel_chapter'];

router.post('/like/:targetType/:targetId', apiAuth, (req, res) => {
  const db = getDb();
  const targetType = req.params.targetType;
  const targetId = parseInt(req.params.targetId);
  const userId = req.apiUser.id;

  if (!VALID_LIKE_TYPES.includes(targetType)) {
    return res.status(400).json({ error: '不支持的点赞类型' });
  }

  const existing = queryOne(db,
    'SELECT id FROM content_likes WHERE user_id = ? AND target_type = ? AND target_id = ?',
    [userId, targetType, targetId]);
  if (existing) {
    db.run('DELETE FROM content_likes WHERE id = ?', [existing.id]);
  } else {
    db.run('INSERT INTO content_likes (user_id, target_type, target_id, like_type) VALUES (?, ?, ?, ?)',
      [userId, targetType, targetId, req.body.like_type || 'like']);
  }
  saveDatabase();
  const count = queryOne(db,
    'SELECT COUNT(*) AS count FROM content_likes WHERE target_type = ? AND target_id = ?',
    [targetType, targetId])?.count || 0;
  res.json({ liked: !existing, count });
});

// ============ 用户主页信息 ============
router.get('/users/:id', (req, res) => {
  const db = getDb();
  const id = parseInt(req.params.id);
  const user = queryOne(db,
    'SELECT id, uid, username, nickname, avatar, bio, role, created_at FROM users WHERE id = ? AND status = ?',
    [id, 'active']);
  if (!user) return res.status(404).json({ error: '用户不存在' });

  const followerCount = queryOne(db, 'SELECT COUNT(*) AS count FROM user_follows WHERE following_id = ?', [id])?.count || 0;
  const followingCount = queryOne(db, 'SELECT COUNT(*) AS count FROM user_follows WHERE follower_id = ?', [id])?.count || 0;
  const articleCount = queryOne(db, "SELECT COUNT(*) AS count FROM articles WHERE author_id = ? AND status = 'published'", [id])?.count || 0;

  res.json({
    user: {
      ...user,
      follower_count: followerCount,
      following_count: followingCount,
      article_count: articleCount,
    },
  });
});

// ============ 通知 ============
router.get('/notifications', apiAuth, (req, res) => {
  const db = getDb();
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
  const offset = (page - 1) * limit;

  const total = queryOne(db, 'SELECT COUNT(*) AS count FROM notifications WHERE user_id = ?', [req.apiUser.id])?.count || 0;
  const rows = queryAll(db, `
    SELECT n.*, u.username AS from_username, u.nickname AS from_nickname, u.avatar AS from_avatar
    FROM notifications n LEFT JOIN users u ON n.from_user_id = u.id
    WHERE n.user_id = ?
    ORDER BY n.created_at DESC LIMIT ? OFFSET ?
  `, [req.apiUser.id, limit, offset]);

  res.json({
    notifications: (rows || []).map((n) => ({ ...n, from_user_name: n.from_nickname || n.from_username || '' })),
    total,
  });
});

// ============ 标记全部通知已读 ============
router.post('/notifications/read-all', apiAuth, (req, res) => {
  const db = getDb();
  db.run('UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0', [req.apiUser.id]);
  saveDatabase();
  res.json({ success: true });
});

module.exports = router;
