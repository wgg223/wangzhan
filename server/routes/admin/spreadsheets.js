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

// Excel日期序列号转日期字符串（1900日期系统）
function excelDateToString(value) {
  if (typeof value !== 'number' || value < 20000 || value > 80000) return null;
  try {
    // Excel日期序列号，1900-01-01对应1（有1900年闰年bug，实际从1899-12-30开始）
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

// 自动检测表头行：如果第一行非空列太少，认为是标题行，使用第二行
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

// 处理单元格值：转换日期、数字转字符串
function processCellValue(value) {
  if (value === null || value === undefined) return '';
  // 尝试转换Excel日期
  if (typeof value === 'number') {
    const dateStr = excelDateToString(value);
    if (dateStr) return dateStr;
  }
  return String(value);
}

// 所有路由需要 spreadsheet.manage 权限
router.use(hasPermission('spreadsheet.manage'));

// 表格管理列表
router.get('/spreadsheets', (req, res) => {
  const db = req.db;
  const sheets = queryAll(db,
    `SELECT s.*, u.username AS creator_name
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
    settings: res.locals.settings || {}
  });
});

// 保存创建
router.post('/spreadsheets', (req, res) => {
  const db = req.db;
  const { name, description } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ error: '表格名称不能为空' });
  }

  // 创建空的 Luckysheet 表格数据
  const emptyData = JSON.stringify([{
    name: name.trim().substring(0, 31),
    index: 0,
    status: 1,
    order: 0,
    row: 36,
    column: 18,
    celldata: [],
    config: {},
    scrollLeft: 0,
    scrollTop: 0,
    zoomRatio: 1,
    showGridLines: 1,
    defaultRowHeight: 28,
    defaultColWidth: 100,
    visibledatarow: 36,
    visibledatacolumn: 18
  }]);

  const result = db.run(
    'INSERT INTO spreadsheets (name, description, created_by, luckysheet_data, is_luckysheet) VALUES (?, ?, ?, ?, 1)',
    [name.trim(), description || '', req.session.user.id, emptyData]
  );
  const sheetId = result.lastInsertRowid;

  saveDatabase();

  logActivity(db, {
    user_id: req.session.user.id,
    username: req.session.user.username,
    action: 'create',
    target_type: 'spreadsheet',
    target_id: sheetId,
    target_title: name.trim(),
    detail: '创建在线表格（Luckysheet）: ' + name.trim(),
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

  const sheets = sheetNames.map(function(name) {
    const worksheet = workbook.Sheets[name];
    const rawRows = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '', raw: true });
    const headerRowIdx = detectHeaderRow(rawRows);
    const headers = rawRows.length > headerRowIdx ? rawRows[headerRowIdx].map(function(h) { return processCellValue(h).trim(); }).filter(function(h) { return h; }) : [];
    const dataRows = rawRows.slice(headerRowIdx + 1).filter(function(r) {
      return r.some(function(c) { return processCellValue(c).trim() !== ''; });
    });
    const hasImages = !!(worksheet['!images'] || (worksheet['!merges'] && worksheet['!merges'].length > 0));
    return {
      name: name,
      columns: headers.length,
      rows: dataRows.length,
      headers: headers.slice(0, 10),
      hasImages: hasImages,
      headerRow: headerRowIdx + 1,
      sampleData: dataRows.slice(0, 3).map(function(r) {
        return r.slice(0, 5).map(function(c) { return processCellValue(c).substring(0, 50); });
      })
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
      const rawRows = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '', raw: true });
      if (rawRows.length === 0) {
        results.push({ name: sheetName, success: false, error: '没有数据' });
        return;
      }

      // 转换为 Luckysheet celldata 格式
      const celldata = [];
      let maxCol = 0;
      rawRows.forEach(function(row, r) {
        row.forEach(function(cell, c) {
          const value = processCellValue(cell);
          if (value !== '' && value != null) {
            celldata.push({
              r: r,
              c: c,
              v: { v: value, m: value, ct: { fa: 'General', t: 'g' } }
            });
            if (c > maxCol) maxCol = c;
          }
        });
      });

      const tableName = (sheetName || 'Sheet' + (sheetIdx + 1)).substring(0, 100);
      const description = '从 ' + req.file.originalname + ' 批量导入';

      // 构建 Luckysheet 数据
      const luckysheetData = [{
        name: tableName,
        index: 0,
        status: 1,
        order: 0,
        row: Math.max(rawRows.length, 36),
        column: Math.max(maxCol + 1, 18),
        celldata: celldata,
        config: {},
        scrollLeft: 0,
        scrollTop: 0,
        zoomRatio: 1,
        showGridLines: 1,
        defaultRowHeight: 28,
        defaultColWidth: 100,
        visibledatarow: Math.max(rawRows.length, 36),
        visibledatacolumn: Math.max(maxCol + 1, 18)
      }];

      const dataJson = JSON.stringify(luckysheetData);

      // 创建表格并获取新ID
      const insertResult = db.run(
        'INSERT INTO spreadsheets (name, description, created_by, luckysheet_data, is_luckysheet) VALUES (?, ?, ?, ?, 1)',
        [tableName, description, req.session.user.id, dataJson]
      );
      const newSheetId = insertResult.lastInsertRowid;
      if (!newSheetId) {
        results.push({ name: sheetName, success: false, error: '创建表格失败' });
        return;
      }

      const rowCount = rawRows.filter(function(r) { return r.some(function(c) { return processCellValue(c).trim() !== ''; }); }).length;
      totalRows += rowCount;
      results.push({
        id: newSheetId,
        name: tableName,
        success: true,
        columns: maxCol + 1,
        rows: rowCount
      });
    });

    saveDatabase();

    try {
      logActivity(db, {
        user_id: req.session.user.id,
        username: req.session.user.username,
        action: 'batch_import',
        target_type: 'spreadsheet',
        target_id: 0,
        target_title: '批量导入表格',
        detail: '从 ' + req.file.originalname + ' 批量导入 ' + results.filter(function(r) { return r.success; }).length + ' 个表格，共 ' + totalRows + ' 行数据（Luckysheet格式）',
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
  res.render('admin/spreadsheet-form', {
    user: req.session.user,
    sheet: sheet,
    settings: res.locals.settings || {}
  });
});

// 更新表格
router.post('/spreadsheets/:id', (req, res) => {
  const db = req.db;
  const sheetId = parseInt(req.params.id, 10);
  const { name, description, status } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ error: '表格名称不能为空' });
  }

  db.run(
    'UPDATE spreadsheets SET name = ?, description = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    [name.trim(), description || '', status || 'active', sheetId]
  );
  saveDatabase();
  res.json({ success: true });
});

// 删除表格
router.delete('/spreadsheets/:id', (req, res) => {
  const db = req.db;
  const sheetId = parseInt(req.params.id, 10);
  db.run('DELETE FROM spreadsheets WHERE id = ?', [sheetId]);
  db.run('DELETE FROM spreadsheet_columns WHERE spreadsheet_id = ?', [sheetId]);
  db.run('DELETE FROM spreadsheet_rows WHERE spreadsheet_id = ?', [sheetId]);
  saveDatabase();
  res.json({ success: true });
});

module.exports = router;