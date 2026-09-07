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
const multer = require('multer');
const XLSX = require('xlsx');
const { hasPermission } = require('../../middlewares/auth');
const { queryAll, queryOne, saveDatabase } = require('../../config/database');
const { logActivity } = require('../../config/activity');

const batchImportUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 }
});

// 将表头转换为合法的 field_key
function toFieldKey(header, existingKeys, idx) {
  let key = String(header).trim().toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^_+|_+$/g, '');
  if (!/^[a-z_][a-z0-9_]*$/.test(key)) {
    key = 'col_' + (idx + 1);
  }
  let finalKey = key;
  let counter = 1;
  while (existingKeys.has(finalKey)) {
    finalKey = key + '_' + counter++;
  }
  existingKeys.add(finalKey);
  return finalKey;
}

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

// 预览 Excel 文件中的 Sheet 列表（查询表内文件）
router.post('/spreadsheets/batch-preview', batchImportUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请上传 Excel 文件' });

  let workbook;
  try {
    workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
  } catch (e) {
    return res.status(400).json({ error: 'Excel 文件解析失败: ' + e.message });
  }

  const sheetNames = workbook.SheetNames;
  if (sheetNames.length === 0) return res.status(400).json({ error: 'Excel 文件中没有工作表' });

  const sheets = sheetNames.map(name => {
    const worksheet = workbook.Sheets[name];
    const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });
    const headers = rows.length > 0 ? rows[0].map(h => String(h).trim()).filter(h => h) : [];
    const dataRows = rows.slice(1).filter(r => r.some(c => String(c).trim() !== ''));
    // 检测是否有图片（xlsx社区版不支持直接提取，但可以检测图片关系）
    const hasImages = !!(worksheet['!images'] || (worksheet['!merges'] && worksheet['!merges'].length > 0));
    return {
      name: name,
      columns: headers.length,
      rows: dataRows.length,
      headers: headers.slice(0, 10),
      hasImages: hasImages,
      sampleData: dataRows.slice(0, 3).map(r => r.slice(0, 5).map(c => String(c).substring(0, 50)))
    };
  });

  res.json({
    success: true,
    data: {
      filename: req.file.originalname,
      totalSheets: sheetNames.length,
      sheets: sheets
    }
  });
});

// 批量导入：多 Sheet Excel 文件，每个 Sheet 创建一个新表格
router.post('/spreadsheets/batch-import', batchImportUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请上传 Excel 文件' });
  const db = req.db;

  let selectedSheets = null;
  try {
    selectedSheets = req.body.selectedSheets ? JSON.parse(req.body.selectedSheets) : null;
  } catch (e) {
    return res.status(400).json({ error: 'selectedSheets 参数格式错误' });
  }

  let workbook;
  try {
    workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
  } catch (e) {
    return res.status(400).json({ error: 'Excel 文件解析失败: ' + e.message });
  }

  let sheetNames = workbook.SheetNames;
  if (sheetNames.length === 0) return res.status(400).json({ error: 'Excel 文件中没有工作表' });

  if (selectedSheets && Array.isArray(selectedSheets) && selectedSheets.length > 0) {
    sheetNames = sheetNames.filter(function(name) { return selectedSheets.indexOf(name) >= 0; });
  }

  if (sheetNames.length === 0) return res.status(400).json({ error: '没有选中的工作表' });

  const results = [];
  let totalRows = 0;

  try {
    sheetNames.forEach(function(sheetName, sheetIdx) {
      const worksheet = workbook.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });
      if (rows.length < 2) {
        results.push({ name: sheetName, success: false, error: '没有数据行' });
        return;
      }

      const headers = rows[0].map(function(h) { return String(h).trim(); });
      const dataRows = rows.slice(1).filter(function(r) { return r.some(function(c) { return String(c).trim() !== ''; }); });
      if (dataRows.length === 0) {
        results.push({ name: sheetName, success: false, error: '没有有效数据' });
        return;
      }

      const tableName = (sheetName || 'Sheet' + (sheetIdx + 1)).substring(0, 100);
      const description = '从 ' + req.file.originalname + ' 批量导入';

      // 创建表格并获取新ID
      const insertResult = db.run(
        'INSERT INTO spreadsheets (name, description, created_by) VALUES (?, ?, ?)',
        [tableName, description, req.session.user.id]
      );
      const newSheetId = insertResult.lastInsertRowid;
      if (!newSheetId) {
        results.push({ name: sheetName, success: false, error: '创建表格失败' });
        return;
      }

      // 创建列
      const existingKeys = new Set();
      const colFieldKeys = [];
      headers.forEach(function(header, idx) {
        if (!header) { colFieldKeys.push(null); return; }
        const fieldKey = toFieldKey(header, existingKeys, idx);
        const colName = header.substring(0, 50);
        db.run(
          'INSERT INTO spreadsheet_columns (spreadsheet_id, name, field_key, type, width, is_visible, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [newSheetId, colName, fieldKey, 'text', 150, 1, idx]
        );
        colFieldKeys.push(fieldKey);
      });

      // 导入行数据
      let imported = 0;
      dataRows.forEach(function(row, rowIdx) {
        const rowData = {};
        headers.forEach(function(header, idx) {
          const fieldKey = colFieldKeys[idx];
          if (fieldKey && row[idx] !== undefined && String(row[idx]).trim() !== '') {
            rowData[fieldKey] = String(row[idx]);
          }
        });
        if (Object.keys(rowData).length > 0) {
          db.run(
            'INSERT INTO spreadsheet_rows (spreadsheet_id, row_data, sort_order) VALUES (?, ?, ?)',
            [newSheetId, JSON.stringify(rowData), rowIdx]
          );
          imported++;
        }
      });

      totalRows += imported;
      results.push({
        id: newSheetId,
        name: tableName,
        success: true,
        columns: colFieldKeys.filter(function(k) { return k; }).length,
        rows: imported
      });
    });

    saveDatabase();

    // 记录活动日志（不影响主流程）
    try {
      logActivity(db, {
        user_id: req.session.user.id,
        username: req.session.user.username,
        action: 'batch_import',
        target_type: 'spreadsheet',
        target_id: 0,
        target_title: '批量导入表格',
        detail: '从 ' + req.file.originalname + ' 批量导入 ' + results.filter(function(r) { return r.success; }).length + ' 个表格，共 ' + totalRows + ' 行数据',
        ip: req.ip
      });
    } catch (logErr) {
      console.error('日志记录失败:', logErr.message);
    }

    res.json({
      success: true,
      data: {
        totalSheets: sheetNames.length,
        importedSheets: results.filter(function(r) { return r.success; }).length,
        totalRows: totalRows,
        results: results
      }
    });
  } catch (err) {
    console.error('批量导入失败:', err);
    res.status(500).json({ error: '导入失败: ' + err.message, stack: err.stack });
  }
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
