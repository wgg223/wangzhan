const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { queryOne, queryAll, getDb, saveDatabase } = require('../../config/database');
const { apiAuth } = require('../../middlewares/api-auth');
const { publicDir } = require('../../config/app-root');

const router = express.Router();

// ============ 上传配置（与网页端一致） ============
const IMAGE_EXT_MAP = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp'
};

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = path.join(publicDir, 'uploads', 'images');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    // 按 mimetype 生成安全扩展名，忽略原始文件名
    cb(null, 'img-' + uniqueSuffix + (IMAGE_EXT_MAP[file.mimetype] || '.jpg'));
  }
});

const imageUpload = multer({
  storage: storage,
  limits: { fileSize: 15 * 1024 * 1024, files: 10 },
  fileFilter: function (req, file, cb) {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const allowedExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
    if (!IMAGE_EXT_MAP[file.mimetype] || !allowedExts.includes(ext)) {
      return cb(new Error('只支持 JPG、PNG、GIF、WebP 格式的图片'));
    }
    cb(null, true);
  }
});

// 可见性过滤（与网页端一致）
function buildVisibilityFilter(user) {
  if (user) {
    return {
      clause: '(i.visibility IS NULL OR i.visibility = \'\' OR i.visibility = \'public\' OR i.user_id = ? OR (i.visibility = \'selected\' AND (\',\' || i.allowed_user_ids || \',\' LIKE \'%,\' || ? || \',%\')))',
      params: [user.id, user.id]
    };
  }
  return {
    clause: '(i.visibility IS NULL OR i.visibility = \'\' OR i.visibility = \'public\')',
    params: []
  };
}

function imageWithMeta(row, userId) {
  if (!row) return null;
  const db = getDb();
  const isFavorite = userId ? Boolean(queryOne(db,
    'SELECT id FROM image_favorites WHERE user_id = ? AND image_id = ?', [userId, row.id])) : false;
  const isLiked = userId ? Boolean(queryOne(db,
    "SELECT id FROM content_likes WHERE user_id = ? AND target_type = 'image' AND target_id = ?", [userId, row.id])) : false;
  const commentCount = queryOne(db, "SELECT COUNT(*) AS count FROM image_comments WHERE image_id = ? AND status = 'approved'", [row.id])?.count || 0;
  return { ...row, is_favorite: isFavorite, is_liked: isLiked, comment_count: commentCount };
}

// ============ 分类列表 ============
router.get('/image-categories', (req, res) => {
  const db = getDb();
  const user = req.apiUser;
  let categories;
  if (user) {
    categories = queryAll(db, 'SELECT * FROM image_categories WHERE status = 1 ORDER BY sort ASC');
  } else {
    categories = queryAll(db, 'SELECT * FROM image_categories WHERE status = 1 AND is_guest = 1 ORDER BY sort ASC');
  }
  res.json({ categories: categories || [] });
});

// ============ 我的收藏 ============
router.get('/images/favorites', apiAuth, (req, res) => {
  const db = getDb();
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
  const offset = (page - 1) * limit;

  const rows = queryAll(db, `
    SELECT i.*, u.username, u.nickname, u.avatar AS user_avatar, c.name AS category_name
    FROM image_favorites f
    JOIN images i ON f.image_id = i.id
    LEFT JOIN users u ON i.user_id = u.id
    LEFT JOIN image_categories c ON i.cate_id = c.id
    WHERE f.user_id = ? AND i.status = 1
    ORDER BY f.created_at DESC LIMIT ? OFFSET ?
  `, [req.apiUser.id, limit, offset]);

  res.json({ images: rows.map((r) => imageWithMeta(r, req.apiUser.id)) });
});

// ============ 图片列表 ============
router.get('/images', (req, res) => {
  const db = getDb();
  const user = req.apiUser || null;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
  const offset = (page - 1) * limit;
  const q = (req.query.q || '').trim();
  const category = parseInt(req.query.category) || null;

  const visFilter = buildVisibilityFilter(user);
  let where = `i.status = 1 AND ${visFilter.clause}`;
  const params = [...visFilter.params];
  if (category) {
    where += ' AND i.cate_id = ?';
    params.push(category);
  }
  if (q) {
    where += ' AND (i.title LIKE ? OR i.description LIKE ?)';
    params.push(`%${q}%`, `%${q}%`);
  }

  const total = queryOne(db, `SELECT COUNT(*) AS count FROM images i WHERE ${where}`, params)?.count || 0;
  const rows = queryAll(db, `
    SELECT i.*, u.username, u.nickname, u.avatar AS user_avatar, c.name AS category_name
    FROM images i
    LEFT JOIN users u ON i.user_id = u.id
    LEFT JOIN image_categories c ON i.cate_id = c.id
    WHERE ${where}
    ORDER BY i.created_at DESC LIMIT ? OFFSET ?
  `, [...params, limit, offset]);

  const userId = user ? user.id : null;
  res.json({
    images: rows.map((r) => imageWithMeta(r, userId)),
    total,
    page,
    has_more: offset + rows.length < total,
  });
});

// ============ 图片详情 ============
router.get('/images/:id', (req, res) => {
  const db = getDb();
  const id = parseInt(req.params.id);
  const user = req.apiUser || null;

  const row = queryOne(db, `
    SELECT i.*, u.username, u.nickname, u.avatar AS user_avatar, c.name AS category_name
    FROM images i
    LEFT JOIN users u ON i.user_id = u.id
    LEFT JOIN image_categories c ON i.cate_id = c.id
    WHERE i.id = ?
  `, [id]);
  if (!row) return res.status(404).json({ error: '图片不存在' });

  const visFilter = buildVisibilityFilter(user);
  const isAllowed = queryOne(db,
    `SELECT id FROM images WHERE id = ? AND ${visFilter.clause}`,
    [id, ...visFilter.params]
  );
  if (!isAllowed) return res.status(403).json({ error: '无权查看该图片' });

  res.json({ image: imageWithMeta(row, user ? user.id : null) });
});

// ============ 收藏/取消收藏 ============
router.post('/images/:id/favorite', apiAuth, (req, res) => {
  const db = getDb();
  const imageId = parseInt(req.params.id);
  const userId = req.apiUser.id;
  const existing = queryOne(db, 'SELECT id FROM image_favorites WHERE user_id = ? AND image_id = ?', [userId, imageId]);
  if (existing) {
    db.run('DELETE FROM image_favorites WHERE id = ?', [existing.id]);
  } else {
    db.run('INSERT INTO image_favorites (image_id, user_id) VALUES (?, ?)', [imageId, userId]);
  }
  saveDatabase();
  res.json({ favorited: !existing });
});

// ============ 点赞 ============
router.post('/images/:id/like', apiAuth, (req, res) => {
  const db = getDb();
  const imageId = parseInt(req.params.id);
  const userId = req.apiUser.id;
  const existing = queryOne(db,
    "SELECT id FROM content_likes WHERE user_id = ? AND target_type = 'image' AND target_id = ?", [userId, imageId]);
  if (existing) {
    db.run('DELETE FROM content_likes WHERE id = ?', [existing.id]);
  } else {
    db.run("INSERT INTO content_likes (user_id, target_type, target_id, like_type) VALUES (?, 'image', ?, 'like')", [userId, imageId]);
  }
  saveDatabase();
  const count = queryOne(db, "SELECT COUNT(*) AS count FROM content_likes WHERE target_type = 'image' AND target_id = ?", [imageId])?.count || 0;
  res.json({ liked: !existing, count });
});

// ============ 评论 ============
router.get('/images/:id/comments', (req, res) => {
  const db = getDb();
  const imageId = parseInt(req.params.id);
  const rows = queryAll(db, `
    SELECT ic.*, u.username, u.nickname, u.avatar AS user_avatar
    FROM image_comments ic LEFT JOIN users u ON ic.user_id = u.id
    WHERE ic.image_id = ? AND ic.status = 'approved'
    ORDER BY ic.created_at DESC LIMIT 100
  `, [imageId]);
  res.json({ comments: rows || [] });
});

router.post('/images/:id/comments', apiAuth, (req, res) => {
  const db = getDb();
  const imageId = parseInt(req.params.id);
  const content = (req.body.content || '').trim();
  if (!content) return res.status(400).json({ error: '评论内容不能为空' });
  if (content.length > 500) return res.status(400).json({ error: '评论内容过长' });

  // 管理员直接通过，普通用户待审核（与网页端一致）
  const isAdmin = req.apiUser.role === 'admin' || req.apiUser.role === 'super_admin';
  db.run(
    "INSERT INTO image_comments (image_id, user_id, content, status) VALUES (?, ?, ?, ?)",
    [imageId, req.apiUser.id, content, isAdmin ? 'approved' : 'pending']
  );
  saveDatabase();
  res.json({ success: true, message: isAdmin ? '评论已发表' : '评论已提交，等待审核' });
});

// ============ 上传图片 ============
router.post('/images', apiAuth, imageUpload.array('files', 10), (req, res) => {
  const db = getDb();
  const title = (req.body.title || '').trim();
  const description = (req.body.description || '').trim();
  const cateId = parseInt(req.body.cate_id);

  if (!title) {
    return res.status(400).json({ error: '标题不能为空' });
  }
  const category = queryOne(db, 'SELECT id FROM image_categories WHERE id = ? AND status = 1', [cateId]);
  if (!category) {
    return res.status(400).json({ error: '分类不存在' });
  }
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: '请选择图片' });
  }

  const user = req.apiUser;
  // 可信用户免审核，否则待审核
  const status = user.image_no_review === 1 ? 1 : 0;

  for (let i = 0; i < req.files.length; i++) {
    const f = req.files[i];
    const url = '/uploads/images/' + f.filename;
    const t = req.files.length > 1 ? `${title} (${i + 1})` : title;
    db.run('INSERT INTO images (title, description, url, cate_id, user_id, status) VALUES (?, ?, ?, ?, ?, ?)',
      [t, description, url, cateId, user.id, status]);
  }
  saveDatabase();
  res.json({ success: true, message: status === 1 ? '上传成功' : '上传成功，等待审核' });
});

module.exports = router;
