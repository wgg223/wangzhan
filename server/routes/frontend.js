/**
 * 前台公共页面与工具接口路由（Web 端最大路由模块）
 * 覆盖：
 *   - 首页/文章/页面/搜索/归档等前台浏览页；
 *   - 评论发表/点赞/收藏等互动接口；
 *   - 上传接口（文章封面、正文图片等）；
 *   - 站内通知、关注等社区能力；
 *   - 全局数据（导航、设置、标签云等）渲染辅助。
 * 说明：本文件各功能块已有 // ==== 分段注释，标注每个路由的职责；
 *       安全相关逻辑（权限中间件、XSS 过滤、上传白名单）在对应位置内联标注。
 */
const express = require('express');
const path = require('path');
const router = express.Router();
const { queryAll, queryOne, saveDatabase } = require('../config/database');
const { isAuthenticated, canEditArticle, hasFrontendPermission, isAdminRole, hasPermKey } = require('../middlewares/auth');
const { settingsCache, queryCache } = require('../config/cache');
const { createNotification } = require('./community');
const { logActivity } = require('../config/activity');
const { getSettings } = require('../utils/settings');
const { renderError } = require('../utils/response');
const { sanitize } = require('../utils/html-sanitizer');
const { doubleSubmitCookie } = require('../middlewares/security');
const { marked } = require('marked');
const sanitizeHtml = require('sanitize-html');
const { createRateLimiter } = require('../middlewares/rate-limiter');

// Markdown 渲染：marked 输出后过白名单净化，防存储型 XSS
function renderMarkdown(md) {
  if (!md) return '';
  const html = marked.parse(md);
  return sanitizeHtml(html, {
    allowedTags: ['p', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
      'table', 'thead', 'tbody', 'tr', 'th', 'td', 'em', 'strong', 'del', 'a', 'hr', 'img', 'span'],
    allowedAttributes: { a: ['href', 'target', 'rel'], img: ['src', 'alt'] },
    allowedSchemes: ['http', 'https', 'mailto']
  });
}

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

// 首页（/home 重定向到 /）
router.get('/home', (req, res) => {
  res.redirect(301, '/');
});

// ============ AI 提示词库（需查询权限） ============
router.get('/ai-prompts', hasFrontendPermission('prompts.view'), (req, res) => {
  const db = req.db;
  const settings = getSettings(db);

  const sections = cachedQuery('ai_prompts_sections', db,
    'SELECT * FROM prompt_sections WHERE is_active = 1 ORDER BY sort_order ASC, id ASC');
  const categories = cachedQuery('ai_prompts_categories', db,
    'SELECT * FROM prompt_categories WHERE is_active = 1 ORDER BY sort_order ASC, id ASC');
  const prompts = cachedQuery('ai_prompts_prompts', db,
    'SELECT id, category_id, title, content, excerpt FROM prompts WHERE is_active = 1 ORDER BY sort_order ASC, id ASC');

  // 组装 section → category → prompt 树（prompt 携带已净化的 Markdown HTML）
  const catById = new Map();
  categories.forEach(c => catById.set(c.id, { id: c.id, name: c.name, description: c.description, prompts: [] }));
  prompts.forEach(p => {
    const c = catById.get(p.category_id);
    if (c) {
      c.prompts.push({ id: p.id, title: p.title, content: p.content, excerpt: p.excerpt || '', content_html: renderMarkdown(p.content) });
    }
  });
  const tree = sections.map(s => ({
    id: s.id,
    name: s.name,
    icon: s.icon,
    description: s.description,
    categories: categories.filter(c => c.section_id === s.id).map(c => catById.get(c.id)).filter(Boolean)
  }));

  res.render('frontend/ai-prompts', {
    layout: false,
    user: req.session.user || null,
    settings: settings,
    tree: tree,
    stats: { sections: tree.length, categories: categories.length, prompts: prompts.length }
  });
});

// ============ AI 提示词评论 API ============

// 获取某提示词的已审核评论
router.get('/ai-prompts/api/comments/:promptId', hasFrontendPermission('prompts.view'), (req, res) => {
  const db = req.db;
  const promptId = parseInt(req.params.promptId, 10);
  if (!promptId) {
    return res.status(400).json({ error: '参数错误' });
  }
  const prompt = queryOne(db, 'SELECT id FROM prompts WHERE id = ?', [promptId]);
  if (!prompt) {
    return res.status(404).json({ error: '提示词不存在' });
  }
  const comments = queryAll(db, `
    SELECT pc.*, u.username, u.avatar
    FROM prompt_comments pc
    LEFT JOIN users u ON pc.user_id = u.id
    WHERE pc.prompt_id = ? AND pc.status = 'approved'
    ORDER BY pc.created_at DESC, pc.id DESC
  `, [promptId]);
  res.json({ success: true, comments: comments });
});

// 发表评论（登录 + 查询权限；写入后待审核）
router.post('/ai-prompts/api/comments/:promptId', isAuthenticated, hasFrontendPermission('prompts.view'), (req, res) => {
  const db = req.db;
  const promptId = parseInt(req.params.promptId, 10);
  const content = (req.body && typeof req.body.content === 'string') ? req.body.content.trim() : '';

  if (!promptId) {
    return res.status(400).json({ error: '参数错误' });
  }
  if (!content) {
    return res.status(400).json({ error: '评论内容不能为空' });
  }
  if (content.length > 500) {
    return res.status(400).json({ error: '评论内容不能超过 500 字' });
  }
  const prompt = queryOne(db, 'SELECT id, title FROM prompts WHERE id = ?', [promptId]);
  if (!prompt) {
    return res.status(404).json({ error: '提示词不存在' });
  }

  db.run("INSERT INTO prompt_comments (prompt_id, user_id, content, status) VALUES (?, ?, ?, 'pending')",
    [promptId, req.session.user.id, content]);
  saveDatabase();
  logActivity(db, { user_id: req.session.user.id, username: req.session.user.username, action: 'create', target_type: 'prompt_comment', target_id: promptId, target_title: prompt.title, detail: '评论提示词：' + prompt.title, ip: req.ip });

  res.json({ success: true, message: '评论已提交，等待管理员审核' });
});

// 删除评论（仅作者或管理员）
router.post('/ai-prompts/api/comments/:id/delete', isAuthenticated, hasFrontendPermission('prompts.view'), (req, res) => {
  const db = req.db;
  const commentId = parseInt(req.params.id, 10);
  if (!commentId) {
    return res.status(400).json({ error: '参数错误' });
  }
  const comment = queryOne(db, 'SELECT * FROM prompt_comments WHERE id = ?', [commentId]);
  if (!comment) {
    return res.status(404).json({ error: '评论不存在' });
  }
  if (comment.user_id !== req.session.user.id && !isAdminRole(req.session.user)) {
    return res.status(403).json({ error: '无权删除此评论' });
  }
  db.run('DELETE FROM prompt_comments WHERE id = ?', [commentId]);
  saveDatabase();
  res.json({ success: true });
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

  // 净化富文本，防止存储型 XSS（article-detail 页面原样输出正文）
  const safeContent = sanitize(content);

  let articleId = id;

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
      [title, safeContent, category || '', location || 'home', status || 'published', cover_image || '', id]);
  } else {
    db.run('INSERT INTO articles (title, content, category, location, status, cover_image, author_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [title, safeContent, category || '', location || 'home', status || 'published', cover_image || '', req.session.user.id]);
    const newArticle = queryOne(db, 'SELECT id FROM articles WHERE title = ? AND author_id = ? ORDER BY id DESC LIMIT 1',
      [title, req.session.user.id]);
    if (newArticle) articleId = newArticle.id;
  }

  // 清除相关缓存（键格式为 prefix:sql:params，需按前缀清除）
  queryCache.deleteByPrefix('home_articles:');
  queryCache.deleteByPrefix('articles_list:');

  saveDatabase();

  // AJAX请求返回JSON（用于附件关联）
  if (req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest') {
    return res.json({ success: true, articleId: articleId });
  }

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
router.get('/articles/:id', hasFrontendPermission('articles.detail.access'), (req, res) => {
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

  const attachments = queryAll(db,
    'SELECT * FROM article_attachments WHERE article_id = ? ORDER BY created_at ASC',
    [req.params.id]
  );

  res.render('frontend/article-detail', {
    user: req.session.user || null,
    settings: settings,
    article: article,
    comments: comments,
    attachments: attachments,
    error: req.query.error || null,
    success: req.query.success || null,
    currentUserId: req.session.user ? req.session.user.id : null
  });
});

// 提交评论
router.post('/articles/:id/comment', doubleSubmitCookie, (req, res) => {
  const db = req.db;
  const articleId = req.params.id;
  const { content, visitor_name, visitor_email, parent_id } = req.body;

  if (!content || content.trim().length === 0) {
    return res.redirect(`/articles/${articleId}?error=评论内容不能为空`);
  }

  if (content.trim().length > 2000) {
    return res.redirect(`/articles/${articleId}?error=评论内容不能超过2000字`);
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

// 小说详情/阅读页（需登录+权限）
router.get('/novels/:id', hasFrontendPermission('novels.detail.access'), (req, res) => {
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
    layout: false,
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
    layout: false,
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

// ============ 文章附件下载 ============
router.get('/attachments/download/:id', (req, res) => {
  const db = req.db;
  const att = queryOne(db, 'SELECT * FROM article_attachments WHERE id = ?', [req.params.id]);

  if (!att) {
    return res.status(404).render('frontend/error', {
      message: '附件不存在',
      error: '您访问的附件不存在或已被删除',
      user: req.session.user || null,
      settings: res.locals.settings || {}
    });
  }

  const article = queryOne(db, 'SELECT id, status FROM articles WHERE id = ?', [att.article_id]);
  if (!article || article.status !== 'published') {
    return res.status(404).render('frontend/error', {
      message: '附件不可用',
      error: '该附件所属文章未发布',
      user: req.session.user || null,
      settings: res.locals.settings || {}
    });
  }

  const filePath = path.join(require('./config/app-root').publicDir, att.file_path);
  if (!require('fs').existsSync(filePath)) {
    return res.status(404).render('frontend/error', {
      message: '文件不存在',
      error: '文件已被删除',
      user: req.session.user || null,
      settings: res.locals.settings || {}
    });
  }

  try {
    db.run('UPDATE article_attachments SET download_count = download_count + 1 WHERE id = ?', [att.id]);
    saveDatabase();
  } catch (e) { /* ignore */ }

  // 文件名净化：防止换行/控制字符注入 Content-Disposition 响应头
  const safeName = String(att.original_name || 'attachment').replace(/[\r\n\0]/g, '').slice(0, 255);
  res.download(filePath, safeName);
});

// ============ 社区主页 ============
router.get('/community', (req, res) => {
  const db = req.db;
  const settings = getSettings(db);
  const page = parseInt(req.query.page) || 1;
  const limit = 20;
  const offset = (page - 1) * limit;
  const filter = req.query.filter || 'all';

  const user = req.session && req.session.user ? req.session.user : null;

  // 检查发布动态权限
  let canPublish = false;
  if (user) {
    if (user.role === 'super_admin' || user.role === 'admin') {
      canPublish = true;
    } else {
      const userPerms = queryAll(db, 'SELECT perm_key FROM user_permissions WHERE user_id = ?', [user.id]);
      canPublish = userPerms.some(p => p.perm_key === 'community.posts.create');
    }
  }

  // 构建 UNION ALL 查询
  let feedItems = [];

  const articleQuery = `
    SELECT 'article' as type, a.id, a.title as content, a.cover_image, a.created_at,
      NULL as images, 0 as like_count, 0 as comment_count,
      u.id as user_id, u.uid as user_uid, u.username, u.nickname, u.avatar
    FROM articles a
    JOIN users u ON a.author_id = u.id
    WHERE a.status = 'published'`;

  const novelQuery = `
    SELECT 'novel' as type, n.id, n.title as content, n.cover_image, n.created_at,
      NULL as images, 0 as like_count, 0 as comment_count,
      u.id as user_id, u.uid as user_uid, u.username, u.nickname, u.avatar
    FROM novels n
    JOIN users u ON n.uploaded_by = u.id
    WHERE n.status = 'published'`;

  const imageQuery = `
    SELECT 'image' as type, i.id, i.title as content, i.url as cover_image, i.created_at,
      NULL as images, 0 as like_count, 0 as comment_count,
      u.id as user_id, u.uid as user_uid, u.username, u.nickname, u.avatar
    FROM images i
    JOIN users u ON i.user_id = u.id
    WHERE i.status = 1${user ? '' : `
      AND (i.visibility IS NULL OR i.visibility = '' OR i.visibility = 'public')
      AND i.cate_id IN (SELECT id FROM image_categories WHERE is_guest = 1 AND status = 1)`}`;

  const postQuery = `
    SELECT 'dynamic' as type, p.id, substr(p.content, 1, 200) as content, NULL as cover_image, p.created_at,
      p.images, p.like_count, p.comment_count,
      u.id as user_id, u.uid as user_uid, u.username, u.nickname, u.avatar
    FROM community_posts p
    JOIN users u ON p.user_id = u.id
    WHERE p.status = 'published'`;

  let unionSQL = '';
  let queryParams = [];

  if (filter === 'article') {
    unionSQL = articleQuery;
  } else if (filter === 'novel') {
    unionSQL = novelQuery;
  } else if (filter === 'image') {
    unionSQL = imageQuery;
  } else if (filter === 'dynamic') {
    unionSQL = postQuery;
  } else {
    unionSQL = [articleQuery, novelQuery, imageQuery, postQuery].join(' UNION ALL ');
  }

  try {
    feedItems = queryAll(db,
      `SELECT * FROM (${unionSQL}) ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...queryParams, limit, offset]
    );
  } catch (err) {
    console.error('[社区] 查询失败:', err.message);
    feedItems = [];
  }

  res.render('frontend/community', {
    user: user,
    settings: settings,
    feed: feedItems || [],
    page: page,
    hasMore: (feedItems || []).length === limit,
    filter: filter,
    canPublish: canPublish
  });
});

// ============ 动态详情页 ============
router.get('/community/post/:id', hasFrontendPermission('community.detail.access'), (req, res) => {
  const db = req.db;
  const settings = getSettings(db);
  const postId = parseInt(req.params.id);
  const user = req.session && req.session.user ? req.session.user : null;

  try {
    const post = queryOne(db,
      `SELECT p.*, u.username, u.nickname, u.avatar, u.uid as user_uid
       FROM community_posts p
       JOIN users u ON p.user_id = u.id
       WHERE p.id = ?`,
      [postId]
    );

    if (!post) {
      return res.status(404).render('frontend/error', {
        message: '动态不存在',
        error: '您查看的动态已被删除或不存在',
        user: user,
        settings: settings
      });
    }

    // 获取评论
    const comments = queryAll(db,
      `SELECT c.*, u.username, u.nickname, u.avatar, u.uid as user_uid
       FROM community_post_comments c
       JOIN users u ON c.user_id = u.id
       WHERE c.post_id = ? AND c.status = 'approved'
       ORDER BY c.created_at ASC`,
      [postId]
    );

    // 检查当前用户是否点赞
    let isLiked = false;
    if (user) {
      const like = queryOne(db,
        'SELECT id FROM content_likes WHERE user_id = ? AND target_type = ? AND target_id = ?',
        [user.id, 'community_post', postId]
      );
      isLiked = Boolean(like);
    }

    res.render('frontend/community-post-detail', {
      user: user,
      settings: settings,
      post: post,
      comments: comments || [],
      isLiked: isLiked
    });
  } catch (err) {
    console.error('[社区] 动态详情查询失败:', err.message);
    res.status(500).render('frontend/error', {
      message: '加载失败',
      error: '动态详情加载失败，请稍后重试',
      user: user,
      settings: settings
    });
  }
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

// AI 图片生成路由（已拆分至独立模块）
const aiImageRoutes = require('./ai-image');
router.use('/', aiImageRoutes);

// ============ AI 聊天模块 ============
const crypto = require('crypto');
const aiChatService = require('../services/ai-chat');
const { checkQuota } = require('../services/ai-chat/quota');
const { refreshSummary, getMemoryStatus, startBackfill, getBackfillProgress, cancelBackfill } = require('../services/ai-chat/memory');
const { resolveModel, fetchModelList } = require('../services/ai-chat/provider');

// AI 聊天接口限流
const aiChatSendLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 6, keyGenerator: r => `aichat:send:${r.session.user.id}`, message: '发送过于频繁，请稍后再试' });
const aiChatOpLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 30, keyGenerator: r => `aichat:op:${r.session.user.id}`, message: '操作过于频繁，请稍后再试' });
const aiChatRoleLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 30, keyGenerator: r => `aichat:role:${r.session.user.id}`, message: '操作过于频繁，请稍后再试' });
const aiChatModelLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 10, keyGenerator: r => `aichat:model:${r.session.user.id}`, message: '操作过于频繁，请稍后再试' });

// CSRF 校验（本模块约定：POST 头 X-CSRF-Token === session.doubleSubmitToken）
function csrfCheck(req, res, next) {
  const token = req.headers['x-csrf-token'];
  if (!token || token !== req.session.doubleSubmitToken) {
    return res.status(403).json({ error: 'CSRF 校验失败，请刷新页面重试' });
  }
  next();
}

const WORLD_BOOK_POSITIONS = ['system_top', 'before_char', 'after_char', 'user_top', 'assistant_top'];

// AI 聊天页面（独立页面，不使用主站布局）
router.get('/ai-chat', isAuthenticated, hasFrontendPermission('aichat.use'), (req, res) => {
  const db = req.db;
  if (!req.session.doubleSubmitToken) {
    req.session.doubleSubmitToken = crypto.randomBytes(32).toString('hex');
  }
  const settings = getSettings(db);
  const user = req.session.user;
  const userPerms = res.locals.userPermissions || [];

  // 提示词库选择（复用 ai_prompts_ 前缀缓存；与 AI 生图一致）
  const canPickPrompt = user.role === 'super_admin' || user.role === 'admin' ||
    userPerms.indexOf('prompts.view') !== -1 || userPerms.indexOf('prompts.manage') !== -1 ||
    userPerms.indexOf('prompts.*') !== -1;
  let prompts = [];
  if (canPickPrompt) {
    prompts = cachedQuery('ai_prompts_prompts', db,
      'SELECT id, category_id, title, excerpt FROM prompts WHERE is_active = 1 ORDER BY sort_order ASC, id ASC');
  }

  // 分享会话链接（与 AI 生图分享链接同权限）
  const canShareLink = user.role === 'super_admin' || user.role === 'admin' ||
    userPerms.indexOf('image-share.share') !== -1 || userPerms.indexOf('image-share.*') !== -1;

  // 导出为独立高危权限，普通用户默认无导出权限
  const canExport = user.role === 'super_admin' || hasPermKey(userPerms, 'aichat.export');

  res.render('frontend/ai-chat', {
    layout: false,
    user,
    settings,
    csrfToken: req.session.doubleSubmitToken,
    canPickPrompt,
    canShareLink,
    canExport,
    prompts
  });
});

// 首屏数据
router.get('/ai-chat/api/bootstrap', isAuthenticated, hasFrontendPermission('aichat.use'), (req, res) => {
  const db = req.db;
  const user = req.session.user;
  const settings = getSettings(db);
  const conversations = queryAll(db, `SELECT id, title, model, role_id, system_prompt, message_count,
      memory_enabled, memory_mode, rag_enabled, current_branch_id, updated_at,
      gen_temperature, gen_top_p, gen_top_k, gen_frequency_penalty, gen_presence_penalty, gen_max_tokens,
      author_note, author_note_depth, prompt_template_id, is_group, group_members, group_mode
    FROM ai_conversations WHERE user_id = ? ORDER BY updated_at DESC, id DESC`, [user.id]);
  const roles = queryAll(db, `SELECT id, name, avatar, description, category, is_official, user_id,
      greeting, personality, scenario, examples
    FROM ai_roles WHERE is_official = 1 OR user_id = ? ORDER BY is_official DESC, sort_order ASC, id ASC`, [user.id]);
  const models = queryAll(db, `SELECT id, name, model_key, provider, api_endpoint, api_key, is_default, max_tokens, temperature
    FROM ai_models WHERE user_id = ? ORDER BY is_default DESC, id ASC`, [user.id]);
  models.forEach(m => { m.has_key = Boolean(m.api_key && m.api_key.indexOf('ENC:') === 0); delete m.api_key; });
  const globalModels = queryAll(db, `SELECT id, name, model_key, provider, is_default
    FROM ai_models WHERE user_id IS NULL AND is_enabled = 1 ORDER BY is_default DESC, sort_order ASC, id ASC`);
  const providers = queryAll(db, `SELECT provider_key, name, api_base, default_model, models, api_key_url
    FROM ai_chat_providers ORDER BY sort_order ASC, id ASC`);
  providers.forEach(p => {
    try { p.models = JSON.parse(p.models || '[]'); } catch (e) { p.models = []; }
    p.requires_key = p.provider_key !== 'pollinations';
  });
  const quota = checkQuota(db, user);
  const presets = queryAll(db, 'SELECT * FROM ai_presets WHERE user_id = ? OR is_global = 1 ORDER BY is_global DESC, is_default DESC, id ASC', [user.id]);
  const promptTemplates = queryAll(db, 'SELECT id, name, content, description, is_global FROM ai_prompt_templates WHERE user_id = ? OR is_global = 1 ORDER BY is_global DESC, sort_order ASC, id ASC', [user.id]);
  res.json({
    success: true,
    data: {
      aiEnabled: String(settings.ai_enabled ?? '1') !== '0',
      streamEnabled: String(settings.ai_stream_enabled ?? '1') !== '0',
      defaultModel: settings.ai_default_model || '',
      allowUserModels: String(settings.ai_allow_user_models ?? '1') !== '0',
      memoryDefaults: {
        enabled: String(settings.ai_memory_enabled ?? '1') !== '0',
        mode: settings.ai_memory_mode || 'summary',
        interval: parseInt(settings.ai_memory_interval, 10) || 10
      },
      conversations, roles, models, globalModels, providers, presets, promptTemplates,
      quota: quota.quota, quotaOk: quota.ok, quotaUnlimited: quota.unlimited,
      canExport: user.role === 'super_admin' || hasPermKey(res.locals.userPermissions || [], 'aichat.export')
    }
  });
});

// 新建会话
router.post('/ai-chat/api/conversations', isAuthenticated, hasFrontendPermission('aichat.use'), csrfCheck, aiChatOpLimiter, (req, res) => {
  try {
    const conv = aiChatService.createConversation(req.db, req.session.user, req.body);
    res.json({ success: true, data: conv });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// 群聊成员/模式管理
router.post('/ai-chat/api/conversations/group', isAuthenticated, hasFrontendPermission('aichat.use'), csrfCheck, aiChatOpLimiter, (req, res) => {
  const conv = aiChatService.getOwnConversation(req.db, req.session.user, parseInt(req.body.id, 10));
  if (!conv) return res.status(404).json({ error: '会话不存在' });
  try {
    const updated = aiChatService.updateGroup(req.db, req.session.user, conv, {
      members: req.body.members, mode: req.body.mode, title: req.body.title
    });
    res.json({ success: true, data: updated });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// 重命名会话
router.post('/ai-chat/api/conversations/rename', isAuthenticated, hasFrontendPermission('aichat.use'), csrfCheck, aiChatOpLimiter, (req, res) => {
  const conv = aiChatService.getOwnConversation(req.db, req.session.user, parseInt(req.body.id, 10));
  if (!conv) return res.status(404).json({ error: '会话不存在' });
  aiChatService.renameConversation(req.db, conv, req.body.title);
  res.json({ success: true });
});

// 切换会话角色（空会话切换角色时自动注入该角色的开场白）
router.post('/ai-chat/api/conversations/role', isAuthenticated, hasFrontendPermission('aichat.use'), csrfCheck, aiChatOpLimiter, (req, res) => {
  const db = req.db;
  const conv = aiChatService.getOwnConversation(db, req.session.user, parseInt(req.body.id, 10));
  if (!conv) return res.status(404).json({ error: '会话不存在' });
  const roleId = parseInt(req.body.role_id, 10) || null;
  let greeting = '';
  if (roleId) {
    const role = queryOne(db, 'SELECT id, greeting FROM ai_roles WHERE id = ? AND (is_official = 1 OR user_id = ?)', [roleId, req.session.user.id]);
    if (!role) return res.status(404).json({ error: '角色不存在' });
    greeting = role.greeting || '';
  }
  db.run('UPDATE ai_conversations SET role_id = ? WHERE id = ?', [roleId, conv.id]);
  // 会话尚无任何消息且角色带开场白 → 注入开场白作为第一条 AI 消息
  if (greeting) {
    const msgCount = queryOne(db, 'SELECT COUNT(*) AS c FROM ai_messages WHERE conversation_id = ?', [conv.id]);
    if (!msgCount || msgCount.c === 0) {
      const { estimateTokens } = require('../services/ai-chat/utils');
      db.run(`INSERT INTO ai_messages (conversation_id, branch_id, role, content, tokens, model, status)
        VALUES (?, 0, 'assistant', ?, ?, '', 'done')`,
      [conv.id, greeting, estimateTokens(greeting)]);
      db.run('UPDATE ai_conversations SET message_count = message_count + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [conv.id]);
    }
  }
  saveDatabase();
  res.json({ success: true });
});

// 切换会话模型
router.post('/ai-chat/api/conversations/model', isAuthenticated, hasFrontendPermission('aichat.use'), csrfCheck, aiChatOpLimiter, (req, res) => {
  const db = req.db;
  const conv = aiChatService.getOwnConversation(db, req.session.user, parseInt(req.body.id, 10));
  if (!conv) return res.status(404).json({ error: '会话不存在' });
  const model = String(req.body.model || '').trim().slice(0, 100);
  if (model) {
    const settings = getSettings(db);
    const allowUserModels = String(settings.ai_allow_user_models ?? '1') !== '0';
    const scope = allowUserModels ? '(user_id = ? OR user_id IS NULL)' : 'user_id IS NULL';
    const exists = queryOne(db, `SELECT id FROM ai_models WHERE is_enabled = 1 AND model_key = ? AND ${scope}`,
      allowUserModels ? [model, req.session.user.id] : [model]);
    if (!exists) return res.status(400).json({ error: '模型不存在或未启用' });
  }
  db.run('UPDATE ai_conversations SET model = ? WHERE id = ?', [model, conv.id]);
  saveDatabase();
  res.json({ success: true });
});

// 删除会话
router.post('/ai-chat/api/conversations/delete', isAuthenticated, hasFrontendPermission('aichat.use'), csrfCheck, aiChatOpLimiter, (req, res) => {
  const conv = aiChatService.getOwnConversation(req.db, req.session.user, parseInt(req.body.id, 10));
  if (!conv) return res.status(404).json({ error: '会话不存在' });
  aiChatService.deleteConversation(req.db, conv);
  res.json({ success: true });
});

// 导入聊天记录（JSON）
router.post('/ai-chat/api/conversations/import', isAuthenticated, hasFrontendPermission('aichat.use'), csrfCheck, aiChatOpLimiter, (req, res) => {
  const db = req.db;
  const user = req.session.user;
  const data = req.body;
  if (!data || !data.chat_export || !Array.isArray(data.messages)) {
    return res.status(400).json({ error: '无效的聊天记录格式' });
  }
  const title = String(data.title || '导入的对话').trim().slice(0, 100);
  const { estimateTokens } = require('../services/ai-chat/utils');

  // 如果导出包含角色信息，尝试查找或忽略
  let roleId = null;
  if (data.character && data.character.name) {
    const role = queryOne(db, 'SELECT id FROM ai_roles WHERE LOWER(name) = LOWER(?) AND (is_official = 1 OR user_id = ?)',
      [data.character.name, user.id]);
    if (role) roleId = role.id;
  }

  const conv = aiChatService.createConversation(db, user, { title: title, role_id: roleId });

  // 批量插入消息
  const stmt = db.prepare('INSERT INTO ai_messages (conversation_id, branch_id, role, content, tokens, model, status) VALUES (?, 0, ?, ?, ?, ?, ?)');
  let msgCount = 0;
  data.messages.forEach(function (m) {
    var role = String(m.role || 'user').trim();
    if (role !== 'user' && role !== 'assistant' && role !== 'system') role = 'user';
    var content = String(m.content || '').trim();
    if (!content) return;
    content = content.slice(0, 32000);
    var model = String(m.model || '').slice(0, 100);
    stmt.run([conv.id, role, content, estimateTokens(content), model, 'done']);
    msgCount++;
  });

  if (msgCount > 0) {
    db.run('UPDATE ai_conversations SET message_count = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [msgCount, conv.id]);
  }
  saveDatabase();

  const full = queryOne(db, 'SELECT * FROM ai_conversations WHERE id = ?', [conv.id]);
  res.json({ success: true, data: full });
});

// 会话消息列表（当前分支 + 分支列表 + 世界书 + 摘要记忆）
router.get('/ai-chat/api/conversations/:id/messages', isAuthenticated, hasFrontendPermission('aichat.use'), (req, res) => {
  const db = req.db;
  const user = req.session.user;
  const conv = aiChatService.getOwnConversation(db, user, parseInt(req.params.id, 10));
  if (!conv) return res.status(404).json({ error: '会话不存在' });
  const branchId = conv.current_branch_id || 0;
  const messages = queryAll(db, 'SELECT id, branch_id, role, content, tokens, input_tokens, output_tokens, model, status, error, is_pinned, created_at, alternate_of, is_active, speaker_role_id, is_image, image_url FROM ai_messages WHERE conversation_id = ? AND branch_id = ? AND (is_active = 1 OR is_active IS NULL) ORDER BY id ASC', [conv.id, branchId]);
  const branches = queryAll(db, 'SELECT id, name, parent_message_id, created_at FROM ai_branches WHERE conversation_id = ? ORDER BY id ASC', [conv.id]);
  const worldBook = queryAll(db, 'SELECT id, key, content, position, enabled, constant, sort_order FROM ai_world_book WHERE conversation_id = ? ORDER BY sort_order ASC, id ASC', [conv.id]);
  const summaries = queryAll(db, "SELECT id, content, created_at FROM ai_memories WHERE conversation_id = ? AND type = 'summary' ORDER BY id ASC", [conv.id]);
  res.json({ success: true, data: { conversation: conv, messages, branches, worldBook, summaries } });
});

// 流式响应公共封装（SSE + 心跳 + 客户端断开中止）
function streamCompletionResponse(req, res, runFn) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const abortController = new AbortController();
  const heartbeat = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) { /* ignore */ } }, 15000);
  res.on('close', () => {
    clearInterval(heartbeat);
    abortController.abort();
  });

  const sendEvent = (event, data) => {
    try { res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n'); } catch (e) { /* ignore */ }
  };

  Promise.resolve().then(() => runFn(abortController.signal, sendEvent))
    .catch(err => {
      sendEvent('error', { message: err.message || '生成失败', messageId: err.messageId });
      sendEvent('done', { error: true });
    })
    .finally(() => {
      clearInterval(heartbeat);
      try { res.end(); } catch (e) { /* ignore */ }
    });
}

// 发送消息（SSE 流式）
router.post('/ai-chat/api/send', isAuthenticated, hasFrontendPermission('aichat.use'), csrfCheck, aiChatSendLimiter, (req, res) => {
  const db = req.db;
  const user = req.session.user;
  const convId = parseInt(req.body.conversation_id, 10);
  if (!convId) return res.status(400).json({ error: '参数错误' });
  const conv = aiChatService.getOwnConversation(db, user, convId);
  if (!conv) return res.status(404).json({ error: '会话不存在' });

  const streamEnabled = String(getSettings(db).ai_stream_enabled ?? '1') !== '0';
  const isGroup = !!conv.is_group;
  streamCompletionResponse(req, res, async (signal, sendEvent) => {
    const result = await aiChatService.sendMessage(db, user, conv, String(req.body.content || ''), {
      stream: streamEnabled,
      signal,
      speakerRoleId: parseInt(req.body.speaker_role_id, 10) || undefined,
      onDelta: streamEnabled ? delta => sendEvent('delta', { delta }) : undefined,
      onSpeaker: isGroup ? sp => sendEvent('speaker', sp) : undefined,
      onResult: isGroup ? (r, sp) => sendEvent('message', {
        id: r.messageId, content: r.content, tokens: r.tokens, inputTokens: r.inputTokens, outputTokens: r.outputTokens, model: r.model, quota: r.quota,
        speaker_role_id: sp.id, speaker_name: sp.name
      }) : undefined
    });
    if (result.noReply) {
      sendEvent('done', { noReply: true });
      return;
    }
    if (!isGroup) {
      sendEvent('message', { id: result.messageId, content: result.content, tokens: result.tokens, inputTokens: result.inputTokens, outputTokens: result.outputTokens, model: result.model, quota: result.quota });
    }
    sendEvent('done', { aborted: !!result.aborted });
  });
});

// 群聊手动顶帖：指定成员对当前上下文回复（SSE 流式）
router.post('/ai-chat/api/group/reply', isAuthenticated, hasFrontendPermission('aichat.use'), csrfCheck, aiChatSendLimiter, (req, res) => {
  const db = req.db;
  const user = req.session.user;
  const conv = aiChatService.getOwnConversation(db, user, parseInt(req.body.conversation_id, 10));
  if (!conv) return res.status(404).json({ error: '会话不存在' });
  const streamEnabled = String(getSettings(db).ai_stream_enabled ?? '1') !== '0';
  streamCompletionResponse(req, res, async (signal, sendEvent) => {
    const { result, speaker } = await aiChatService.groupReply(db, user, conv, req.body.role_id, {
      stream: streamEnabled,
      signal,
      onDelta: streamEnabled ? delta => sendEvent('delta', { delta }) : undefined,
      onSpeaker: sp => sendEvent('speaker', sp)
    });
    sendEvent('message', {
      id: result.messageId, content: result.content, tokens: result.tokens, inputTokens: result.inputTokens, outputTokens: result.outputTokens, model: result.model, quota: result.quota,
      speaker_role_id: speaker.id, speaker_name: speaker.name
    });
    sendEvent('done', { aborted: !!result.aborted });
  });
});

// 重新生成（SSE 流式）
router.post('/ai-chat/api/messages/regenerate', isAuthenticated, hasFrontendPermission('aichat.use'), csrfCheck, aiChatSendLimiter, (req, res) => {
  const db = req.db;
  const user = req.session.user;
  const targetId = parseInt(req.body.message_id, 10);
  const convId = parseInt(req.body.conversation_id, 10);
  if (!targetId || !convId) return res.status(400).json({ error: '参数错误' });
  const conv = aiChatService.getOwnConversation(db, user, convId);
  if (!conv) return res.status(404).json({ error: '会话不存在' });

  const streamEnabled = String(getSettings(db).ai_stream_enabled ?? '1') !== '0';
  streamCompletionResponse(req, res, async (signal, sendEvent) => {
    const result = await aiChatService.regenerateMessage(db, user, conv, targetId, {
      stream: streamEnabled,
      signal,
      onDelta: streamEnabled ? delta => sendEvent('delta', { delta }) : undefined
    });
    sendEvent('message', { id: result.messageId, content: result.content, tokens: result.tokens, inputTokens: result.inputTokens, outputTokens: result.outputTokens, model: result.model, quota: result.quota });
    sendEvent('done', { aborted: !!result.aborted });
  });
});

// 编辑消息
router.post('/ai-chat/api/messages/edit', isAuthenticated, hasFrontendPermission('aichat.use'), csrfCheck, aiChatOpLimiter, (req, res) => {
  const { msg, conv } = aiChatService.getOwnMessage(req.db, req.session.user, parseInt(req.body.message_id, 10)) || {};
  if (!msg || msg.role !== 'user') return res.status(404).json({ error: '消息不存在' });
  aiChatService.editMessage(req.db, conv, msg, req.body.content);
  res.json({ success: true });
});

// 删除消息（及后续同分支消息）
router.post('/ai-chat/api/messages/delete', isAuthenticated, hasFrontendPermission('aichat.use'), csrfCheck, aiChatOpLimiter, (req, res) => {
  const { msg, conv } = aiChatService.getOwnMessage(req.db, req.session.user, parseInt(req.body.message_id, 10)) || {};
  if (!msg) return res.status(404).json({ error: '消息不存在' });
  aiChatService.deleteMessage(req.db, conv, msg);
  res.json({ success: true });
});

// 分叉（在此消息之后创建新分支）
router.post('/ai-chat/api/messages/fork', isAuthenticated, hasFrontendPermission('aichat.use'), csrfCheck, aiChatOpLimiter, (req, res) => {
  const { msg, conv } = aiChatService.getOwnMessage(req.db, req.session.user, parseInt(req.body.message_id, 10)) || {};
  if (!msg) return res.status(404).json({ error: '消息不存在' });
  const branch = aiChatService.forkConversation(req.db, conv, msg);
  res.json({ success: true, data: branch });
});

// 切换分支
router.post('/ai-chat/api/branches/switch', isAuthenticated, hasFrontendPermission('aichat.use'), csrfCheck, aiChatOpLimiter, (req, res) => {
  const conv = aiChatService.getOwnConversation(req.db, req.session.user, parseInt(req.body.conversation_id, 10));
  if (!conv) return res.status(404).json({ error: '会话不存在' });
  if (!aiChatService.switchBranch(req.db, conv, parseInt(req.body.branch_id, 10) || 0)) {
    return res.status(404).json({ error: '分支不存在' });
  }
  res.json({ success: true });
});

// 删除分支
router.post('/ai-chat/api/branches/delete', isAuthenticated, hasFrontendPermission('aichat.use'), csrfCheck, aiChatOpLimiter, (req, res) => {
  const conv = aiChatService.getOwnConversation(req.db, req.session.user, parseInt(req.body.conversation_id, 10));
  if (!conv) return res.status(404).json({ error: '会话不存在' });
  if (!aiChatService.deleteBranch(req.db, conv, parseInt(req.body.branch_id, 10) || 0)) {
    return res.status(404).json({ error: '分支不存在' });
  }
  res.json({ success: true });
});

// 世界书列表
router.get('/ai-chat/api/world-book', isAuthenticated, hasFrontendPermission('aichat.use'), (req, res) => {
  const db = req.db;
  const conv = aiChatService.getOwnConversation(db, req.session.user, parseInt(req.query.conversation_id, 10));
  if (!conv) return res.status(404).json({ error: '会话不存在' });
  const list = queryAll(db, 'SELECT id, key, content, position, enabled, constant, sort_order FROM ai_world_book WHERE conversation_id = ? ORDER BY sort_order ASC, id ASC', [conv.id]);
  res.json({ success: true, data: list });
});

// 世界书保存（新建/更新）
router.post('/ai-chat/api/world-book', isAuthenticated, hasFrontendPermission('aichat.use'), csrfCheck, aiChatOpLimiter, (req, res) => {
  const db = req.db;
  const conv = aiChatService.getOwnConversation(db, req.session.user, parseInt(req.body.conversation_id, 10));
  if (!conv) return res.status(404).json({ error: '会话不存在' });

  const id = parseInt(req.body.id, 10) || 0;
  const key = String(req.body.key || '').trim().slice(0, 100);
  const content = String(req.body.content || '').trim().slice(0, 20000);
  const position = WORLD_BOOK_POSITIONS.indexOf(req.body.position) !== -1 ? req.body.position : 'before_char';
  const sortOrder = parseInt(req.body.sort_order, 10) || 0;
  const enabled = req.body.enabled === false || req.body.enabled === 0 ? 0 : 1;
  const constant = req.body.constant === true || req.body.constant === 1 || req.body.constant === '1' ? 1 : 0;
  if (!content) return res.status(400).json({ error: '内容不能为空' });

  if (id) {
    const row = queryOne(db, 'SELECT id FROM ai_world_book WHERE id = ? AND conversation_id = ?', [id, conv.id]);
    if (!row) return res.status(404).json({ error: '条目不存在' });
    db.run('UPDATE ai_world_book SET key = ?, content = ?, position = ?, sort_order = ?, enabled = ?, constant = ? WHERE id = ?',
      [key, content, position, sortOrder, enabled, constant, id]);
  } else {
    db.run('INSERT INTO ai_world_book (conversation_id, key, content, position, sort_order, enabled, constant) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [conv.id, key, content, position, sortOrder, enabled, constant]);
  }
  saveDatabase();
  res.json({ success: true });
});

// 世界书删除
router.post('/ai-chat/api/world-book/delete', isAuthenticated, hasFrontendPermission('aichat.use'), csrfCheck, aiChatOpLimiter, (req, res) => {
  const db = req.db;
  const conv = aiChatService.getOwnConversation(db, req.session.user, parseInt(req.body.conversation_id, 10));
  if (!conv) return res.status(404).json({ error: '会话不存在' });
  const row = queryOne(db, 'SELECT id FROM ai_world_book WHERE id = ? AND conversation_id = ?', [parseInt(req.body.id, 10), conv.id]);
  if (!row) return res.status(404).json({ error: '条目不存在' });
  db.run('DELETE FROM ai_world_book WHERE id = ?', [row.id]);
  saveDatabase();
  res.json({ success: true });
});

// 从默认世界书模板导入：把当前启用的默认条目复制进本会话（已存在的 key 跳过）
router.post('/ai-chat/api/world-book/import-defaults', isAuthenticated, hasFrontendPermission('aichat.use'), csrfCheck, aiChatOpLimiter, (req, res) => {
  const db = req.db;
  const conv = aiChatService.getOwnConversation(db, req.session.user, parseInt(req.body.conversation_id, 10));
  if (!conv) return res.status(404).json({ error: '会话不存在' });
  const defaults = queryAll(db, 'SELECT key, content, position, sort_order, enabled, constant FROM ai_default_world_book WHERE enabled = 1 ORDER BY sort_order ASC, id ASC');
  const existing = new Set(queryAll(db, 'SELECT key FROM ai_world_book WHERE conversation_id = ?', [conv.id]).map(r => String(r.key).trim().toLowerCase()));
  let imported = 0;
  defaults.forEach(e => {
    const k = String(e.key || '').trim();
    if (existing.has(k.toLowerCase())) return;
    db.run('INSERT INTO ai_world_book (conversation_id, key, content, position, sort_order, enabled, constant) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [conv.id, k, e.content, e.position, e.sort_order, e.enabled, e.constant]);
    imported++;
  });
  saveDatabase();
  res.json({ success: true, data: { imported, total: defaults.length } });
});

// 世界书文件导入（SillyTavern lorebook / 自有格式 / Markdown 解析后的条目批量写入）
router.post('/ai-chat/api/world-book/import', isAuthenticated, hasFrontendPermission('aichat.use'), csrfCheck, aiChatOpLimiter, (req, res) => {
  const db = req.db;
  const conv = aiChatService.getOwnConversation(db, req.session.user, parseInt(req.body.conversation_id, 10));
  if (!conv) return res.status(404).json({ error: '会话不存在' });
  const entries = Array.isArray(req.body.entries) ? req.body.entries.slice(0, 500) : [];
  if (!entries.length) return res.status(400).json({ error: '没有可导入的条目' });
  const existing = new Set(queryAll(db, 'SELECT key FROM ai_world_book WHERE conversation_id = ?', [conv.id]).map(r => String(r.key).trim().toLowerCase()));
  let imported = 0;
  let skipped = 0;
  entries.forEach((e, i) => {
    if (!e || typeof e !== 'object') { skipped++; return; }
    const key = String(e.key || '').trim().slice(0, 100);
    const content = String(e.content || '').trim().slice(0, 20000);
    if (!content || (key && existing.has(key.toLowerCase()))) { skipped++; return; }
    const position = WORLD_BOOK_POSITIONS.indexOf(e.position) !== -1 ? e.position : 'before_char';
    const enabled = e.enabled === 0 || e.enabled === false ? 0 : 1;
    const constant = e.constant === 1 || e.constant === true || e.constant === '1' ? 1 : 0;
    const sortOrder = parseInt(e.sort_order, 10) || i;
    db.run('INSERT INTO ai_world_book (conversation_id, key, content, position, sort_order, enabled, constant) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [conv.id, key, content, position, sortOrder, enabled, constant]);
    if (key) existing.add(key.toLowerCase());
    imported++;
  });
  saveDatabase();
  res.json({ success: true, data: { imported, skipped } });
});

// 会话级知识库（RAG）开关
router.post('/ai-chat/api/conversations/rag', isAuthenticated, hasFrontendPermission('aichat.use'), csrfCheck, aiChatOpLimiter, (req, res) => {
  const db = req.db;
  const conv = aiChatService.getOwnConversation(db, req.session.user, parseInt(req.body.conversation_id, 10));
  if (!conv) return res.status(404).json({ error: '会话不存在' });
  const ragEnabled = req.body.rag_enabled === true || req.body.rag_enabled === 1 || req.body.rag_enabled === '1' ? 1 : 0;
  db.run('UPDATE ai_conversations SET rag_enabled = ? WHERE id = ?', [ragEnabled, conv.id]);
  saveDatabase();
  res.json({ success: true });
});

// 记忆设置
router.post('/ai-chat/api/memory/settings', isAuthenticated, hasFrontendPermission('aichat.use'), csrfCheck, aiChatOpLimiter, (req, res) => {
  const db = req.db;
  const conv = aiChatService.getOwnConversation(db, req.session.user, parseInt(req.body.conversation_id, 10));
  if (!conv) return res.status(404).json({ error: '会话不存在' });
  const enabled = req.body.memory_enabled === true || req.body.memory_enabled === 1 ? 1 : 0;
  const mode = ['summary', 'vector', 'both', 'off'].indexOf(req.body.memory_mode) !== -1 ? req.body.memory_mode : 'summary';
  db.run('UPDATE ai_conversations SET memory_enabled = ?, memory_mode = ? WHERE id = ?', [enabled, mode, conv.id]);
  saveDatabase();
  res.json({ success: true });
});

// 手动刷新记忆（强制摘要最近消息）
router.post('/ai-chat/api/memory/refresh', isAuthenticated, hasFrontendPermission('aichat.use'), csrfCheck, aiChatOpLimiter, async (req, res) => {
  const db = req.db;
  const conv = aiChatService.getOwnConversation(db, req.session.user, parseInt(req.body.conversation_id, 10));
  if (!conv) return res.status(404).json({ error: '会话不存在' });
  try {
    const summary = await refreshSummary(db, conv, resolveModel(db, req.session.user.id), 20);
    res.json({ success: true, data: { summary } });
  } catch (err) {
    res.status(500).json({ error: err.message || '摘要生成失败' });
  }
});

// 记忆状态（逐轮总结/向量/分组统计，供补录弹窗）
router.get('/ai-chat/api/memory/status', isAuthenticated, hasFrontendPermission('aichat.use'), (req, res) => {
  const db = req.db;
  const conv = aiChatService.getOwnConversation(db, req.session.user, parseInt(req.query.conversation_id, 10));
  if (!conv) return res.status(404).json({ error: '会话不存在' });
  res.json({ success: true, data: getMemoryStatus(db, conv) });
});

// 启动记忆补录（后台异步：逐轮总结/向量坐标/二次压缩）
router.post('/ai-chat/api/memory/backfill', isAuthenticated, hasFrontendPermission('aichat.use'), csrfCheck, aiChatOpLimiter, (req, res) => {
  const db = req.db;
  const user = req.session.user;
  const conv = aiChatService.getOwnConversation(db, user, parseInt(req.body.conversation_id, 10));
  if (!conv) return res.status(404).json({ error: '会话不存在' });
  let phases = Array.isArray(req.body.phases) ? req.body.phases : ['summaries', 'vectors', 'groups'];
  phases = phases.filter(p => ['summaries', 'vectors', 'groups'].indexOf(p) !== -1);
  if (!phases.length) phases = ['summaries', 'vectors', 'groups'];
  const modelInfo = resolveModel(db, user.id, conv.model);
  if (!modelInfo) return res.status(500).json({ error: '未配置可用模型' });
  const r = startBackfill(db, conv, modelInfo, phases);
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.json({ success: true });
});

// 补录进度
router.get('/ai-chat/api/memory/backfill/progress', isAuthenticated, hasFrontendPermission('aichat.use'), (req, res) => {
  const convId = parseInt(req.query.conversation_id, 10);
  const conv = aiChatService.getOwnConversation(req.db, req.session.user, convId);
  if (!conv) return res.status(404).json({ error: '会话不存在' });
  const job = getBackfillProgress(conv.id);
  res.json({ success: true, data: job || { running: false, finished: false } });
});

// 取消补录
router.post('/ai-chat/api/memory/backfill/cancel', isAuthenticated, hasFrontendPermission('aichat.use'), csrfCheck, aiChatOpLimiter, (req, res) => {
  const conv = aiChatService.getOwnConversation(req.db, req.session.user, parseInt(req.body.conversation_id, 10));
  if (!conv) return res.status(404).json({ error: '会话不存在' });
  const r = cancelBackfill(conv.id);
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.json({ success: true });
});

// 创建用户角色（支持开场白/性格/场景/示例对话等角色卡字段）
router.post('/ai-chat/api/roles', isAuthenticated, hasFrontendPermission('aichat.use'), csrfCheck, aiChatRoleLimiter, (req, res) => {
  const db = req.db;
  const user = req.session.user;
  const name = String(req.body.name || '').trim().slice(0, 50);
  const systemPrompt = String(req.body.system_prompt || '').trim().slice(0, 32000);
  const greeting = String(req.body.greeting || '').trim().slice(0, 2000);
  if (!name) return res.status(400).json({ error: '角色名称不能为空' });
  if (!systemPrompt && !greeting) return res.status(400).json({ error: '角色设定或开场白至少填写一项' });
  // 角色去重：与官方角色或本人已有角色同名（大小写不敏感）时拒绝
  const dup = queryOne(db, 'SELECT id, name FROM ai_roles WHERE LOWER(name) = LOWER(?) AND (is_official = 1 OR user_id = ?)', [name, user.id]);
  if (dup) return res.status(400).json({ error: '同名角色「' + dup.name + '」已存在（官方角色或您的角色），请换一个名称' });
  db.run(`INSERT INTO ai_roles (name, description, system_prompt, greeting, personality, scenario, examples, category, avatar, is_official, user_id, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0)`,
  [name,
    String(req.body.description || '').slice(0, 500),
    systemPrompt,
    greeting,
    String(req.body.personality || '').slice(0, 4000),
    String(req.body.scenario || '').slice(0, 4000),
    String(req.body.examples || '').slice(0, 8000),
    String(req.body.category || 'default').slice(0, 50),
    String(req.body.avatar || '').slice(0, 2000),
    user.id]);
  const role = queryOne(db, 'SELECT * FROM ai_roles WHERE id = last_insert_rowid()');
  saveDatabase();
  res.json({ success: true, data: role });
});

// 删除用户自建角色（官方角色不可删）
router.post('/ai-chat/api/roles/delete', isAuthenticated, hasFrontendPermission('aichat.use'), csrfCheck, aiChatRoleLimiter, (req, res) => {
  const db = req.db;
  const role = queryOne(db, 'SELECT * FROM ai_roles WHERE id = ?', [parseInt(req.body.id, 10)]);
  if (!role || role.user_id !== req.session.user.id) return res.status(404).json({ error: '角色不存在' });
  db.run('DELETE FROM ai_roles WHERE id = ?', [role.id]);
  saveDatabase();
  res.json({ success: true });
});

// 从外部 URL 获取角色卡数据（best-effort 抓取 Next.js / 静态 JSON 页面）
router.post('/ai-chat/api/roles/fetch-url', isAuthenticated, hasFrontendPermission('aichat.use'), csrfCheck, aiChatRoleLimiter, async (req, res) => {
  const url = String(req.body.url || '').trim();
  if (!url) return res.status(400).json({ error: '请提供角色卡页面 URL' });
  if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'URL 格式不正确' });

  try {
    const https = require('https');
    const http = require('http');
    const client = url.startsWith('https') ? https : http;

    const body = await new Promise((resolve, reject) => {
      const doRequest = (reqUrl, reqClient) => {
        const req = reqClient.get(reqUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 15000 }, (resp) => {
          if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
            const redirectUrl = resp.headers.location;
            const rClient = redirectUrl.startsWith('https') ? https : http;
            doRequest(redirectUrl, rClient);
            return;
          }
          const chunks = [];
          resp.on('data', chunk => chunks.push(chunk));
          resp.on('end', () => {
            const buf = Buffer.concat(chunks);
            const ct = (resp.headers['content-type'] || '').toLowerCase();
            let encoding = 'utf-8';
            const charsetMatch = ct.match(/charset=([^\s;]+)/);
            if (charsetMatch) {
              const detected = charsetMatch[1].replace(/['"]/g, '').toLowerCase();
              if (detected === 'gbk' || detected === 'gb2312' || detected === 'gb18030') encoding = 'gbk';
              else if (detected === 'latin1' || detected === 'iso-8859-1') encoding = 'latin1';
            }
            if (encoding !== 'utf-8') {
              try {
                const iconv = require('iconv-lite');
                resolve(iconv.decode(buf, encoding));
              } catch (e) { resolve(buf.toString('utf-8')); }
            } else {
              const raw = buf.toString('utf-8');
              const metaCharset = raw.match(/<meta[^>]+charset=["']?([^"'\s;>]+)/i);
              if (metaCharset) {
                const mc = metaCharset[1].toLowerCase();
                if (mc === 'gbk' || mc === 'gb2312' || mc === 'gb18030') {
                  try { const iconv = require('iconv-lite'); resolve(iconv.decode(buf, 'gbk')); return; } catch (e) { /* fallback */ }
                }
              }
              resolve(raw);
            }
          });
          resp.on('error', reject);
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
      };
      doRequest(url, client);
    });

    let charData = null;

    // 1. Next.js __NEXT_DATA__
    const nextDataMatch = body.match(/<script\s+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
    if (nextDataMatch) {
      try {
        const nextData = JSON.parse(nextDataMatch[1]);
        const props = nextData && nextData.props && nextData.props.pageProps;
        if (props) {
          charData = props.character || props.char || props.data || props.characterData || null;
        }
      } catch (e) { /* JSON parse failed */ }
    }

    // 2. Embedded JSON script
    if (!charData) {
      const jsonScriptMatch = body.match(/<script\s+type="application\/json"[^>]*>([\s\S]*?)<\/script>/i);
      if (jsonScriptMatch) {
        try {
          const jsonData = JSON.parse(jsonScriptMatch[1]);
          charData = jsonData.character || jsonData.char || jsonData.data || jsonData;
        } catch (e) { /* ignore */ }
      }
    }

    // 3. Meta tags
    if (!charData) {
      const metaName = body.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i);
      const metaDesc = body.match(/<meta\s+property="og:description"\s+content="([^"]+)"/i);
      if (metaName || metaDesc) {
        charData = { name: metaName ? metaName[1] : '', description: metaDesc ? metaDesc[1] : '' };
      }
    }

    // 4. HTML title / h1
    if (!charData) {
      const titleMatch = body.match(/<title>([^<]+)<\/title>/i);
      const h1Match = body.match(/<h1[^>]*>([^<]+)<\/h1>/i);
      if (titleMatch || h1Match) {
        charData = { name: h1Match ? h1Match[1].trim() : (titleMatch ? titleMatch[1].trim() : ''), description: '' };
      }
    }

    if (!charData || !charData.name) {
      return res.json({
        success: false,
        error: '无法从该页面提取角色数据。建议手动下载 JSON 文件后通过「导入」功能添加。',
        hint: '该网站可能使用客户端渲染，无法直接抓取。'
      });
    }

    const result = {
      name: String(charData.name || '').trim().slice(0, 50),
      description: String(charData.description || charData.summary || '').trim().slice(0, 200),
      system_prompt: String(charData.system_prompt || charData.system || charData.personality || '').trim().slice(0, 4000),
      greeting: String(charData.first_mes || charData.greeting || charData.first_message || '').trim().slice(0, 1000),
      personality: String(charData.personality || '').trim().slice(0, 2000),
      scenario: String(charData.scenario || '').trim().slice(0, 2000),
      examples: String(charData.mes_example || charData.examples || charData.mesExample || '').trim().slice(0, 4000)
    };

    res.json({ success: true, data: result });
  } catch (err) {
    res.json({ success: false, error: '抓取失败：' + (err.message || '网络错误') });
  }
});

// 保存用户自建模型（id 存在则更新，否则新建；仅本人；我的模型优先于站长全局模型）
router.post('/ai-chat/api/models', isAuthenticated, hasFrontendPermission('aichat.use'), csrfCheck, aiChatModelLimiter, (req, res) => {
  const db = req.db;
  const user = req.session.user;
  const id = parseInt(req.body.id, 10) || 0;
  const name = String(req.body.name || '').trim().slice(0, 100);
  const modelKey = String(req.body.model_key || '').trim().slice(0, 100);
  const provider = String(req.body.provider || 'openai').trim().slice(0, 50);
  const apiEndpoint = String(req.body.api_endpoint || '').trim().slice(0, 300);
  const apiKey = String(req.body.api_key || '').trim();
  const maxTokens = Math.min(Math.max(parseInt(req.body.max_tokens, 10) || 4096, 256), 32768);
  const temperature = Math.min(Math.max(parseFloat(req.body.temperature) || 0.7, 0), 2);
  const isDefault = req.body.is_default === true || req.body.is_default === 1 || req.body.is_default === '1' ? 1 : 0;
  if (!name || !modelKey) return res.status(400).json({ error: '名称和模型标识不能为空' });
  if (apiKey.length > 300) return res.status(400).json({ error: 'API Key 超出长度限制' });
  if (apiKey.indexOf('ENC:') === 0) return res.status(400).json({ error: 'API Key 格式不正确' });

  const { encrypt } = require('../config/crypto-secure');
  const encKey = apiKey ? encrypt(apiKey) : '';

  if (id) {
    const row = queryOne(db, 'SELECT id FROM ai_models WHERE id = ? AND user_id = ?', [id, user.id]);
    if (!row) return res.status(404).json({ error: '模型不存在' });
    db.run('UPDATE ai_models SET name = ?, model_key = ?, provider = ?, api_endpoint = ?, max_tokens = ?, temperature = ?, is_default = ? WHERE id = ?',
      [name, modelKey, provider, apiEndpoint, maxTokens, temperature, isDefault, id]);
    if (encKey) db.run('UPDATE ai_models SET api_key = ? WHERE id = ?', [encKey, id]);
  } else {
    db.run('INSERT INTO ai_models (name, model_key, provider, api_endpoint, api_key, is_enabled, is_default, user_id) VALUES (?, ?, ?, ?, ?, 1, ?, ?)',
      [name, modelKey, provider, apiEndpoint, encKey, isDefault, user.id]);
  }
  // 设为默认时，同用户其他模型取消默认
  if (isDefault) {
    db.run('UPDATE ai_models SET is_default = 0 WHERE user_id = ? AND model_key != ?', [user.id, modelKey]);
  }
  saveDatabase();
  res.json({ success: true });
});

// 删除用户自建模型
router.post('/ai-chat/api/models/delete', isAuthenticated, hasFrontendPermission('aichat.use'), csrfCheck, aiChatModelLimiter, (req, res) => {
  const db = req.db;
  const row = queryOne(db, 'SELECT id FROM ai_models WHERE id = ? AND user_id = ?', [parseInt(req.body.id, 10), req.session.user.id]);
  if (!row) return res.status(404).json({ error: '模型不存在' });
  db.run('DELETE FROM ai_models WHERE id = ?', [row.id]);
  saveDatabase();
  res.json({ success: true });
});

// 自动获取模型列表（OpenAI 兼容 /models）：按用户填写的端点+Key 实时拉取
router.post('/ai-chat/api/models/fetch', isAuthenticated, hasFrontendPermission('aichat.use'), csrfCheck, aiChatModelLimiter, async (req, res) => {
  const db = req.db;
  const user = req.session.user;
  let endpoint = String(req.body.api_endpoint || '').trim().slice(0, 300);
  let apiKey = String(req.body.api_key || '').trim();
  const id = parseInt(req.body.id, 10) || 0;
  // 编辑已有模型时 Key 留空 → 使用已加密存储的 Key
  if (!apiKey && id) {
    const row = queryOne(db, 'SELECT api_endpoint, api_key FROM ai_models WHERE id = ? AND user_id = ?', [id, user.id]);
    if (row) {
      if (!endpoint) endpoint = row.api_endpoint || '';
      const { decrypt } = require('../config/crypto-secure');
      apiKey = decrypt(row.api_key || '') || '';
    }
  }
  try {
    const list = await fetchModelList(endpoint, apiKey);
    res.json({ success: true, data: list });
  } catch (err) {
    const { normalizeError } = require('../services/ai-chat/utils');
    res.status(400).json({ error: normalizeError(err) });
  }
});

// 测试用户自建模型连通性（短文本非流式）
router.post('/ai-chat/api/models/test', isAuthenticated, hasFrontendPermission('aichat.use'), csrfCheck, aiChatModelLimiter, async (req, res) => {
  const db = req.db;
  const row = queryOne(db, 'SELECT * FROM ai_models WHERE id = ? AND user_id = ?', [parseInt(req.body.id, 10), req.session.user.id]);
  if (!row) return res.status(404).json({ error: '模型不存在' });
  const { callChatCompletion } = require('../services/ai-chat/provider');
  const { decrypt } = require('../config/crypto-secure');
  try {
    const { content } = await callChatCompletion({
      name: row.name, provider: row.provider, model_key: row.model_key,
      api_endpoint: row.api_endpoint, api_key: decrypt(row.api_key || '') || null,
      max_tokens: Math.min(parseInt(row.max_tokens, 10) || 4096, 256),
      temperature: 0.3
    }, [{ role: 'user', content: '你好，请回复"连接成功"四个字' }], { stream: false, timeout: 30000 });
    res.json({ success: true, data: { reply: String(content || '').slice(0, 200) } });
  } catch (err) {
    const { normalizeError } = require('../services/ai-chat/utils');
    res.status(400).json({ error: normalizeError(err) });
  }
});

// ============ 生成参数 / 预设 / 模板 / 继续 / 模仿 / 滑动 ============

// 保存会话生成参数
router.post('/ai-chat/api/conversations/gen-settings', isAuthenticated, hasFrontendPermission('aichat.use'), csrfCheck, aiChatOpLimiter, (req, res) => {
  const db = req.db;
  const conv = aiChatService.getOwnConversation(db, req.session.user, parseInt(req.body.id, 10));
  if (!conv) return res.status(404).json({ error: '会话不存在' });
  const b = req.body;
  const clamp = (v, min, max) => v == null || v === '' ? null : Math.min(Math.max(parseFloat(v), min), max);
  db.run(`UPDATE ai_conversations SET gen_temperature = ?, gen_top_p = ?, gen_top_k = ?,
    gen_frequency_penalty = ?, gen_presence_penalty = ?, gen_max_tokens = ?,
    author_note = ?, author_note_depth = ?, prompt_template_id = ? WHERE id = ?`,
    [clamp(b.temperature, 0, 2), clamp(b.top_p, 0, 1),
      b.top_k != null && b.top_k !== '' ? Math.max(parseInt(b.top_k, 10) || 0, 0) : null,
      clamp(b.frequency_penalty, -2, 2), clamp(b.presence_penalty, -2, 2),
      b.max_tokens != null && b.max_tokens !== '' ? Math.min(Math.max(parseInt(b.max_tokens, 10) || 4096, 256), 32768) : null,
      String(b.author_note || '').slice(0, 2000),
      Math.max(parseInt(b.author_note_depth, 10) || 4, 0),
      b.prompt_template_id ? parseInt(b.prompt_template_id, 10) : null,
      conv.id]);
  saveDatabase();
  res.json({ success: true });
});

// 压缩对话历史（将旧消息摘要化以节省 token）
router.post('/ai-chat/api/conversations/compress', isAuthenticated, hasFrontendPermission('aichat.use'), csrfCheck, aiChatOpLimiter, async (req, res) => {
  const db = req.db;
  const conv = aiChatService.getOwnConversation(db, req.session.user, parseInt(req.body.id, 10));
  if (!conv) return res.status(404).json({ error: '会话不存在' });

  const keepRecent = Math.min(Math.max(parseInt(req.body.keep_recent, 10) || 10, 4), 50);
  const messages = queryAll(db, 'SELECT * FROM ai_messages WHERE conversation_id = ? ORDER BY created_at ASC, id ASC', [conv.id]);

  if (messages.length <= keepRecent) {
    return res.json({ success: true, compressed: 0, message: '消息数量不足，无需压缩' });
  }

  const toCompress = messages.slice(0, messages.length - keepRecent);
  const toKeep = messages.slice(messages.length - keepRecent);

  // 生成摘要
  let summary = '';
  try {
    const { callChatCompletion } = require('../services/ai-chat/provider');
    const { resolveModel } = require('../services/ai-chat/provider');
    const modelInfo = resolveModel(db, req.session.user.id, conv.model);
    if (!modelInfo) throw new Error('未配置可用模型');

    const compressPrompt = `请将以下对话历史压缩为一段简洁的摘要（保留关键信息、角色设定、重要事件），以便后续对话参考：

${toCompress.map(m => `${m.role}: ${m.content}`).join('\n')}

摘要：`;

    const result = await callChatCompletion(modelInfo, [
      { role: 'user', content: compressPrompt }
    ], { stream: false, timeout: 60000, max_tokens: 1000 });

    summary = String(result.content || '').trim();
    // 记录压缩调用的 token 消耗（用于统计，不写入消息表）
    if (result.usage) {
      console.log('[ai-chat] 压缩调用 token:', result.usage.prompt_tokens, '+', result.usage.completion_tokens, '=', result.usage.total_tokens);
    }
  } catch (err) {
    return res.status(500).json({ error: '压缩失败：' + (err.message || '模型调用错误') });
  }

  if (!summary) {
    return res.status(500).json({ error: '压缩失败：未生成摘要' });
  }

  // 删除旧消息，插入摘要消息
  const oldIds = toCompress.map(m => m.id);
  db.run(`DELETE FROM ai_messages WHERE id IN (${oldIds.map(() => '?').join(',')})`, oldIds);

  // 插入摘要作为系统消息
  const { estimateTokens } = require('../services/ai-chat/utils');
  const summaryContent = `[对话历史摘要]\n${summary}`;
  db.run('INSERT INTO ai_messages (conversation_id, role, content, tokens) VALUES (?, ?, ?, ?)',
    [conv.id, 'system', summaryContent, estimateTokens(summaryContent)]);

  saveDatabase();

  res.json({
    success: true,
    compressed: oldIds.length,
    kept: toKeep.length,
    summary: summary.slice(0, 200) + (summary.length > 200 ? '...' : '')
  });
});

// 根据对话上下文生成图片
router.post('/ai-chat/api/image/generate', isAuthenticated, hasFrontendPermission('aichat.use'), csrfCheck, aiChatOpLimiter, async (req, res) => {
  const db = req.db;
  const user = req.session.user;
  const conv = aiChatService.getOwnConversation(db, user, parseInt(req.body.conversation_id, 10));
  if (!conv) return res.status(404).json({ error: '会话不存在' });

  // 获取最近的消息作为上下文
  const messages = queryAll(db, 'SELECT role, content FROM ai_messages WHERE conversation_id = ? ORDER BY created_at DESC, id DESC LIMIT 10', [conv.id]);
  messages.reverse();

  if (!messages.length) return res.status(400).json({ error: '对话为空，无法生成图片' });

  // 构建场景描述提示词
  const contextSummary = messages.map(m => `${m.role}: ${m.content.slice(0, 200)}`).join('\n');
  const scenePrompt = `根据以下对话内容，生成一个简洁的英文图片描述（场景、氛围、关键元素），只输出描述本身，不要任何前缀：

${contextSummary}

图片描述：`;

  // 调用 LLM 生成图片提示词
  let imagePrompt = '';
  try {
    const { callChatCompletion, resolveModel } = require('../services/ai-chat/provider');
    const modelInfo = resolveModel(db, user.id, conv.model);
    if (!modelInfo) throw new Error('未配置可用模型');

    const { content } = await callChatCompletion(modelInfo, [
      { role: 'user', content: scenePrompt }
    ], { stream: false, timeout: 30000, max_tokens: 200 });

    imagePrompt = String(content || '').trim();
    if (!imagePrompt) throw new Error('未生成图片描述');
  } catch (err) {
    return res.status(500).json({ error: '生成图片描述失败：' + (err.message || '') });
  }

  // 使用 AI 生图系统生成图片（支持多服务商、异步任务）
  try {
    const { startImageTask } = require('../services/image-gen');

    // 选择默认服务商（优先 pollinations 免 Key，否则用第一个启用的）
    const imgProviders = queryAll(db, 'SELECT provider_key FROM ai_image_providers WHERE enabled = 1 ORDER BY sort_order ASC LIMIT 1');
    const providerKey = imgProviders.length ? imgProviders[0].provider_key : 'pollinations';

    const taskId = startImageTask(db, {
      userId: user.id,
      providerKey,
      prompt: imagePrompt,
      negativePrompt: '',
      size: '1024x1024',
      n: 1,
      seed: 0,
      style: ''
    });

    res.json({
      success: true,
      data: {
        taskId,
        prompt: imagePrompt
      }
    });
  } catch (err) {
    res.status(500).json({ error: '图片生成任务启动失败：' + (err.message || '') });
  }
});

// 保存场景图片为会话消息（前端轮询到生成结果后调用，持久化图片消息）
router.post('/ai-chat/api/image/save', isAuthenticated, hasFrontendPermission('aichat.use'), csrfCheck, aiChatOpLimiter, (req, res) => {
  const db = req.db;
  const user = req.session.user;
  const conv = aiChatService.getOwnConversation(db, user, parseInt(req.body.conversation_id, 10));
  if (!conv) return res.status(404).json({ error: '会话不存在' });
  const imageUrl = String(req.body.image_url || '').trim();
  const prompt = String(req.body.prompt || '').trim();
  if (!imageUrl) return res.status(400).json({ error: '缺少图片地址' });
  db.run(`INSERT INTO ai_messages (conversation_id, branch_id, role, content, tokens, model, status, is_image, image_url)
    VALUES (?, ?, 'assistant', ?, 0, '', 'done', 1, ?)`,
  [conv.id, conv.current_branch_id || 0, prompt || '场景图片', imageUrl]);
  const msg = queryOne(db, 'SELECT * FROM ai_messages WHERE id = last_insert_rowid()');
  db.run('UPDATE ai_conversations SET message_count = message_count + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [conv.id]);
  saveDatabase();
  res.json({ success: true, data: { id: msg.id } });
});

// 预设列表（用户 + 全局）
router.get('/ai-chat/api/presets', isAuthenticated, hasFrontendPermission('aichat.use'), (req, res) => {
  const db = req.db;
  const rows = queryAll(db, 'SELECT * FROM ai_presets WHERE user_id = ? OR is_global = 1 ORDER BY is_global DESC, is_default DESC, id ASC', [req.session.user.id]);
  res.json({ success: true, data: rows });
});

// 保存预设
router.post('/ai-chat/api/presets', isAuthenticated, hasFrontendPermission('aichat.use'), csrfCheck, aiChatOpLimiter, (req, res) => {
  const db = req.db;
  const b = req.body;
  const id = parseInt(b.id, 10) || 0;
  const name = String(b.name || '').trim().slice(0, 100);
  if (!name) return res.status(400).json({ error: '预设名称不能为空' });
  const clamp = (v, min, max, def) => v == null || v === '' ? def : Math.min(Math.max(parseFloat(v), min), max);
  const vals = [name, clamp(b.temperature, 0, 2, 0.7), clamp(b.top_p, 0, 1, 1),
    Math.max(parseInt(b.top_k, 10) || 0, 0), clamp(b.frequency_penalty, -2, 2, 0),
    clamp(b.presence_penalty, -2, 2, 0), Math.min(Math.max(parseInt(b.max_tokens, 10) || 4096, 256), 32768),
    b.is_default ? 1 : 0];
  if (id) {
    const existing = queryOne(db, 'SELECT id FROM ai_presets WHERE id = ? AND user_id = ?', [id, req.session.user.id]);
    if (!existing) return res.status(404).json({ error: '预设不存在' });
    db.run('UPDATE ai_presets SET name=?, temperature=?, top_p=?, top_k=?, frequency_penalty=?, presence_penalty=?, max_tokens=?, is_default=? WHERE id=?', [...vals, id]);
    if (b.is_default) db.run('UPDATE ai_presets SET is_default = 0 WHERE user_id = ? AND id != ?', [req.session.user.id, id]);
  } else {
    db.run('INSERT INTO ai_presets (user_id, name, temperature, top_p, top_k, frequency_penalty, presence_penalty, max_tokens, is_default) VALUES (?,?,?,?,?,?,?,?,?)',
      [req.session.user.id, ...vals]);
    if (b.is_default) db.run('UPDATE ai_presets SET is_default = 0 WHERE user_id = ? AND id != last_insert_rowid()', [req.session.user.id]);
  }
  saveDatabase();
  res.json({ success: true });
});

// 删除预设
router.post('/ai-chat/api/presets/delete', isAuthenticated, hasFrontendPermission('aichat.use'), csrfCheck, aiChatOpLimiter, (req, res) => {
  const db = req.db;
  const row = queryOne(db, 'SELECT id FROM ai_presets WHERE id = ? AND user_id = ?', [parseInt(req.body.id, 10), req.session.user.id]);
  if (!row) return res.status(404).json({ error: '预设不存在' });
  db.run('DELETE FROM ai_presets WHERE id = ?', [row.id]);
  saveDatabase();
  res.json({ success: true });
});

// 提示词模板列表（全局 + 用户）
router.get('/ai-chat/api/prompt-templates', isAuthenticated, hasFrontendPermission('aichat.use'), (req, res) => {
  const db = req.db;
  const rows = queryAll(db, 'SELECT * FROM ai_prompt_templates WHERE user_id = ? OR is_global = 1 ORDER BY is_global DESC, sort_order ASC, id ASC', [req.session.user.id]);
  res.json({ success: true, data: rows });
});

// 保存提示词模板（用户自定义）
router.post('/ai-chat/api/prompt-templates', isAuthenticated, hasFrontendPermission('aichat.use'), csrfCheck, aiChatOpLimiter, (req, res) => {
  const db = req.db;
  const b = req.body;
  const id = parseInt(b.id, 10) || 0;
  const name = String(b.name || '').trim().slice(0, 100);
  const content = String(b.content || '').trim().slice(0, 8000);
  if (!name || !content) return res.status(400).json({ error: '名称和内容不能为空' });
  if (id) {
    const existing = queryOne(db, 'SELECT id FROM ai_prompt_templates WHERE id = ? AND user_id = ?', [id, req.session.user.id]);
    if (!existing) return res.status(404).json({ error: '模板不存在' });
    db.run('UPDATE ai_prompt_templates SET name=?, content=?, description=? WHERE id=?',
      [name, content, String(b.description || '').slice(0, 200), id]);
  } else {
    db.run('INSERT INTO ai_prompt_templates (user_id, name, content, description) VALUES (?,?,?,?)',
      [req.session.user.id, name, content, String(b.description || '').slice(0, 200)]);
  }
  saveDatabase();
  res.json({ success: true });
});

// 删除提示词模板
router.post('/ai-chat/api/prompt-templates/delete', isAuthenticated, hasFrontendPermission('aichat.use'), csrfCheck, aiChatOpLimiter, (req, res) => {
  const db = req.db;
  const row = queryOne(db, 'SELECT id FROM ai_prompt_templates WHERE id = ? AND user_id = ?', [parseInt(req.body.id, 10), req.session.user.id]);
  if (!row) return res.status(404).json({ error: '模板不存在' });
  db.run('DELETE FROM ai_prompt_templates WHERE id = ?', [row.id]);
  saveDatabase();
  res.json({ success: true });
});

// 继续生成（从最后一条 AI 消息续写）
router.post('/ai-chat/api/messages/continue', isAuthenticated, hasFrontendPermission('aichat.use'), csrfCheck, aiChatSendLimiter, (req, res) => {
  const db = req.db;
  const user = req.session.user;
  const conv = aiChatService.getOwnConversation(db, user, parseInt(req.body.conversation_id, 10));
  if (!conv) return res.status(404).json({ error: '会话不存在' });
  const branchId = conv.current_branch_id || 0;
  const lastMsg = queryOne(db, `SELECT * FROM ai_messages WHERE conversation_id = ? AND branch_id = ? AND role = 'assistant' AND is_active = 1 ORDER BY id DESC LIMIT 1`, [conv.id, branchId]);
  if (!lastMsg) return res.status(400).json({ error: '没有可继续的 AI 消息' });
  const { resolveModel } = require('../services/ai-chat/provider');
  const { buildContext } = require('../services/ai-chat/context');
  const { checkQuota } = require('../services/ai-chat/quota');
  const quotaCheck = checkQuota(db, user);
  if (!quotaCheck.ok) return res.status(429).json({ error: quotaCheck.reason });
  const modelInfo = resolveModel(db, user.id, conv.model);
  const messages = buildContext(db, conv, '请继续', { excludeMsgId: null });
  // 将最后一条 AI 消息的内容作为 assistant prefill 提示
  messages.push({ role: 'assistant', content: String(lastMsg.content || '') + '\n' });
  const { streamEnabled } = req.body;
  const useStream = streamEnabled !== false && String(getSettings(db).ai_stream_enabled ?? '1') !== '0';
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const controller = new AbortController();
  req.on('close', () => controller.abort());
  const { callChatCompletion } = require('../services/ai-chat/provider');
  const { estimateTokens, normalizeError } = require('../services/ai-chat/utils');
  const { consumeQuota } = require('../services/ai-chat/quota');
  let full = '';
  const sendEvt = (event, data) => { if (!res.writableEnded) res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n'); };
  callChatCompletion(modelInfo, messages, {
    stream: useStream, signal: controller.signal,
    onDelta: useStream ? (delta) => { full += delta; sendEvt('delta', { delta }); } : undefined,
    genParams: aiChatService.extractGenParams ? aiChatService.extractGenParams(conv) : undefined
  }).then(result => {
    full = result.content;
    const usage = result.usage;
    const combined = String(lastMsg.content || '') + '\n' + full;
    const inputTokens = usage ? usage.prompt_tokens : estimateTokens(messages.map(m => m.content).join('\n'));
    const outputTokens = usage ? usage.completion_tokens : estimateTokens(full);
    const totalTokens = inputTokens + outputTokens;
    db.run('UPDATE ai_messages SET content = ?, tokens = ?, input_tokens = ?, output_tokens = ? WHERE id = ?', [combined, totalTokens, inputTokens, outputTokens, lastMsg.id]);
    saveDatabase();
    consumeQuota(db, user, { tokens: totalTokens, count: true });
    sendEvt('message', { id: lastMsg.id, content: combined, tokens: totalTokens, inputTokens: inputTokens, outputTokens: outputTokens, model: modelInfo.model_key, quota: checkQuota(db, user).quota });
    sendEvt('done', { aborted: false });
    res.end();
  }).catch(err => {
    if (controller.signal.aborted) {
      if (full) {
        const combined = String(lastMsg.content || '') + '\n' + full;
        db.run('UPDATE ai_messages SET content = ?, tokens = ?, status = ? WHERE id = ?', [combined, estimateTokens(combined), 'stopped', lastMsg.id]);
        saveDatabase();
      }
      sendEvt('done', { aborted: true });
    } else {
      sendEvt('error', { message: normalizeError(err) });
      sendEvt('done', { aborted: false });
    }
    res.end();
  });
});

// 模仿用户（以用户身份生成一条消息）
router.post('/ai-chat/api/messages/impersonate', isAuthenticated, hasFrontendPermission('aichat.use'), csrfCheck, aiChatSendLimiter, (req, res) => {
  const db = req.db;
  const user = req.session.user;
  const conv = aiChatService.getOwnConversation(db, user, parseInt(req.body.conversation_id, 10));
  if (!conv) return res.status(404).json({ error: '会话不存在' });
  const { resolveModel, callChatCompletion } = require('../services/ai-chat/provider');
  const { buildContext } = require('../services/ai-chat/context');
  const { checkQuota, consumeQuota } = require('../services/ai-chat/quota');
  const { estimateTokens, normalizeError } = require('../services/ai-chat/utils');
  const quotaCheck = checkQuota(db, user);
  if (!quotaCheck.ok) return res.status(429).json({ error: quotaCheck.reason });
  const modelInfo = resolveModel(db, user.id, conv.model);
  const messages = buildContext(db, conv, '', {});
  messages.push({ role: 'system', content: 'Now generate the next user message in this conversation. Write only the user message content, no prefixes or labels. Match the user\'s style and language.' });
  const useStream = String(getSettings(db).ai_stream_enabled ?? '1') !== '0';
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const controller = new AbortController();
  req.on('close', () => controller.abort());
  let full = '';
  const sendEvt = (event, data) => { if (!res.writableEnded) res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n'); };
  callChatCompletion(modelInfo, messages, {
    stream: useStream, signal: controller.signal,
    onDelta: useStream ? (delta) => { full += delta; sendEvt('delta', { delta }); } : undefined
  }).then(result => {
    full = result.content;
    const usage = result.usage;
    const inputTokens = usage ? usage.prompt_tokens : estimateTokens(messages.map(m => m.content).join('\n'));
    const outputTokens = usage ? usage.completion_tokens : estimateTokens(full);
    const totalTokens = inputTokens + outputTokens;
    db.run(`INSERT INTO ai_messages (conversation_id, branch_id, role, content, tokens, input_tokens, output_tokens, model, status) VALUES (?, ?, 'user', ?, ?, ?, ?, ?, 'done')`,
      [conv.id, conv.current_branch_id || 0, full, totalTokens, inputTokens, outputTokens, modelInfo.model_key]);
    const msg = queryOne(db, 'SELECT * FROM ai_messages WHERE id = last_insert_rowid()');
    db.run('UPDATE ai_conversations SET message_count = message_count + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [conv.id]);
    saveDatabase();
    consumeQuota(db, user, { tokens: totalTokens, count: true });
    sendEvt('message', { id: msg.id, content: full, tokens: totalTokens, inputTokens: inputTokens, outputTokens: outputTokens, model: modelInfo.model_key, role: 'user', quota: checkQuota(db, user).quota });
    sendEvt('done', { aborted: false });
    res.end();
  }).catch(err => {
    sendEvt('error', { message: normalizeError(err) });
    sendEvt('done', { aborted: false });
    res.end();
  });
});

// 获取消息的 alternates（滑动回复）
router.get('/ai-chat/api/messages/:id/alternates', isAuthenticated, hasFrontendPermission('aichat.use'), (req, res) => {
  const db = req.db;
  const msgId = parseInt(req.params.id, 10);
  const msg = queryOne(db, 'SELECT * FROM ai_messages WHERE id = ?', [msgId]);
  if (!msg) return res.status(404).json({ error: '消息不存在' });
  const conv = aiChatService.getOwnConversation(db, req.session.user, msg.conversation_id);
  if (!conv) return res.status(404).json({ error: '会话不存在' });
  const rootId = msg.alternate_of || msg.id;
  const alternates = queryAll(db, 'SELECT id, content, tokens, model, status, is_active, created_at FROM ai_messages WHERE (id = ? OR alternate_of = ?) AND conversation_id = ? ORDER BY id ASC', [rootId, rootId, conv.id]);
  res.json({ success: true, data: alternates });
});

// 切换活跃 alternate
router.post('/ai-chat/api/messages/swipe', isAuthenticated, hasFrontendPermission('aichat.use'), csrfCheck, aiChatOpLimiter, (req, res) => {
  const db = req.db;
  const targetId = parseInt(req.body.message_id, 10);
  const msg = queryOne(db, 'SELECT * FROM ai_messages WHERE id = ?', [targetId]);
  if (!msg) return res.status(404).json({ error: '消息不存在' });
  const conv = aiChatService.getOwnConversation(db, req.session.user, msg.conversation_id);
  if (!conv) return res.status(404).json({ error: '会话不存在' });
  const rootId = msg.alternate_of || msg.id;
  db.run('UPDATE ai_messages SET is_active = 0 WHERE (id = ? OR alternate_of = ?) AND conversation_id = ?', [rootId, rootId, conv.id]);
  db.run('UPDATE ai_messages SET is_active = 1 WHERE id = ?', [targetId]);
  saveDatabase();
  res.json({ success: true });
});

// 重生成作为 alternate（滑动新增）
router.post('/ai-chat/api/messages/swipe-regenerate', isAuthenticated, hasFrontendPermission('aichat.use'), csrfCheck, aiChatSendLimiter, (req, res) => {
  const db = req.db;
  const user = req.session.user;
  const targetId = parseInt(req.body.message_id, 10);
  const target = queryOne(db, 'SELECT * FROM ai_messages WHERE id = ?', [targetId]);
  if (!target || target.role !== 'assistant') return res.status(404).json({ error: '消息不存在' });
  const conv = aiChatService.getOwnConversation(db, user, target.conversation_id);
  if (!conv) return res.status(404).json({ error: '会话不存在' });
  const { resolveModel, callChatCompletion } = require('../services/ai-chat/provider');
  const { buildContext } = require('../services/ai-chat/context');
  const { checkQuota, consumeQuota } = require('../services/ai-chat/quota');
  const { estimateTokens, normalizeError } = require('../services/ai-chat/utils');
  const quotaCheck = checkQuota(db, user);
  if (!quotaCheck.ok) return res.status(429).json({ error: quotaCheck.reason });
  const branchId = target.branch_id || 0;
  const prevUser = queryOne(db, `SELECT * FROM ai_messages WHERE conversation_id = ? AND branch_id = ? AND id < ? AND role = 'user' ORDER BY id DESC LIMIT 1`, [conv.id, branchId, target.id]);
  if (!prevUser) return res.status(400).json({ error: '找不到对应的用户消息' });
  const modelInfo = resolveModel(db, user.id, conv.model);
  const messages = buildContext(db, conv, prevUser.content, { excludeMsgId: prevUser.id });
  const useStream = String(getSettings(db).ai_stream_enabled ?? '1') !== '0';
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const controller = new AbortController();
  req.on('close', () => controller.abort());
  let full = '';
  const sendEvt = (event, data) => { if (!res.writableEnded) res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n'); };
  const rootId = target.alternate_of || target.id;
  callChatCompletion(modelInfo, messages, {
    stream: useStream, signal: controller.signal,
    onDelta: useStream ? (delta) => { full += delta; sendEvt('delta', { delta }); } : undefined,
    genParams: aiChatService.extractGenParams ? aiChatService.extractGenParams(conv) : undefined
  }).then(result => {
    full = result.content;
    db.run(`INSERT INTO ai_messages (conversation_id, branch_id, role, content, tokens, model, status, alternate_of, is_active) VALUES (?, ?, 'assistant', ?, ?, ?, 'done', ?, 0)`,
      [conv.id, branchId, full, estimateTokens(full), modelInfo.model_key, rootId]);
    const newMsg = queryOne(db, 'SELECT * FROM ai_messages WHERE id = last_insert_rowid()');
    saveDatabase();
    consumeQuota(db, user, { tokens: estimateTokens(full), count: true });
    sendEvt('message', { id: newMsg.id, content: full, tokens: estimateTokens(full), model: modelInfo.model_key, alternate_of: rootId, quota: checkQuota(db, user).quota });
    sendEvt('done', { aborted: false });
    res.end();
  }).catch(err => {
    if (controller.signal.aborted) {
      sendEvt('done', { aborted: true });
    } else {
      sendEvt('error', { message: normalizeError(err) });
      sendEvt('done', { aborted: false });
    }
    res.end();
  });
});

// 上下文预览（调试用：返回当前会话的完整 prompt 组装结果）
router.get('/ai-chat/api/conversations/:id/context-preview', isAuthenticated, hasFrontendPermission('aichat.use'), (req, res) => {
  const db = req.db;
  const conv = aiChatService.getOwnConversation(db, req.session.user, parseInt(req.params.id, 10));
  if (!conv) return res.status(404).json({ error: '会话不存在' });
  const { buildContext } = require('../services/ai-chat/context');
  const { estimateTokens } = require('../services/ai-chat/utils');
  const messages = buildContext(db, conv, '（预览）', {});
  const totalTokens = messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
  res.json({ success: true, data: { messages, totalTokens } });
});

module.exports = router;
