/**
 * 小说 API 路由（供 Flutter App 使用）
 * 提供三个只读接口：
 *   GET /api/v1/novels                 —— 已发布小说分页列表（含章节数）
 *   GET /api/v1/novels/:id             —— 小说详情 + 章节列表
 *   GET /api/v1/novels/:id/chapters/:chapterId —— 单章正文内容
 * 安全要点：章节接口必须校验父级小说已发布，防止通过章节 ID 枚举读取未发布内容。
 */

const express = require('express');
const { queryOne, queryAll, getDb } = require('../../config/database');

const router = express.Router();

// ============ 小说列表 ============
// 仅返回 status='published' 的小说，按更新时间倒序分页；
// 每条附带章节数（子查询统计 novel_chapters）。
router.get('/novels', (req, res) => {
  const db = getDb();
  // 分页参数防御：page 最小 1，limit 限制在 1~50
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 10));
  const offset = (page - 1) * limit;

  // 总条数（用于分页）
  const total = queryOne(db, "SELECT COUNT(*) AS count FROM novels WHERE status = 'published'")?.count || 0;
  // 列表数据 + 每本小说的章节数
  const rows = queryAll(db, `
    SELECT n.*, (SELECT COUNT(*) FROM novel_chapters c WHERE c.novel_id = n.id) AS chapter_count
    FROM novels n
    WHERE n.status = 'published'
    ORDER BY n.updated_at DESC, n.created_at DESC LIMIT ? OFFSET ?
  `, [limit, offset]);

  res.json({ novels: rows || [], total, page, has_more: offset + rows.length < total });
});

// ============ 小说详情（含章节列表） ============
// 只返回已发布小说；章节按 chapter_number 升序（阅读顺序）。
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
// 先校验父级小说已发布，再按 (章节id, 小说id) 双重条件查章节，避免跨小说越权读取。
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
