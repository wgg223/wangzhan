const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { queryAll, queryOne, saveDatabase } = require('../config/database');
const { logActivity } = require('../config/activity');
const { isAuthenticated, hasFrontendPermission } = require('../middlewares/auth');
const { validateMagicBytes } = require('../utils/file-validator');
const { getImageConfigs } = require('../utils/settings');

// 上传配置
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = path.join(__dirname, '../../public/uploads/images');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'img-' + uniqueSuffix + path.extname(file.originalname));
  }
});

// 单文件上传配置
const imageUpload = multer({
  storage: storage,
  limits: {
    fileSize: 15 * 1024 * 1024 // 15MB
  },
  fileFilter: function (req, file, cb) {
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
    if (!allowedTypes.includes(file.mimetype)) {
      return cb(new Error('只支持 JPG、PNG、GIF、WebP 格式的图片'));
    }
    cb(null, true);
  }
});

// 批量上传配置 - 最多同时上传30张图片
const imageUploadMultiple = multer({
  storage: storage,
  limits: {
    fileSize: 15 * 1024 * 1024, // 15MB 每张
    files: 30 // 最多30张
  },
  fileFilter: function (req, file, cb) {
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
    if (!allowedTypes.includes(file.mimetype)) {
      return cb(new Error('只支持 JPG、PNG、GIF、WebP 格式的图片'));
    }
    cb(null, true);
  }
});

// 辅助：检查访客是否可以访问分类
function canAccessCategory(db, cateId, user) {
  if (user) return true;
  const category = queryOne(db, 'SELECT is_guest FROM image_categories WHERE id = ? AND status = 1', [cateId]);
  return category && category.is_guest === 1;
}

// 辅助：记录操作日志
function addLog(db, adminId, content) {
  db.run('INSERT INTO image_logs (admin_id, content) VALUES (?, ?)', [adminId, content]);
  saveDatabase();
}

// 辅助：构建可见性过滤SQL片段和参数
// 返回 { clause, params }
// user 可能为 null（未登录）
function buildVisibilityFilter(user) {
  if (user) {
    // 已登录用户：公开 OR 自己的图片 OR 被选中的用户
    return {
      clause: '(i.visibility IS NULL OR i.visibility = \'\' OR i.visibility = \'public\' OR i.user_id = ? OR (i.visibility = \'selected\' AND (\',\' || i.allowed_user_ids || \',\' LIKE \'%,\' || ? || \',%\')))',
      params: [user.id, user.id]
    };
  } else {
    // 未登录：仅公开
    return {
      clause: '(i.visibility IS NULL OR i.visibility = \'\' OR i.visibility = \'public\')',
      params: []
    };
  }
}

// ============ 前端页面 ============

// 首页
router.get('/', hasFrontendPermission('image-share.access'), (req, res) => {
  const db = req.db;
  const user = req.session.user;
  const config = getImageConfigs(db);

  const stats = {};
  const imgCount = queryOne(db, 'SELECT COUNT(*) as count FROM images WHERE status = 1');
  stats.images = imgCount ? imgCount.count : 0;
  const cateCount = queryOne(db, 'SELECT COUNT(*) as count FROM image_categories WHERE status = 1');
  stats.categories = cateCount ? cateCount.count : 0;

  let hotImages = [];
  let categories = [];

  const visFilter = buildVisibilityFilter(user);
  if (user) {
    hotImages = queryAll(db, `
      SELECT i.*, u.nickname, c.name as cate_name
      FROM images i
      LEFT JOIN users u ON i.user_id = u.id
      LEFT JOIN image_categories c ON i.cate_id = c.id
      WHERE i.status = 1 AND ${visFilter.clause}
      ORDER BY i.created_at DESC LIMIT 12
    `, visFilter.params);
    categories = queryAll(db, 'SELECT * FROM image_categories WHERE status = 1 ORDER BY sort ASC');
  } else {
    const guestCates = queryAll(db, 'SELECT id FROM image_categories WHERE is_guest = 1 AND status = 1');
    const guestIds = guestCates.map(c => c.id);
    const idsStr = guestIds.length > 0 ? guestIds.join(',') : '0';
    hotImages = queryAll(db, `
      SELECT i.*, u.nickname, c.name as cate_name
      FROM images i
      LEFT JOIN users u ON i.user_id = u.id
      LEFT JOIN image_categories c ON i.cate_id = c.id
      WHERE i.status = 1 AND i.cate_id IN (${idsStr}) AND ${visFilter.clause}
      ORDER BY i.created_at DESC LIMIT 12
    `, visFilter.params);
    categories = queryAll(db, 'SELECT * FROM image_categories WHERE status = 1 AND is_guest = 1 ORDER BY sort ASC');
  }

  res.render('image-share/index', {
    user: user,
    config: config,
    stats: stats,
    hotImages: hotImages,
    categories: categories
  });
});

// 分类详情
router.get('/category', (req, res) => {
  const db = req.db;
  const user = req.session.user;
  const cateId = parseInt(req.query.id);
  const config = getImageConfigs(db);

  if (!cateId) {
    return res.redirect('/image-share');
  }

  const category = queryOne(db, 'SELECT * FROM image_categories WHERE id = ? AND status = 1', [cateId]);
  if (!category) {
    return res.render('image-share/message', { user, config, message: '分类不存在', type: 'error' });
  }

  if (!canAccessCategory(db, cateId, user)) {
    return res.render('image-share/message', { user, config, message: '您无权访问此分类', type: 'error' });
  }

  var visFilter = buildVisibilityFilter(user);
  var queryParams = [cateId].concat(visFilter.params);
  const images = queryAll(db, `
    SELECT i.*, u.nickname, c.name as cate_name
    FROM images i
    LEFT JOIN users u ON i.user_id = u.id
    LEFT JOIN image_categories c ON i.cate_id = c.id
    WHERE i.status = 1 AND i.cate_id = ? AND ${visFilter.clause}
    ORDER BY i.created_at DESC
  `, queryParams);

  res.render('image-share/category', {
    user: user,
    config: config,
    category: category,
    images: images
  });
});

// 图片详情
router.get('/image', (req, res) => {
  const db = req.db;
  const user = req.session.user;
  const imageId = parseInt(req.query.id);
  const config = getImageConfigs(db);

  if (!imageId) {
    return res.redirect('/image-share');
  }

  const image = queryOne(db, `
    SELECT i.*, u.nickname, c.name as cate_name 
    FROM images i 
    LEFT JOIN users u ON i.user_id = u.id 
    LEFT JOIN image_categories c ON i.cate_id = c.id 
    WHERE i.id = ?
  `, [imageId]);

  if (!image) {
    return res.render('image-share/message', { user, config, message: '图片不存在', type: 'error' });
  }

  if (image.status !== 1 && (!user || (user.role !== 'admin' && user.role !== 'super_admin' && user.id !== image.user_id))) {
    return res.render('image-share/message', { user, config, message: '图片未通过审核或不存在', type: 'error' });
  }

  // 可见性检查：非管理员用户访问非公开图片时校验权限
  if (image.status === 1) {
    var canView = false;
    var vis = image.visibility || 'public';
    if (vis === 'public' || vis === '' || vis === null) {
      canView = true;
    } else if (user) {
      if (user.role === 'admin' || user.role === 'super_admin' || user.id === image.user_id) {
        canView = true;
      } else if (vis === 'selected') {
        try {
          var allowedIds = JSON.parse(image.allowed_user_ids || '[]');
          if (allowedIds.indexOf(user.id) !== -1) {
            canView = true;
          }
        } catch (e) { /* ignore */ }
      }
    }
    if (!canView) {
      return res.render('image-share/message', { user, config, message: '图片不存在或您无权查看', type: 'error' });
    }
  }

  // 功能2：获取该图片的已审核评论
  const comments = queryAll(db, `
    SELECT ic.*, u.nickname, u.avatar
    FROM image_comments ic
    LEFT JOIN users u ON ic.user_id = u.id
    WHERE ic.image_id = ? AND ic.status = 'approved'
    ORDER BY ic.created_at DESC
  `, [imageId]);

  // 功能2：获取待审核评论数量（仅图片作者或管理员可见）
  let pendingCommentCount = 0;
  if (user && (user.id === image.user_id || user.role === 'admin' || user.role === 'super_admin')) {
    const pendingRes = queryOne(db, "SELECT COUNT(*) as count FROM image_comments WHERE image_id = ? AND status = 'pending'", [imageId]);
    pendingCommentCount = pendingRes ? pendingRes.count : 0;
  }

  res.render('image-share/image-detail', {
    user: user,
    config: config,
    image: image,
    comments: comments,
    pendingCommentCount: pendingCommentCount
  });
});

// 搜索
router.get('/search', (req, res) => {
  const db = req.db;
  const user = req.session.user;
  const keyword = req.query.q || '';
  const config = getImageConfigs(db);

  let images = [];
  if (keyword.trim()) {
    var visFilter = buildVisibilityFilter(user);
    if (user) {
      images = queryAll(db, `
        SELECT i.*, u.nickname, c.name as cate_name
        FROM images i
        LEFT JOIN users u ON i.user_id = u.id
        LEFT JOIN image_categories c ON i.cate_id = c.id
        WHERE i.status = 1 AND (i.title LIKE ? OR i.description LIKE ?) AND ${visFilter.clause}
        ORDER BY i.created_at DESC
      `, [`%${keyword}%`, `%${keyword}%`].concat(visFilter.params));
    } else {
      const guestCates = queryAll(db, 'SELECT id FROM image_categories WHERE is_guest = 1 AND status = 1');
      const guestIds = guestCates.map(c => c.id);
      const idsStr = guestIds.length > 0 ? guestIds.join(',') : '0';
      images = queryAll(db, `
        SELECT i.*, u.nickname, c.name as cate_name
        FROM images i
        LEFT JOIN users u ON i.user_id = u.id
        LEFT JOIN image_categories c ON i.cate_id = c.id
        WHERE i.status = 1 AND i.cate_id IN (${idsStr}) AND (i.title LIKE ? OR i.description LIKE ?) AND ${visFilter.clause}
        ORDER BY i.created_at DESC
      `, [`%${keyword}%`, `%${keyword}%`].concat(visFilter.params));
    }
  }

  res.render('image-share/search', {
    user: user,
    config: config,
    images: images,
    keyword: keyword
  });
});

// ============ 用户功能 ============

// 用户首页（我的图片）
router.get('/user', isAuthenticated, (req, res) => {
  const db = req.db;
  const user = req.session.user;
  const config = getImageConfigs(db);

  const myImages = queryAll(db, `
    SELECT i.*, c.name as cate_name 
    FROM images i 
    LEFT JOIN image_categories c ON i.cate_id = c.id 
    WHERE i.user_id = ?
    ORDER BY i.created_at DESC
  `, [user.id]);

  res.render('image-share/user/index', {
    user: user,
    config: config,
    myImages: myImages
  });
});

// 上传图片页面
router.get('/user/upload', isAuthenticated, (req, res) => {
  const db = req.db;
  const user = req.session.user;
  const config = getImageConfigs(db);
  const categories = queryAll(db, 'SELECT * FROM image_categories WHERE status = 1 ORDER BY sort ASC');

  res.render('image-share/user/upload', {
    user: user,
    config: config,
    categories: categories
  });
});

// 处理上传
router.post('/user/upload', isAuthenticated, imageUpload.single('image'), (req, res) => {
  const db = req.db;
  const user = req.session.user;
  const config = getImageConfigs(db);

  if (!req.file) {
    const categories = queryAll(db, 'SELECT * FROM image_categories WHERE status = 1 ORDER BY sort ASC');
    return res.render('image-share/user/upload', {
      user, config, categories,
      error: '请选择要上传的图片'
    });
  }

  // 构造正确的文件路径 - 修复：直接使用 req.file.path
  var uploadFilePath = req.file.path;

  // 验证上传文件完整性：检查实际文件大小是否与预期一致
  if (fs.existsSync(uploadFilePath)) {
    const stat = fs.statSync(uploadFilePath);
    if (stat.size !== req.file.size) {
      console.error(`[image-share] 文件完整性校验失败: multer报告=${req.file.size}B, 实际=${stat.size}B, 文件=${req.file.filename}`);
      try { fs.unlinkSync(uploadFilePath); } catch (e) { /* ignore */ }
      const categories = queryAll(db, 'SELECT * FROM image_categories WHERE status = 1 ORDER BY sort ASC');
      return res.render('image-share/user/upload', {
        user, config, categories,
        error: '文件上传不完整，请重新上传'
      });
    }
    if (stat.size === 0) {
      console.error(`[image-share] 文件大小为0: ${req.file.filename}`);
      try { fs.unlinkSync(uploadFilePath); } catch (e) { /* ignore */ }
      const categories = queryAll(db, 'SELECT * FROM image_categories WHERE status = 1 ORDER BY sort ASC');
      return res.render('image-share/user/upload', {
        user, config, categories,
        error: '文件上传失败（文件为空），请重新上传'
      });
    }
  } else {
    const categories = queryAll(db, 'SELECT * FROM image_categories WHERE status = 1 ORDER BY sort ASC');
    return res.render('image-share/user/upload', {
      user, config, categories,
      error: '文件上传失败，文件未保存成功'
    });
  }

  try {
    var fileBuffer = fs.readFileSync(uploadFilePath);

    // 修复：更健壮的验证逻辑
    let isValid = validateMagicBytes(fileBuffer, req.file.mimetype);

    if (!isValid) {
      // 如果 image/jpeg 不匹配，尝试 image/jpg
      if (req.file.mimetype === 'image/jpeg' || req.file.mimetype === 'image/jpg') {
        isValid = validateMagicBytes(fileBuffer, 'image/jpeg') || validateMagicBytes(fileBuffer, 'image/jpg');
      }
    }

    if (!isValid) {
      try {
        fs.unlinkSync(uploadFilePath);
      } catch (e) { /* ignore */ }
      const categories = queryAll(db, 'SELECT * FROM image_categories WHERE status = 1 ORDER BY sort ASC');
      return res.render('image-share/user/upload', {
        user, config, categories,
        error: '文件内容与声明类型不符，已拒绝上传'
      });
    }
  } catch (validationErr) {
    try {
      fs.unlinkSync(uploadFilePath);
    } catch (e) { /* ignore */ }
    const categories = queryAll(db, 'SELECT * FROM image_categories WHERE status = 1 ORDER BY sort ASC');
    return res.render('image-share/user/upload', {
      user, config, categories,
      error: '文件验证失败，请重试'
    });
  }

  const title = req.body.title || '';
  const description = req.body.description || '';
  const cateId = parseInt(req.body.cate_id);

  if (!title || !cateId) {
    const categories = queryAll(db, 'SELECT * FROM image_categories WHERE status = 1 ORDER BY sort ASC');
    return res.render('image-share/user/upload', {
      user, config, categories,
      error: '请填写图片标题并选择分类'
    });
  }

  const reviewEnabled = config.review_enabled === '1';
  // 功能1：如果用户免审核或全局关闭审核，直接通过
  let status = reviewEnabled ? 0 : 1;
  if (status === 0) {
    const userInfo = queryOne(db, 'SELECT image_no_review FROM users WHERE id = ?', [user.id]);
    if (userInfo && userInfo.image_no_review === 1) {
      status = 1;
    }
  }
  const url = '/uploads/images/' + req.file.filename;

  db.run('INSERT INTO images (title, description, url, cate_id, user_id, status) VALUES (?, ?, ?, ?, ?, ?)',
    [title, description, url, cateId, user.id, status]);
  saveDatabase();

  const message = status === 1 ? '上传成功' : '上传成功，等待管理员审核';
  res.render('image-share/message', {
    user, config,
    message: message,
    type: 'success',
    redirect: '/image-share/user'
  });
});

// ============ 批量上传功能 ============

// 批量上传页面
router.get('/user/upload-batch', isAuthenticated, (req, res) => {
  const db = req.db;
  const user = req.session.user;
  const config = getImageConfigs(db);
  const categories = queryAll(db, 'SELECT * FROM image_categories WHERE status = 1 ORDER BY sort ASC');

  res.render('image-share/user/upload-batch', {
    user: user,
    config: config,
    categories: categories
  });
});

// 处理批量上传
router.post('/user/upload-batch', isAuthenticated, imageUploadMultiple.array('images', 20), async (req, res) => {
  const db = req.db;
  const user = req.session.user;
  const config = getImageConfigs(db);

  if (!req.files || req.files.length === 0) {
    const categories = queryAll(db, 'SELECT * FROM image_categories WHERE status = 1 ORDER BY sort ASC');
    return res.render('image-share/user/upload-batch', {
      user, config, categories,
      error: '请选择要上传的图片（最多20张）'
    });
  }

  const title = req.body.title || '';
  const description = req.body.description || '';
  const cateId = parseInt(req.body.cate_id);

  if (!title || !cateId) {
    // 删除已上传的文件
    for (const file of req.files) {
      try {
        fs.unlinkSync(file.path);
      } catch (e) { /* ignore */ }
    }
    const categories = queryAll(db, 'SELECT * FROM image_categories WHERE status = 1 ORDER BY sort ASC');
    return res.render('image-share/user/upload-batch', {
      user, config, categories,
      error: '请填写图片标题并选择分类'
    });
  }

  const reviewEnabled = config.review_enabled === '1';
  let status = reviewEnabled ? 0 : 1;
  if (status === 0) {
    const userInfo = queryOne(db, 'SELECT image_no_review FROM users WHERE id = ?', [user.id]);
    if (userInfo && userInfo.image_no_review === 1) {
      status = 1;
    }
  }

  // 验证并保存文件
  const uploadedImages = [];
  const errors = [];

  for (let i = 0; i < req.files.length; i++) {
    const file = req.files[i];
    try {
      // 验证批量上传文件完整性
      if (!fs.existsSync(file.path)) {
        errors.push(`第${i + 1}张图片：文件未保存成功`);
        continue;
      }
      const fileStat = fs.statSync(file.path);
      if (fileStat.size !== file.size) {
        console.error(`[image-share] 批量上传完整性校验失败: multer报告=${file.size}B, 实际=${fileStat.size}B, 文件=${file.filename}`);
        try { fs.unlinkSync(file.path); } catch (e) { /* ignore */ }
        errors.push(`第${i + 1}张图片：文件上传不完整`);
        continue;
      }
      if (fileStat.size === 0) {
        try { fs.unlinkSync(file.path); } catch (e) { /* ignore */ }
        errors.push(`第${i + 1}张图片：文件为空`);
        continue;
      }

      var fileBuffer = fs.readFileSync(file.path);
      let isValid = validateMagicBytes(fileBuffer, file.mimetype);

      if (!isValid && (file.mimetype === 'image/jpeg' || file.mimetype === 'image/jpg')) {
        isValid = validateMagicBytes(fileBuffer, 'image/jpeg') || validateMagicBytes(fileBuffer, 'image/jpg');
      }

      if (!isValid) {
        try {
          fs.unlinkSync(file.path);
        } catch (e) { /* ignore */ }
        errors.push(`第${i + 1}张图片：文件内容与声明类型不符`);
        continue;
      }

      const url = '/uploads/images/' + file.filename;
      db.run('INSERT INTO images (title, description, url, cate_id, user_id, status) VALUES (?, ?, ?, ?, ?, ?)',
        [title + ' (' + (i + 1) + ')', description, url, cateId, user.id, status]);
      uploadedImages.push({
        filename: file.filename,
        title: title + ' (' + (i + 1) + ')'
      });
    } catch (err) {
      errors.push(`第${i + 1}张图片：处理失败 - ${err.message}`);
      try {
        fs.unlinkSync(file.path);
      } catch (e) { /* ignore */ }
    }
  }

  saveDatabase();

  let message = '';
  if (uploadedImages.length > 0) {
    message = `成功上传 ${uploadedImages.length} 张图片`;
    if (status === 0) {
      message += '，等待管理员审核';
    }
  }

  const categories = queryAll(db, 'SELECT * FROM image_categories WHERE status = 1 ORDER BY sort ASC');
  res.render('image-share/message', {
    user, config,
    message: message + (errors.length > 0 ? '<br>失败：' + errors.join('<br>') : ''),
    type: errors.length === uploadedImages.length ? 'error' : 'success',
    redirect: '/image-share/user'
  });
});

// 编辑图片页面
router.get('/user/edit', isAuthenticated, (req, res) => {
  const db = req.db;
  const user = req.session.user;
  const config = getImageConfigs(db);
  const imageId = parseInt(req.query.id);

  if (!imageId) {
    return res.redirect('/image-share/user');
  }

  const image = queryOne(db, 'SELECT * FROM images WHERE id = ? AND user_id = ?', [imageId, user.id]);
  if (!image) {
    return res.render('image-share/message', { user, config, message: '图片不存在', type: 'error' });
  }

  const categories = queryAll(db, 'SELECT * FROM image_categories WHERE status = 1 ORDER BY sort ASC');

  res.render('image-share/user/edit', {
    user: user,
    config: config,
    image: image,
    categories: categories
  });
});

// 处理编辑
router.post('/user/edit', isAuthenticated, (req, res) => {
  const db = req.db;
  const user = req.session.user;
  const config = getImageConfigs(db);
  const { id, title, description, cate_id } = req.body;

  if (!id || !title || !cate_id) {
    return res.render('image-share/message', { user, config, message: '参数不完整', type: 'error' });
  }

  const image = queryOne(db, 'SELECT * FROM images WHERE id = ? AND user_id = ?', [id, user.id]);
  if (!image) {
    return res.render('image-share/message', { user, config, message: '图片不存在', type: 'error' });
  }

  db.run('UPDATE images SET title = ?, description = ?, cate_id = ? WHERE id = ?',
    [title, description || '', parseInt(cate_id), id]);
  saveDatabase();

  res.render('image-share/message', {
    user, config,
    message: '修改成功',
    type: 'success',
    redirect: '/image-share/user'
  });
});

// 删除图片
router.post('/user/delete', isAuthenticated, (req, res) => {
  const db = req.db;
  const user = req.session.user;
  const config = getImageConfigs(db);
  const imageId = parseInt(req.body.id);

  if (!imageId) {
    return res.redirect('/image-share/user');
  }

  const image = queryOne(db, 'SELECT * FROM images WHERE id = ? AND user_id = ?', [imageId, user.id]);
  if (!image) {
    return res.render('image-share/message', { user, config, message: '图片不存在', type: 'error' });
  }

  // 删除文件
  const filePath = path.join(__dirname, '../../public', image.url);
  if (fs.existsSync(filePath)) {
    try { fs.unlinkSync(filePath); } catch (e) { /* ignore */ }
  }

  db.run('DELETE FROM images WHERE id = ?', [imageId]);
  saveDatabase();

  res.redirect('/image-share/user');
});

// ============ 功能3：图片下载 ============

router.get('/download', (req, res) => {
  const db = req.db;
  const imageId = parseInt(req.query.id);
  if (!imageId) {
    return res.redirect('/image-share');
  }

  const image = queryOne(db, 'SELECT * FROM images WHERE id = ?', [imageId]);
  if (!image) {
    return res.render('image-share/message', { user: req.session.user, config: getImageConfigs(db), message: '图片不存在', type: 'error' });
  }

  // 增加下载次数
  db.run('UPDATE images SET download_count = download_count + 1 WHERE id = ?', [imageId]);
  saveDatabase();

  // 重定向到图片URL让浏览器下载
  const filePath = path.join(__dirname, '../../public', image.url);
  if (fs.existsSync(filePath)) {
    const fileName = image.title + path.extname(image.url);
    res.download(filePath, fileName);
  } else {
    // 如果文件不存在，直接重定向到图片URL
    res.redirect(image.url);
  }
});

// ============ 功能2：图片评论 API ============

// 添加评论
router.post('/comment/add', isAuthenticated, (req, res) => {
  const db = req.db;
  const user = req.session.user;
  const config = getImageConfigs(db);
  const { image_id, content } = req.body;

  if (!image_id || !content || !content.trim()) {
    return res.render('image-share/message', { user, config, message: '评论内容不能为空', type: 'error' });
  }

  const image = queryOne(db, 'SELECT id FROM images WHERE id = ?', [parseInt(image_id)]);
  if (!image) {
    return res.render('image-share/message', { user, config, message: '图片不存在', type: 'error' });
  }

  db.run("INSERT INTO image_comments (image_id, user_id, content, status) VALUES (?, ?, ?, 'pending')",
    [parseInt(image_id), user.id, content.trim()]);
  saveDatabase();

  res.render('image-share/message', {
    user, config,
    message: '评论发表成功，等待管理员审核',
    type: 'success',
    redirect: '/image-share/image?id=' + image_id
  });
});

// 删除评论（仅评论作者可删除）
router.post('/comment/delete', isAuthenticated, (req, res) => {
  const db = req.db;
  const user = req.session.user;
  const config = getImageConfigs(db);
  const commentId = parseInt(req.body.id);
  const imageId = parseInt(req.body.image_id);

  if (!commentId) {
    return res.redirect('/image-share');
  }

  const comment = queryOne(db, 'SELECT * FROM image_comments WHERE id = ?', [commentId]);
  if (!comment) {
    return res.render('image-share/message', { user, config, message: '评论不存在', type: 'error' });
  }

  // 仅评论作者或管理员可删除
  if (comment.user_id !== user.id && user.role !== 'admin' && user.role !== 'super_admin') {
    return res.render('image-share/message', { user, config, message: '无权删除此评论', type: 'error' });
  }

  db.run('DELETE FROM image_comments WHERE id = ?', [commentId]);
  saveDatabase();

  res.redirect('/image-share/image?id=' + (imageId || comment.image_id));
});

// ============ 管理后台 - 已整合到主后台 /admin/image-share ============

// 所有管理路由重定向到主后台
router.get('/admin', isAuthenticated, (req, res) => {
  res.redirect('/admin/image-share');
});

router.get('/admin/images', isAuthenticated, (req, res) => {
  const status = req.query.status;
  const query = status !== undefined ? `?status=${status}` : '';
  res.redirect('/admin/image-share/images' + query);
});

router.post('/admin/review', isAuthenticated, (req, res) => {
  res.redirect('/admin/image-share');
});

router.post('/admin/delete', isAuthenticated, (req, res) => {
  res.redirect('/admin/image-share');
});

router.get('/admin/categories', isAuthenticated, (req, res) => {
  res.redirect('/admin/image-share/categories');
});

router.post('/admin/categories/add', isAuthenticated, (req, res) => {
  res.redirect('/admin/image-share');
});

router.post('/admin/categories/edit', isAuthenticated, (req, res) => {
  res.redirect('/admin/image-share');
});

router.post('/admin/categories/delete', isAuthenticated, (req, res) => {
  res.redirect('/admin/image-share');
});

router.get('/admin/users', isAuthenticated, (req, res) => {
  res.redirect('/admin/image-share');
});

router.post('/admin/users/toggle', isAuthenticated, (req, res) => {
  res.redirect('/admin/image-share');
});

// GET /admin/settings - 由主admin.js的 /admin/image-share/settings 渲染
// 所以这里保持重定向，确保GET请求能正确获取设置页面
// POST处理保留在此用于AJAX保存，不冲突
router.get('/admin/settings', isAuthenticated, (req, res) => {
  res.redirect('/admin/image-share/settings');
});

router.post('/admin/settings', isAuthenticated, (req, res) => {
  const db = req.db;
  const {
    site_name,
    site_description,
    site_logo,
    icp_number,
    review_enabled,
    comment_enabled,
    comment_review_enabled,
    guest_view_enabled,
    guest_upload_enabled,
    max_size,
    allowed_formats,
    images_per_page,
    hot_images_count
  } = req.body;

  if (site_name !== undefined) {
    db.run("INSERT OR REPLACE INTO image_configs (config_key, config_value) VALUES ('site_name', ?)", [site_name || '']);
  }
  if (site_description !== undefined) {
    db.run("INSERT OR REPLACE INTO image_configs (config_key, config_value) VALUES ('site_description', ?)", [site_description || '']);
  }
  if (site_logo !== undefined) {
    db.run("INSERT OR REPLACE INTO image_configs (config_key, config_value) VALUES ('site_logo', ?)", [site_logo || '']);
  }
  if (icp_number !== undefined) {
    db.run("INSERT OR REPLACE INTO image_configs (config_key, config_value) VALUES ('icp_number', ?)", [icp_number || '']);
  }
  if (review_enabled !== undefined) {
    db.run("INSERT OR REPLACE INTO image_configs (config_key, config_value) VALUES ('review_enabled', ?)", [review_enabled ? '1' : '0']);
  }
  if (comment_enabled !== undefined) {
    db.run("INSERT OR REPLACE INTO image_configs (config_key, config_value) VALUES ('comment_enabled', ?)", [comment_enabled ? '1' : '0']);
  }
  if (comment_review_enabled !== undefined) {
    db.run("INSERT OR REPLACE INTO image_configs (config_key, config_value) VALUES ('comment_review_enabled', ?)", [comment_review_enabled ? '1' : '0']);
  }
  if (guest_view_enabled !== undefined) {
    db.run("INSERT OR REPLACE INTO image_configs (config_key, config_value) VALUES ('guest_view_enabled', ?)", [guest_view_enabled ? '1' : '0']);
  }
  if (guest_upload_enabled !== undefined) {
    db.run("INSERT OR REPLACE INTO image_configs (config_key, config_value) VALUES ('guest_upload_enabled', ?)", [guest_upload_enabled ? '1' : '0']);
  }
  if (max_size !== undefined) {
    db.run("INSERT OR REPLACE INTO image_configs (config_key, config_value) VALUES ('max_size', ?)", [String(max_size)]);
  }
  if (allowed_formats !== undefined) {
    db.run("INSERT OR REPLACE INTO image_configs (config_key, config_value) VALUES ('allowed_formats', ?)", [allowed_formats || '']);
  }
  if (images_per_page !== undefined) {
    db.run("INSERT OR REPLACE INTO image_configs (config_key, config_value) VALUES ('images_per_page', ?)", [String(images_per_page)]);
  }
  if (hot_images_count !== undefined) {
    db.run("INSERT OR REPLACE INTO image_configs (config_key, config_value) VALUES ('hot_images_count', ?)", [String(hot_images_count)]);
  }

  saveDatabase();
  res.json({ success: true, message: '保存成功' });
});

router.get('/admin/logs', isAuthenticated, (req, res) => {
  res.redirect('/admin/image-share/logs');
});

// ============ 用户资料 ============

// 个人资料
router.get('/user/profile', isAuthenticated, (req, res) => {
  const db = req.db;
  const user = req.session.user;
  const config = getImageConfigs(db);

  const userInfo = queryOne(db, 'SELECT * FROM users WHERE id = ?', [user.id]);

  res.render('image-share/user/profile', {
    user: user,
    config: config,
    userInfo: userInfo
  });
});

// 更新资料
router.post('/user/profile', isAuthenticated, (req, res) => {
  const db = req.db;
  const user = req.session.user;
  const config = getImageConfigs(db);

  const { nickname, email, current_password, new_password } = req.body;

  if (nickname) {
    db.run('UPDATE users SET nickname = ? WHERE id = ?', [nickname, user.id]);
  }
  if (email) {
    // 检查邮箱是否被其他用户使用
    const existing = queryOne(db, 'SELECT id FROM users WHERE email = ? AND id != ?', [email, user.id]);
    if (existing) {
      return res.render('image-share/message', { user, config, message: '该邮箱已被其他用户使用', type: 'error' });
    }
    db.run('UPDATE users SET email = ? WHERE id = ?', [email, user.id]);
  }
  if (new_password) {
    const userInfo = queryOne(db, 'SELECT password FROM users WHERE id = ?', [user.id]);
    const bcrypt = require('bcryptjs');

    // 验证当前密码
    let passwordOk = false;
    if (userInfo) {
      if (bcrypt.compareSync(current_password, userInfo.password)) {
        passwordOk = true;
      } else if (require('crypto').createHash('sha256').update(current_password).digest('hex') === userInfo.password) {
        passwordOk = true;
      }
    }

    if (!passwordOk) {
      return res.render('image-share/message', { user, config, message: '当前密码错误', type: 'error' });
    }

    const hashedPassword = bcrypt.hashSync(new_password, 10);
    db.run('UPDATE users SET password = ? WHERE id = ?', [hashedPassword, user.id]);
  }

  saveDatabase();

  res.render('image-share/message', {
    user, config,
    message: '资料更新成功',
    type: 'success',
    redirect: '/image-share/user/profile'
  });
});

// ============ 前端用户认证（统一认证页面） ============

// 登录页面 - 重定向到统一认证页面
router.get('/login', (req, res) => {
  res.redirect('/auth/image-share/login');
});

// 处理登录 - 重定向到统一认证页面（307保留POST方法）
router.post('/login', (req, res) => {
  // 无权限直接渲染message，不进行POST重定向
  const db = req.db;
  const user = req.session.user;
  const config = getImageConfigs(db);
  res.status(403).render('image-share/message', {
    user, config,
    message: '请通过统一认证页面登录',
    type: 'error',
    redirect: '/auth/image-share/login'
  });
});

// 注册页面 - 重定向到统一认证页面
router.get('/register', (req, res) => {
  res.redirect('/auth/image-share/register');
});

// 处理注册 - 直接渲染提示页面，不进行POST重定向
router.post('/register', (req, res) => {
  const db = req.db;
  const user = req.session.user;
  const config = getImageConfigs(db);
  res.status(403).render('image-share/message', {
    user, config,
    message: '请通过统一认证页面注册',
    type: 'error',
    redirect: '/auth/image-share/register'
  });
});

// 退出登录
router.get('/logout', (req, res) => {
  try {
    if (req.session.user && req.db) {
      logActivity(req.db, {
        user_id: req.session.user.id,
        username: req.session.user.username,
        action: 'logout',
        target_type: 'auth',
        target_title: '图片分享',
        detail: `用户 ${req.session.user.username} 从图片分享站登出`,
        ip: req.ip
      });
    }
  } catch (err) {
    console.error('[image-share] logActivity 错误:', err.message);
  }
  req.session.destroy();
  res.redirect('/image-share');
});

// ==================== 图片收藏 API ====================

/**
 * 收藏/取消收藏图片
 */
router.post('/api/image/:id/favorite', isAuthenticated, (req, res) => {
  const db = req.db;
  const userId = req.session.user.id;
  const imageId = parseInt(req.params.id);

  // 检查图片是否存在
  const image = queryOne(db, 'SELECT * FROM images WHERE id = ?', [imageId]);
  if (!image) {
    return res.status(404).json({ success: false, error: '图片不存在' });
  }

  // 检查是否已收藏
  const existing = queryOne(db,
    'SELECT id FROM image_favorites WHERE user_id = ? AND image_id = ?',
    [userId, imageId]
  );

  try {
    if (existing) {
      // 取消收藏
      db.run('DELETE FROM image_favorites WHERE user_id = ? AND image_id = ?', [userId, imageId]);
      res.json({ success: true, data: { favorited: false, message: '已取消收藏' } });
    } else {
      // 添加收藏
      db.run('INSERT INTO image_favorites (user_id, image_id) VALUES (?, ?)', [userId, imageId]);
      res.json({ success: true, data: { favorited: true, message: '已收藏' } });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: `操作失败: ${err.message}` });
  }
});

/**
 * 检查图片收藏状态
 */
router.get('/api/image/:id/favorite/status', isAuthenticated, (req, res) => {
  const db = req.db;
  const userId = req.session.user.id;
  const imageId = parseInt(req.params.id);

  const existing = queryOne(db,
    'SELECT id FROM image_favorites WHERE user_id = ? AND image_id = ?',
    [userId, imageId]
  );

  const count = queryOne(db,
    'SELECT COUNT(*) as count FROM image_favorites WHERE image_id = ?',
    [imageId]
  );

  res.json({
    success: true,
    data: {
      favorited: Boolean(existing),
      favorite_count: count?.count || 0
    }
  });
});

/**
 * 获取用户收藏列表
 */
router.get('/api/user/favorites', isAuthenticated, (req, res) => {
  const db = req.db;
  const userId = req.session.user.id;
  const page = parseInt(req.query.page) || 1;
  const limit = Math.min(parseInt(req.query.limit) || 20, 50);
  const offset = (page - 1) * limit;

  try {
    const total = queryOne(db,
      'SELECT COUNT(*) as count FROM image_favorites WHERE user_id = ?',
      [userId]
    )?.count || 0;

    const favorites = queryAll(db,
      `SELECT f.id as favorite_id, f.created_at as favorited_at,
              i.id, i.title, i.description, i.url, i.cate_id, i.status, i.created_at,
              ic.name as category_name
       FROM image_favorites f
       JOIN images i ON f.image_id = i.id
       LEFT JOIN image_categories ic ON i.cate_id = ic.id
       WHERE f.user_id = ?
       ORDER BY f.created_at DESC
       LIMIT ? OFFSET ?`,
      [userId, limit, offset]
    );

    res.json({
      success: true,
      data: {
        favorites: favorites || [],
        pagination: { page, limit, total, hasMore: offset + limit < total }
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: `获取收藏列表失败: ${err.message}` });
  }
});

// ==================== 图片批量操作 API ====================

/**
 * 批量审核图片（管理员）
 */
router.post('/api/admin/images/batch-review', isAuthenticated, (req, res) => {
  const db = req.db;
  const userId = req.session.user.id;
  const { image_ids, status } = req.body;

  if (!image_ids || !Array.isArray(image_ids) || image_ids.length === 0) {
    return res.status(400).json({ success: false, error: '请选择要操作的图片' });
  }
  if (status === undefined || ![0, 1].includes(parseInt(status))) {
    return res.status(400).json({ success: false, error: '无效的审核状态' });
  }

  // 检查权限
  const user = queryOne(db, 'SELECT role FROM users WHERE id = ?', [userId]);
  if (!user || (user.role !== 'admin' && user.role !== 'super_admin')) {
    return res.status(403).json({ success: false, error: '无权操作' });
  }

  const newStatus = parseInt(status);
  const ids = image_ids.map(id => parseInt(id)).filter(id => !isNaN(id));

  try {
    const updated = db.run(
      'UPDATE images SET status = ? WHERE id IN (' + ids.map(() => '?').join(',') + ')',
      [newStatus, ...ids]
    );

    // 记录日志
    addLog(db, userId, `批量审核图片: ${ids.length} 张图片状态变更为 ${newStatus === 1 ? '通过' : '待审核'}`);

    res.json({ success: true, message: `已更新 ${ids.length} 张图片`, data: { affected: ids.length } });
  } catch (err) {
    res.status(500).json({ success: false, error: `批量审核失败: ${err.message}` });
  }
});

/**
 * 批量移动图片分类（管理员）
 */
router.post('/api/admin/images/batch-move-category', isAuthenticated, (req, res) => {
  const db = req.db;
  const userId = req.session.user.id;
  const { image_ids, cate_id } = req.body;

  if (!image_ids || !Array.isArray(image_ids) || image_ids.length === 0) {
    return res.status(400).json({ success: false, error: '请选择要操作的图片' });
  }
  if (!cate_id) {
    return res.status(400).json({ success: false, error: '请选择目标分类' });
  }

  // 检查权限
  const user = queryOne(db, 'SELECT role FROM users WHERE id = ?', [userId]);
  if (!user || (user.role !== 'admin' && user.role !== 'super_admin')) {
    return res.status(403).json({ success: false, error: '无权操作' });
  }

  // 检查分类是否存在
  const category = queryOne(db, 'SELECT id, name FROM image_categories WHERE id = ?', [parseInt(cate_id)]);
  if (!category) {
    return res.status(404).json({ success: false, error: '分类不存在' });
  }

  const ids = image_ids.map(id => parseInt(id)).filter(id => !isNaN(id));

  try {
    db.run(
      'UPDATE images SET cate_id = ? WHERE id IN (' + ids.map(() => '?').join(',') + ')',
      [category.id, ...ids]
    );

    addLog(db, userId, `批量移动分类: ${ids.length} 张图片移至「${category.name}」`);

    res.json({ success: true, message: `已移动 ${ids.length} 张图片到「${category.name}」`, data: { affected: ids.length } });
  } catch (err) {
    res.status(500).json({ success: false, error: `批量移动失败: ${err.message}` });
  }
});

/**
 * 批量删除图片（管理员）
 */
router.post('/api/admin/images/batch-delete', isAuthenticated, (req, res) => {
  const db = req.db;
  const userId = req.session.user.id;
  const { image_ids } = req.body;

  if (!image_ids || !Array.isArray(image_ids) || image_ids.length === 0) {
    return res.status(400).json({ success: false, error: '请选择要删除的图片' });
  }

  const user = queryOne(db, 'SELECT role FROM users WHERE id = ?', [userId]);
  if (!user || (user.role !== 'admin' && user.role !== 'super_admin')) {
    return res.status(403).json({ success: false, error: '无权操作' });
  }

  const ids = image_ids.map(id => parseInt(id)).filter(id => !isNaN(id));

  try {
    // 获取图片信息用于删除文件
    const images = queryAll(db,
      'SELECT url FROM images WHERE id IN (' + ids.map(() => '?').join(',') + ')',
      ids
    );

    // 删除数据库记录（外键级联删除关联数据）
    db.run(
      'DELETE FROM images WHERE id IN (' + ids.map(() => '?').join(',') + ')',
      ids
    );

    // 尝试删除物理文件
    const fs = require('fs');
    const path = require('path');
    for (const img of images || []) {
      if (img.url) {
        const filePath = path.join(__dirname, '../../public', img.url);
        try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (e) { /* 忽略 */ }
      }
    }

    addLog(db, userId, `批量删除图片: ${ids.length} 张图片已删除`);

    res.json({ success: true, message: `已删除 ${ids.length} 张图片`, data: { affected: ids.length } });
  } catch (err) {
    res.status(500).json({ success: false, error: `批量删除失败: ${err.message}` });
  }
});

// ==================== 图片标签 API ====================

/**
 * 为图片添加标签
 */
router.post('/api/image/:id/tags', isAuthenticated, (req, res) => {
  const db = req.db;
  const userId = req.session.user.id;
  const imageId = parseInt(req.params.id);
  const { tags } = req.body;

  if (!tags || !Array.isArray(tags) || tags.length === 0) {
    return res.status(400).json({ success: false, error: '请提供标签列表' });
  }

  // 验证图片所有权或管理员权限
  const image = queryOne(db, 'SELECT * FROM images WHERE id = ?', [imageId]);
  if (!image) {
    return res.status(404).json({ success: false, error: '图片不存在' });
  }

  const user = queryOne(db, 'SELECT role FROM users WHERE id = ?', [userId]);
  if (image.user_id !== userId && (!user || (user.role !== 'admin' && user.role !== 'super_admin'))) {
    return res.status(403).json({ success: false, error: '无权操作' });
  }

  try {
    const addedTags = [];
    for (const tagName of tags) {
      const trimmed = tagName.trim().toLowerCase();
      if (!trimmed) continue;

      // 获取或创建标签
      let tag = queryOne(db, 'SELECT id FROM image_tags WHERE name = ?', [trimmed]);
      if (!tag) {
        const result = db.run('INSERT INTO image_tags (name) VALUES (?)', [trimmed]);
        tag = { id: result.lastInsertRowid };
      }

      // 添加关联
      try {
        db.run('INSERT OR IGNORE INTO image_tag_relations (image_id, tag_id) VALUES (?, ?)', [imageId, tag.id]);
        addedTags.push(trimmed);
      } catch (e) { /* 忽略重复 */ }
    }

    res.json({ success: true, data: { tags: addedTags } });
  } catch (err) {
    res.status(500).json({ success: false, error: `添加标签失败: ${err.message}` });
  }
});

/**
 * 获取图片标签
 */
router.get('/api/image/:id/tags', (req, res) => {
  const db = req.db;
  const imageId = parseInt(req.params.id);

  const tags = queryAll(db,
    `SELECT t.id, t.name
     FROM image_tags t
     JOIN image_tag_relations r ON t.id = r.tag_id
     WHERE r.image_id = ?
     ORDER BY t.name`,
    [imageId]
  );

  res.json({ success: true, data: tags || [] });
});

/**
 * 删除图片标签
 */
router.delete('/api/image/:id/tags', isAuthenticated, (req, res) => {
  const db = req.db;
  const userId = req.session.user.id;
  const imageId = parseInt(req.params.id);
  const { tags } = req.body;

  if (!tags || !Array.isArray(tags) || tags.length === 0) {
    return res.status(400).json({ success: false, error: '请提供要删除的标签' });
  }

  const image = queryOne(db, 'SELECT * FROM images WHERE id = ?', [imageId]);
  if (!image) {
    return res.status(404).json({ success: false, error: '图片不存在' });
  }

  const user = queryOne(db, 'SELECT role FROM users WHERE id = ?', [userId]);
  if (image.user_id !== userId && (!user || (user.role !== 'admin' && user.role !== 'super_admin'))) {
    return res.status(403).json({ success: false, error: '无权操作' });
  }

  try {
    for (const tagName of tags) {
      const tag = queryOne(db, 'SELECT id FROM image_tags WHERE name = ?', [tagName.trim().toLowerCase()]);
      if (tag) {
        db.run('DELETE FROM image_tag_relations WHERE image_id = ? AND tag_id = ?', [imageId, tag.id]);
      }
    }
    res.json({ success: true, message: '标签已删除' });
  } catch (err) {
    res.status(500).json({ success: false, error: `删除标签失败: ${err.message}` });
  }
});

// ==================== 相似图片搜索 API ====================

/**
 * 基于标签的相似图片搜索
 * 使用标签重叠度计算相似度
 */
router.get('/api/image/:id/similar', (req, res) => {
  const db = req.db;
  const imageId = parseInt(req.params.id);
  const limit = Math.min(parseInt(req.query.limit) || 12, 30);

  try {
    // 获取当前图片信息
    const image = queryOne(db, 'SELECT * FROM images WHERE id = ?', [imageId]);
    if (!image) {
      return res.status(404).json({ success: false, error: '图片不存在' });
    }

    // 获取当前图片的标签
    const imageTags = queryAll(db,
      `SELECT t.id, t.name
       FROM image_tags t
       JOIN image_tag_relations r ON t.id = r.tag_id
       WHERE r.image_id = ?`,
      [imageId]
    );

    if (!imageTags || imageTags.length === 0) {
      // 没有标签时，返回同分类的图片
      const similar = queryAll(db,
        `SELECT i.*, ic.name as category_name,
                (SELECT COUNT(*) FROM image_favorites WHERE image_id = i.id) as favorite_count
         FROM images i
         LEFT JOIN image_categories ic ON i.cate_id = ic.id
         WHERE i.cate_id = ? AND i.id != ? AND i.status = 1
         ORDER BY i.created_at DESC
         LIMIT ?`,
        [image.cate_id, imageId, limit]
      );
      return res.json({ success: true, data: similar || [], method: 'category' });
    }

    const tagIds = imageTags.map(t => t.id);

    // 基于共同标签数量计算相似度
    const similar = queryAll(db,
      `SELECT i.*, ic.name as category_name,
              COUNT(r.tag_id) as common_tags,
              (SELECT COUNT(*) FROM image_favorites WHERE image_id = i.id) as favorite_count
       FROM images i
       JOIN image_tag_relations r ON i.id = r.image_id
       LEFT JOIN image_categories ic ON i.cate_id = ic.id
       WHERE r.tag_id IN (${tagIds.map(() => '?').join(',')})
         AND i.id != ? AND i.status = 1
       GROUP BY i.id
       ORDER BY common_tags DESC, i.created_at DESC
       LIMIT ?`,
      [...tagIds, imageId, limit]
    );

    res.json({ success: true, data: similar || [], method: 'tags' });
  } catch (err) {
    res.status(500).json({ success: false, error: `搜索相似图片失败: ${err.message}` });
  }
});

/**
 * 搜索图片（按标题、描述、标签）
 */
router.get('/api/images/search', (req, res) => {
  const db = req.db;
  const q = req.query.q || '';
  const page = parseInt(req.query.page) || 1;
  const limit = Math.min(parseInt(req.query.limit) || 20, 50);
  const offset = (page - 1) * limit;

  if (!q.trim()) {
    return res.status(400).json({ success: false, error: '搜索词不能为空' });
  }

  const searchTerm = `%${q.trim()}%`;

  try {
    const total = queryOne(db,
      `SELECT COUNT(DISTINCT i.id) as count
       FROM images i
       LEFT JOIN image_tag_relations r ON i.id = r.image_id
       LEFT JOIN image_tags t ON r.tag_id = t.id
       WHERE i.status = 1
         AND (i.title LIKE ? OR i.description LIKE ? OR t.name LIKE ?)`,
      [searchTerm, searchTerm, searchTerm]
    )?.count || 0;

    const results = queryAll(db,
      `SELECT DISTINCT i.*, ic.name as category_name,
              (SELECT COUNT(*) FROM image_favorites WHERE image_id = i.id) as favorite_count
       FROM images i
       LEFT JOIN image_categories ic ON i.cate_id = ic.id
       LEFT JOIN image_tag_relations r ON i.id = r.image_id
       LEFT JOIN image_tags t ON r.tag_id = t.id
       WHERE i.status = 1
         AND (i.title LIKE ? OR i.description LIKE ? OR t.name LIKE ?)
       ORDER BY i.created_at DESC
       LIMIT ? OFFSET ?`,
      [searchTerm, searchTerm, searchTerm, limit, offset]
    );

    res.json({
      success: true,
      data: {
        images: results || [],
        pagination: { page, limit, total, hasMore: offset + limit < total },
        query: q
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: `搜索失败: ${err.message}` });
  }
});

module.exports = router;
