/**
 * 后台在线表格管理路由（Univer 重构版）
 * 页面/接口：
 *   GET    /admin/spreadsheets                 —— 管理列表（统计 + 状态过滤 + 搜索）
 *   GET    /admin/spreadsheets/create          —— 创建表单
 *   POST   /admin/spreadsheets                 —— 创建（Univer 空文档）
 *   POST   /admin/spreadsheets/import          —— 上传 .xlsx/.csv 创建表格
 *   POST   /admin/spreadsheets/batch-preview   —— 预览 Excel 各 Sheet 结构
 *   POST   /admin/spreadsheets/batch-import    —— 批量导入（每 Sheet 一个表格）
 *   POST   /admin/spreadsheets/batch           —— 批量管理（软删/硬删/恢复/锁定/解锁）
 *   GET    /admin/spreadsheets/:id/edit        —— 编辑元数据表单
 *   POST   /admin/spreadsheets/:id             —— 保存元数据（名称/描述/状态/锁定）
 *   GET    /admin/spreadsheets/:id/inspect     —— 文档结构概览（JSON）
 *   POST   /admin/spreadsheets/:id/migrate     —— 强制迁移旧 Luckysheet 数据
 *   DELETE /admin/spreadsheets/:id             —— 删除（默认软删；?hard=1 硬删含级联清理）
 */
'use strict';
const express = require('express');
const router = express.Router();
const multer = require('multer');
const { hasPermission } = require('../../middlewares/auth');
const { queryAll, queryOne, saveDatabase } = require('../../config/database');
const { logActivity } = require('../../config/activity');
const { createEmptyUniverDoc } = require('../../utils/spreadsheet-migrate');
const { importBufferToUniverDoc } = require('../../utils/spreadsheet-univer-io');
const docStore = require('../../utils/spreadsheet-doc-store');

const importUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

// 所有路由需要 spreadsheet.manage 权限
router.use(hasPermission('spreadsheet.manage'));

// ============ 列表 ============

router.get('/spreadsheets', (req, res) => {
  const db = req.db;
  const status = ['active', 'deleted', 'all'].includes(req.query.status) ? req.query.status : 'all';
  const keyword = String(req.query.q || '').trim();

  let sql = `SELECT s.id, s.name, s.description, s.status, s.doc_version, s.is_luckysheet, s.is_locked,
    s.created_by, s.created_at, s.updated_at, u.username AS creator_name,
    LENGTH(s.doc_data) AS doc_size,
    (SELECT COUNT(*) FROM spreadsheet_versions v WHERE v.spreadsheet_id = s.id) AS version_count,
    (SELECT COUNT(*) FROM spreadsheet_comments cm WHERE cm.spreadsheet_id = s.id) AS comment_count,
    (SELECT COUNT(*) FROM spreadsheet_charts ch WHERE ch.spreadsheet_id = s.id) AS chart_count,
    (SELECT COUNT(*) FROM spreadsheet_user_permissions p WHERE p.spreadsheet_id = s.id) AS perm_count
    FROM spreadsheets s LEFT JOIN users u ON s.created_by = u.id`;
  const where = [];
  const params = [];
  if (status !== 'all') { where.push('s.status = ?'); params.push(status); }
  if (keyword) { where.push('s.name LIKE ?'); params.push('%' + keyword + '%'); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY s.updated_at DESC';

  const sheets = queryAll(db, sql, params).map(s => ({
    ...s,
    cached: docStore.docCache.has(s.id)
  }));
  res.render('admin/spreadsheets', {
    user: req.session.user,
    sheets,
    filter: { status, q: keyword },
    settings: res.locals.settings || {}
  });
});

// ============ 创建 ============

router.get('/spreadsheets/create', (req, res) => {
  res.render('admin/spreadsheet-form', {
    user: req.session.user,
    sheet: null,
    settings: res.locals.settings || {}
  });
});

router.post('/spreadsheets', (req, res) => {
  const db = req.db;
  const name = String(req.body.name || '').trim().slice(0, 100);
  if (!name) return res.status(400).json({ success: false, error: '表格名称不能为空' });
  const description = String(req.body.description || '').trim().slice(0, 500);
  const doc = createEmptyUniverDoc(name);
  const result = db.run(
    'INSERT INTO spreadsheets (name, description, created_by, doc_data, doc_version) VALUES (?, ?, ?, ?, 1)',
    [name, description, req.session.user.id, JSON.stringify(doc)]
  );
  saveDatabase(db);
  logActivity(db, {
    user_id: req.session.user.id, username: req.session.user.username,
    action: 'create', target_type: 'spreadsheet', target_id: result.lastInsertRowid,
    target_title: name, detail: '后台创建在线表格（Univer）: ' + name, ip: req.ip
  });
  res.json({ success: true, data: { id: result.lastInsertRowid }, redirect: '/admin/spreadsheets' });
});

// ============ 导入（单文件创建） ============

router.post('/spreadsheets/import', importUpload.single('file'), (req, res) => {
  const db = req.db;
  if (!req.file) return res.status(400).json({ success: false, error: '请上传 .xlsx 或 .csv 文件' });
  const docName = String(req.body.name || '').trim().slice(0, 100)
    || String(req.file.originalname || '').replace(/\.(xlsx|xls|csv)$/i, '').slice(0, 100)
    || '导入的表格';
  let imported;
  try {
    imported = importBufferToUniverDoc(req.file.buffer, req.file.originalname, docName);
  } catch (e) {
    return res.status(400).json({ success: false, error: e.message || '文件解析失败' });
  }
  const result = db.run(
    'INSERT INTO spreadsheets (name, description, created_by, doc_data, doc_version) VALUES (?, ?, ?, ?, 1)',
    [docName, String(req.body.description || '').trim().slice(0, 500), req.session.user.id, JSON.stringify(imported.workbook)]
  );
  saveDatabase(db);
  logActivity(db, {
    user_id: req.session.user.id, username: req.session.user.username,
    action: 'import', target_type: 'spreadsheet', target_id: result.lastInsertRowid,
    target_title: docName, detail: `后台导入表格：${docName}（${imported.stats.sheets} 个工作表，${imported.stats.cells} 个单元格）`, ip: req.ip
  });
  res.json({ success: true, data: { id: result.lastInsertRowid, stats: imported.stats }, redirect: '/admin/spreadsheets' });
});

// ============ 批量导入 ============

/** 统计一个 Univer 工作表的单元格数 */
function countSheetCells(sheet) {
  let cells = 0;
  const cellData = (sheet && sheet.cellData) || {};
  Object.keys(cellData).forEach(rk => { cells += Object.keys(cellData[rk]).length; });
  return cells;
}

/** 预览 Excel 文件中的 Sheet 列表（查询表内文件） */
router.post('/spreadsheets/batch-preview', importUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: '请上传 Excel 文件' });
  let imported;
  try {
    imported = importBufferToUniverDoc(req.file.buffer, req.file.originalname, '预览');
  } catch (e) {
    return res.status(400).json({ success: false, error: e.message || '文件解析失败' });
  }
  const sheets = imported.workbook.sheetOrder.map(sheetId => {
    const sheet = imported.workbook.sheets[sheetId];
    return {
      sheetId,
      name: sheet.name,
      rows: sheet.rowCount,
      columns: sheet.columnCount,
      cells: countSheetCells(sheet),
      merges: Array.isArray(sheet.mergeData) ? sheet.mergeData.length : 0
    };
  });
  res.json({ success: true, data: { filename: req.file.originalname, totalSheets: sheets.length, sheets } });
});

/** 批量导入：多 Sheet Excel 文件，每个 Sheet 创建一个新表格 */
router.post('/spreadsheets/batch-import', importUpload.single('file'), (req, res) => {
  const db = req.db;
  if (!req.file) return res.status(400).json({ success: false, error: '请上传 Excel 文件' });

  let selectedSheets = null;
  try {
    selectedSheets = req.body.selectedSheets ? JSON.parse(req.body.selectedSheets) : null;
  } catch (e) {
    return res.status(400).json({ success: false, error: 'selectedSheets 参数格式错误' });
  }

  let imported;
  try {
    imported = importBufferToUniverDoc(req.file.buffer, req.file.originalname, '批量导入');
  } catch (e) {
    return res.status(400).json({ success: false, error: e.message || '文件解析失败' });
  }

  let sheetIds = imported.workbook.sheetOrder.slice();
  if (selectedSheets && Array.isArray(selectedSheets) && selectedSheets.length > 0) {
    const nameOf = (id) => (imported.workbook.sheets[id] ? imported.workbook.sheets[id].name : id);
    sheetIds = sheetIds.filter(id => selectedSheets.includes(nameOf(id)));
  }
  if (sheetIds.length === 0) return res.status(400).json({ success: false, error: '没有选中的工作表' });

  const results = [];
  try {
    sheetIds.forEach((sheetId, idx) => {
      const sheet = imported.workbook.sheets[sheetId];
      const tableName = String(sheet.name || ('Sheet' + (idx + 1))).slice(0, 100);
      const description = '从 ' + req.file.originalname + ' 批量导入';
      // 每个工作表拆成独立 Univer 文档
      const doc = {
        id: `wb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        rev: 1,
        name: tableName,
        appVersion: imported.workbook.appVersion,
        locale: imported.workbook.locale,
        styles: imported.workbook.styles || {},
        sheetOrder: [sheetId],
        sheets: { [sheetId]: sheet },
      };
      const insertResult = db.run(
        'INSERT INTO spreadsheets (name, description, created_by, doc_data, doc_version) VALUES (?, ?, ?, ?, 1)',
        [tableName, description, req.session.user.id, JSON.stringify(doc)]
      );
      if (!insertResult.lastInsertRowid) {
        results.push({ name: tableName, success: false, error: '创建表格失败' });
        return;
      }
      results.push({
        id: insertResult.lastInsertRowid,
        name: tableName,
        success: true,
        rows: sheet.rowCount,
        columns: sheet.columnCount,
        cells: countSheetCells(sheet)
      });
    });

    saveDatabase(db);
    const okCount = results.filter(r => r.success).length;
    const totalCells = results.reduce((sum, r) => sum + (r.success ? r.cells : 0), 0);
    try {
      logActivity(db, {
        user_id: req.session.user.id, username: req.session.user.username,
        action: 'batch_import', target_type: 'spreadsheet', target_id: 0,
        target_title: '批量导入表格',
        detail: `从 ${req.file.originalname} 批量导入 ${okCount} 个表格，共 ${totalCells} 个单元格（Univer格式）`,
        ip: req.ip
      });
    } catch (logErr) {
      console.error('日志记录失败:', logErr.message);
    }
    res.json({ success: true, data: { totalSheets: sheetIds.length, importedSheets: okCount, totalCells, results } });
  } catch (err) {
    console.error('批量导入失败:', err);
    res.status(500).json({ success: false, error: '导入失败: ' + err.message });
  }
});

// ============ 批量管理 ============

/** 软删除（可恢复）：状态置为 deleted 并失效文档缓存 */
function softDeleteSheet(db, sheet) {
  db.run("UPDATE spreadsheets SET status = 'deleted', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [sheet.id]);
  docStore.evictDoc(sheet.id, true);
}

/** 硬删除：级联清理全部关联数据 */
function hardDeleteSheet(db, sheet) {
  const tables = [
    'spreadsheet_versions', 'spreadsheet_comments', 'spreadsheet_charts',
    'spreadsheet_cell_edits', 'spreadsheet_user_permissions', 'spreadsheet_permission_applications'
  ];
  tables.forEach(t => db.run(`DELETE FROM ${t} WHERE spreadsheet_id = ?`, [sheet.id]));
  db.run("DELETE FROM image_shares WHERE source_type IN ('spreadsheet', 'luckysheet') AND source_id = ?", [sheet.id]);
  db.run('DELETE FROM spreadsheets WHERE id = ?', [sheet.id]);
  docStore.evictDoc(sheet.id, true);
}

/** 清除在线会话状态（presence / 变更队列） */
function clearLiveState(sheetId) {
  docStore.presenceMap.delete(sheetId);
  docStore.changeQueues.delete(sheetId);
}

const BATCH_ACTIONS = ['soft-delete', 'hard-delete', 'restore', 'lock', 'unlock'];

/**
 * 批量管理表格
 * body: { ids: [1, 2, ...], action }
 * action：soft-delete 软删除（可恢复）/ hard-delete 彻底删除 /
 *         restore 恢复 / lock 锁定 / unlock 解锁
 */
router.post('/spreadsheets/batch', (req, res) => {
  const db = req.db;
  const ids = (Array.isArray(req.body.ids) ? req.body.ids : [])
    .map(v => parseInt(v, 10)).filter(v => v > 0);
  const action = String(req.body.action || '');

  if (!ids.length) return res.status(400).json({ success: false, error: '请先勾选要操作的表格' });
  if (ids.length > 200) return res.status(400).json({ success: false, error: '单次最多批量操作 200 个表格' });
  if (!BATCH_ACTIONS.includes(action)) return res.status(400).json({ success: false, error: '不支持的批量操作类型' });

  const placeholders = ids.map(() => '?').join(',');
  const targets = queryAll(db, `SELECT id, name FROM spreadsheets WHERE id IN (${placeholders})`, ids);
  if (!targets.length) return res.status(404).json({ success: false, error: '选中的表格均不存在' });

  const results = targets.map(t => {
    try {
      switch (action) {
        case 'soft-delete':
          softDeleteSheet(db, t);
          clearLiveState(t.id);
          break;
        case 'hard-delete':
          hardDeleteSheet(db, t);
          clearLiveState(t.id);
          break;
        case 'restore':
          db.run("UPDATE spreadsheets SET status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [t.id]);
          docStore.broadcast(t.id, 'docReload', req.session.user.id, req.session.user.username, { meta: true });
          break;
        case 'lock':
          db.run('UPDATE spreadsheets SET is_locked = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [t.id]);
          docStore.broadcast(t.id, 'docReload', req.session.user.id, req.session.user.username, { meta: true });
          break;
        case 'unlock':
          db.run('UPDATE spreadsheets SET is_locked = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [t.id]);
          docStore.broadcast(t.id, 'docReload', req.session.user.id, req.session.user.username, { meta: true });
          break;
        default:
          break;
      }
      return { id: t.id, name: t.name, success: true };
    } catch (e) {
      return { id: t.id, name: t.name, success: false, error: e.message || '操作失败' };
    }
  });

  saveDatabase(db);
  const okCount = results.filter(r => r.success).length;
  try {
    logActivity(db, {
      user_id: req.session.user.id, username: req.session.user.username,
      action: 'batch_' + action.replace('-', '_'), target_type: 'spreadsheet', target_id: 0,
      target_title: '批量管理表格（' + action + '）',
      detail: `批量操作 ${action}：${okCount}/${targets.length} 成功，IDs: ${targets.map(t => t.id).join(',').slice(0, 200)}`,
      ip: req.ip
    });
  } catch (logErr) {
    console.error('日志记录失败:', logErr.message);
  }
  res.json({
    success: okCount > 0,
    data: { action, total: targets.length, ok: okCount, failed: targets.length - okCount, results }
  });
});

// ============ 编辑元数据 ============

router.get('/spreadsheets/:id/edit', (req, res) => {
  const db = req.db;
  const sheetId = parseInt(req.params.id, 10);
  const sheet = queryOne(db,
    `SELECT s.id, s.name, s.description, s.status, s.is_locked, s.is_luckysheet, s.doc_version, s.created_at, s.updated_at, u.username AS creator_name
     FROM spreadsheets s LEFT JOIN users u ON s.created_by = u.id WHERE s.id = ?`, [sheetId]);
  if (!sheet) {
    return res.status(404).render('admin/error', { message: '表格不存在', user: req.session.user });
  }
  const stats = {
    versions: queryOne(db, 'SELECT COUNT(*) AS c FROM spreadsheet_versions WHERE spreadsheet_id = ?', [sheetId]).c,
    comments: queryOne(db, 'SELECT COUNT(*) AS c FROM spreadsheet_comments WHERE spreadsheet_id = ?', [sheetId]).c,
    charts: queryOne(db, 'SELECT COUNT(*) AS c FROM spreadsheet_charts WHERE spreadsheet_id = ?', [sheetId]).c,
    perms: queryOne(db, 'SELECT COUNT(*) AS c FROM spreadsheet_user_permissions WHERE spreadsheet_id = ?', [sheetId]).c
  };
  res.render('admin/spreadsheet-form', {
    user: req.session.user,
    sheet: { ...sheet, ...stats },
    settings: res.locals.settings || {}
  });
});

router.post('/spreadsheets/:id', (req, res) => {
  const db = req.db;
  const sheetId = parseInt(req.params.id, 10);
  const sheet = queryOne(db, 'SELECT id, name FROM spreadsheets WHERE id = ?', [sheetId]);
  if (!sheet) return res.status(404).json({ success: false, error: '表格不存在' });

  const name = String(req.body.name || '').trim().slice(0, 100);
  if (!name) return res.status(400).json({ success: false, error: '表格名称不能为空' });
  const description = String(req.body.description || '').trim().slice(0, 500);
  const status = ['active', 'deleted'].includes(req.body.status) ? req.body.status : 'active';
  const isLocked = req.body.isLocked ? 1 : 0;

  db.run(
    'UPDATE spreadsheets SET name = ?, description = ?, status = ?, is_locked = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    [name, description, status, isLocked, sheetId]
  );
  saveDatabase(db);
  // 状态或锁定变更广播，让在线编辑端感知
  docStore.broadcast(sheetId, 'docReload', req.session.user.id, req.session.user.username, { meta: true });
  logActivity(db, {
    user_id: req.session.user.id, username: req.session.user.username,
    action: 'update', target_type: 'spreadsheet', target_id: sheetId,
    target_title: name, detail: '后台更新表格设置: ' + name, ip: req.ip
  });
  res.json({ success: true, redirect: '/admin/spreadsheets' });
});

// ============ 文档结构概览 ============

router.get('/spreadsheets/:id/inspect', (req, res) => {
  const db = req.db;
  const sheetId = parseInt(req.params.id, 10);
  const sheet = queryOne(db, 'SELECT id, name, doc_version, is_luckysheet FROM spreadsheets WHERE id = ?', [sheetId]);
  if (!sheet) return res.status(404).json({ success: false, error: '表格不存在' });
  const entry = docStore.loadDoc(db, sheetId);
  const doc = entry.doc;
  const sheets = (doc.sheetOrder || []).map(sid => {
    const s = doc.sheets[sid] || {};
    return {
      id: sid,
      name: s.name,
      rowCount: s.rowCount,
      columnCount: s.columnCount,
      cells: countSheetCells(s),
      merges: Array.isArray(s.mergeData) ? s.mergeData.length : 0,
      hidden: s.hidden ? 1 : 0
    };
  });
  res.json({
    success: true,
    data: {
      id: sheetId,
      name: sheet.name,
      docVersion: entry.version,
      legacyLuckysheet: sheet.is_luckysheet === 1,
      docId: doc.id,
      sheetCount: sheets.length,
      sheets,
      docSize: JSON.stringify(doc).length,
      cached: docStore.docCache.has(sheetId),
      stats: {
        versions: queryOne(db, 'SELECT COUNT(*) AS c FROM spreadsheet_versions WHERE spreadsheet_id = ?', [sheetId]).c,
        comments: queryOne(db, 'SELECT COUNT(*) AS c FROM spreadsheet_comments WHERE spreadsheet_id = ?', [sheetId]).c,
        charts: queryOne(db, 'SELECT COUNT(*) AS c FROM spreadsheet_charts WHERE spreadsheet_id = ?', [sheetId]).c,
        edits: queryOne(db, 'SELECT COUNT(*) AS c FROM spreadsheet_cell_edits WHERE spreadsheet_id = ?', [sheetId]).c
      }
    }
  });
});

// ============ 强制迁移旧数据 ============

router.post('/spreadsheets/:id/migrate', (req, res) => {
  const db = req.db;
  const sheetId = parseInt(req.params.id, 10);
  const sheet = queryOne(db, 'SELECT id, name, doc_data, luckysheet_data, is_luckysheet FROM spreadsheets WHERE id = ?', [sheetId]);
  if (!sheet) return res.status(404).json({ success: false, error: '表格不存在' });
  if (!sheet.luckysheet_data) {
    return res.status(400).json({ success: false, error: '该表格没有旧版 Luckysheet 数据，无需迁移' });
  }
  if (sheet.doc_data) {
    return res.status(400).json({ success: false, error: '文档已是新版 Univer 格式，无需迁移' });
  }
  // 失效缓存后惰性迁移（loadDoc 内完成迁移落库 + 批注导入）
  const entry = docStore.reloadDoc(db, sheetId);
  docStore.broadcast(sheetId, 'docReload', req.session.user.id, req.session.user.username, { version: entry.version });
  logActivity(db, {
    user_id: req.session.user.id, username: req.session.user.username,
    action: 'migrate', target_type: 'spreadsheet', target_id: sheetId,
    target_title: sheet.name, detail: '后台迁移 Luckysheet → Univer: ' + sheet.name, ip: req.ip
  });
  const sheetCount = (entry.doc.sheetOrder || []).length;
  res.json({ success: true, data: { id: sheetId, sheets: sheetCount, version: entry.version } });
});

// ============ 删除 ============

router.delete('/spreadsheets/:id', (req, res) => {
  const db = req.db;
  const sheetId = parseInt(req.params.id, 10);
  const sheet = queryOne(db, 'SELECT id, name FROM spreadsheets WHERE id = ?', [sheetId]);
  if (!sheet) return res.status(404).json({ success: false, error: '表格不存在' });

  if (req.query.hard === '1' || req.body.hard === true) {
    // 硬删除：清空所有关联数据
    hardDeleteSheet(db, sheet);
    clearLiveState(sheetId);
    logActivity(db, {
      user_id: req.session.user.id, username: req.session.user.username,
      action: 'delete', target_type: 'spreadsheet', target_id: sheetId,
      target_title: sheet.name, detail: '后台彻底删除在线表格（含所有关联数据）: ' + sheet.name, ip: req.ip
    });
  } else {
    // 软删除（可恢复）
    softDeleteSheet(db, sheet);
    clearLiveState(sheetId);
    logActivity(db, {
      user_id: req.session.user.id, username: req.session.user.username,
      action: 'delete', target_type: 'spreadsheet', target_id: sheetId,
      target_title: sheet.name, detail: '后台删除在线表格（软删除）: ' + sheet.name, ip: req.ip
    });
  }
  saveDatabase(db);
  res.json({ success: true });
});

module.exports = router;
