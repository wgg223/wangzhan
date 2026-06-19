/**
 * 内容管理增强路由
 * 文章草稿自动保存、标签系统、内容版本管理
 */
const express = require('express');
const router = express.Router();
const { queryOne, queryAll, getDb } = require('../config/database');
const { isAuthenticated } = require('../middlewares/auth');

// ==================== 文章草稿自动保存 ====================

/**
 * 保存草稿（自动保存）
 */
router.post('/api/drafts', isAuthenticated, (req, res) => {
  const db = getDb();
  const userId = req.session.user.id;
  const { article_id, title, content } = req.body;

  if (!title && !content) {
    return res.status(400).json({ success: false, error: '标题或内容不能同时为空' });
  }

  try {
    if (article_id) {
      // 更新已有文章的草稿
      const existing = queryOne(db,
        'SELECT id FROM article_drafts WHERE article_id = ? AND user_id = ?',
        [article_id, userId]
      );

      if (existing) {
        db.run(
          'UPDATE article_drafts SET title = ?, content = ?, saved_at = CURRENT_TIMESTAMP WHERE id = ?',
          [title || '', content || '', existing.id]
        );
      } else {
        db.run(
          'INSERT INTO article_drafts (article_id, title, content, user_id) VALUES (?, ?, ?, ?)',
          [article_id, title || '', content || '', userId]
        );
      }
    } else {
      // 创建新草稿
      db.run(
        'INSERT INTO article_drafts (title, content, user_id) VALUES (?, ?, ?)',
        [title || '', content || '', userId]
      );
    }

    res.json({ success: true, message: '草稿已保存' });
  } catch (err) {
    res.status(500).json({ success: false, error: `保存草稿失败: ${err.message}` });
  }
});

/**
 * 获取用户的草稿列表
 */
router.get('/api/drafts', isAuthenticated, (req, res) => {
  const db = getDb();
  const userId = req.session.user.id;
  const page = parseInt(req.query.page) || 1;
  const limit = Math.min(parseInt(req.query.limit) || 20, 50);
  const offset = (page - 1) * limit;

  try {
    const total = queryOne(db,
      'SELECT COUNT(*) as count FROM article_drafts WHERE user_id = ?',
      [userId]
    )?.count || 0;

    const drafts = queryAll(db,
      `SELECT d.*, a.title as article_title, a.status as article_status
       FROM article_drafts d
       LEFT JOIN articles a ON d.article_id = a.id
       WHERE d.user_id = ?
       ORDER BY d.saved_at DESC
       LIMIT ? OFFSET ?`,
      [userId, limit, offset]
    );

    res.json({
      success: true,
      data: {
        drafts: drafts || [],
        pagination: { page, limit, total, hasMore: offset + limit < total }
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: `获取草稿失败: ${err.message}` });
  }
});

/**
 * 获取单个草稿
 */
router.get('/api/drafts/:id', isAuthenticated, (req, res) => {
  const db = getDb();
  const userId = req.session.user.id;
  const draftId = parseInt(req.params.id);

  const draft = queryOne(db,
    'SELECT * FROM article_drafts WHERE id = ? AND user_id = ?',
    [draftId, userId]
  );

  if (!draft) {
    return res.status(404).json({ success: false, error: '草稿不存在' });
  }

  res.json({ success: true, data: draft });
});

/**
 * 删除草稿
 */
router.delete('/api/drafts/:id', isAuthenticated, (req, res) => {
  const db = getDb();
  const userId = req.session.user.id;
  const draftId = parseInt(req.params.id);

  try {
    db.run('DELETE FROM article_drafts WHERE id = ? AND user_id = ?', [draftId, userId]);
    res.json({ success: true, message: '草稿已删除' });
  } catch (err) {
    res.status(500).json({ success: false, error: `删除草稿失败: ${err.message}` });
  }
});

// ==================== 标签系统 ====================

/**
 * 创建标签
 */
router.post('/api/tags', isAuthenticated, (req, res) => {
  const db = getDb();
  const { name, description, color } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ success: false, error: '标签名称为必填项' });
  }

  const slug = name.trim()
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  try {
    const result = db.run(
      'INSERT INTO tags (name, slug, description, color) VALUES (?, ?, ?, ?)',
      [name.trim(), slug, description || '', color || '#6b7280']
    );
    res.json({ success: true, data: { id: result.lastInsertRowid, name: name.trim(), slug } });
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE')) {
      return res.status(409).json({ success: false, error: '标签已存在' });
    }
    res.status(500).json({ success: false, error: `创建标签失败: ${err.message}` });
  }
});

/**
 * 获取标签列表
 */
router.get('/api/tags', (req, res) => {
  const db = getDb();
  const search = req.query.search || '';

  try {
    let tags;
    if (search) {
      tags = queryAll(db,
        'SELECT t.*, (SELECT COUNT(*) FROM content_tags WHERE tag_id = t.id) as usage_count FROM tags t WHERE t.name LIKE ? ORDER BY usage_count DESC, t.name ASC',
        [`%${search}%`]
      );
    } else {
      tags = queryAll(db,
        `SELECT t.*, (SELECT COUNT(*) FROM content_tags WHERE tag_id = t.id) as usage_count
         FROM tags t
         ORDER BY usage_count DESC, t.name ASC`
      );
    }

    res.json({ success: true, data: tags || [] });
  } catch (err) {
    res.status(500).json({ success: false, error: `获取标签失败: ${err.message}` });
  }
});

/**
 * 为内容添加标签
 */
router.post('/api/content/:type/:id/tags', isAuthenticated, (req, res) => {
  const db = getDb();
  const targetType = req.params.type;
  const targetId = parseInt(req.params.id);
  const { tag_ids, tag_names } = req.body;

  const validTypes = ['article', 'page', 'image'];
  if (!validTypes.includes(targetType)) {
    return res.status(400).json({ success: false, error: '不支持的内容类型' });
  }

  try {
    const addedTags = [];

    // 通过标签ID添加
    if (tag_ids && Array.isArray(tag_ids)) {
      for (const tagId of tag_ids) {
        try {
          db.run(
            'INSERT OR IGNORE INTO content_tags (target_type, target_id, tag_id) VALUES (?, ?, ?)',
            [targetType, targetId, tagId]
          );
          const tag = queryOne(db, 'SELECT id, name FROM tags WHERE id = ?', [tagId]);
          if (tag) addedTags.push(tag);
        } catch (e) { /* 忽略 */ }
      }
    }

    // 通过标签名称添加（自动创建不存在的标签）
    if (tag_names && Array.isArray(tag_names)) {
      for (const name of tag_names) {
        const trimmed = name.trim();
        if (!trimmed) continue;

        const slug = trimmed.toLowerCase().replace(/[^\w\u4e00-\u9fa5]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
        let tag = queryOne(db, 'SELECT id, name FROM tags WHERE slug = ?', [slug]);
        if (!tag) {
          const result = db.run('INSERT INTO tags (name, slug) VALUES (?, ?)', [trimmed, slug]);
          tag = { id: result.lastInsertRowid, name: trimmed };
        }

        try {
          db.run(
            'INSERT OR IGNORE INTO content_tags (target_type, target_id, tag_id) VALUES (?, ?, ?)',
            [targetType, targetId, tag.id]
          );
          addedTags.push(tag);
        } catch (e) { /* 忽略 */ }
      }
    }

    res.json({ success: true, data: { tags: addedTags } });
  } catch (err) {
    res.status(500).json({ success: false, error: `添加标签失败: ${err.message}` });
  }
});

/**
 * 获取内容的标签
 */
router.get('/api/content/:type/:id/tags', (req, res) => {
  const db = getDb();
  const targetType = req.params.type;
  const targetId = parseInt(req.params.id);

  const tags = queryAll(db,
    `SELECT t.id, t.name, t.slug, t.color, t.description
     FROM tags t
     JOIN content_tags ct ON t.id = ct.tag_id
     WHERE ct.target_type = ? AND ct.target_id = ?
     ORDER BY t.name`,
    [targetType, targetId]
  );

  res.json({ success: true, data: tags || [] });
});

/**
 * 删除内容的标签
 */
router.delete('/api/content/:type/:id/tags/:tagId', isAuthenticated, (req, res) => {
  const db = getDb();
  const targetType = req.params.type;
  const targetId = parseInt(req.params.id);
  const tagId = parseInt(req.params.tagId);

  try {
    db.run(
      'DELETE FROM content_tags WHERE target_type = ? AND target_id = ? AND tag_id = ?',
      [targetType, targetId, tagId]
    );
    res.json({ success: true, message: '标签已移除' });
  } catch (err) {
    res.status(500).json({ success: false, error: `移除标签失败: ${err.message}` });
  }
});

/**
 * 按标签获取内容
 */
router.get('/api/tags/:slug/contents', (req, res) => {
  const db = getDb();
  const slug = req.params.slug;
  const type = req.query.type; // 可选：过滤内容类型
  const page = parseInt(req.query.page) || 1;
  const limit = Math.min(parseInt(req.query.limit) || 20, 50);
  const offset = (page - 1) * limit;

  try {
    const tag = queryOne(db, 'SELECT * FROM tags WHERE slug = ?', [slug]);
    if (!tag) {
      return res.status(404).json({ success: false, error: '标签不存在' });
    }

    let whereClause = 'WHERE ct.tag_id = ?';
    const params = [tag.id];

    if (type) {
      whereClause += ' AND ct.target_type = ?';
      params.push(type);
    }

    const total = queryOne(db,
      `SELECT COUNT(*) as count FROM content_tags ct ${whereClause}`,
      params
    )?.count || 0;

    const contents = queryAll(db,
      `SELECT ct.target_type, ct.target_id, ct.created_at as tagged_at
       FROM content_tags ct
       ${whereClause}
       ORDER BY ct.id DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    res.json({
      success: true,
      data: {
        tag,
        contents: contents || [],
        pagination: { page, limit, total, hasMore: offset + limit < total }
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: `获取内容失败: ${err.message}` });
  }
});

// ==================== 内容版本管理 ====================

/**
 * 保存内容版本
 */
router.post('/api/content/:type/:id/versions', isAuthenticated, (req, res) => {
  const db = getDb();
  const targetType = req.params.type;
  const targetId = parseInt(req.params.id);
  const editorId = req.session.user.id;
  const { change_summary } = req.body;

  const validTypes = ['article', 'page'];
  if (!validTypes.includes(targetType)) {
    return res.status(400).json({ success: false, error: '不支持的内容类型' });
  }

  try {
    // 获取当前内容
    let title, content;
    if (targetType === 'article') {
      const article = queryOne(db, 'SELECT title, content FROM articles WHERE id = ?', [targetId]);
      if (!article) return res.status(404).json({ success: false, error: '文章不存在' });
      title = article.title;
      content = article.content;
    } else if (targetType === 'page') {
      const page = queryOne(db, 'SELECT title, content FROM pages WHERE id = ?', [targetId]);
      if (!page) return res.status(404).json({ success: false, error: '页面不存在' });
      title = page.title;
      content = page.content;
    }

    // 获取当前版本号
    const lastVersion = queryOne(db,
      'SELECT version_number FROM content_versions WHERE target_type = ? AND target_id = ? ORDER BY version_number DESC LIMIT 1',
      [targetType, targetId]
    );
    const versionNumber = (lastVersion?.version_number || 0) + 1;

    db.run(
      `INSERT INTO content_versions (target_type, target_id, version_number, title, content, editor_id, change_summary)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [targetType, targetId, versionNumber, title, content, editorId, change_summary || `版本 ${versionNumber}`]
    );

    res.json({ success: true, data: { version_number: versionNumber } });
  } catch (err) {
    res.status(500).json({ success: false, error: `保存版本失败: ${err.message}` });
  }
});

/**
 * 获取内容版本列表
 */
router.get('/api/content/:type/:id/versions', (req, res) => {
  const db = getDb();
  const targetType = req.params.type;
  const targetId = parseInt(req.params.id);
  const page = parseInt(req.query.page) || 1;
  const limit = Math.min(parseInt(req.query.limit) || 20, 50);
  const offset = (page - 1) * limit;

  try {
    const total = queryOne(db,
      'SELECT COUNT(*) as count FROM content_versions WHERE target_type = ? AND target_id = ?',
      [targetType, targetId]
    )?.count || 0;

    const versions = queryAll(db,
      `SELECT v.*, u.username as editor_name
       FROM content_versions v
       LEFT JOIN users u ON v.editor_id = u.id
       WHERE v.target_type = ? AND v.target_id = ?
       ORDER BY v.version_number DESC
       LIMIT ? OFFSET ?`,
      [targetType, targetId, limit, offset]
    );

    res.json({
      success: true,
      data: {
        versions: versions || [],
        pagination: { page, limit, total, hasMore: offset + limit < total }
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: `获取版本列表失败: ${err.message}` });
  }
});

/**
 * 获取单个版本详情
 */
router.get('/api/content/:type/:id/versions/:versionId', (req, res) => {
  const db = getDb();
  const targetType = req.params.type;
  const targetId = parseInt(req.params.id);
  const versionId = parseInt(req.params.versionId);

  const version = queryOne(db,
    `SELECT v.*, u.username as editor_name
     FROM content_versions v
     LEFT JOIN users u ON v.editor_id = u.id
     WHERE v.id = ? AND v.target_type = ? AND v.target_id = ?`,
    [versionId, targetType, targetId]
  );

  if (!version) {
    return res.status(404).json({ success: false, error: '版本不存在' });
  }

  res.json({ success: true, data: version });
});

/**
 * 回滚到指定版本
 */
router.post('/api/content/:type/:id/versions/:versionId/restore', isAuthenticated, (req, res) => {
  const db = getDb();
  const targetType = req.params.type;
  const targetId = parseInt(req.params.id);
  const versionId = parseInt(req.params.versionId);
  const editorId = req.session.user.id;

  const validTypes = ['article', 'page'];
  if (!validTypes.includes(targetType)) {
    return res.status(400).json({ success: false, error: '不支持的内容类型' });
  }

  try {
    const version = queryOne(db,
      'SELECT * FROM content_versions WHERE id = ? AND target_type = ? AND target_id = ?',
      [versionId, targetType, targetId]
    );

    if (!version) {
      return res.status(404).json({ success: false, error: '版本不存在' });
    }

    // 保存当前版本（回滚前自动存档）
    let currentTitle, currentContent;
    if (targetType === 'article') {
      const article = queryOne(db, 'SELECT title, content FROM articles WHERE id = ?', [targetId]);
      if (article) {
        currentTitle = article.title;
        currentContent = article.content;
      }
    } else {
      const page = queryOne(db, 'SELECT title, content FROM pages WHERE id = ?', [targetId]);
      if (page) {
        currentTitle = page.title;
        currentContent = page.content;
      }
    }

    if (currentTitle !== undefined) {
      const lastVersion = queryOne(db,
        'SELECT version_number FROM content_versions WHERE target_type = ? AND target_id = ? ORDER BY version_number DESC LIMIT 1',
        [targetType, targetId]
      );
      const newVersionNumber = (lastVersion?.version_number || 0) + 1;

      db.run(
        `INSERT INTO content_versions (target_type, target_id, version_number, title, content, editor_id, change_summary)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [targetType, targetId, newVersionNumber, currentTitle, currentContent, editorId, `回滚前自动保存 (版本 ${newVersionNumber})`]
      );
    }

    // 恢复版本内容
    if (targetType === 'article') {
      db.run(
        'UPDATE articles SET title = ?, content = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [version.title, version.content, targetId]
      );
    } else {
      db.run(
        'UPDATE pages SET title = ?, content = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [version.title, version.content, targetId]
      );
    }

    res.json({ success: true, message: `已恢复到版本 ${version.version_number}` });
  } catch (err) {
    res.status(500).json({ success: false, error: `恢复版本失败: ${err.message}` });
  }
});

module.exports = router;
