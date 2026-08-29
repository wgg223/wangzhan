const express = require('express');
const { queryOne, queryAll, getDb } = require('../../config/database');

const router = express.Router();

// ============ 小说列表 ============
router.get('/novels', (req, res) => {
  const db = getDb();
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 10));
  const offset = (page - 1) * limit;

  const total = queryOne(db, "SELECT COUNT(*) AS count FROM novels WHERE status = 'published'")?.count || 0;
  const rows = queryAll(db, `
    SELECT n.*, (SELECT COUNT(*) FROM novel_chapters c WHERE c.novel_id = n.id) AS chapter_count
    FROM novels n
    WHERE n.status = 'published'
    ORDER BY n.updated_at DESC, n.created_at DESC LIMIT ? OFFSET ?
  `, [limit, offset]);

  res.json({ novels: rows || [], total, page, has_more: offset + rows.length < total });
});

// ============ 小说详情（含章节列表） ============
router.get('/novels/:id', (req, res) => {
  const db = getDb();
  const id = parseInt(req.params.id);
  const novel = queryOne(db, `
    SELECT n.*, (SELECT COUNT(*) FROM novel_chapters c WHERE c.novel_id = n.id) AS chapter_count
    FROM novels n WHERE n.id = ? AND n.status = 'published'
  `, [id]);
  if (!novel) return res.status(404).json({ error: '小说不存在' });

  const chapters = queryAll(db,
    'SELECT id, novel_id, title, chapter_number, file_size, created_at FROM novel_chapters WHERE novel_id = ? ORDER BY chapter_number ASC',
    [id]
  );

  res.json({ novel, chapters: chapters || [] });
});

// ============ 章节内容 ============
router.get('/novels/:id/chapters/:chapterId', (req, res) => {
  const db = getDb();
  const novelId = parseInt(req.params.id);
  const chapterId = parseInt(req.params.chapterId);

  // 安全：校验父级小说已发布，防止通过章节 ID 枚举读取未发布小说内容
  const novel = queryOne(db, "SELECT id FROM novels WHERE id = ? AND status = 'published'", [novelId]);
  if (!novel) return res.status(404).json({ error: '小说不存在' });

  const chapter = queryOne(db,
    'SELECT * FROM novel_chapters WHERE id = ? AND novel_id = ?',
    [chapterId, novelId]
  );
  if (!chapter) return res.status(404).json({ error: '章节不存在' });

  res.json({ chapter });
});

module.exports = router;
