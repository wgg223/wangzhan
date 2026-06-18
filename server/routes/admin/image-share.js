const express = require('express');
const router = express.Router();
const path = require('path');
const { isAuthenticated, hasPermission, isAdminRole } = require('../../middlewares/auth');
const { saveDatabase, queryAll, queryOne } = require('../../config/database');
const { getImageConfigs, addImageLog } = require('../../utils/image-utils');
const fsSafe = require('../../utils/fs-safe');

// ============ 图片分享管理 ============

// 图片分享 - 管理首页
router.get('/image-share', isAuthenticated, hasPermission('image-share.view'), (req, res) => {
  const db = req.db;
  const config = getImageConfigs(db);

  const stats = {};
  const totalCount = queryOne(db, 'SELECT COUNT(*) as count FROM images');
  stats.total = totalCount ? totalCount.count : 0;
  const pendingCount = queryOne(db, 'SELECT COUNT(*) as count FROM images WHERE status = 0');
  stats.pending = pendingCount ? pendingCount.count : 0;
  const approvedCount = queryOne(db, 'SELECT COUNT(*) as count FROM images WHERE status = 1');
  stats.approved = approvedCount ? approvedCount.count : 0;
  const rejectedCount = queryOne(db, 'SELECT COUNT(*) as count FROM images WHERE status = 2');
  stats.rejected = rejectedCount ? rejectedCount.count : 0;
  const userCount = queryOne(db, 'SELECT COUNT(*) as count FROM users');
  stats.users = userCount ? userCount.count : 0;
  const cateCount = queryOne(db, 'SELECT COUNT(*) as count FROM image_categories');
  stats.categories = cateCount ? cateCount.count : 0;

  const recentLogs = queryAll(db, `
    SELECT l.*, u.username as admin_name 
    FROM image_logs l 
    LEFT JOIN users u ON l.admin_id = u.id 
    ORDER BY l.created_at DESC LIMIT 10
  `);

  res.render('admin/image-share-dashboard', {
    user: req.session.user,
    config: config,
    stats: stats,
    recentLogs: recentLogs,
    settings: res.locals.settings || {}
  });
});

// 图片分享 - 图片管理
router.get('/image-share/images', isAuthenticated, hasPermission('image-share.view'), (req, res) => {
  const db = req.db;
  const config = getImageConfigs(db);
  const status = req.query.status;
  const user = req.session.user;
  const isAdmin = user.role === 'admin' || user.role === 'super_admin';

  let images;
  if (isAdmin) {
    if (status !== undefined && status !== '') {
      images = queryAll(db, `
        SELECT i.*, u.username, u.nickname, c.name as cate_name
        FROM images i
        LEFT JOIN users u ON i.user_id = u.id
        LEFT JOIN image_categories c ON i.cate_id = c.id
        WHERE i.status = ?
        ORDER BY i.created_at DESC
      `, [parseInt(status)]);
    } else {
      images = queryAll(db, `
        SELECT i.*, u.username, u.nickname, c.name as cate_name
        FROM images i
        LEFT JOIN users u ON i.user_id = u.id
        LEFT JOIN image_categories c ON i.cate_id = c.id
        ORDER BY i.created_at DESC
      `);
    }
  } else {
    if (status !== undefined && status !== '') {
      images = queryAll(db, `
        SELECT i.*, u.username, u.nickname, c.name as cate_name
        FROM images i
        LEFT JOIN users u ON i.user_id = u.id
        LEFT JOIN image_categories c ON i.cate_id = c.id
        WHERE i.status = ? AND i.user_id = ?
        ORDER BY i.created_at DESC
      `, [parseInt(status), user.id]);
    } else {
      images = queryAll(db, `
        SELECT i.*, u.username, u.nickname, c.name as cate_name
        FROM images i
        LEFT JOIN users u ON i.user_id = u.id
        LEFT JOIN image_categories c ON i.cate_id = c.id
        WHERE i.user_id = ?
        ORDER BY i.created_at DESC
      `, [user.id]);
    }
  }

  res.render('admin/image-share-images', {
    user: req.session.user,
    config: config,
    images: images,
    currentStatus: status,
    settings: res.locals.settings || {}
  });
});

// 图片分享 - 审核图片
router.post('/image-share/review', isAuthenticated, hasPermission('image-share.review'), (req, res) => {
  const db = req.db;
  const { id, action } = req.body;
  if (!id || !action) {
    return res.json({ success: false, message: '参数不完整' });
  }

  const newStatus = action === 'approve' ? 1 : 2;
  const statusText = action === 'approve' ? '通过' : '驳回';

  db.run('UPDATE images SET status = ? WHERE id = ?', [newStatus, parseInt(id)]);
  addImageLog(db, req.session.user.id, '审核图片 #' + id + '：' + statusText);
  saveDatabase();

  res.json({ success: true, message: '已' + statusText });
});

// 图片分享 - 删除图片
router.post('/image-share/delete', isAuthenticated, hasPermission('image-share.view'), (req, res) => {
  const db = req.db;
  const { id } = req.body;
  if (!id) {
    return res.json({ success: false, message: '参数不完整' });
  }

  const image = queryOne(db, 'SELECT * FROM images WHERE id = ?', [parseInt(id)]);
  if (!image) {
    return res.json({ success: false, message: '图片不存在' });
  }

  const filePath = path.join(__dirname, '../../public', image.url);
  fsSafe.safeUnlinkSync(filePath);

  db.run('DELETE FROM images WHERE id = ?', [parseInt(id)]);
  addImageLog(db, req.session.user.id, '删除图片 #' + id + '：' + image.title);
  saveDatabase();

  res.json({ success: true, message: '删除成功' });
});

// 图片分享 - 分类管理
router.get('/image-share/categories', isAuthenticated, hasPermission('image-share.categories.manage'), (req, res) => {
  const db = req.db;
  const config = getImageConfigs(db);
  const categories = queryAll(db, 'SELECT * FROM image_categories ORDER BY sort ASC');

  res.render('admin/image-share-categories', {
    user: req.session.user,
    config: config,
    categories: categories,
    settings: res.locals.settings || {}
  });
});

// 图片分享 - 添加分类
router.post('/image-share/categories/add', isAuthenticated, hasPermission('image-share.categories.manage'), (req, res) => {
  const db = req.db;
  const { name, sort, is_guest } = req.body;
  if (!name) {
    return res.json({ success: false, message: '分类名称不能为空' });
  }

  db.run('INSERT INTO image_categories (name, sort, status, is_guest) VALUES (?, ?, 1, ?)',
    [name, parseInt(sort) || 0, is_guest ? 1 : 0]);
  addImageLog(db, req.session.user.id, '添加分类：' + name);
  saveDatabase();

  res.json({ success: true, message: '添加成功' });
});

// 图片分享 - 编辑分类
router.post('/image-share/categories/edit', isAuthenticated, hasPermission('image-share.categories.manage'), (req, res) => {
  const db = req.db;
  const { id, name, sort, status, is_guest } = req.body;
  if (!id || !name) {
    return res.json({ success: false, message: '参数不完整' });
  }

  db.run('UPDATE image_categories SET name = ?, sort = ?, status = ?, is_guest = ? WHERE id = ?',
    [name, parseInt(sort) || 0, parseInt(status), is_guest ? 1 : 0, parseInt(id)]);
  addImageLog(db, req.session.user.id, '编辑分类 #' + id + '：' + name);
  saveDatabase();

  res.json({ success: true, message: '修改成功' });
});

// 图片分享 - 删除分类
router.post('/image-share/categories/delete', isAuthenticated, hasPermission('image-share.categories.manage'), (req, res) => {
  const db = req.db;
  const { id } = req.body;
  if (!id) {
    return res.json({ success: false, message: '参数不完整' });
  }

  const imgCount = queryOne(db, 'SELECT COUNT(*) as count FROM images WHERE cate_id = ?', [parseInt(id)]);
  if (imgCount && imgCount.count > 0) {
    return res.json({ success: false, message: '该分类下还有图片，无法删除' });
  }

  const category = queryOne(db, 'SELECT name FROM image_categories WHERE id = ?', [parseInt(id)]);
  db.run('DELETE FROM image_categories WHERE id = ?', [parseInt(id)]);
  addImageLog(db, req.session.user.id, '删除分类 #' + id + '：' + (category ? category.name : ''));
  saveDatabase();

  res.json({ success: true, message: '删除成功' });
});

// 图片分享 - 设置页面
router.get('/image-share/settings', isAuthenticated, hasPermission('image-share.view'), (req, res) => {
  const db = req.db;
  const config = getImageConfigs(db);

  res.render('admin/image-share-settings', {
    user: req.session.user,
    config: config,
    settings: res.locals.settings || {}
  });
});

// 图片分享 - 保存设置
router.post('/image-share/settings', isAuthenticated, hasPermission('image-share.view'), (req, res) => {
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

  addImageLog(db, req.session.user.id, '修改图片分享网站设置');
  saveDatabase();

  res.json({ success: true, message: '保存成功' });
});

// 图片分享 - 操作日志
router.get('/image-share/logs', isAuthenticated, hasPermission('image-share.view'), (req, res) => {
  const db = req.db;
  const logs = queryAll(db, `
    SELECT l.*, u.username as admin_name 
    FROM image_logs l 
    LEFT JOIN users u ON l.admin_id = u.id 
    ORDER BY l.created_at DESC LIMIT 100
  `);

  res.render('admin/image-share-logs', {
    user: req.session.user,
    logs: logs,
    settings: res.locals.settings || {}
  });
});

// 功能1：图片分享 - 免审核用户管理页面
router.get('/image-share/trusted-users', isAuthenticated, hasPermission('image-share.users.manage'), (req, res) => {
  const db = req.db;
  const users = queryAll(db, "SELECT id, username, email, nickname, image_no_review, status, created_at FROM users WHERE username != 'admin' ORDER BY image_no_review DESC, created_at DESC");

  res.render('admin/image-share-trusted-users', {
    user: req.session.user,
    users: users,
    settings: res.locals.settings || {}
  });
});

// 功能1：图片分享 - 切换用户免审核状态
router.post('/image-share/trusted-users/toggle', isAuthenticated, hasPermission('image-share.users.manage'), (req, res) => {
  const db = req.db;
  const { id } = req.body;
  if (!id) {
    return res.json({ success: false, message: '参数不完整' });
  }

  const targetUser = queryOne(db, 'SELECT * FROM users WHERE id = ?', [parseInt(id)]);
  if (!targetUser) {
    return res.json({ success: false, message: '用户不存在' });
  }

  const newStatus = targetUser.image_no_review === 1 ? 0 : 1;
  db.run('UPDATE users SET image_no_review = ? WHERE id = ?', [newStatus, parseInt(id)]);
  addImageLog(db, req.session.user.id, (newStatus === 1 ? '设置' : '取消') + '用户免审核：' + targetUser.username);
  saveDatabase();

  res.json({ success: true, message: newStatus === 1 ? '已设置为免审核用户' : '已取消免审核', no_review: newStatus });
});

// 功能2：图片分享 - 评论管理页面
router.get('/image-share/comments', isAuthenticated, hasPermission('image-share.comments.manage'), (req, res) => {
  const db = req.db;
  const status = req.query.status;
  let comments;

  if (status && status !== 'all') {
    comments = queryAll(db, `
      SELECT ic.*, u.username, u.nickname, u.avatar, i.title as image_title
      FROM image_comments ic
      LEFT JOIN users u ON ic.user_id = u.id
      LEFT JOIN images i ON ic.image_id = i.id
      WHERE ic.status = ?
      ORDER BY ic.created_at DESC
    `, [status]);
  } else {
    comments = queryAll(db, `
      SELECT ic.*, u.username, u.nickname, u.avatar, i.title as image_title
      FROM image_comments ic
      LEFT JOIN users u ON ic.user_id = u.id
      LEFT JOIN images i ON ic.image_id = i.id
      ORDER BY ic.created_at DESC
    `);
  }

  const stats = {
    total: queryOne(db, 'SELECT COUNT(*) as count FROM image_comments')?.count || 0,
    pending: queryOne(db, "SELECT COUNT(*) as count FROM image_comments WHERE status = 'pending'")?.count || 0,
    approved: queryOne(db, "SELECT COUNT(*) as count FROM image_comments WHERE status = 'approved'")?.count || 0,
    rejected: queryOne(db, "SELECT COUNT(*) as count FROM image_comments WHERE status = 'rejected'")?.count || 0
  };

  res.render('admin/image-share-comments', {
    user: req.session.user,
    comments: comments,
    stats: stats,
    currentStatus: status || 'all',
    settings: res.locals.settings || {}
  });
});

// 功能2：图片分享 - 审核评论
router.post('/image-share/comments/review', isAuthenticated, hasPermission('image-share.comments.manage'), (req, res) => {
  const db = req.db;
  const { id, action } = req.body;
  if (!id || !action) {
    return res.json({ success: false, message: '参数不完整' });
  }

  const newStatus = action === 'approve' ? 'approved' : 'rejected';
  const statusText = action === 'approve' ? '通过' : '驳回';

  db.run('UPDATE image_comments SET status = ? WHERE id = ?', [newStatus, parseInt(id)]);
  addImageLog(db, req.session.user.id, '审核图片评论 #' + id + '：' + statusText);
  saveDatabase();

  res.json({ success: true, message: '已' + statusText });
});

// 功能2：图片分享 - 删除评论
router.post('/image-share/comments/delete', isAuthenticated, hasPermission('image-share.comments.manage'), (req, res) => {
  const db = req.db;
  const { id } = req.body;
  if (!id) {
    return res.json({ success: false, message: '参数不完整' });
  }

  const comment = queryOne(db, 'SELECT * FROM image_comments WHERE id = ?', [parseInt(id)]);
  if (!comment) {
    return res.json({ success: false, message: '评论不存在' });
  }

  db.run('DELETE FROM image_comments WHERE id = ?', [parseInt(id)]);
  addImageLog(db, req.session.user.id, '删除图片评论 #' + id);
  saveDatabase();

  res.json({ success: true, message: '删除成功' });
});

// 功能3：图片分享 - 设置图片可见性和可见用户
router.post('/image-share/set-visibility', isAuthenticated, hasPermission('image-share.view'), (req, res) => {
  const db = req.db;
  const { id, visibility, allowed_user_ids } = req.body;

  if (!id) {
    return res.json({ success: false, message: '参数不完整' });
  }

  const image = queryOne(db, 'SELECT * FROM images WHERE id = ?', [parseInt(id)]);
  if (!image) {
    return res.json({ success: false, message: '图片不存在' });
  }

  const user = req.session.user;
  const isAdmin = user.role === 'admin' || user.role === 'super_admin';
  if (!isAdmin && image.user_id !== user.id) {
    return res.json({ success: false, message: '无权修改此图片的可见性' });
  }

  const validVisibilities = ['public', 'private', 'selected'];
  const newVisibility = visibility || 'public';
  if (!validVisibilities.includes(newVisibility)) {
    return res.json({ success: false, message: '无效的可见性设置' });
  }

  let userIds = [];
  if (newVisibility === 'selected') {
    if (!allowed_user_ids || !Array.isArray(allowed_user_ids)) {
      return res.json({ success: false, message: '请选择可见用户' });
    }
    userIds = allowed_user_ids.map(id => parseInt(id)).filter(id => !isNaN(id) && id > 0);
  }

  db.run('UPDATE images SET visibility = ?, allowed_user_ids = ? WHERE id = ?',
    [newVisibility, JSON.stringify(userIds), parseInt(id)]);
  addImageLog(db, req.session.user.id, '设置图片 #' + id + ' 可见性：' + newVisibility + (newVisibility === 'selected' ? '（已选' + userIds.length + '位用户）' : ''));
  saveDatabase();

  res.json({ success: true, message: '可见性设置已更新' });
});

// 功能3：图片分享 - 获取所有非管理员用户列表（用于设置可见用户弹窗）
router.get('/image-share/visible-users', isAuthenticated, hasPermission('image-share.view'), (req, res) => {
  const db = req.db;
  const search = req.query.search || '';

  let users;
  if (search) {
    users = queryAll(db,
      "SELECT id, username, nickname, email FROM users WHERE role = 'user' AND (username LIKE ? OR nickname LIKE ? OR email LIKE ?) ORDER BY username ASC LIMIT 50",
      ['%' + search + '%', '%' + search + '%', '%' + search + '%']
    );
  } else {
    users = queryAll(db,
      "SELECT id, username, nickname, email FROM users WHERE role = 'user' ORDER BY username ASC LIMIT 50"
    );
  }

  const userList = users.map(u => ({
    id: u.id,
    name: u.nickname || u.username,
    username: u.username,
    email: u.email
  }));

  res.json({ success: true, users: userList });
});

// 图片分享 - 禁用/启用用户
router.post('/image-share/users/toggle', isAuthenticated, hasPermission('image-share.users.manage'), (req, res) => {
  const db = req.db;
  const { id, status } = req.body;
  if (!id) {
    return res.json({ success: false, message: '参数不完整' });
  }

  const targetUser = queryOne(db, 'SELECT * FROM users WHERE id = ?', [parseInt(id)]);
  if (!targetUser) {
    return res.json({ success: false, message: '用户不存在' });
  }

  const newStatus = status === 'active' ? 'active' : 'disabled';
  db.run('UPDATE users SET status = ? WHERE id = ?', [newStatus, parseInt(id)]);
  addImageLog(db, req.session.user.id, (newStatus === 'active' ? '启用' : '禁用') + '用户：' + targetUser.username);
  saveDatabase();

  res.json({ success: true, message: '操作成功' });
});

// ============ 批量操作 ============

// 批量删除图片
router.post('/image-share/batch-delete', isAuthenticated, hasPermission('image-share.view'), (req, res) => {
  const db = req.db;
  const { ids } = req.body;

  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    return res.json({ success: false, message: '请选择要删除的图片' });
  }

  const intIds = ids.map(id => parseInt(id)).filter(id => !isNaN(id));
  if (intIds.length === 0) {
    return res.json({ success: false, message: '无有效的图片ID' });
  }

  // Get images to delete files
  const placeholders = intIds.map(() => '?').join(',');
  const images = queryAll(db, `SELECT id, url, title FROM images WHERE id IN (${placeholders})`, intIds);

  // Delete files
  let deletedFiles = 0;
  for (const img of images) {
    try {
      const filePath = path.join(__dirname, '../../public', img.url);
      fsSafe.safeUnlinkSync(filePath);
      deletedFiles++;
    } catch (e) {}
  }

  // Delete from database
  db.run(`DELETE FROM images WHERE id IN (${placeholders})`, intIds);

  // Delete related comments
  db.run(`DELETE FROM image_comments WHERE image_id IN (${placeholders})`, intIds);

  addImageLog(db, req.session.user.id, `批量删除 ${intIds.length} 张图片`);
  saveDatabase();

  res.json({ success: true, message: `成功删除 ${intIds.length} 张图片` });
});

// 批量审核图片
router.post('/image-share/batch-review', isAuthenticated, hasPermission('image-share.review'), (req, res) => {
  const db = req.db;
  const { ids, action } = req.body;

  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    return res.json({ success: false, message: '请选择要审核的图片' });
  }

  if (!action || !['approve', 'reject'].includes(action)) {
    return res.json({ success: false, message: '无效的审核操作' });
  }

  const intIds = ids.map(id => parseInt(id)).filter(id => !isNaN(id));
  if (intIds.length === 0) {
    return res.json({ success: false, message: '无有效的图片ID' });
  }

  const newStatus = action === 'approve' ? 1 : 2;
  const statusText = action === 'approve' ? '通过' : '驳回';

  const placeholders = intIds.map(() => '?').join(',');
  db.run(`UPDATE images SET status = ? WHERE id IN (${placeholders})`, [newStatus, ...intIds]);

  addImageLog(db, req.session.user.id, `批量${statusText} ${intIds.length} 张图片`);
  saveDatabase();

  res.json({ success: true, message: `已${statusText} ${intIds.length} 张图片` });
});

// 批量删除分类（同时删除分类下的图片）
router.post('/image-share/batch-delete-categories', isAuthenticated, hasPermission('image-share.categories.manage'), (req, res) => {
  const db = req.db;
  const { ids } = req.body;

  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    return res.json({ success: false, message: '请选择要删除的分类' });
  }

  const intIds = ids.map(id => parseInt(id)).filter(id => !isNaN(id));
  if (intIds.length === 0) {
    return res.json({ success: false, message: '无有效的分类ID' });
  }

  const placeholders = intIds.map(() => '?').join(',');

  // Get images in these categories to delete files
  const images = queryAll(db, `SELECT id, url FROM images WHERE cate_id IN (${placeholders})`, intIds);

  let deletedFiles = 0;
  for (const img of images) {
    try {
      const filePath = path.join(__dirname, '../../public', img.url);
      fsSafe.safeUnlinkSync(filePath);
      deletedFiles++;
    } catch (e) {}
  }

  // Delete images in categories
  db.run(`DELETE FROM images WHERE cate_id IN (${placeholders})`, intIds);

  // Delete comments for those images
  const imageIds = images.map(i => i.id);
  if (imageIds.length > 0) {
    const imgPlaceholders = imageIds.map(() => '?').join(',');
    db.run(`DELETE FROM image_comments WHERE image_id IN (${imgPlaceholders})`, imageIds);
  }

  // Delete categories
  db.run(`DELETE FROM image_categories WHERE id IN (${placeholders})`, intIds);

  addImageLog(db, req.session.user.id, `批量删除 ${intIds.length} 个分类及 ${images.length} 张图片`);
  saveDatabase();

  res.json({ success: true, message: `成功删除 ${intIds.length} 个分类和 ${images.length} 张图片` });
});

module.exports = router;
