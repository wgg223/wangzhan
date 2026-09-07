/**
 * 后台在线表格管理路由
 * 页面/接口：
 *   GET  /admin/spreadsheets              —— 表格管理列表
 *   GET  /admin/spreadsheets/create       —— 创建表格表单
 *   POST /admin/spreadsheets              —— 保存创建
 *   GET  /admin/spreadsheets/:id/edit     —— 编辑表格设置
 *   POST /admin/spreadsheets/:id          —— 保存编辑
 *   DELETE /admin/spreadsheets/:id        —— 删除表格
 *   GET  /admin/spreadsheets/:id/columns  —— 列管理页
 *   POST /admin/spreadsheets/:id/columns  —— 批量保存列配置
 */
const express = require('express');
const router = express.Router();
const { hasPermission } = require('../../middlewares/auth');
const { queryAll, queryOne, saveDatabase } = require('../../config/database');
const { logActivity } = require('../../config/activity');

// 所有路由需要 spreadsheet.manage 权限
router.use(hasPermission('spreadsheet.manage'));

// 表格管理列表
router.get('/spreadsheets', (req, res) => {
  const db = req.db;
  const sheets = queryAll(db,
    `SELECT s.*, u.username AS creator_name,
      (SELECT COUNT(*) FROM spreadsheet_columns c WHERE c.spreadsheet_id = s.id) AS col_count,
      (SELECT COUNT(*) FROM spreadsheet_rows r WHERE r.spreadsheet_id = s.id) AS row_count
     FROM spreadsheets s LEFT JOIN users u ON s.created_by = u.id
     ORDER BY s.created_at DESC`
  );
  res.render('admin/spreadsheets', {
    user: req.session.user,
    sheets: sheets,
    settings: res.locals.settings || {}
  });
});

// 创建表格表单
router.get('/spreadsheets/create', (req, res) => {
  res.render('admin/spreadsheet-form', {
    user: req.session.user,
    sheet: null,
    columns: [],
    settings: res.locals.settings || {}
  });
});

// 保存创建
router.post('/spreadsheets', (req, res) => {
  const db = req.db;
  const { name, description, page_size, columns } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ error: '表格名称不能为空' });
  }

  const result = db.run(
    'INSERT INTO spreadsheets (name, description, created_by, page_size) VALUES (?, ?, ?, ?)',
    [name.trim(), description || '', req.session.user.id, parseInt(page_size, 10) || 20]
  );
  const sheetId = result.lastInsertRowid;

  // 添加默认列或用户指定的列
  let colList = [];
  if (Array.isArray(columns) && columns.length > 0) {
    colList = columns;
  } else {
    colList = [
      { name: '名称', field_key: 'name', type: 'text', width: 200 },
      { name: '描述', field_key: 'description', type: 'text', width: 300 },
      { name: '状态', field_key: 'status', type: 'text', width: 100 }
    ];
  }

  colList.forEach((col, idx) => {
    db.run(
      'INSERT INTO spreadsheet_columns (spreadsheet_id, name, field_key, type, width, sort_order, is_visible) VALUES (?, ?, ?, ?, ?, ?, 1)',
      [sheetId, col.name || '列' + (idx + 1), col.field_key || ('col_' + idx), col.type || 'text', col.width || 150, idx]
    );
  });

  saveDatabase();

  logActivity(db, {
    user_id: req.session.user.id,
    username: req.session.user.username,
    action: 'create',
    target_type: 'spreadsheet',
    target_id: sheetId,
    target_title: name.trim(),
    detail: '创建在线表格: ' + name.trim(),
    ip: req.ip
  });

  res.json({ success: true, redirect: '/admin/spreadsheets' });
});

// 编辑表格设置
router.get('/spreadsheets/:id/edit', (req, res) => {
  const db = req.db;
  const sheetId = parseInt(req.params.id, 10);
  const sheet = queryOne(db, 'SELECT * FROM spreadsheets WHERE id = ?', [sheetId]);
  if (!sheet) {
    return res.status(404).render('admin/error', { message: '表格不存在', user: req.session.user });
  }
  const columns = queryAll(db, 'SELECT * FROM spreadsheet_columns WHERE spreadsheet_id = ? ORDER BY sort_order ASC, id ASC', [sheetId]);
  res.render('admin/spreadsheet-form', {
    user: req.session.user,
    sheet: sheet,
    columns: columns,
    settings: res.locals.settings || {}
  });
});

// 保存编辑
router.post('/spreadsheets/:id', (req, res) => {
  const db = req.db;
  const sheetId = parseInt(req.params.id, 10);
  const { name, description, page_size, status } = req.body;

  const sheet = queryOne(db, 'SELECT id FROM spreadsheets WHERE id = ?', [sheetId]);
  if (!sheet) return res.status(404).json({ error: '表格不存在' });

  db.run(
    'UPDATE spreadsheets SET name = ?, description = ?, page_size = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    [name.trim(), description || '', parseInt(page_size, 10) || 20, status || 'active', sheetId]
  );
  saveDatabase();

  logActivity(db, {
    user_id: req.session.user.id,
    username: req.session.user.username,
    action: 'update',
    target_type: 'spreadsheet',
    target_id: sheetId,
    target_title: name.trim(),
    detail: '编辑在线表格设置: ' + name.trim(),
    ip: req.ip
  });

  res.json({ success: true, redirect: '/admin/spreadsheets' });
});

// 删除表格
router.delete('/spreadsheets/:id', (req, res) => {
  const db = req.db;
  const sheetId = parseInt(req.params.id, 10);

  const sheet = queryOne(db, 'SELECT name FROM spreadsheets WHERE id = ?', [sheetId]);
  if (!sheet) return res.status(404).json({ error: '表格不存在' });

  db.run('DELETE FROM spreadsheets WHERE id = ?', [sheetId]);
  saveDatabase();

  logActivity(db, {
    user_id: req.session.user.id,
    username: req.session.user.username,
    action: 'delete',
    target_type: 'spreadsheet',
    target_id: sheetId,
    target_title: sheet.name,
    detail: '删除在线表格: ' + sheet.name,
    ip: req.ip
  });

  res.json({ success: true });
});

// 列管理页
router.get('/spreadsheets/:id/columns', (req, res) => {
  const db = req.db;
  const sheetId = parseInt(req.params.id, 10);
  const sheet = queryOne(db, 'SELECT * FROM spreadsheets WHERE id = ?', [sheetId]);
  if (!sheet) {
    return res.status(404).render('admin/error', { message: '表格不存在', user: req.session.user });
  }
  const columns = queryAll(db, 'SELECT * FROM spreadsheet_columns WHERE spreadsheet_id = ? ORDER BY sort_order ASC, id ASC', [sheetId]);
  res.render('admin/spreadsheet-columns', {
    user: req.session.user,
    sheet: sheet,
    columns: columns,
    settings: res.locals.settings || {}
  });
});

// 批量保存列配置
router.post('/spreadsheets/:id/columns', (req, res) => {
  const db = req.db;
  const sheetId = parseInt(req.params.id, 10);
  const { columns } = req.body;

  if (!Array.isArray(columns)) {
    return res.status(400).json({ error: '列数据格式错误' });
  }

  columns.forEach((col, idx) => {
    if (col.id) {
      // 更新已有列
      db.run(
        'UPDATE spreadsheet_columns SET name = ?, field_key = ?, type = ?, width = ?, sort_order = ?, is_visible = ? WHERE id = ? AND spreadsheet_id = ?',
        [col.name, col.field_key, col.type || 'text', col.width || 150, idx, col.is_visible ? 1 : 0, col.id, sheetId]
      );
    } else {
      // 新增列
      db.run(
        'INSERT INTO spreadsheet_columns (spreadsheet_id, name, field_key, type, width, sort_order, is_visible) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [sheetId, col.name, col.field_key, col.type || 'text', col.width || 150, idx, col.is_visible ? 1 : 0]
      );
    }
  });

  saveDatabase();
  res.json({ success: true });
});

// 删除列
router.delete('/spreadsheets/:id/columns/:colId', (req, res) => {
  const db = req.db;
  const sheetId = parseInt(req.params.id, 10);
  const colId = parseInt(req.params.colId, 10);

  db.run('DELETE FROM spreadsheet_columns WHERE id = ? AND spreadsheet_id = ?', [colId, sheetId]);
  saveDatabase();
  res.json({ success: true });
});

module.exports = router;
