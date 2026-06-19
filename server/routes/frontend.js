const express = require('express');
const path = require('path');
const router = express.Router();
const { queryAll, queryOne, saveDatabase } = require('../config/database');
const { isAuthenticated, canEditArticle, hasFrontendPermission } = require('../middlewares/auth');
const { settingsCache, queryCache } = require('../config/cache');
const { createNotification } = require('./community');
const { getSettings } = require('../utils/settings');

// 缓存包装：对查询结果进行短时间缓存（10秒）
function cachedQuery(cacheKey, db, sql, params = []) {
  const key = `${cacheKey}:${sql}:${JSON.stringify(params)}`;
  let result = queryCache.get(key);
  if (result === null) {
    result = queryAll(db, sql, params);
    queryCache.set(key, result, 10);
  }
  return result;
}

// 缓存包装：单行查询
function cachedQueryOne(cacheKey, db, sql, params = []) {
  const results = cachedQuery(cacheKey, db, sql, params);
  return results[0] || null;
}

// 首页根路径 - 直接渲染项目首页
router.get('/', (req, res) => {
  const db = req.db;

  const settings = getSettings(db);
  const articles = cachedQuery('home_articles', db,
    "SELECT * FROM articles WHERE status = 'published' AND (location = 'home' OR location = 'both') ORDER BY created_at DESC LIMIT 10");
  const pages = cachedQuery('nav_pages', db,
    "SELECT * FROM pages WHERE status = 'published' AND parent_id = 0 ORDER BY sort_order ASC");

  res.render('frontend/index', {
    user: req.session.user || null,
    settings: settings,
    articles: articles,
    pages: pages
  });
});

// 首页
router.get('/home', (req, res) => {
  const db = req.db;

  const settings = getSettings(db);
  const articles = cachedQuery('home_articles', db,
    "SELECT * FROM articles WHERE status = 'published' AND (location = 'home' OR location = 'both') ORDER BY created_at DESC LIMIT 10");
  const pages = cachedQuery('nav_pages', db,
    "SELECT * FROM pages WHERE status = 'published' AND parent_id = 0 ORDER BY sort_order ASC");

  res.render('frontend/index', {
    user: req.session.user || null,
    settings: settings,
    articles: articles,
    pages: pages
  });
});

// ============ 前端文章管理（登录用户） ============
// 注意：具体路由（/new、/save）必须放在参数化路由（/:id）之前

// 新建文章页面（前端）
router.get('/articles/new', isAuthenticated, (req, res) => {
  const db = req.db;
  const settings = getSettings(db);

  res.render('frontend/article-editor', {
    user: req.session.user || null,
    settings: settings,
    article: null
  });
});

// 保存文章（前端）
router.post('/articles/save', isAuthenticated, (req, res) => {
  const db = req.db;
  const { id, title, content, category, status, cover_image, location } = req.body;

  if (!title) {
    return res.status(400).json({ error: '文章标题不能为空' });
  }

  if (id) {
    // 验证是否为作者本人
    const article = queryOne(db, 'SELECT * FROM articles WHERE id = ?', [id]);
    if (!article) {
      return res.status(404).json({ error: '文章不存在' });
    }
    if (article.author_id !== req.session.user.id && req.session.user.role !== 'admin' && req.session.user.role !== 'super_admin') {
      return res.status(403).json({ error: '无权编辑此文章' });
    }
    db.run('UPDATE articles SET title=?, content=?, category=?, location=?, status=?, cover_image=?, updated_at=CURRENT_TIMESTAMP WHERE id=?',
      [title, content, category || '', location || 'home', status || 'published', cover_image || '', id]);
  } else {
    db.run('INSERT INTO articles (title, content, category, location, status, cover_image, author_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [title, content, category || '', location || 'home', status || 'published', cover_image || '', req.session.user.id]);
  }

  // 清除相关缓存
  queryCache.delete('home_articles');
  queryCache.delete('articles_list');

  saveDatabase();
  res.redirect('/articles');
});

// 编辑文章页面（前端）
router.get('/articles/:id/edit', isAuthenticated, canEditArticle, (req, res) => {
  const db = req.db;
  const settings = getSettings(db);
  const article = queryOne(db, 'SELECT * FROM articles WHERE id = ?', [req.params.id]);

  if (!article) {
    return res.status(404).render('frontend/error', {
      message: '文章不存在',
      error: '您访问的文章不存在或已被删除',
      settings: settings,
      user: req.session.user || null
    });
  }

  res.render('frontend/article-editor', {
    user: req.session.user || null,
    settings: settings,
    article: article
  });
});

// 文章列表（登录用户可看到自己的文章在前面）
router.get('/articles', (req, res) => {
  const db = req.db;

  const settings = getSettings(db);
  const articles = cachedQuery('articles_list', db,
    "SELECT a.*, u.username as author_name, u.uid as author_uid FROM articles a LEFT JOIN users u ON a.author_id = u.id WHERE a.status = 'published' AND (a.location = 'both' OR a.location = 'category' OR a.location = 'home') ORDER BY a.created_at DESC");

  // 获取当前登录用户的文章（含草稿）- 这个不缓存，因为是个人的
  let myArticles = [];
  if (req.session.user) {
    myArticles = queryAll(db, 'SELECT a.*, u.username as author_name FROM articles a LEFT JOIN users u ON a.author_id = u.id WHERE a.author_id = ? ORDER BY a.created_at DESC', [req.session.user.id]);
  }

  res.render('frontend/articles', {
    user: req.session.user || null,
    settings: settings,
    articles: articles,
    myArticles: myArticles
  });
});

// 文章详情（含评论）
router.get('/articles/:id', (req, res) => {
  const db = req.db;

  const settings = getSettings(db);
  const article = queryOne(db, "SELECT a.*, u.username as author_name, u.uid as author_uid FROM articles a LEFT JOIN users u ON a.author_id = u.id WHERE a.id = ? AND a.status = 'published'", [req.params.id]);

  if (!article) {
    return res.status(404).render('frontend/error', {
      message: '文章不存在',
      error: '您访问的文章不存在或已被删除',
      settings: settings,
      user: req.session.user || null
    });
  }

  // 获取已审核的评论
  const comments = queryAll(db, `
    SELECT c.*, u.username as commenter_name 
    FROM comments c 
    LEFT JOIN users u ON c.user_id = u.id 
    WHERE c.article_id = ? AND c.status = 'approved' AND c.parent_id = 0
    ORDER BY c.created_at ASC
  `, [req.params.id]);

  // 获取子评论
  const allComments = queryAll(db, `
    SELECT c.*, u.username as commenter_name 
    FROM comments c 
    LEFT JOIN users u ON c.user_id = u.id 
    WHERE c.article_id = ? AND c.status = 'approved' AND c.parent_id > 0
    ORDER BY c.created_at ASC
  `, [req.params.id]);

  // 组织评论层级
  const commentMap = {};
  comments.forEach(c => {
    c.replies = [];
    commentMap[c.id] = c;
  });
  allComments.forEach(c => {
    if (commentMap[c.parent_id]) {
      commentMap[c.parent_id].replies.push(c);
    }
  });

  res.render('frontend/article-detail', {
    user: req.session.user || null,
    settings: settings,
    article: article,
    comments: comments,
    error: req.query.error || null,
    success: req.query.success || null,
    currentUserId: req.session.user ? req.session.user.id : null
  });
});

// 提交评论
router.post('/articles/:id/comment', (req, res) => {
  const db = req.db;
  const articleId = req.params.id;
  const { content, visitor_name, visitor_email, parent_id } = req.body;

  if (!content || content.trim().length === 0) {
    return res.redirect(`/articles/${articleId}?error=评论内容不能为空`);
  }

  // 检查文章是否存在
  const article = queryOne(db, "SELECT id FROM articles WHERE id = ? AND status = 'published'", [articleId]);
  if (!article) {
    return res.status(404).render('frontend/error', {
      message: '文章不存在',
      error: '您访问的文章不存在或已被删除',
      user: req.session.user || null
    });
  }

  if (req.session.user) {
    // 登录用户评论 - 直接通过审核
    db.run("INSERT INTO comments (article_id, user_id, content, status, parent_id) VALUES (?, ?, ?, 'approved', ?)",
      [articleId, req.session.user.id, content.trim(), parent_id || 0]);

    // 触发通知 - 通知文章作者
    const articleInfo = queryOne(db, 'SELECT author_id, title FROM articles WHERE id = ?', [articleId]);
    if (articleInfo && articleInfo.author_id && articleInfo.author_id !== req.session.user.id) {
      createNotification(db, {
        userId: articleInfo.author_id,
        type: 'comment',
        title: '新评论',
        content: `用户 ${req.session.user.username} 评论了你的文章《${articleInfo.title}》`,
        fromUserId: req.session.user.id,
        targetType: 'article',
        targetId: String(articleId)
      });
    }

    // 如果是回复评论，还通知被回复的人
    const parentId = parseInt(parent_id) || 0;
    if (parentId > 0) {
      const parentComment = queryOne(db, 'SELECT user_id FROM comments WHERE id = ?', [parentId]);
      if (parentComment && parentComment.user_id && parentComment.user_id !== req.session.user.id) {
        createNotification(db, {
          userId: parentComment.user_id,
          type: 'comment_reply',
          title: '新回复',
          content: `用户 ${req.session.user.username} 回复了你的评论`,
          fromUserId: req.session.user.id,
          targetType: 'article',
          targetId: String(articleId)
        });
      }
    }
  } else {
    // 访客评论
    if (!visitor_name || !visitor_email) {
      return res.redirect(`/articles/${articleId}?error=访客评论需要填写姓名和邮箱`);
    }
    db.run("INSERT INTO comments (article_id, visitor_name, visitor_email, content, status, parent_id) VALUES (?, ?, ?, ?, 'pending', ?)",
      [articleId, visitor_name, visitor_email, content.trim(), parent_id || 0]);
  }

  saveDatabase();
  const articleSuccessMsg = req.session.user ? '评论提交成功' : '评论提交成功，等待管理员审核';
  res.redirect(`/articles/${articleId}?success=${encodeURIComponent(articleSuccessMsg)}`);
});

// 动态页面（根据 slug）
router.get('/page/:slug', (req, res) => {
  const db = req.db;

  const settings = getSettings(db);
  const page = queryOne(db, "SELECT * FROM pages WHERE slug = ? AND status = 'published'", [req.params.slug]);

  if (!page) {
    return res.status(404).render('frontend/error', {
      message: '页面不存在',
      error: '您访问的页面不存在或已被删除',
      settings: settings,
      user: req.session.user || null
    });
  }

  res.render('frontend/page', {
    user: req.session.user || null,
    settings: settings,
    page: page
  });
});

// ============ 小说（需登录） ============
// 小说列表（需登录 + 小说访问权限）
router.get('/novels', isAuthenticated, hasFrontendPermission('novels.access'), (req, res) => {
  const db = req.db;
  const settings = getSettings(db);

  const novels = cachedQuery('novels_list', db, `
    SELECT n.*, u.username as uploader_name,
    (SELECT COUNT(*) FROM novel_chapters WHERE novel_id = n.id) as chapter_count
    FROM novels n
    LEFT JOIN users u ON n.uploaded_by = u.id
    WHERE n.status = 'published'
    ORDER BY n.created_at DESC
  `);

  res.render('frontend/novels', {
    user: req.session.user || null,
    settings: settings,
    novels: novels
  });
});

// 小说详情/阅读页（需登录）
router.get('/novels/:id', isAuthenticated, (req, res) => {
  const db = req.db;
  const settings = getSettings(db);

  const novel = queryOne(db, "SELECT * FROM novels WHERE id = ? AND status = 'published'", [req.params.id]);

  if (!novel) {
    return res.status(404).render('frontend/error', {
      message: '小说不存在',
      error: '您访问的小说不存在或已被删除',
      settings: settings,
      user: req.session.user || null
    });
  }

  const chapters = queryAll(db, 'SELECT * FROM novel_chapters WHERE novel_id = ? ORDER BY chapter_number ASC', [req.params.id]);

  res.render('frontend/novel-reader', {
    user: req.session.user || null,
    settings: settings,
    novel: novel,
    chapters: chapters,
    currentChapter: null,
    chapterIndex: -1
  });
});

// 小说章节阅读（含分页，需登录）
router.get('/novels/:id/chapter/:chapterId', isAuthenticated, (req, res) => {
  const db = req.db;
  const settings = getSettings(db);

  const novel = queryOne(db, "SELECT * FROM novels WHERE id = ? AND status = 'published'", [req.params.id]);

  if (!novel) {
    return res.status(404).render('frontend/error', {
      message: '小说不存在',
      error: '您访问的小说不存在或已被删除',
      settings: settings,
      user: req.session.user || null
    });
  }

  const chapters = queryAll(db, 'SELECT * FROM novel_chapters WHERE novel_id = ? ORDER BY chapter_number ASC', [req.params.id]);
  const currentChapter = queryOne(db, 'SELECT * FROM novel_chapters WHERE id = ? AND novel_id = ?', [req.params.chapterId, req.params.id]);

  if (!currentChapter) {
    return res.status(404).render('frontend/error', {
      message: '章节不存在',
      error: '您访问的章节不存在',
      settings: settings,
      user: req.session.user || null
    });
  }

  // 找当前章节索引
  const chapterIndex = chapters.findIndex(ch => ch.id === Number(req.params.chapterId));

  res.render('frontend/novel-reader', {
    user: req.session.user || null,
    settings: settings,
    novel: novel,
    chapters: chapters,
    currentChapter: currentChapter,
    chapterIndex: chapterIndex
  });
});

// ============ 站内信（用户端） ============

router.get('/messages', isAuthenticated, (req, res) => {
  const db = req.db;
  const settings = getSettings(db);
  const userId = req.session.user.id;

  const messages = queryAll(db, `
    SELECT m.id, m.from_user_id, m.to_user_id, m.title, m.content, m.is_read, m.is_popup, m.created_at,
      COALESCE(u.username, m.from_username) as from_username
    FROM internal_messages m
    LEFT JOIN users u ON m.from_user_id = u.id
    WHERE m.to_user_id = ?
    ORDER BY m.is_read ASC, m.created_at DESC
  `, [userId]);

  res.render('frontend/messages', {
    user: req.session.user,
    settings: settings,
    messages: messages
  });
});

router.get('/messages/unread-count', isAuthenticated, (req, res) => {
  const db = req.db;
  const count = queryOne(db,
    'SELECT COUNT(*) as count FROM internal_messages WHERE to_user_id = ? AND is_read = 0',
    [req.session.user.id]
  );
  res.json({ count: count ? count.count : 0 });
});

router.get('/messages/check-popup', isAuthenticated, (req, res) => {
  const db = req.db;
  const msg = queryOne(db,
    'SELECT * FROM internal_messages WHERE to_user_id = ? AND is_read = 0 AND is_popup = 1 ORDER BY created_at DESC LIMIT 1',
    [req.session.user.id]
  );
  if (msg) {
    db.run('UPDATE internal_messages SET is_read = 1 WHERE id = ?', [msg.id]);
    saveDatabase();
    res.json({ hasPopup: true, message: { id: msg.id, title: msg.title, content: msg.content } });
  } else {
    res.json({ hasPopup: false });
  }
});

router.post('/messages/mark-read/:id', isAuthenticated, (req, res) => {
  const db = req.db;
  db.run('UPDATE internal_messages SET is_read = 1 WHERE id = ? AND to_user_id = ?',
    [req.params.id, req.session.user.id]);
  saveDatabase();
  res.json({ success: true });
});

router.post('/messages/mark-all-read', isAuthenticated, (req, res) => {
  const db = req.db;
  db.run('UPDATE internal_messages SET is_read = 1 WHERE to_user_id = ? AND is_read = 0',
    [req.session.user.id]);
  saveDatabase();
  res.json({ success: true });
});

router.post('/messages/delete/:id', isAuthenticated, (req, res) => {
  const db = req.db;
  db.run('DELETE FROM internal_messages WHERE id = ? AND to_user_id = ?',
    [req.params.id, req.session.user.id]);
  saveDatabase();
  res.redirect('/messages');
});

// ============ 搜索功能（所有用户均可使用，包括未注册用户） ============
router.get('/search', (req, res) => {
  const db = req.db;
  const settings = getSettings(db);
  const keyword = (req.query.q || '').trim();

  let articles = [];
  if (keyword) {
    articles = queryAll(db, `
      SELECT a.*, u.username as author_name
      FROM articles a
      LEFT JOIN users u ON a.author_id = u.id
      WHERE a.status = 'published' AND (a.title LIKE ? OR a.content LIKE ?)
      ORDER BY a.created_at DESC
      LIMIT 50
    `, [`%${keyword}%`, `%${keyword}%`]);
  }

  res.render('frontend/search', {
    user: req.session.user || null,
    settings: settings,
    articles: articles,
    keyword: keyword
  });
});

// ============ 社区主页 ============
router.get('/community', (req, res) => {
  const db = req.db;
  const settings = getSettings(db);
  const userId = req.session && req.session.user ? req.session.user.id : null;
  const page = parseInt(req.query.page) || 1;
  const limit = 20;
  const offset = (page - 1) * limit;

  let feedItems = [];

  if (userId) {
    feedItems = queryAll(db, `
      SELECT 'article' as type, a.id, a.title as content, a.cover_image, a.created_at,
        u.id as user_id, u.uid as user_uid, u.username, u.nickname, u.avatar
      FROM articles a
      JOIN users u ON a.author_id = u.id
      WHERE a.status = 'published' AND a.author_id IN (
        SELECT following_id FROM user_follows WHERE follower_id = ?
      )
      UNION ALL
      SELECT 'comment' as type, c.id, substr(c.content, 1, 100) as content, NULL as cover_image, c.created_at,
        u.id as user_id, u.uid as user_uid, u.username, u.nickname, u.avatar
      FROM comments c
      JOIN users u ON c.user_id = u.id
      WHERE c.user_id IN (
        SELECT following_id FROM user_follows WHERE follower_id = ?
      ) AND c.status = 'approved'
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `, [userId, userId, limit, offset]);
  } else {
    feedItems = queryAll(db, `
      SELECT 'article' as type, a.id, a.title as content, a.cover_image, a.created_at,
        u.id as user_id, u.uid as user_uid, u.username, u.nickname, u.avatar
      FROM articles a
      JOIN users u ON a.author_id = u.id
      WHERE a.status = 'published'
      ORDER BY a.created_at DESC
      LIMIT ? OFFSET ?
    `, [limit, offset]);
  }

  res.render('frontend/community', {
    user: req.session ? req.session.user : null,
    settings: settings,
    feed: feedItems,
    page: page,
    hasMore: feedItems.length === limit
  });
});

// ============ 用户个人主页 ============
router.get('/user/:id', (req, res) => {
  const db = req.db;
  const settings = getSettings(db);
  const param = req.params.id;
  const currentUserId = req.session && req.session.user ? req.session.user.id : null;

  // 支持通过 uid 或数字 id 查找
  let profileUser;
  if (/^\d+$/.test(param)) {
    profileUser = queryOne(db,
      'SELECT id, uid, username, nickname, avatar, bio, created_at FROM users WHERE id = ?',
      [parseInt(param)]
    );
  } else {
    profileUser = queryOne(db,
      'SELECT id, uid, username, nickname, avatar, bio, created_at FROM users WHERE uid = ?',
      [param.toUpperCase()]
    );
  }
  if (!profileUser) {
    return res.status(404).render('frontend/error', {
      message: '用户不存在',
      error: '您访问的用户不存在',
      user: req.session ? req.session.user : null,
      settings: settings
    });
  }

  const profileUserId = profileUser.id;

  const isFollowing = currentUserId ? Boolean(queryOne(db,
    'SELECT id FROM user_follows WHERE follower_id = ? AND following_id = ?',
    [currentUserId, profileUserId]
  )) : false;

  const followerCount = queryOne(db,
    'SELECT COUNT(*) as count FROM user_follows WHERE following_id = ?', [profileUserId]
  ) ? queryOne(db, 'SELECT COUNT(*) as count FROM user_follows WHERE following_id = ?', [profileUserId]).count : 0;

  const followingCount = queryOne(db,
    'SELECT COUNT(*) as count FROM user_follows WHERE follower_id = ?', [profileUserId]
  ) ? queryOne(db, 'SELECT COUNT(*) as count FROM user_follows WHERE follower_id = ?', [profileUserId]).count : 0;

  const articles = queryAll(db,
    'SELECT id, title, created_at FROM articles WHERE author_id = ? AND status = ? ORDER BY created_at DESC LIMIT 10',
    [profileUserId, 'published']
  );

  res.render('frontend/user-profile', {
    user: req.session ? req.session.user : null,
    settings: settings,
    profileUser: profileUser,
    isFollowing: isFollowing,
    followerCount: followerCount,
    followingCount: followingCount,
    articles: articles
  });
});

// ============ 聊天页面 ============
router.get('/chat', isAuthenticated, (req, res) => {
  const db = req.db;
  const settings = getSettings(db);

  res.render('frontend/chat-list', {
    user: req.session.user,
    settings: settings
  });
});

router.get('/chat/:id', isAuthenticated, (req, res) => {
  const db = req.db;
  const settings = getSettings(db);
  const convId = parseInt(req.params.id);
  const userId = req.session.user.id;

  const conv = queryOne(db,
    'SELECT * FROM conversations WHERE id = ? AND (user1_id = ? OR user2_id = ?)',
    [convId, userId, userId]
  );
  if (!conv) {
    return res.redirect('/chat');
  }

  const otherUserId = conv.user1_id === userId ? conv.user2_id : conv.user1_id;
  const otherUser = queryOne(db, 'SELECT id, uid, username, nickname, avatar FROM users WHERE id = ?', [otherUserId]);

  res.render('frontend/chat', {
    user: req.session.user,
    settings: settings,
    conversation: conv,
    otherUser: otherUser
  });
});

module.exports = router;
