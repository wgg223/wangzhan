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
  res.render('frontend/spreadsheet-editor', {
    user: req.session.user,
    sheet: sheet,
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

// ============ 文件导入功能（CSV / XLSX） ============
const multer = require('multer');
const XLSX = require('xlsx');
const importUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 } // 最大50MB
});

// Excel日期序列号转日期字符串
function excelDateToString(value) {
  if (typeof value !== 'number' || value < 20000 || value > 80000) return null;
  try {
    const date = new Date(Math.round((value - 25569) * 86400 * 1000));
    if (isNaN(date.getTime())) return null;
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + d;
  } catch (e) {
    return null;
  }
}

// 处理单元格值
function processCellValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') {
    const dateStr = excelDateToString(value);
    if (dateStr) return dateStr;
  }
  return String(value);
}

// 自动检测表头行
function detectHeaderRow(rows) {
  if (rows.length === 0) return 0;
  const firstRow = rows[0];
  const totalCols = firstRow.length;
  const nonEmptyCols = firstRow.filter(function(c) { return String(c).trim() !== ''; }).length;
  
  // 条件1：第一行非空列比例很低（<40%），认为是标题行
  if (totalCols >= 2 && nonEmptyCols / totalCols < 0.4 && rows.length > 1) {
    return 1;
  }
  
  // 条件2：第一行只有1列有值，且第二行有更多列有值，认为是标题行
  if (nonEmptyCols <= 1 && rows.length > 1) {
    const secondRowNonEmpty = rows[1].filter(function(c) { return String(c).trim() !== ''; }).length;
    if (secondRowNonEmpty > nonEmptyCols) {
      return 1;
    }
  }
  
  return 0;
}

// 统一解析导入文件，返回 { headers, dataRows }
function parseImportFile(file) {
  const ext = (file.originalname.split('.').pop() || '').toLowerCase();
  let rawRows;
  if (ext === 'csv') {
    const text = file.buffer.toString('utf-8');
    rawRows = parseCSV(text);
  } else if (ext === 'xlsx' || ext === 'xls') {
    const workbook = XLSX.read(file.buffer, { type: 'buffer' });
    const firstSheetName = workbook.SheetNames[0];
    if (!firstSheetName) throw new Error('Excel 文件中没有工作表');
    const worksheet = workbook.Sheets[firstSheetName];
    rawRows = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '', raw: true });
  } else {
    throw new Error('不支持的文件格式，请上传 CSV 或 XLSX 文件');
  }

  if (rawRows.length === 0) throw new Error('文件为空');

  // 自动检测表头行
  const headerRowIdx = detectHeaderRow(rawRows);
  const headers = rawRows[headerRowIdx].map(function(h) { return processCellValue(h).trim(); });
  const dataRows = rawRows.slice(headerRowIdx + 1).filter(function(r) {
    return r.some(function(c) { return processCellValue(c).trim() !== ''; });
  });

  return { headers: headers, dataRows: dataRows, headerRowIdx: headerRowIdx };
}

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
      totalRows: rows.length - 1, // 减去表头
      headers: headers,
      sampleRows: sampleRows,
      tableColumns: columns.map(c => ({ id: c.id, name: c.name, field_key: c.field_key }))
    }
  });
});

// 将表头转换为合法的 field_key
function toFieldKey(header, existingKeys, idx) {
  // 先尝试直接用表头（如果是合法的英文标识符）
  let key = String(header).trim().toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^_+|_+$/g, '');
  if (!/^[a-z_][a-z0-9_]*$/.test(key)) {
    key = 'col_' + (idx + 1);
  }
  // 避免重复
  let finalKey = key;
  let counter = 1;
  while (existingKeys.has(finalKey)) {
    finalKey = key + '_' + counter++;
  }
  existingKeys.add(finalKey);
  return finalKey;
}

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

  // 权限检查
  if (!canManageSpreadsheet(req)) {
    return res.status(403).json({ success: false, error: '没有编辑权限' });
  }

  const sheet = queryOne(db, 'SELECT id FROM spreadsheets WHERE id = ? AND status = ?', [sheetId, 'active']);
  if (!sheet) return res.status(404).json({ success: false, error: '表格不存在' });

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

module.exports = router;
