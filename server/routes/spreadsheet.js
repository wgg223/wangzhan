/**
 * 在线表格前台路由
 * 页面/接口：
 *   GET  /spreadsheet              —— 表格列表页（需 spreadsheet.access）
 *   GET  /spreadsheet/:id          —— 表格查看/编辑页（需 spreadsheet.access；编辑需 spreadsheet.manage）
 *   GET  /api/spreadsheet/:id/data —— 获取表格数据（分页、搜索、排序）
 *   POST /api/spreadsheet/:id/row  —— 添加行（需 spreadsheet.manage）
 *   PUT  /api/spreadsheet/:id/row/:rowId   —— 编辑行
 *   DELETE /api/spreadsheet/:id/row/:rowId —— 删除行
 *   PUT  /api/spreadsheet/:id/column/:colId —— 编辑列（隐藏/显示/重命名/排序）
 *   POST /api/spreadsheet/:id/column        —— 添加列
 */
const express = require('express');
const router = express.Router();
const { isAuthenticated, hasFrontendPermission, hasPermission } = require('../middlewares/auth');
const { queryAll, queryOne, saveDatabase } = require('../config/database');
const { logActivity } = require('../config/activity');
const { createNotification } = require('./community');

// 辅助：检查用户是否有表格管理权限
function canManageSpreadsheet(req) {
  if (!req.session || !req.session.user) return false;
  // super_admin 和 admin 角色都有管理权限
  if (req.session.user.role === 'super_admin' || req.session.user.role === 'admin') return true;
  const db = req.db;
  if (!db) return false;
  const userPerms = queryAll(db, 'SELECT perm_key FROM user_permissions WHERE user_id = ?', [req.session.user.id]);
  const keys = userPerms.map(p => p.perm_key);
  return keys.includes('spreadsheet.manage') || keys.includes('spreadsheet.*');
}

// ============ 页面路由 ============

// 表格列表页
router.get('/spreadsheet', isAuthenticated, hasFrontendPermission('spreadsheet.access'), (req, res) => {
  const db = req.db;
  const sheets = queryAll(db,
    "SELECT s.*, u.username AS creator_name FROM spreadsheets s LEFT JOIN users u ON s.created_by = u.id WHERE s.status = 'active' ORDER BY s.created_at DESC"
  );
  const canManage = canManageSpreadsheet(req);
  res.render('frontend/spreadsheets', {
    user: req.session.user,
    sheets: sheets,
    canManage: canManage,
    settings: res.locals.settings || {}
  });
});

// 在线表格编辑页（Luckysheet，功能接近 Excel）
router.get('/spreadsheet/:id', isAuthenticated, hasFrontendPermission('spreadsheet.access'), (req, res) => {
  const db = req.db;
  const sheetId = parseInt(req.params.id, 10);
  if (!sheetId) {
    return res.status(400).render('frontend/error', { message: '请求错误', error: '表格ID无效', user: req.session.user, settings: res.locals.settings || {} });
  }
  const sheet = queryOne(db, 'SELECT * FROM spreadsheets WHERE id = ? AND status = ?', [sheetId, 'active']);
  if (!sheet) {
    return res.status(404).render('frontend/error', { message: '页面未找到', error: '表格不存在或已被删除', user: req.session.user, settings: res.locals.settings || {} });
  }
  const canManage = canManageSpreadsheet(req);
  // 检查文档级编辑权限
  const userId = req.session.user.id;
  const docEditPerm = queryOne(db,
    'SELECT id FROM spreadsheet_user_permissions WHERE spreadsheet_id = ? AND user_id = ? AND perm_type = ?',
    [sheetId, userId, 'edit']
  );
  const canEdit = canManage || !!docEditPerm;
  res.render('frontend/spreadsheet-editor', {
    layout: false,
    user: req.session.user,
    sheet: sheet,
    canManage: canManage,
    canEdit: canEdit,
    settings: res.locals.settings || {}
  });
});

// ============ 数据 API ============

// 获取表格数据（分页 + 搜索 + 排序）
router.get('/api/spreadsheet/:id/data', isAuthenticated, hasFrontendPermission('spreadsheet.access'), (req, res) => {
  const db = req.db;
  const sheetId = parseInt(req.params.id, 10);
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 20));
  const search = (req.query.search || '').trim();
  const sortField = req.query.sortField || '';
  const sortOrder = req.query.sortOrder === 'desc' ? 'desc' : 'asc';

  if (!sheetId) {
    return res.status(400).json({ error: '表格ID无效' });
  }

  const sheet = queryOne(db, 'SELECT * FROM spreadsheets WHERE id = ? AND status = ?', [sheetId, 'active']);
  if (!sheet) {
    return res.status(404).json({ error: '表格不存在' });
  }

  const columns = queryAll(db,
    'SELECT * FROM spreadsheet_columns WHERE spreadsheet_id = ? ORDER BY sort_order ASC, id ASC',
    [sheetId]
  );

  // 无搜索、无排序时走 SQL 分页快路径（避免全表加载与逐行 JSON.parse，适合大数据量表）
  if (!search && !sortField) {
    const countRow = queryOne(db, 'SELECT COUNT(*) AS total FROM spreadsheet_rows WHERE spreadsheet_id = ?', [sheetId]);
    const total = countRow ? countRow.total : 0;
    const totalPages = Math.ceil(total / pageSize);
    const offset = (page - 1) * pageSize;
    const rows = queryAll(db,
      'SELECT * FROM spreadsheet_rows WHERE spreadsheet_id = ? ORDER BY sort_order ASC, id ASC LIMIT ? OFFSET ?',
      [sheetId, pageSize, offset]
    );
    const pagedRows = rows.map(r => {
      let data = {};
      try { data = JSON.parse(r.row_data || '{}'); } catch (e) { data = {}; }
      return { ...r, data: data };
    });
    return res.json({
      success: true,
      data: {
        sheet: { id: sheet.id, name: sheet.name, description: sheet.description },
        columns: columns,
        rows: pagedRows,
        pagination: {
          page: page,
          pageSize: pageSize,
          total: total,
          totalPages: totalPages
        }
      }
    });
  }

  // 搜索/排序路径：先按 row_data LIKE 粗筛（SQLite 端），再做精确匹配
  let rows;
  if (search) {
    const like = '%' + search.replace(/[\\%_]/g, function(m) { return '\\' + m; }) + '%';
    rows = queryAll(db, "SELECT * FROM spreadsheet_rows WHERE spreadsheet_id = ? AND row_data LIKE ? ESCAPE '\\' ORDER BY sort_order ASC, id ASC", [sheetId, like]);
  } else {
    rows = queryAll(db,
      'SELECT * FROM spreadsheet_rows WHERE spreadsheet_id = ? ORDER BY sort_order ASC, id ASC',
      [sheetId]
    );
  }

  // 解析 row_data 并精确搜索
  let parsedRows = rows.map(r => {
    let data = {};
    try { data = JSON.parse(r.row_data || '{}'); } catch (e) { data = {}; }
    return { ...r, data: data };
  });

  if (search) {
    const lowerSearch = search.toLowerCase();
    parsedRows = parsedRows.filter(r => {
      return Object.values(r.data).some(v => {
        const text = (v && typeof v === 'object') ? (v.text || '') : String(v || '');
        return text.toLowerCase().includes(lowerSearch);
      });
    });
  }

  // 排序
  if (sortField) {
    parsedRows.sort((a, b) => {
      const vaRaw = a.data[sortField];
      const vbRaw = b.data[sortField];
      const va = (vaRaw && typeof vaRaw === 'object') ? (vaRaw.text || '') : String(vaRaw || '');
      const vb = (vbRaw && typeof vbRaw === 'object') ? (vbRaw.text || '') : String(vbRaw || '');
      const cmp = va.localeCompare(vb, 'zh-CN', { numeric: true });
      return sortOrder === 'desc' ? -cmp : cmp;
    });
  }

  const total = parsedRows.length;
  const totalPages = Math.ceil(total / pageSize);
  const start = (page - 1) * pageSize;
  const pagedRows = parsedRows.slice(start, start + pageSize);

  res.json({
    success: true,
    data: {
      sheet: { id: sheet.id, name: sheet.name, description: sheet.description },
      columns: columns,
      rows: pagedRows,
      pagination: {
        page: page,
        pageSize: pageSize,
        total: total,
        totalPages: totalPages
      }
    }
  });
});

// 添加行
router.post('/api/spreadsheet/:id/row', isAuthenticated, (req, res, next) => {
  if (!canManageSpreadsheet(req)) {
    return res.status(403).json({ error: '您没有编辑此表格的权限' });
  }
  next();
}, (req, res) => {
  const db = req.db;
  const sheetId = parseInt(req.params.id, 10);
  const rowData = req.body.row_data || {};

  if (!sheetId) return res.status(400).json({ error: '表格ID无效' });

  const sheet = queryOne(db, 'SELECT id FROM spreadsheets WHERE id = ?', [sheetId]);
  if (!sheet) return res.status(404).json({ error: '表格不存在' });

  // 获取最大 sort_order
  const maxOrder = queryOne(db, 'SELECT MAX(sort_order) AS max_order FROM spreadsheet_rows WHERE spreadsheet_id = ?', [sheetId]);
  const newOrder = (maxOrder && maxOrder.max_order != null) ? maxOrder.max_order + 1 : 0;

  const result = db.run(
    'INSERT INTO spreadsheet_rows (spreadsheet_id, row_data, sort_order) VALUES (?, ?, ?)',
    [sheetId, JSON.stringify(rowData), newOrder]
  );
  saveDatabase();

  logActivity(db, {
    user_id: req.session.user.id,
    username: req.session.user.username,
    action: 'create',
    target_type: 'spreadsheet_row',
    target_id: result.lastInsertRowid,
    target_title: '表格行',
    detail: '在表格 #' + sheetId + ' 中添加行',
    ip: req.ip
  });

  res.json({ success: true, data: { id: result.lastInsertRowid, row_data: rowData, sort_order: newOrder } });
});

// 编辑行
router.put('/api/spreadsheet/:id/row/:rowId', isAuthenticated, (req, res, next) => {
  if (!canManageSpreadsheet(req)) {
    return res.status(403).json({ error: '您没有编辑此表格的权限' });
  }
  next();
}, (req, res) => {
  const db = req.db;
  const sheetId = parseInt(req.params.id, 10);
  const rowId = parseInt(req.params.rowId, 10);
  const rowData = req.body.row_data;

  if (!sheetId || !rowId) return res.status(400).json({ error: '参数无效' });

  const row = queryOne(db, 'SELECT id FROM spreadsheet_rows WHERE id = ? AND spreadsheet_id = ?', [rowId, sheetId]);
  if (!row) return res.status(404).json({ error: '行不存在' });

  db.run(
    'UPDATE spreadsheet_rows SET row_data = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    [JSON.stringify(rowData), rowId]
  );
  saveDatabase();

  logActivity(db, {
    user_id: req.session.user.id,
    username: req.session.user.username,
    action: 'update',
    target_type: 'spreadsheet_row',
    target_id: rowId,
    target_title: '表格行',
    detail: '在表格 #' + sheetId + ' 中编辑行 #' + rowId,
    ip: req.ip
  });

  res.json({ success: true });
});

// 删除行
router.delete('/api/spreadsheet/:id/row/:rowId', isAuthenticated, (req, res, next) => {
  if (!canManageSpreadsheet(req)) {
    return res.status(403).json({ error: '您没有编辑此表格的权限' });
  }
  next();
}, (req, res) => {
  const db = req.db;
  const sheetId = parseInt(req.params.id, 10);
  const rowId = parseInt(req.params.rowId, 10);

  if (!sheetId || !rowId) return res.status(400).json({ error: '参数无效' });

  const row = queryOne(db, 'SELECT id FROM spreadsheet_rows WHERE id = ? AND spreadsheet_id = ?', [rowId, sheetId]);
  if (!row) return res.status(404).json({ error: '行不存在' });

  db.run('DELETE FROM spreadsheet_rows WHERE id = ?', [rowId]);
  saveDatabase();

  logActivity(db, {
    user_id: req.session.user.id,
    username: req.session.user.username,
    action: 'delete',
    target_type: 'spreadsheet_row',
    target_id: rowId,
    target_title: '表格行',
    detail: '在表格 #' + sheetId + ' 中删除行 #' + rowId,
    ip: req.ip
  });

  res.json({ success: true });
});

// 编辑列（隐藏/显示/重命名/宽度/排序）
router.put('/api/spreadsheet/:id/column/:colId', isAuthenticated, (req, res, next) => {
  if (!canManageSpreadsheet(req)) {
    return res.status(403).json({ error: '您没有编辑此表格的权限' });
  }
  next();
}, (req, res) => {
  const db = req.db;
  const sheetId = parseInt(req.params.id, 10);
  const colId = parseInt(req.params.colId, 10);
  const { name, width, is_visible, sort_order } = req.body;

  if (!sheetId || !colId) return res.status(400).json({ error: '参数无效' });

  const col = queryOne(db, 'SELECT id FROM spreadsheet_columns WHERE id = ? AND spreadsheet_id = ?', [colId, sheetId]);
  if (!col) return res.status(404).json({ error: '列不存在' });

  const updates = [];
  const params = [];
  if (name !== undefined) { updates.push('name = ?'); params.push(name); }
  if (width !== undefined) { updates.push('width = ?'); params.push(width); }
  if (is_visible !== undefined) { updates.push('is_visible = ?'); params.push(is_visible ? 1 : 0); }
  if (sort_order !== undefined) { updates.push('sort_order = ?'); params.push(sort_order); }

  if (updates.length === 0) return res.status(400).json({ error: '没有要更新的字段' });

  params.push(colId);
  db.run('UPDATE spreadsheet_columns SET ' + updates.join(', ') + ' WHERE id = ?', params);
  saveDatabase();

  res.json({ success: true });
});

// 添加列
router.post('/api/spreadsheet/:id/column', isAuthenticated, (req, res, next) => {
  if (!canManageSpreadsheet(req)) {
    return res.status(403).json({ error: '您没有编辑此表格的权限' });
  }
  next();
}, (req, res) => {
  const db = req.db;
  const sheetId = parseInt(req.params.id, 10);
  const { name, field_key, type, width } = req.body;

  if (!sheetId || !name || !field_key) return res.status(400).json({ error: '列名和字段标识不能为空' });
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(field_key)) {
    return res.status(400).json({ error: '字段标识只能包含字母、数字和下划线，且必须以字母或下划线开头' });
  }
  if (String(name).length > 50) return res.status(400).json({ error: '列名不能超过50个字符' });

  const sheet = queryOne(db, 'SELECT id FROM spreadsheets WHERE id = ?', [sheetId]);
  if (!sheet) return res.status(404).json({ error: '表格不存在' });

  // 检查 field_key 是否重复
  const existing = queryOne(db, 'SELECT id FROM spreadsheet_columns WHERE spreadsheet_id = ? AND field_key = ?', [sheetId, field_key]);
  if (existing) return res.status(400).json({ error: '字段标识已存在' });

  const maxOrder = queryOne(db, 'SELECT MAX(sort_order) AS max_order FROM spreadsheet_columns WHERE spreadsheet_id = ?', [sheetId]);
  const newOrder = (maxOrder && maxOrder.max_order != null) ? maxOrder.max_order + 1 : 0;

  const result = db.run(
    'INSERT INTO spreadsheet_columns (spreadsheet_id, name, field_key, type, width, sort_order, is_visible) VALUES (?, ?, ?, ?, ?, ?, 1)',
    [sheetId, name, field_key, type || 'text', width || 150, newOrder]
  );
  saveDatabase();

  res.json({ success: true, data: { id: result.lastInsertRowid, name, field_key, type: type || 'text', width: width || 150, sort_order: newOrder, is_visible: 1 } });
});

// ============ 文件导入功能（CSV / XLSX） ============
const { parseImportFile, processCellValue, toFieldKey } = require('../utils/spreadsheet-import');
const multer = require('multer');
const importUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 } // 最大50MB
});

// 预览导入文件（解析前几行，返回列名和示例数据）
router.post('/api/spreadsheet/:id/import/preview', isAuthenticated, (req, res, next) => {
  if (!canManageSpreadsheet(req)) return res.status(403).json({ error: '您没有编辑此表格的权限' });
  next();
}, importUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请上传 CSV 或 XLSX 文件' });
  const sheetId = parseInt(req.params.id, 10);
  const db = req.db;

  let parsed;
  try {
    parsed = parseImportFile(req.file);
  } catch (e) {
    return res.status(400).json({ error: e.message || '文件解析失败' });
  }

  if (parsed.dataRows.length === 0) return res.status(400).json({ error: '文件没有数据行' });

  const headers = parsed.headers;
  const sampleRows = parsed.dataRows.slice(0, 5).map(function(r) {
    return r.map(function(c) { return processCellValue(c); });
  });

  // 获取表格现有列
  const columns = queryAll(db, 'SELECT * FROM spreadsheet_columns WHERE spreadsheet_id = ? ORDER BY sort_order ASC, id ASC', [sheetId]);

  res.json({
    success: true,
    data: {
      filename: req.file.originalname,
      totalRows: parsed.dataRows.length, // 数据行数（已排除表头）
      encoding: parsed.encoding,
      delimiter: parsed.delimiter,
      headers: headers,
      sampleRows: sampleRows,
      tableColumns: columns.map(c => ({ id: c.id, name: c.name, field_key: c.field_key }))
    }
  });
});

// 执行导入（自动匹配表头，无对应列自动创建）
router.post('/api/spreadsheet/:id/import', isAuthenticated, (req, res, next) => {
  if (!canManageSpreadsheet(req)) return res.status(403).json({ error: '您没有编辑此表格的权限' });
  next();
}, importUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请上传 CSV 或 XLSX 文件' });
  const sheetId = parseInt(req.params.id, 10);
  const db = req.db;
  const mode = req.body.mode || 'append'; // append（追加）或 replace（覆盖）

  const sheet = queryOne(db, 'SELECT id FROM spreadsheets WHERE id = ?', [sheetId]);
  if (!sheet) return res.status(404).json({ error: '表格不存在' });

  let parsed;
  try {
    parsed = parseImportFile(req.file);
  } catch (e) {
    return res.status(400).json({ error: e.message || '文件解析失败' });
  }

  if (parsed.dataRows.length === 0) return res.status(400).json({ error: '文件没有数据行' });

  const headers = parsed.headers;
  const dataRows = parsed.dataRows;

  // 获取现有列
  const existingColumns = queryAll(db, 'SELECT id, name, field_key, sort_order FROM spreadsheet_columns WHERE spreadsheet_id = ? ORDER BY sort_order ASC, id ASC', [sheetId]);
  const existingKeys = new Set(existingColumns.map(c => c.field_key));
  const maxColOrder = existingColumns.length > 0 ? Math.max(...existingColumns.map(c => c.sort_order || 0)) : 0;

  // 自动匹配表头到 field_key，无对应列自动创建
  const headerToFieldKey = {};
  const newColumns = [];
  let colOrder = maxColOrder + 1;

  headers.forEach((header, idx) => {
    if (!header) {
      headerToFieldKey[idx] = null;
      return;
    }
    // 1. 精确匹配 field_key
    let matched = existingColumns.find(c => c.field_key === header);
    // 2. 精确匹配 name
    if (!matched) matched = existingColumns.find(c => c.name === header);
    // 3. 忽略大小写匹配 field_key
    if (!matched) matched = existingColumns.find(c => c.field_key.toLowerCase() === header.toLowerCase());

    if (matched) {
      headerToFieldKey[idx] = matched.field_key;
    } else {
      // 自动创建新列
      const fieldKey = toFieldKey(header, existingKeys, idx);
      const colName = header.substring(0, 50); // 列名最多50字符
      newColumns.push({ name: colName, field_key: fieldKey, sort_order: colOrder++ });
      headerToFieldKey[idx] = fieldKey;
    }
  });

  // 创建新列
  newColumns.forEach(col => {
    db.run(
      'INSERT INTO spreadsheet_columns (spreadsheet_id, name, field_key, type, width, is_visible, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [sheetId, col.name, col.field_key, 'text', 150, 1, col.sort_order]
    );
  });

  // 覆盖模式：先删除所有行
  if (mode === 'replace') {
    db.run('DELETE FROM spreadsheet_rows WHERE spreadsheet_id = ?', [sheetId]);
  }

  // 获取最大 sort_order
  const maxOrder = queryOne(db, 'SELECT MAX(sort_order) AS max_order FROM spreadsheet_rows WHERE spreadsheet_id = ?', [sheetId]);
  let sortOrder = (maxOrder && maxOrder.max_order != null) ? maxOrder.max_order + 1 : 0;

  let imported = 0;
  dataRows.forEach(row => {
    const rowData = {};
    headers.forEach((header, idx) => {
      const fieldKey = headerToFieldKey[idx];
      const cellValue = processCellValue(row[idx]);
      if (fieldKey && cellValue !== '') {
        rowData[fieldKey] = cellValue;
      }
    });
    if (Object.keys(rowData).length > 0) {
      db.run(
        'INSERT INTO spreadsheet_rows (spreadsheet_id, row_data, sort_order) VALUES (?, ?, ?)',
        [sheetId, JSON.stringify(rowData), sortOrder++]
      );
      imported++;
    }
  });

  saveDatabase();

  logActivity(db, {
    user_id: req.session.user.id,
    username: req.session.user.username,
    action: 'import',
    target_type: 'spreadsheet',
    target_id: sheetId,
    target_title: '文件导入',
    detail: `从 ${req.file.originalname} 导入 ${imported} 行数据，自动创建 ${newColumns.length} 个新列（${mode === 'replace' ? '覆盖模式' : '追加模式'}）`,
    ip: req.ip
  });

  res.json({ success: true, data: { imported: imported, mode: mode, newColumns: newColumns.length, totalColumns: existingColumns.length + newColumns.length } });
});

// ============ Luckysheet 在线表格 API ============

// 获取 Luckysheet 表格数据
router.get('/api/spreadsheet/:id/luckysheet/data', isAuthenticated, hasFrontendPermission('spreadsheet.access'), (req, res) => {
  const db = req.db;
  const sheetId = parseInt(req.params.id, 10);
  const sheet = queryOne(db, 'SELECT luckysheet_data FROM spreadsheets WHERE id = ? AND status = ?', [sheetId, 'active']);
  if (!sheet) return res.status(404).json({ success: false, error: '表格不存在' });
  res.json({ success: true, data: sheet.luckysheet_data || null });
});

// 保存 Luckysheet 表格数据
router.post('/api/spreadsheet/:id/luckysheet/save', isAuthenticated, (req, res, next) => {
  const db = req.db;
  const sheetId = parseInt(req.params.id, 10);

  // 权限检查：全局管理权限 或 文档级编辑权限
  const userId = req.session.user.id;
  const hasDocEdit = queryOne(db,
    'SELECT id FROM spreadsheet_user_permissions WHERE spreadsheet_id = ? AND user_id = ? AND perm_type = ?',
    [sheetId, userId, 'edit']
  );
  if (!canManageSpreadsheet(req) && !hasDocEdit) {
    return res.status(403).json({ success: false, error: '没有编辑权限' });
  }

  const sheet = queryOne(db, 'SELECT id, is_locked FROM spreadsheets WHERE id = ? AND status = ?', [sheetId, 'active']);
  if (!sheet) return res.status(404).json({ success: false, error: '表格不存在' });

  // 锁定检查
  if (sheet.is_locked === 1) {
    return res.status(403).json({ success: false, error: '表格已锁定，无法保存' });
  }

  const luckysheetData = req.body.data;
  if (typeof luckysheetData !== 'string') {
    return res.status(400).json({ success: false, error: '数据格式错误' });
  }

  // 限制数据大小（50MB）
  if (luckysheetData.length > 50 * 1024 * 1024) {
    return res.status(400).json({ success: false, error: '数据过大，超过50MB限制' });
  }

  // 验证 JSON 格式（大数据量时用 try-catch 保护）
  try {
    JSON.parse(luckysheetData);
  } catch (e) {
    return res.status(400).json({ success: false, error: '数据格式不是有效的JSON' });
  }

  try {
    db.run(
      'UPDATE spreadsheets SET luckysheet_data = ?, is_luckysheet = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [luckysheetData, sheetId]
    );
    saveDatabase(db);
    logActivity(db, {
      user_id: req.session.user.id,
      username: req.session.user.username,
      action: 'update',
      target_type: 'spreadsheet',
      target_id: sheetId,
      target_title: 'Luckysheet表格保存',
      detail: `保存在线表格数据（${(luckysheetData.length / 1024).toFixed(1)}KB）`,
      ip: req.ip
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ============ 在线用户追踪 ============
const onlineUsers = new Map(); // sheetId -> Map(userId -> { username, lastSeen })

// ============ 实时协同（单元格编辑状态 / 变更广播） ============
// 活跃编辑：sheetId -> Map(userId -> { username, sheet, row, col, ts })
const cellPresence = new Map();
// 变更队列：sheetId -> [{ seq, userId, username, sheet, row, col, value, ts }]（保留最近 500 条）
const cellChanges = new Map();
// seq 从当前毫秒时间戳起步：跨进程重启后单调递增，避免前端"上次序号"大于新队列序号导致拉不到变更
let cellChangeSeq = Date.now();

// 定时清理超时（8 秒无心跳）的编辑状态
setInterval(function() {
  const now = Date.now();
  cellPresence.forEach(function(userMap, sheetId) {
    userMap.forEach(function(info, userId) {
      if (now - info.ts > 8000) {
        userMap.delete(userId);
      }
    });
    if (userMap.size === 0) {
      cellPresence.delete(sheetId);
    }
  });
}, 5000);

// 定时清理离线用户（每30秒清理一次，超过30秒未上报的视为离线）
setInterval(function() {
  const now = Date.now();
  onlineUsers.forEach(function(userMap, sheetId) {
    userMap.forEach(function(info, userId) {
      if (now - info.lastSeen > 30000) {
        userMap.delete(userId);
      }
    });
    if (userMap.size === 0) {
      onlineUsers.delete(sheetId);
    }
  });
}, 30000);

// 上报在线状态并获取在线用户列表
router.post('/api/spreadsheet/:id/online', isAuthenticated, hasFrontendPermission('spreadsheet.access'), (req, res) => {
  const sheetId = parseInt(req.params.id, 10);
  const userId = req.session.user.id;
  const username = req.session.user.username;

  if (!onlineUsers.has(sheetId)) {
    onlineUsers.set(sheetId, new Map());
  }
  const userMap = onlineUsers.get(sheetId);
  userMap.set(userId, { username: username, lastSeen: Date.now() });

  // 返回在线用户列表
  const users = [];
  userMap.forEach(function(info, uid) {
    users.push({ id: uid, username: info.username });
  });

  res.json({ success: true, users: users });
});

// ============ 表格锁定功能 ============

// 获取锁定状态
router.get('/api/spreadsheet/:id/lock', isAuthenticated, hasFrontendPermission('spreadsheet.access'), (req, res) => {
  const db = req.db;
  const sheetId = parseInt(req.params.id, 10);
  const sheet = queryOne(db, 'SELECT is_locked, locked_by FROM spreadsheets WHERE id = ?', [sheetId]);
  if (!sheet) return res.status(404).json({ success: false, error: '表格不存在' });
  res.json({ success: true, locked: sheet.is_locked === 1, locked_by: sheet.locked_by });
});

// 设置锁定状态
router.post('/api/spreadsheet/:id/lock', isAuthenticated, (req, res, next) => {
  const db = req.db;
  const sheetId = parseInt(req.params.id, 10);

  // 只有管理员可以锁定/解锁
  if (!canManageSpreadsheet(req)) {
    return res.status(403).json({ success: false, error: '没有权限操作' });
  }

  const sheet = queryOne(db, 'SELECT id FROM spreadsheets WHERE id = ?', [sheetId]);
  if (!sheet) return res.status(404).json({ success: false, error: '表格不存在' });

  const locked = req.body.locked ? 1 : 0;
  const lockedBy = locked ? req.session.user.id : null;

  try {
    db.run(
      'UPDATE spreadsheets SET is_locked = ?, locked_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [locked, lockedBy, sheetId]
    );
    saveDatabase(db);
    logActivity(db, {
      user_id: req.session.user.id,
      username: req.session.user.username,
      action: locked ? 'lock' : 'unlock',
      target_type: 'spreadsheet',
      target_id: sheetId,
      target_title: locked ? '锁定表格' : '解锁表格',
      detail: locked ? '锁定在线表格' : '解锁在线表格',
      ip: req.ip
    });
    res.json({ success: true, locked: locked === 1 });
  } catch (err) {
    next(err);
  }
});


// ============ 文档级权限管理 ============

// 权限类型说明
const PERM_TYPES = ['view', 'edit', 'download', 'copy'];
const PERM_NAMES = { view: '查看', edit: '编辑', download: '下载', copy: '创建副本' };

// 辅助：检查用户是否有某个文档的特定权限
function hasDocPermission(db, sheetId, userId, permType) {
  if (permType === 'view') return true; // 查看权限默认所有有访问权的用户都有
  const perm = queryOne(db,
    'SELECT id FROM spreadsheet_user_permissions WHERE spreadsheet_id = ? AND user_id = ? AND perm_type = ?',
    [sheetId, userId, permType]
  );
  return !!perm;
}

// 获取我的权限
router.get('/api/spreadsheet/:id/permission/my', isAuthenticated, hasFrontendPermission('spreadsheet.access'), (req, res) => {
  const db = req.db;
  const sheetId = parseInt(req.params.id, 10);
  const userId = req.session.user.id;
  const perms = queryAll(db,
    'SELECT perm_type FROM spreadsheet_user_permissions WHERE spreadsheet_id = ? AND user_id = ?',
    [sheetId, userId]
  );
  const permList = perms.map(p => p.perm_type);
  permList.push('view'); // 查看默认有
  res.json({ success: true, permissions: permList, isAdmin: canManageSpreadsheet(req) });
});

// 申请权限
router.post('/api/spreadsheet/:id/permission/apply', isAuthenticated, hasFrontendPermission('spreadsheet.access'), (req, res, next) => {
  const db = req.db;
  const sheetId = parseInt(req.params.id, 10);
  const userId = req.session.user.id;
  const { perm_type, reason } = req.body;

  if (!perm_type || !PERM_TYPES.includes(perm_type)) {
    return res.status(400).json({ success: false, error: '无效的权限类型' });
  }
  if (perm_type === 'view') {
    return res.status(400).json({ success: false, error: '查看权限无需申请' });
  }

  const sheet = queryOne(db, 'SELECT id, name, created_by FROM spreadsheets WHERE id = ?', [sheetId]);
  if (!sheet) return res.status(404).json({ success: false, error: '表格不存在' });

  // 检查是否已有该权限
  if (hasDocPermission(db, sheetId, userId, perm_type)) {
    return res.status(400).json({ success: false, error: '您已拥有该权限' });
  }

  // 检查是否已有待处理的申请
  const existing = queryOne(db,
    'SELECT id FROM spreadsheet_permission_applications WHERE spreadsheet_id = ? AND user_id = ? AND perm_type = ? AND status = ?',
    [sheetId, userId, perm_type, 'pending']
  );
  if (existing) {
    return res.status(400).json({ success: false, error: '已有待处理的申请，请等待审批' });
  }

  try {
    db.run(
      'INSERT INTO spreadsheet_permission_applications (spreadsheet_id, user_id, perm_type, reason) VALUES (?, ?, ?, ?)',
      [sheetId, userId, perm_type, reason || '']
    );
    saveDatabase(db);

    // 通知表格创建者和所有管理员
    const admins = queryAll(db, `
      SELECT DISTINCT u.id, u.username FROM users u
      WHERE u.role = 'super_admin'
      OR u.id IN (SELECT user_id FROM user_permissions WHERE perm_key IN ('spreadsheet.manage', 'spreadsheet.*'))
    `);
    admins.forEach(admin => {
      createNotification(db, {
        userId: admin.id,
        type: 'permission_apply',
        title: '表格权限申请',
        content: `${req.session.user.username} 申请表格「${sheet.name}」的${PERM_NAMES[perm_type]}权限${reason ? '：' + reason : ''}`,
        fromUserId: userId,
        targetType: 'spreadsheet',
        targetId: String(sheetId)
      });
    });

    res.json({ success: true, message: '申请已提交，等待审批' });
  } catch (err) {
    next(err);
  }
});

// 获取权限列表（管理员）
router.get('/api/spreadsheet/:id/permissions', isAuthenticated, (req, res) => {
  if (!canManageSpreadsheet(req)) {
    return res.status(403).json({ success: false, error: '没有权限' });
  }
  const db = req.db;
  const sheetId = parseInt(req.params.id, 10);
  const perms = queryAll(db, `
    SELECT p.*, u.username, u.email
    FROM spreadsheet_user_permissions p
    LEFT JOIN users u ON p.user_id = u.id
    WHERE p.spreadsheet_id = ?
    ORDER BY p.created_at DESC
  `, [sheetId]);
  res.json({ success: true, permissions: perms });
});

// 获取申请列表（管理员）
router.get('/api/spreadsheet/:id/permission/applications', isAuthenticated, (req, res) => {
  if (!canManageSpreadsheet(req)) {
    return res.status(403).json({ success: false, error: '没有权限' });
  }
  const db = req.db;
  const sheetId = parseInt(req.params.id, 10);
  const apps = queryAll(db, `
    SELECT a.*, u.username, u.email
    FROM spreadsheet_permission_applications a
    LEFT JOIN users u ON a.user_id = u.id
    WHERE a.spreadsheet_id = ?
    ORDER BY a.created_at DESC
    LIMIT 50
  `, [sheetId]);
  res.json({ success: true, applications: apps });
});

// 审批申请
router.post('/api/spreadsheet/:id/permission/approve', isAuthenticated, (req, res, next) => {
  if (!canManageSpreadsheet(req)) {
    return res.status(403).json({ success: false, error: '没有权限' });
  }
  const db = req.db;
  const sheetId = parseInt(req.params.id, 10);
  const { application_id, approved, perm_type } = req.body;

  const app = queryOne(db, 'SELECT * FROM spreadsheet_permission_applications WHERE id = ? AND spreadsheet_id = ?', [application_id, sheetId]);
  if (!app) return res.status(404).json({ success: false, error: '申请不存在' });
  if (app.status !== 'pending') return res.status(400).json({ success: false, error: '申请已处理' });

  const sheet = queryOne(db, 'SELECT name FROM spreadsheets WHERE id = ?', [sheetId]);
  const actualPermType = perm_type || app.perm_type;

  try {
    // 更新申请状态
    db.run(
      'UPDATE spreadsheet_permission_applications SET status = ?, handled_by = ?, handled_at = CURRENT_TIMESTAMP WHERE id = ?',
      [approved ? 'approved' : 'rejected', req.session.user.id, application_id]
    );

    if (approved) {
      // 授予权限（忽略重复）
      db.run(
        'INSERT OR IGNORE INTO spreadsheet_user_permissions (spreadsheet_id, user_id, perm_type, granted_by) VALUES (?, ?, ?, ?)',
        [sheetId, app.user_id, actualPermType, req.session.user.id]
      );
    }
    saveDatabase(db);

    // 通知申请人
    createNotification(db, {
      userId: app.user_id,
      type: 'permission_result',
      title: approved ? '权限申请已通过' : '权限申请被拒绝',
      content: `您申请的表格「${sheet ? sheet.name : ''}」的${PERM_NAMES[actualPermType]}权限${approved ? '已通过' : '被拒绝'}`,
      fromUserId: req.session.user.id,
      targetType: 'spreadsheet',
      targetId: String(sheetId)
    });

    res.json({ success: true, message: approved ? '已通过申请' : '已拒绝申请' });
  } catch (err) {
    next(err);
  }
});

// 撤销用户权限
router.delete('/api/spreadsheet/:id/permission/:userId', isAuthenticated, (req, res, next) => {
  if (!canManageSpreadsheet(req)) {
    return res.status(403).json({ success: false, error: '没有权限' });
  }
  const db = req.db;
  const sheetId = parseInt(req.params.id, 10);
  const userId = parseInt(req.params.userId, 10);
  const { perm_type } = req.body;

  try {
    if (perm_type) {
      db.run(
        'DELETE FROM spreadsheet_user_permissions WHERE spreadsheet_id = ? AND user_id = ? AND perm_type = ?',
        [sheetId, userId, perm_type]
      );
    } else {
      db.run(
        'DELETE FROM spreadsheet_user_permissions WHERE spreadsheet_id = ? AND user_id = ?',
        [sheetId, userId]
      );
    }
    saveDatabase(db);
    res.json({ success: true, message: '权限已撤销' });
  } catch (err) {
    next(err);
  }
});

// ============ 实时协同 API ============

// 上报/结束单元格编辑状态（用于在对应单元格显示"谁在编辑"）
router.post('/api/spreadsheet/:id/cell-active', isAuthenticated, (req, res) => {
  const sheetId = parseInt(req.params.id, 10);
  const userId = req.session.user.id;
  const { sheet, row, col, action } = req.body || {};
  const sheetIdx = parseInt(sheet, 10) || 0;
  const r = parseInt(row, 10);
  const c = parseInt(col, 10);

  if (!cellPresence.has(sheetId)) cellPresence.set(sheetId, new Map());
  const userMap = cellPresence.get(sheetId);

  if (action === 'end') {
    userMap.delete(userId);
  } else if (!isNaN(r) && !isNaN(c)) {
    userMap.set(userId, {
      username: req.session.user.username || '用户',
      sheet: sheetIdx,
      row: r,
      col: c,
      ts: Date.now()
    });
  }
  res.json({ success: true });
});

// 获取当前正在编辑的用户（用于前端叠加"编辑者"角标）
router.get('/api/spreadsheet/:id/cell-presence', isAuthenticated, (req, res) => {
  const sheetId = parseInt(req.params.id, 10);
  const userMap = cellPresence.get(sheetId);
  const list = [];
  if (userMap) {
    const now = Date.now();
    userMap.forEach(function(info, uid) {
      if (now - info.ts <= 8000 && uid !== req.session.user.id) {
        list.push({ username: info.username, sheet: info.sheet, row: info.row, col: info.col });
      }
    });
  }
  res.json({ success: true, users: list });
});

// 单格编辑保存：更新 luckysheet_data 中对应单元格 + 记历史 + 广播给其他用户
router.post('/api/spreadsheet/:id/cell-edit', isAuthenticated, (req, res, next) => {
  const db = req.db;
  const sheetId = parseInt(req.params.id, 10);
  const userId = req.session.user.id;
  const { sheet, row, col, value } = req.body || {};

  // 权限检查：全局管理权限 或 文档级编辑权限
  const hasDocEdit = queryOne(db,
    'SELECT id FROM spreadsheet_user_permissions WHERE spreadsheet_id = ? AND user_id = ? AND perm_type = ?',
    [sheetId, userId, 'edit']
  );
  if (!canManageSpreadsheet(req) && !hasDocEdit) {
    return res.status(403).json({ success: false, error: '没有编辑权限' });
  }

  const sheetRow = queryOne(db, 'SELECT id, is_locked, luckysheet_data FROM spreadsheets WHERE id = ? AND status = ?', [sheetId, 'active']);
  if (!sheetRow) return res.status(404).json({ success: false, error: '表格不存在' });
  if (sheetRow.is_locked === 1) return res.status(403).json({ success: false, error: '表格已锁定，无法编辑' });

  const sheetIdx = parseInt(sheet, 10);
  const r = parseInt(row, 10);
  const c = parseInt(col, 10);
  if (isNaN(sheetIdx) || isNaN(r) || isNaN(c) || r < 0 || c < 0) {
    return res.status(400).json({ success: false, error: '单元格坐标无效' });
  }

  let parsed = null;
  try {
    parsed = sheetRow.luckysheet_data ? JSON.parse(sheetRow.luckysheet_data) : null;
  } catch (e) {
    return res.status(500).json({ success: false, error: '表格数据损坏，请刷新后重试' });
  }
  if (!Array.isArray(parsed) || !parsed[sheetIdx]) {
    return res.status(400).json({ success: false, error: '表格 Sheet 不存在' });
  }

  const target = parsed[sheetIdx];
  let oldValue;
  const newValue = JSON.parse(JSON.stringify(value)); // 深拷贝，避免引用污染

  try {
    // 二维 data 格式（Luckysheet 内部 flowdata）
    if (Array.isArray(target.data)) {
      if (target.data[r] === undefined) target.data[r] = [];
      oldValue = target.data[r][c];
      target.data[r][c] = newValue;
    }
    // celldata 扁平格式（若存在）
    if (Array.isArray(target.celldata)) {
      const cell = target.celldata.find(function(x) { return x.r === r && x.c === c; });
      if (cell) {
        if (oldValue === undefined) oldValue = cell.v;
        cell.v = newValue;
      } else {
        target.celldata.push({ r: r, c: c, v: newValue });
      }
    }
    // 同时同步到 config 内的 dataVerification 无关，不处理
  } catch (e) {
    return res.status(500).json({ success: false, error: '更新单元格失败' });
  }

  const oldText = oldValue === undefined ? null : JSON.stringify(oldValue);
  const newText = newValue === undefined ? null : JSON.stringify(newValue);

  try {
    db.run(
      'UPDATE spreadsheets SET luckysheet_data = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [JSON.stringify(parsed), sheetId]
    );
    saveDatabase(db);

    // 记录编辑历史
    db.run(
      'INSERT INTO spreadsheet_cell_edits (spreadsheet_id, sheet_index, row, col, user_id, username, old_value, new_value) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [sheetId, sheetIdx, r, c, userId, req.session.user.username || '用户', oldText, newText]
    );

    // 广播变更给其他在线用户
    if (!cellChanges.has(sheetId)) cellChanges.set(sheetId, []);
    const queue = cellChanges.get(sheetId);
    cellChangeSeq++;
    queue.push({
      seq: cellChangeSeq,
      userId: userId,
      username: req.session.user.username || '用户',
      sheet: sheetIdx,
      row: r,
      col: c,
      value: newValue,
      ts: Date.now()
    });
    if (queue.length > 500) queue.splice(0, queue.length - 500);

    res.json({ success: true, old_value: oldText });
  } catch (err) {
    next(err);
  }
});

// 拉取其他用户的单元格变更（增量轮询，基于 seq 序号而非时间戳，规避前后端时钟偏差）
router.get('/api/spreadsheet/:id/cell-changes', isAuthenticated, (req, res) => {
  const sheetId = parseInt(req.params.id, 10);
  const since = parseInt(req.query.since, 10) || 0;
  const userId = req.session.user.id;
  const queue = cellChanges.get(sheetId) || [];
  const nowTs = Date.now();
  const changes = queue
    .filter(function(change) {
      // seq 严格增量过滤 + 只返回最近 5 分钟的变更（首次拉取 since=0 时不会拿几天前的旧值覆盖）
      return change.seq > since && change.ts > nowTs - 5 * 60 * 1000;
    })
    .map(function(change) {
      return {
        seq: change.seq,
        isMine: change.userId === userId,
        username: change.username,
        sheet: change.sheet,
        row: change.row,
        col: change.col,
        value: change.value,
        ts: change.ts
      };
    });
  const maxSeq = queue.length > 0 ? queue[queue.length - 1].seq : since;
  res.json({ success: true, since: maxSeq, changes: changes });
});

// 查询单元格编辑历史
router.get('/api/spreadsheet/:id/cell-history', isAuthenticated, hasFrontendPermission('spreadsheet.access'), (req, res) => {
  const db = req.db;
  const sheetId = parseInt(req.params.id, 10);
  const sheetIdx = parseInt(req.query.sheet, 10) || 0;
  const r = parseInt(req.query.row, 10);
  const c = parseInt(req.query.col, 10);
  if (isNaN(r) || isNaN(c) || r < 0 || c < 0) {
    return res.status(400).json({ success: false, error: '单元格坐标无效' });
  }
  const history = queryAll(db,
    `SELECT id, sheet_index, row, col, user_id, username, old_value, new_value, created_at
     FROM spreadsheet_cell_edits
     WHERE spreadsheet_id = ? AND sheet_index = ? AND row = ? AND col = ?
     ORDER BY id DESC LIMIT 50`,
    [sheetId, sheetIdx, r, c]
  );
  res.json({ success: true, history: history });
});

module.exports = router;
