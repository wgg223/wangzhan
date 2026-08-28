const express = require('express');
const path = require('path');
const multer = require('multer');
const router = express.Router();
const { queryAll, queryOne, saveDatabase } = require('../config/database');
const { isAuthenticated, canEditArticle, hasFrontendPermission, isAdminRole } = require('../middlewares/auth');
const { settingsCache, queryCache } = require('../config/cache');
const { createNotification } = require('./community');
const { logActivity } = require('../config/activity');
const { getSettings, getImageConfigs } = require('../utils/settings');
const { renderError } = require('../utils/response');
const { sanitize } = require('../utils/html-sanitizer');
const { marked } = require('marked');
const sanitizeHtml = require('sanitize-html');
const { createRateLimiter } = require('../middlewares/rate-limiter');
const { countDailyUsage, getUserProviderKeys, saveUserProviderKey, deleteUserProviderKey, verifyProviderKey, startImageTask, getImageTask, cancelImageTask } = require('../services/image-gen');
const { saveReferenceImage, normalizeError } = require('../services/image-gen/utils');
const { enhancePrompt } = require('../services/prompt-enhance');
const { validateMagicBytes } = require('../utils/file-validator');

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
router.post('/articles/:id/comment', (req, res) => {
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

  res.download(filePath, att.original_name);
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
    WHERE i.status = 1`;

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

// ============ AI 图片生成 ============

// 参考图上传（内存存储，5MB，仅图片格式；落盘前再做魔数校验）
const refUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (['image/jpeg', 'image/jpg', 'image/png', 'image/webp'].includes(file.mimetype)) {
      return cb(null, true);
    }
    cb(new Error('参考图仅支持 JPG/PNG/WebP 格式'));
  }
});

// 生成接口限流：每用户 1 分钟 6 次
const aiImageLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 6,
  keyGenerator: (req) => `aiimg:${req.session.user.id}`,
  message: '生成过于频繁，请稍后再试'
});

// AI 生图页面
router.get('/ai-image', isAuthenticated, hasFrontendPermission('imagegen.use'), (req, res) => {
  const db = req.db;
  const user = req.session.user;
  const settings = getSettings(db);

  const userKeys = getUserProviderKeys(db, user.id);
  const userKeySet = new Set(userKeys);

  // 可生成服务商：站长已启用 或 用户已自填 Key；全部服务商供「添加 Key」弹窗使用
  const allProviderRows = queryAll(db, `SELECT provider_key, name, enabled, default_model, models, api_key_url, supports_negative, supports_n, supports_img2img
    FROM ai_image_providers ORDER BY sort_order ASC, id ASC`);
  const providers = allProviderRows.filter(p => p.enabled || userKeySet.has(p.provider_key));
  providers.forEach(p => {
    try { p.models = JSON.parse(p.models || '[]'); } catch (e) { p.models = []; }
    p.requires_key = p.provider_key !== 'pollinations';
  });
  const allProviders = allProviderRows.map(p => ({
    provider_key: p.provider_key, name: p.name, api_key_url: p.api_key_url || ''
  }));

  const dailyLimit = parseInt(settings.ai_image_daily_limit, 10) || 20;
  const used = countDailyUsage(db, user.id);
  const unlimited = isAdminRole(user);
  const userPerms = res.locals.userPermissions || [];
  const canPickPrompt = user.role === 'super_admin' || user.role === 'admin' ||
    userPerms.indexOf('prompts.view') !== -1 || userPerms.indexOf('prompts.manage') !== -1 ||
    userPerms.indexOf('prompts.*') !== -1;
  const canShare = user.role === 'super_admin' || user.role === 'admin' ||
    userPerms.indexOf('image-share.access') !== -1 || userPerms.indexOf('image-share.*') !== -1;

  // 提示词库数据（picker 用；复用 ai_prompts_ 前缀缓存，后台改动自动失效）
  let prompts = [];
  if (canPickPrompt) {
    prompts = cachedQuery('ai_prompts_prompts', db,
      'SELECT id, category_id, title, excerpt FROM prompts WHERE is_active = 1 ORDER BY sort_order ASC, id ASC');
  }

  res.render('frontend/ai-image', {
    user,
    settings,
    providers,
    allProviders,
    dailyLimit,
    used,
    unlimited,
    canPickPrompt,
    canShare,
    userKeys,
    prompts
  });
});

// 保存用户自填的服务商 Key（加密存储；用户 Key 优先于后台全局 Key）
router.post('/ai-image/api/keys/save', isAuthenticated, hasFrontendPermission('imagegen.use'),
  createRateLimiter({ windowMs: 60 * 1000, max: 20, keyGenerator: r => `aiimgkey:${r.session.user.id}`, message: '操作过于频繁，请稍后再试' }),
  (req, res) => {
    const db = req.db;
    const userId = req.session.user.id;
    const providerKey = (req.body.provider_key || '').trim();
    const apiKey = typeof req.body.api_key === 'string' ? req.body.api_key.trim() : '';

    if (!providerKey) return res.status(400).json({ error: '服务商不能为空' });
    const provider = queryOne(db, 'SELECT provider_key FROM ai_image_providers WHERE provider_key = ?', [providerKey]);
    if (!provider) return res.status(404).json({ error: '服务商不存在' });
    if (!apiKey) return res.status(400).json({ error: 'API Key 不能为空' });
    if (apiKey.length > 300) return res.status(400).json({ error: 'API Key 长度超出限制' });
    if (apiKey.indexOf('ENC:') === 0) return res.status(400).json({ error: 'API Key 格式不正确' });

    saveUserProviderKey(db, userId, providerKey, apiKey);
    logActivity(db, {
      user_id: userId,
      username: req.session.user.username,
      action: 'update',
      target_type: 'ai_image_user_key',
      target_title: providerKey,
      detail: `用户保存了自己的 AI 生图服务商 Key：${providerKey}`,
      ip: req.ip
    });

    // 自动验证 Key 有效性并尝试获取模型（异步；整体 25s 兜底，避免服务商网络慢导致请求挂起）
    const verifyPromise = verifyProviderKey(db, providerKey, apiKey);
    const verifyTimeout = new Promise(resolve => {
      setTimeout(() => resolve({ ok: true, verified: false, error: '验证超时（服务商响应慢），Key 已保存' }), 25000);
    });
    Promise.race([verifyPromise, verifyTimeout]).then(verifyResult => {
      if (verifyResult.verified && verifyResult.models && verifyResult.models.length) {
        // 将 API 获取到的模型合并进服务商全局模型列表（去重），保证模型下拉可选到
        const row = queryOne(db, 'SELECT models, default_model FROM ai_image_providers WHERE provider_key = ?', [providerKey]);
        if (row) {
          let current = [];
          try { current = JSON.parse(row.models || '[]'); } catch (e) { current = []; }
          const merged = current.slice();
          verifyResult.models.forEach(m => {
            if (merged.indexOf(m) === -1) merged.push(m);
          });
          let updated = false;
          if (merged.length !== current.length) {
            db.run('UPDATE ai_image_providers SET models = ? WHERE provider_key = ?', [JSON.stringify(merged), providerKey]);
            updated = true;
          }
          if (!row.default_model && merged.length) {
            db.run('UPDATE ai_image_providers SET default_model = ? WHERE provider_key = ?', [merged[0], providerKey]);
            updated = true;
          }
          if (updated) saveDatabase();
        }
      }
      if (!res.headersSent) {
        if (verifyResult.verified) {
          res.json({
            success: true,
            message: 'API Key 已保存并验证通过',
            verified: true,
            models: verifyResult.models || [],
            verifyError: ''
          });
        } else {
          res.json({
            success: true,
            message: 'API Key 已保存',
            verified: false,
            models: [],
            verifyError: verifyResult.error || '该平台暂不支持自动验证'
          });
        }
      }
    }).catch(() => {
      if (!res.headersSent) {
        res.json({ success: true, message: 'API Key 已保存', verified: false, models: [], verifyError: '验证失败' });
      }
    });
  });

// 删除用户自填的服务商 Key
router.post('/ai-image/api/keys/delete', isAuthenticated, hasFrontendPermission('imagegen.use'), (req, res) => {
  const db = req.db;
  const userId = req.session.user.id;
  const providerKey = (req.body.provider_key || '').trim();
  if (!providerKey) return res.status(400).json({ error: '服务商不能为空' });
  deleteUserProviderKey(db, userId, providerKey);
  logActivity(db, {
    user_id: userId,
    username: req.session.user.username,
    action: 'delete',
    target_type: 'ai_image_user_key',
    target_title: providerKey,
    detail: `用户删除了自己的 AI 生图服务商 Key：${providerKey}`,
    ip: req.ip
  });
  res.json({ success: true, message: 'API Key 已清除' });
});

// 提示词优化（免费 Pollinations 接口或后台配置的自建 LLM）
router.post('/ai-image/api/enhance-prompt', isAuthenticated, hasFrontendPermission('imagegen.use'),
  createRateLimiter({ windowMs: 60 * 1000, max: 10, keyGenerator: r => `aiimg-enh:${r.session.user.id}`, message: '操作过于频繁，请稍后再试' }),
  async (req, res) => {
    const db = req.db;
    const prompt = (req.body.prompt || '').trim();
    if (!prompt) return res.status(400).json({ error: '请输入要优化的内容' });
    if (prompt.length > 500) return res.status(400).json({ error: '描述不能超过 500 字' });

    try {
      const { enhanced, source } = await enhancePrompt(db, prompt);
      res.json({ success: true, enhanced, source });
    } catch (err) {
      res.status(502).json({ error: normalizeError(err) });
    }
  });

// 生成图片（异步任务：立即返回 taskId，前端轮询状态，支持取消）
router.post('/ai-image/api/generate', isAuthenticated, hasFrontendPermission('imagegen.use'), aiImageLimiter, (req, res) => {
  refUpload.single('reference_image')(req, res, async (uploadErr) => {
    if (uploadErr) {
      const msg = uploadErr.code === 'LIMIT_FILE_SIZE'
        ? '参考图不能超过 5MB'
        : (uploadErr.message || '参考图上传失败');
      return res.status(400).json({ error: msg });
    }
    const db = req.db;
    const user = req.session.user;

    const prompt = (req.body.prompt || '').trim();
    const negativePrompt = (req.body.negative_prompt || '').trim();
    const size = (req.body.size || '1024x1024').trim();
    const providerKey = (req.body.provider || '').trim();
    const mode = (req.body.mode || 't2i').trim();
    const rawN = parseInt(req.body.n, 10) || 1;
    const rawSeed = req.body.seed === '' || req.body.seed === undefined ? 0 : parseInt(req.body.seed, 10);
    const style = (req.body.style || '').trim();

    if (!prompt) return res.status(400).json({ error: '提示词不能为空' });
    if (prompt.length > 1000) return res.status(400).json({ error: '提示词不能超过 1000 字' });
    if (negativePrompt.length > 500) return res.status(400).json({ error: '负向提示词不能超过 500 字' });
    if (!/^\d{1,4}[x*]\d{1,4}$/.test(size)) return res.status(400).json({ error: '图片尺寸格式不正确' });
    if (mode !== 't2i' && mode !== 'i2i') return res.status(400).json({ error: '生成模式不正确' });
    if (Number.isNaN(rawSeed) || rawSeed < 0 || rawSeed > 4294967295) {
      return res.status(400).json({ error: '种子数超出范围（0-4294967295）' });
    }

    // 服务商可用性：已启用 或 用户已自填 Key（用户用自己的 Key 不受启用开关限制）
    const provider = queryOne(db, 'SELECT * FROM ai_image_providers WHERE provider_key = ?', [providerKey]);
    if (!provider) return res.status(400).json({ error: '所选服务商不存在' });
    const userKeyList = getUserProviderKeys(db, user.id);
    if (!provider.enabled && userKeyList.indexOf(providerKey) === -1) {
      return res.status(400).json({ error: '所选服务商未启用，请选择其他服务商' });
    }
    const n = provider.supports_n ? Math.min(Math.max(rawN, 1), 4) : 1;

    // 图生图模式校验：服务商需支持且必须上传参考图
    if (mode === 'i2i') {
      if (!provider.supports_img2img) {
        return res.status(400).json({ error: '所选服务商不支持图生图，请切换服务商或回到文生图模式' });
      }
      if (!req.file) {
        return res.status(400).json({ error: '图生图模式请先上传参考图' });
      }
    }

    // 每日限额（管理员不限；成功+失败均计次）
    if (!isAdminRole(user)) {
      const settings = getSettings(db);
      const dailyLimit = parseInt(settings.ai_image_daily_limit, 10) || 20;
      if (countDailyUsage(db, user.id) >= dailyLimit) {
        return res.status(429).json({ error: `今日生成次数已达上限（${dailyLimit} 次），明天再来吧` });
      }
    }

    // 参考图（图生图）
    let referenceImagePath = null;
    let referenceImageWebPath = '';
    if (req.file) {
      if (!validateMagicBytes(req.file.buffer, req.file.mimetype)) {
        return res.status(400).json({ error: '参考图文件校验失败，请更换图片' });
      }
      referenceImageWebPath = saveReferenceImage(req.file.buffer);
      referenceImagePath = path.join(__dirname, '../..', 'public', referenceImageWebPath);
    }

    try {
      // 后台异步执行，立即返回任务 ID；结果通过 /ai-image/api/status 轮询获取
      const taskId = startImageTask(db, {
        userId: user.id,
        providerKey,
        prompt,
        negativePrompt,
        size,
        n,
        seed: rawSeed || 0,
        style,
        referenceImagePath,
        referenceImageWebPath
      });
      return res.json({ success: true, taskId });
    } catch (err) {
      return res.status(500).json({ error: '生成服务异常：' + (err.message || '未知错误') });
    }
  });
});

// 生成任务状态（轮询）
router.get('/ai-image/api/status', isAuthenticated, hasFrontendPermission('imagegen.use'), (req, res) => {
  const task = getImageTask(String(req.query.task || ''));
  if (!task || task.userId !== req.session.user.id) {
    return res.status(404).json({ success: false, error: '任务不存在或已过期' });
  }
  res.json({
    success: true,
    data: {
      status: task.status,
      message: task.message || '',
      elapsedMs: Date.now() - task.createdAt,
      result: task.result || null
    }
  });
});

// 取消生成任务（尽力调用服务商取消接口，避免远程资源浪费）
router.post('/ai-image/api/cancel', isAuthenticated, hasFrontendPermission('imagegen.use'), (req, res) => {
  const r = cancelImageTask(String((req.body && req.body.task) || ''), req.session.user.id);
  if (!r.ok) return res.status(400).json({ success: false, error: r.error });
  res.json({ success: true, message: r.message });
});

// 生成历史（分页，含失败记录）
router.get('/ai-image/api/history', isAuthenticated, hasFrontendPermission('imagegen.use'), (req, res) => {
  const db = req.db;
  const userId = req.session.user.id;
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 12, 1), 50);
  const offset = (page - 1) * pageSize;

  const totalRows = queryAll(db, 'SELECT COUNT(*) AS cnt FROM ai_image_records WHERE user_id = ?', [userId]);
  const total = (totalRows && totalRows[0] && totalRows[0].cnt) || 0;
  const records = queryAll(db,
    'SELECT id, prompt, provider, model, size, status, image_path, error, shared, created_at FROM ai_image_records WHERE user_id = ? ORDER BY id DESC LIMIT ? OFFSET ?',
    [userId, pageSize, offset]);
  res.json({ success: true, data: { records, total, page, pageSize } });
});

// 分享到图片分享模块（复用 images 表与审核流程）
router.post('/ai-image/api/share', isAuthenticated, hasFrontendPermission('imagegen.use'),
  hasFrontendPermission('image-share.access'), (req, res) => {
    const db = req.db;
    const user = req.session.user;
    const recordId = parseInt(req.body.record_id, 10);
    if (!recordId) return res.status(400).json({ error: '参数错误' });

    const record = queryOne(db, 'SELECT * FROM ai_image_records WHERE id = ? AND user_id = ?', [recordId, user.id]);
    if (!record) return res.status(404).json({ error: '生成记录不存在' });
    if (record.status !== 'success' || !record.image_path) return res.status(400).json({ error: '该记录没有可分享的图片' });
    if (record.shared) return res.status(400).json({ error: '该图片已分享过' });

    // 目标分类：第一个启用的分类，无则自动创建"AI生图"分类
    let cate = queryOne(db, 'SELECT id FROM image_categories WHERE status = 1 ORDER BY sort ASC, id ASC LIMIT 1');
    if (!cate) {
      db.run("INSERT INTO image_categories (name, sort, status) VALUES ('AI生图', 0, 1)");
      cate = queryOne(db, 'SELECT id FROM image_categories WHERE status = 1 ORDER BY sort ASC, id ASC LIMIT 1');
    }
    if (!cate) return res.status(500).json({ error: '图片分享分类初始化失败' });

    const config = getImageConfigs(db);
    let status = config.review_enabled === '1' ? 0 : 1;
    if (status === 0) {
      const userInfo = queryOne(db, 'SELECT image_no_review FROM users WHERE id = ?', [user.id]);
      if (userInfo && userInfo.image_no_review === 1) status = 1;
    }

    const title = record.prompt.slice(0, 50) || 'AI生图';
    db.run('INSERT INTO images (title, description, url, cate_id, user_id, status) VALUES (?, ?, ?, ?, ?, ?)',
      [title, record.prompt.slice(0, 500), record.image_path, cate.id, user.id, status]);
    db.run('UPDATE ai_image_records SET shared = 1 WHERE id = ?', [recordId]);
    saveDatabase();

    logActivity(db, {
      user_id: user.id,
      username: user.username,
      action: 'create',
      target_type: 'image',
      target_title: title,
      detail: `将 AI 生成图片（记录 #${recordId}）分享到图片分享`,
      ip: req.ip
    });

    res.json({ success: true, message: status === 1 ? '已分享到图片分享' : '已提交分享，等待管理员审核' });
  });

module.exports = router;
