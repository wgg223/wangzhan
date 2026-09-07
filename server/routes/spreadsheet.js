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

// 辅助：检查用户是否有表格管理权限
function canManageSpreadsheet(req) {
  if (!req.session || !req.session.user) return false;
  if (req.session.user.role === 'super_admin') return true;
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

// 表格查看/编辑页
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

  const columns = queryAll(db,
    'SELECT * FROM spreadsheet_columns WHERE spreadsheet_id = ? ORDER BY sort_order ASC, id ASC',
    [sheetId]
  );
  const canManage = canManageSpreadsheet(req);

  res.render('frontend/spreadsheet', {
    user: req.session.user,
    sheet: sheet,
    columns: columns,
    canManage: canManage,
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

  // 获取所有行（SQLite 中用 LIKE 做搜索）
  let rows = queryAll(db,
    'SELECT * FROM spreadsheet_rows WHERE spreadsheet_id = ? ORDER BY sort_order ASC, id ASC',
    [sheetId]
  );

  // 解析 row_data 并搜索
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

// ============ CSV 导入功能 ============
const multer = require('multer');
const importUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 最大10MB
});

// 简易 CSV 解析器（支持引号包裹、逗号、换行）
function parseCSV(text) {
  // 移除 BOM
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const rows = [];
  let cur = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { cur.push(field); field = ''; i++; continue; }
    if (c === '\r') {
      if (text[i + 1] === '\n') i++;
      cur.push(field); rows.push(cur); cur = []; field = ''; i++; continue;
    }
    if (c === '\n') { cur.push(field); rows.push(cur); cur = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field.length > 0 || cur.length > 0) { cur.push(field); rows.push(cur); }
  // 移除空行
  return rows.filter(r => r.some(c => c.trim() !== ''));
}

// 预览 CSV（解析前几行，返回列名和示例数据）
router.post('/api/spreadsheet/:id/import/preview', isAuthenticated, (req, res, next) => {
  if (!canManageSpreadsheet(req)) return res.status(403).json({ error: '您没有编辑此表格的权限' });
  next();
}, importUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请上传 CSV 文件' });
  const sheetId = parseInt(req.params.id, 10);
  const db = req.db;

  let text;
  try {
    text = req.file.buffer.toString('utf-8');
  } catch (e) {
    return res.status(400).json({ error: '文件编码不支持，请使用 UTF-8 编码的 CSV 文件' });
  }

  const rows = parseCSV(text);
  if (rows.length === 0) return res.status(400).json({ error: 'CSV 文件为空' });

  const headers = rows[0].map(h => h.trim());
  const sampleRows = rows.slice(1, 6); // 最多预览5行数据

  // 获取表格现有列
  const columns = queryAll(db, 'SELECT * FROM spreadsheet_columns WHERE spreadsheet_id = ? ORDER BY sort_order ASC, id ASC', [sheetId]);

  res.json({
    success: true,
    data: {
      filename: req.file.originalname,
      totalRows: rows.length - 1, // 减去表头
      headers: headers,
      sampleRows: sampleRows,
      tableColumns: columns.map(c => ({ id: c.id, name: c.name, field_key: c.field_key }))
    }
  });
});

// 执行导入
router.post('/api/spreadsheet/:id/import', isAuthenticated, (req, res, next) => {
  if (!canManageSpreadsheet(req)) return res.status(403).json({ error: '您没有编辑此表格的权限' });
  next();
}, importUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请上传 CSV 文件' });
  const sheetId = parseInt(req.params.id, 10);
  const db = req.db;
  const mode = req.body.mode || 'append'; // append（追加）或 replace（覆盖）
  const mapping = req.body.mapping ? JSON.parse(req.body.mapping) : {}; // { csvHeader: field_key }

  const sheet = queryOne(db, 'SELECT id FROM spreadsheets WHERE id = ?', [sheetId]);
  if (!sheet) return res.status(404).json({ error: '表格不存在' });

  let text;
  try {
    text = req.file.buffer.toString('utf-8');
  } catch (e) {
    return res.status(400).json({ error: '文件编码不支持' });
  }

  const rows = parseCSV(text);
  if (rows.length < 2) return res.status(400).json({ error: 'CSV 文件没有数据行' });

  const headers = rows[0].map(h => h.trim());
  const dataRows = rows.slice(1);

  // 覆盖模式：先删除所有行
  if (mode === 'replace') {
    db.run('DELETE FROM spreadsheet_rows WHERE spreadsheet_id = ?', [sheetId]);
  }

  // 获取最大 sort_order
  const maxOrder = queryOne(db, 'SELECT MAX(sort_order) AS max_order FROM spreadsheet_rows WHERE spreadsheet_id = ?', [sheetId]);
  let sortOrder = (maxOrder && maxOrder.max_order != null) ? maxOrder.max_order + 1 : 0;

  let imported = 0;
  const columns = queryAll(db, 'SELECT field_key FROM spreadsheet_columns WHERE spreadsheet_id = ?', [sheetId]);
  const validKeys = new Set(columns.map(c => c.field_key));

  dataRows.forEach(row => {
    const rowData = {};
    headers.forEach((header, idx) => {
      const fieldKey = mapping[header] || header;
      if (validKeys.has(fieldKey) && row[idx] !== undefined) {
        rowData[fieldKey] = row[idx];
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
    target_title: 'CSV导入',
    detail: `从 ${req.file.originalname} 导入 ${imported} 行数据（${mode === 'replace' ? '覆盖模式' : '追加模式'}）`,
    ip: req.ip
  });

  res.json({ success: true, data: { imported: imported, mode: mode } });
});

module.exports = router;
