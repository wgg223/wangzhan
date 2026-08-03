const express = require('express');
const { queryOne, queryAll, getDb, saveDatabase } = require('../../config/database');
const { apiAuth } = require('../../middlewares/api-auth');

const router = express.Router();

// 文章列表字段（含统计）
const ARTICLE_SELECT = `
  SELECT a.id, a.title, substr(a.content, 1, 150) AS summary, a.content, a.cover_image, a.category, a.location, a.status,
         a.author_id, a.created_at, a.updated_at,
         u.username AS author_name, u.nickname AS author_nickname, u.avatar AS author_avatar,
         (SELECT COUNT(*) FROM content_likes l WHERE l.target_type = 'article' AND l.target_id = a.id) AS like_count,
         (SELECT COUNT(*) FROM comments c WHERE c.article_id = a.id AND c.status = 'approved') AS comment_count
  FROM articles a
  LEFT JOIN users u ON a.author_id = u.id
`;

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
router.get('/articles', (req, res) => {
  const db = getDb();
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 10));
  const offset = (page - 1) * limit;
  const q = (req.query.q || '').trim();
  const tag = (req.query.tag || '').trim();

  let where = "WHERE a.status = 'published'";
  const params = [];
  if (q) {
    where += ' AND (a.title LIKE ? OR a.content LIKE ?)';
    params.push(`%${q}%`, `%${q}%`);
  }
  if (tag) {
    where += ' AND a.id IN (SELECT target_id FROM content_tags WHERE target_type = ? AND tag_id = (SELECT id FROM tags WHERE name = ? OR slug = ?))';
    params.push('article', tag, tag);
  }

  const total = queryOne(db, `SELECT COUNT(*) AS count FROM articles a ${where}`, params)?.count || 0;
  const rows = queryAll(db, `${ARTICLE_SELECT} ${where} ORDER BY a.created_at DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  const userId = req.apiUser ? req.apiUser.id : null;

  res.json({
    articles: withIsLiked(rows, userId).map((r) => ({ ...r, content: '' })),
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
  if (!row || row.status !== 'published') {
    return res.status(404).json({ error: '文章不存在' });
  }

  const attachments = queryAll(db,
    'SELECT id, original_name AS filename, file_size AS filesize, file_path AS filepath, download_count FROM article_attachments WHERE article_id = ? ORDER BY id ASC',
    [id]
  );

  const tags = queryAll(db,
    `SELECT t.name FROM tags t JOIN content_tags ct ON ct.tag_id = t.id WHERE ct.target_type = 'article' AND ct.target_id = ?`,
    [id]
  ).map((t) => t.name);

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
router.post('/articles/:id/like', apiAuth, (req, res) => {
  const db = getDb();
  const articleId = parseInt(req.params.id);
  const userId = req.apiUser.id;

  const existing = queryOne(db,
    "SELECT id FROM content_likes WHERE user_id = ? AND target_type = 'article' AND target_id = ?", [userId, articleId]);
  if (existing) {
    db.run('DELETE FROM content_likes WHERE id = ?', [existing.id]);
  } else {
    db.run("INSERT INTO content_likes (user_id, target_type, target_id, like_type) VALUES (?, 'article', ?, 'like')", [userId, articleId]);
  }
  saveDatabase();
  const count = queryOne(db, "SELECT COUNT(*) AS count FROM content_likes WHERE target_type = 'article' AND target_id = ?", [articleId])?.count || 0;
  res.json({ liked: !existing, count });
});

// ============ 附件下载计数 ============
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
