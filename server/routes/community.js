/**
 * 社区互动路由
 * 用户关注、通知中心、点赞/感谢功能
 */
const express = require('express');
const router = express.Router();
const { queryOne, queryAll, getDb } = require('../config/database');
const { isAuthenticated } = require('../middlewares/auth');

// ==================== 用户关注系统 ====================

/**
 * 关注/取消关注用户
 */
router.post('/api/user/:id/follow', isAuthenticated, (req, res) => {
  const db = getDb();
  const followerId = req.session.user.id;
  const followingId = parseInt(req.params.id);

  if (followerId === followingId) {
    return res.status(400).json({ success: false, error: '不能关注自己' });
  }

  // 检查目标用户是否存在
  const targetUser = queryOne(db, 'SELECT id, username FROM users WHERE id = ?', [followingId]);
  if (!targetUser) {
    return res.status(404).json({ success: false, error: '用户不存在' });
  }

  // 检查是否已关注
  const existing = queryOne(db,
    'SELECT id FROM user_follows WHERE follower_id = ? AND following_id = ?',
    [followerId, followingId]
  );

  try {
    if (existing) {
      // 取消关注
      db.run('DELETE FROM user_follows WHERE follower_id = ? AND following_id = ?', [followerId, followingId]);
      res.json({ success: true, data: { following: false, message: '已取消关注' } });
    } else {
      // 添加关注
      db.run('INSERT INTO user_follows (follower_id, following_id) VALUES (?, ?)', [followerId, followingId]);

      // 创建通知
      createNotification(db, {
        userId: followingId,
        type: 'follow',
        title: '新粉丝',
        content: `用户 ${req.session.user.username} 关注了你`,
        fromUserId: followerId,
        targetType: 'user',
        targetId: String(followerId)
      });

      res.json({ success: true, data: { following: true, message: '已关注' } });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: `操作失败: ${err.message}` });
  }
});

/**
 * 检查关注状态
 */
router.get('/api/user/:id/follow/status', isAuthenticated, (req, res) => {
  const db = getDb();
  const followerId = req.session.user.id;
  const followingId = parseInt(req.params.id);

  const existing = queryOne(db,
    'SELECT id FROM user_follows WHERE follower_id = ? AND following_id = ?',
    [followerId, followingId]
  );

  // 获取关注数
  const followingCount = queryOne(db,
    'SELECT COUNT(*) as count FROM user_follows WHERE follower_id = ?',
    [followingId]
  )?.count || 0;

  // 获取粉丝数
  const followerCount = queryOne(db,
    'SELECT COUNT(*) as count FROM user_follows WHERE following_id = ?',
    [followingId]
  )?.count || 0;

  res.json({
    success: true,
    data: {
      is_following: Boolean(existing),
      following_count: followingCount,
      follower_count: followerCount
    }
  });
});

/**
 * 获取用户的关注列表
 */
router.get('/api/user/:id/following', (req, res) => {
  const db = getDb();
  const userId = parseInt(req.params.id);
  const page = parseInt(req.query.page) || 1;
  const limit = Math.min(parseInt(req.query.limit) || 20, 50);
  const offset = (page - 1) * limit;

  try {
    const total = queryOne(db,
      'SELECT COUNT(*) as count FROM user_follows WHERE follower_id = ?',
      [userId]
    )?.count || 0;

    const following = queryAll(db,
      `SELECT u.id, u.username, u.nickname, u.avatar, u.created_at as user_created_at,
              f.created_at as followed_at
       FROM user_follows f
       JOIN users u ON f.following_id = u.id
       WHERE f.follower_id = ?
       ORDER BY f.created_at DESC
       LIMIT ? OFFSET ?`,
      [userId, limit, offset]
    );

    res.json({
      success: true,
      data: {
        users: following || [],
        pagination: { page, limit, total, hasMore: offset + limit < total }
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: `获取关注列表失败: ${err.message}` });
  }
});

/**
 * 获取用户的粉丝列表
 */
router.get('/api/user/:id/followers', (req, res) => {
  const db = getDb();
  const userId = parseInt(req.params.id);
  const page = parseInt(req.query.page) || 1;
  const limit = Math.min(parseInt(req.query.limit) || 20, 50);
  const offset = (page - 1) * limit;

  try {
    const total = queryOne(db,
      'SELECT COUNT(*) as count FROM user_follows WHERE following_id = ?',
      [userId]
    )?.count || 0;

    const followers = queryAll(db,
      `SELECT u.id, u.username, u.nickname, u.avatar, u.created_at as user_created_at,
              f.created_at as followed_at
       FROM user_follows f
       JOIN users u ON f.follower_id = u.id
       WHERE f.following_id = ?
       ORDER BY f.created_at DESC
       LIMIT ? OFFSET ?`,
      [userId, limit, offset]
    );

    res.json({
      success: true,
      data: {
        users: followers || [],
        pagination: { page, limit, total, hasMore: offset + limit < total }
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: `获取粉丝列表失败: ${err.message}` });
  }
});

// ==================== 通知中心 ====================

/**
 * 创建通知（内部函数）
 */
function createNotification(db, { userId, type, title, content, fromUserId, targetType, targetId }) {
  try {
    db.run(
      `INSERT INTO notifications (user_id, type, title, content, from_user_id, target_type, target_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [userId, type, title, content || '', fromUserId || null, targetType || '', targetId || '']
    );
    return true;
  } catch (err) {
    console.error('[通知] 创建通知失败:', err.message);
    return false;
  }
}

/**
 * 获取用户通知列表
 */
router.get('/api/notifications', isAuthenticated, (req, res) => {
  const db = getDb();
  const userId = req.session.user.id;
  const page = parseInt(req.query.page) || 1;
  const limit = Math.min(parseInt(req.query.limit) || 20, 50);
  const offset = (page - 1) * limit;
  const unreadOnly = req.query.unread === 'true';

  try {
    let whereClause = 'WHERE n.user_id = ?';
    const params = [userId];

    if (unreadOnly) {
      whereClause += ' AND n.is_read = 0';
    }

    const total = queryOne(db,
      `SELECT COUNT(*) as count FROM notifications n ${whereClause}`,
      params
    )?.count || 0;

    const notifications = queryAll(db,
      `SELECT n.*, u.username as from_username, u.nickname as from_nickname, u.avatar as from_avatar
       FROM notifications n
       LEFT JOIN users u ON n.from_user_id = u.id
       ${whereClause}
       ORDER BY n.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    // 获取未读数量
    const unreadCount = queryOne(db,
      'SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND is_read = 0',
      [userId]
    )?.count || 0;

    res.json({
      success: true,
      data: {
        notifications: notifications || [],
        unread_count: unreadCount,
        pagination: { page, limit, total, hasMore: offset + limit < total }
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: `获取通知失败: ${err.message}` });
  }
});

/**
 * 标记通知为已读
 */
router.patch('/api/notifications/:id/read', isAuthenticated, (req, res) => {
  const db = getDb();
  const userId = req.session.user.id;
  const notificationId = parseInt(req.params.id);

  try {
    db.run(
      'UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?',
      [notificationId, userId]
    );
    res.json({ success: true, message: '已标记为已读' });
  } catch (err) {
    res.status(500).json({ success: false, error: `操作失败: ${err.message}` });
  }
});

/**
 * 标记所有通知为已读
 */
router.patch('/api/notifications/read-all', isAuthenticated, (req, res) => {
  const db = getDb();
  const userId = req.session.user.id;

  try {
    db.run(
      'UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0',
      [userId]
    );
    res.json({ success: true, message: '已全部标记为已读' });
  } catch (err) {
    res.status(500).json({ success: false, error: `操作失败: ${err.message}` });
  }
});

/**
 * 删除通知
 */
router.delete('/api/notifications/:id', isAuthenticated, (req, res) => {
  const db = getDb();
  const userId = req.session.user.id;
  const notificationId = parseInt(req.params.id);

  try {
    db.run('DELETE FROM notifications WHERE id = ? AND user_id = ?', [notificationId, userId]);
    res.json({ success: true, message: '通知已删除' });
  } catch (err) {
    res.status(500).json({ success: false, error: `删除失败: ${err.message}` });
  }
});

/**
 * 获取未读通知数量
 */
router.get('/api/notifications/unread-count', isAuthenticated, (req, res) => {
  const db = getDb();
  const userId = req.session.user.id;

  try {
    const count = queryOne(db,
      'SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND is_read = 0',
      [userId]
    )?.count || 0;

    res.json({ success: true, data: { count } });
  } catch (err) {
    res.status(500).json({ success: false, error: `获取失败: ${err.message}` });
  }
});

// ==================== 点赞/感谢功能 ====================

/**
 * 点赞/取消点赞内容
 * target_type: 'article', 'comment', 'image', 'image_comment', 'novel_chapter'
 */
router.post('/api/like/:targetType/:targetId', isAuthenticated, (req, res) => {
  const db = getDb();
  const userId = req.session.user.id;
  const targetType = req.params.targetType;
  const targetId = parseInt(req.params.targetId);
  const likeType = req.body.like_type || 'like';

  const validTypes = ['article', 'comment', 'image', 'image_comment', 'novel_chapter'];
  if (!validTypes.includes(targetType)) {
    return res.status(400).json({ success: false, error: '不支持的点赞类型' });
  }

  // 检查目标是否存在
  let targetExists = false;
  if (targetType === 'article') {
    targetExists = Boolean(queryOne(db, 'SELECT id FROM articles WHERE id = ?', [targetId]));
  } else if (targetType === 'comment') {
    targetExists = Boolean(queryOne(db, 'SELECT id FROM comments WHERE id = ?', [targetId]));
  } else if (targetType === 'image') {
    targetExists = Boolean(queryOne(db, 'SELECT id FROM images WHERE id = ?', [targetId]));
  } else if (targetType === 'image_comment') {
    targetExists = Boolean(queryOne(db, 'SELECT id FROM image_comments WHERE id = ?', [targetId]));
  } else if (targetType === 'novel_chapter') {
    targetExists = Boolean(queryOne(db, 'SELECT id FROM novel_chapters WHERE id = ?', [targetId]));
  }

  if (!targetExists) {
    return res.status(404).json({ success: false, error: '目标不存在' });
  }

  // 检查是否已点赞
  const existing = queryOne(db,
    'SELECT id, like_type FROM content_likes WHERE user_id = ? AND target_type = ? AND target_id = ?',
    [userId, targetType, targetId]
  );

  try {
    if (existing) {
      // 取消点赞
      db.run('DELETE FROM content_likes WHERE id = ?', [existing.id]);
      const count = queryOne(db,
        'SELECT COUNT(*) as count FROM content_likes WHERE target_type = ? AND target_id = ?',
        [targetType, targetId]
      )?.count || 0;

      res.json({ success: true, data: { liked: false, like_count: count, message: '已取消点赞' } });
    } else {
      // 添加点赞
      db.run(
        'INSERT INTO content_likes (user_id, target_type, target_id, like_type) VALUES (?, ?, ?, ?)',
        [userId, targetType, targetId, likeType]
      );

      const count = queryOne(db,
        'SELECT COUNT(*) as count FROM content_likes WHERE target_type = ? AND target_id = ?',
        [targetType, targetId]
      )?.count || 0;

      // 触发通知 - 通知被点赞内容的作者
      let contentOwnerId = null;
      let contentTitle = '';
      if (targetType === 'article') {
        const article = queryOne(db, 'SELECT author_id, title FROM articles WHERE id = ?', [targetId]);
        if (article) {
          contentOwnerId = article.author_id;
          contentTitle = article.title;
        }
      } else if (targetType === 'comment') {
        const comment = queryOne(db, 'SELECT user_id FROM comments WHERE id = ?', [targetId]);
        if (comment) contentOwnerId = comment.user_id;
      } else if (targetType === 'image') {
        const image = queryOne(db, 'SELECT user_id, title FROM images WHERE id = ?', [targetId]);
        if (image) {
          contentOwnerId = image.user_id;
          contentTitle = image.title;
        }
      }

      if (contentOwnerId && contentOwnerId !== userId) {
        const typeNames = { article: '文章', comment: '评论', image: '图片' };
        createNotification(db, {
          userId: contentOwnerId,
          type: 'like',
          title: '收到新点赞',
          content: `用户 ${req.session.user.username} 点赞了你的${typeNames[targetType] || '内容'}${contentTitle ? '《' + contentTitle + '》' : ''}`,
          fromUserId: userId,
          targetType: targetType,
          targetId: String(targetId)
        });
      }

      res.json({ success: true, data: { liked: true, like_count: count, message: '点赞成功' } });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: `操作失败: ${err.message}` });
  }
});

/**
 * 获取点赞状态和数量
 */
router.get('/api/like/:targetType/:targetId/status', isAuthenticated, (req, res) => {
  const db = getDb();
  const userId = req.session.user.id;
  const targetType = req.params.targetType;
  const targetId = parseInt(req.params.targetId);

  const existing = queryOne(db,
    'SELECT id, like_type FROM content_likes WHERE user_id = ? AND target_type = ? AND target_id = ?',
    [userId, targetType, targetId]
  );

  const count = queryOne(db,
    'SELECT COUNT(*) as count FROM content_likes WHERE target_type = ? AND target_id = ?',
    [targetType, targetId]
  )?.count || 0;

  res.json({
    success: true,
    data: {
      liked: Boolean(existing),
      like_type: existing?.like_type || null,
      like_count: count
    }
  });
});

/**
 * 获取内容的点赞用户列表
 */
router.get('/api/like/:targetType/:targetId/users', (req, res) => {
  const db = getDb();
  const targetType = req.params.targetType;
  const targetId = parseInt(req.params.targetId);
  const limit = Math.min(parseInt(req.query.limit) || 10, 50);

  const users = queryAll(db,
    `SELECT u.id, u.username, u.nickname, u.avatar, l.created_at as liked_at
     FROM content_likes l
     JOIN users u ON l.user_id = u.id
     WHERE l.target_type = ? AND l.target_id = ?
     ORDER BY l.created_at DESC
     LIMIT ?`,
    [targetType, targetId, limit]
  );

  res.json({ success: true, data: users || [] });
});

module.exports = router;
module.exports.createNotification = createNotification;
