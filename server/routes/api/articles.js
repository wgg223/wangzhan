/**
 * 文章 API 路由（供 Flutter App 使用）
 * 接口：
 *   GET  /api/v1/articles                —— 已发布文章分页列表（支持搜索/标签筛选）
 *   GET  /api/v1/articles/:id            —— 文章详情（含附件、标签、点赞状态）
 *   GET  /api/v1/articles/:id/comments   —— 文章评论列表（已审核）
 *   POST /api/v1/articles/:id/comments   —— 发表评论（需登录）
 *   POST /api/v1/articles/:id/like       —— 点赞/取消点赞（需登录，切换式）
 *   POST /api/v1/attachments/:id/download —— 附件下载计数
 * 安全要点：评论内容长度限制、点赞用内容点赞表去重、列表不返回正文全文。
 */

const express = require('express');
const { queryOne, queryAll, getDb, saveDatabase } = require('../../config/database');
const { apiAuth } = require('../../middlewares/api-auth');

const router = express.Router();

// 文章列表字段（含统计）：
// 摘要取正文前 150 字；附带作者信息、点赞数与已审核评论数
const ARTICLE_SELECT = `
  SELECT a.id, a.title, substr(a.content, 1, 150) AS summary, a.content, a.cover_image, a.category, a.location, a.status,
         a.author_id, a.created_at, a.updated_at,
         u.username AS author_name, u.nickname AS author_nickname, u.avatar AS author_avatar,
         (SELECT COUNT(*) FROM content_likes l WHERE l.target_type = 'article' AND l.target_id = a.id) AS like_count,
         (SELECT COUNT(*) FROM comments c WHERE c.article_id = a.id AND c.status = 'approved') AS comment_count
  FROM articles a
  LEFT JOIN users u ON a.author_id = u.id
`;

/**
 * 为文章行附加"当前用户是否已点赞"字段
 * @param {Array} rows - 文章行数组
 * @param {number|null} userId - 当前登录用户 ID（未登录传 null）
 * @returns {Array} 增强后的行（含 is_liked / summary / cover）
 */
function withIsLiked(rows, userId) {
  return rows.map((r) => ({
    ...r,
    summary: r.summary || '',
    cover: r.cover_image,
    is_liked: userId ? Boolean(queryOne(getDb(),
      "SELECT id FROM content_likes WHERE user_id = ? AND target_type = 'article' AND target_id = ?",
      [userId, r.id])) : false,
  }));
}

// ============ 文章列表 ============
// 支持 q（标题/内容模糊搜索）、tag（标签筛选）、page/limit 分页；
// 返回时把 content 置空（列表不需要正文，省流量）。
router.get('/articles', (req, res) => {
  const db = getDb();
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 10));
  const offset = (page - 1) * limit;
  const q = (req.query.q || '').trim();
  const tag = (req.query.tag || '').trim();

  // 动态拼 WHERE（参数全部用占位符，防注入）
  let where = "WHERE a.status = 'published'";
  const params = [];
  if (q) {
    where += ' AND (a.title LIKE ? OR a.content LIKE ?)';
    params.push(`%${q}%`, `%${q}%`);
  }
  if (tag) {
    // 按标签名/slug 查到 tag_id，再反查文章
    where += ' AND a.id IN (SELECT target_id FROM content_tags WHERE target_type = ? AND tag_id = (SELECT id FROM tags WHERE name = ? OR slug = ?))';
    params.push('article', tag, tag);
  }

  // 总数 + 当前页数据
  const total = queryOne(db, `SELECT COUNT(*) AS count FROM articles a ${where}`, params)?.count || 0;
  const rows = queryAll(db, `${ARTICLE_SELECT} ${where} ORDER BY a.created_at DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  const userId = req.apiUser ? req.apiUser.id : null;

  res.json({
    articles: withIsLiked(rows, userId).map((r) => ({ ...r, content: '' })),   // 列表不返回全文
    total,
    page,
    has_more: offset + rows.length < total,
  });
});

// ============ 文章详情 ============
router.get('/articles/:id', (req, res) => {
  const db = getDb();
  const id = parseInt(req.params.id);
  const row = queryOne(db, `${ARTICLE_SELECT} WHERE a.id = ?`, [id]);
  // 未发布/不存在统一 404
  if (!row || row.status !== 'published') {
    return res.status(404).json({ error: '文章不存在' });
  }

  // 附件列表（文件名/大小/下载次数）
  const attachments = queryAll(db,
    'SELECT id, original_name AS filename, file_size AS filesize, download_count FROM article_attachments WHERE article_id = ? ORDER BY id ASC',
    [id]
  );

  // 标签名列表
  const tags = queryAll(db,
    `SELECT t.name FROM tags t JOIN content_tags ct ON ct.tag_id = t.id WHERE ct.target_type = 'article' AND ct.target_id = ?`,
    [id]
  ).map((t) => t.name);

  // 当前用户点赞状态
  const userId = req.apiUser ? req.apiUser.id : null;
  const isLiked = userId ? Boolean(queryOne(db,
    "SELECT id FROM content_likes WHERE user_id = ? AND target_type = 'article' AND target_id = ?", [userId, id])) : false;

  res.json({
    article: {
      ...row,
      summary: row.summary || '',
      cover: row.cover_image,
      attachments,
      tags,
      is_liked: isLiked,
    },
  });
});

// ============ 文章评论 ============
// 列表：只返回已审核（approved）的一级评论（parent_id=0），最多 50 条
router.get('/articles/:id/comments', (req, res) => {
  const db = getDb();
  const articleId = parseInt(req.params.id);
  const comments = queryAll(db,
    `SELECT c.id, c.article_id, c.user_id, c.content, c.parent_id, c.status, c.created_at,
            u.username, u.nickname, u.avatar
     FROM comments c LEFT JOIN users u ON c.user_id = u.id
     WHERE c.article_id = ? AND c.status = 'approved' AND c.parent_id = 0
     ORDER BY c.created_at DESC LIMIT 50`,
    [articleId]
  );
  res.json({ comments: comments || [] });
});

// 发表评论（需登录；内容 1-1000 字；直接以 approved 状态入库）
router.post('/articles/:id/comments', apiAuth, (req, res) => {
  const db = getDb();
  const articleId = parseInt(req.params.id);
  const content = (req.body.content || '').trim();
  if (!content) return res.status(400).json({ error: '评论内容不能为空' });
  if (content.length > 1000) return res.status(400).json({ error: '评论内容过长' });

  const article = queryOne(db, 'SELECT id FROM articles WHERE id = ?', [articleId]);
  if (!article) return res.status(404).json({ error: '文章不存在' });

  db.run(
    "INSERT INTO comments (article_id, user_id, content, status, parent_id) VALUES (?, ?, ?, 'approved', 0)",
    [articleId, req.apiUser.id, content]
  );
  saveDatabase();
  res.json({ success: true, message: '评论已发表' });
});

// ============ 文章点赞 ============
// 切换式点赞：已点赞则取消，未点赞则新增；返回最新状态与点赞数
router.post('/articles/:id/like', apiAuth, (req, res) => {
  const db = getDb();
  const articleId = parseInt(req.params.id);
  const userId = req.apiUser.id;

  const existing = queryOne(db,
    "SELECT id FROM content_likes WHERE user_id = ? AND target_type = 'article' AND target_id = ?", [userId, articleId]);
  if (existing) {
    db.run('DELETE FROM content_likes WHERE id = ?', [existing.id]);   // 取消点赞
  } else {
    db.run("INSERT INTO content_likes (user_id, target_type, target_id, like_type) VALUES (?, 'article', ?, 'like')", [userId, articleId]);
  }
  saveDatabase();
  const count = queryOne(db, "SELECT COUNT(*) AS count FROM content_likes WHERE target_type = 'article' AND target_id = ?", [articleId])?.count || 0;
  res.json({ liked: !existing, count });
});

// ============ 附件下载计数 ============
// 仅累加下载次数（实际文件下载走 Web 端鉴权接口），失败静默
router.post('/attachments/:id/download', (req, res) => {
  const db = getDb();
  const id = parseInt(req.params.id);
  try {
    db.run('UPDATE article_attachments SET download_count = download_count + 1 WHERE id = ?', [id]);
    saveDatabase();
  } catch (e) { /* 忽略 */ }
  res.json({ success: true });
});

module.exports = router;
