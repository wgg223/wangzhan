/**
 * 后台在线表格管理路由（Univer 重构版）
 * 页面/接口：
 *   GET    /admin/spreadsheets                 —— 管理列表（统计 + 状态过滤 + 搜索）
 *   GET    /admin/spreadsheets/create          —— 创建表单
 *   POST   /admin/spreadsheets                 —— 创建（Univer 空文档）
 *   POST   /admin/spreadsheets/import          —— 上传 .xlsx/.csv 创建表格
 *   POST   /admin/spreadsheets/batch-preview   —— 预览 Excel 各 Sheet 结构
 *   POST   /admin/spreadsheets/batch-import    —— 批量导入（每 Sheet 一个表格）
 *   POST   /admin/spreadsheets/batch           —— 批量管理（软删/硬删/恢复/锁定/解锁/公开只读开关）
 *   GET    /admin/spreadsheets/:id/permissions  —— 权限数据（公开只读状态 + 授权列表 + 全部用户）
 *   POST   /admin/spreadsheets/:id/permissions  —— 直接授予用户权限
 *   DELETE /admin/spreadsheets/:id/permissions/:userId —— 撤销用户权限
 *   POST   /admin/spreadsheets/:id/public-read —— 公开只读开关（开启后所有登录用户可查看）
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
const { createNotification } = require('../community');
const { createEmptyUniverDoc } = require('../../utils/spreadsheet-migrate');
const { importBufferToUniverDoc } = require('../../utils/spreadsheet-univer-io');
const docStore = require('../../utils/spreadsheet-doc-store');

const importUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

// 所有路由需要 spreadsheet.manage 权限
router.use(hasPermission('spreadsheet.manage'));

// 文档级权限类型（与前台 spreadsheet.js 保持一致）
const PERM_TYPES = ['view', 'comment', 'edit', 'download', 'copy'];
const PERM_NAMES = { view: '只读查看', comment: '评论', edit: '编辑', download: '下载', copy: '创建副本' };

// ============ 列表 ============

router.get('/spreadsheets', (req, res) => {
  const db = req.db;
  const status = ['active', 'deleted', 'all'].includes(req.query.status) ? req.query.status : 'all';
  const keyword = String(req.query.q || '').trim();

  let sql = `SELECT s.id, s.name, s.description, s.status, s.doc_version, s.is_luckysheet, s.is_locked, s.is_public_read,
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

const BATCH_ACTIONS = ['soft-delete', 'hard-delete', 'restore', 'lock', 'unlock', 'public-read', 'public-read-off'];

/**
 * 批量管理表格
 * body: { ids: [1, 2, ...], action }
 * action：soft-delete 软删除（可恢复）/ hard-delete 彻底删除 /
 *         restore 恢复 / lock 锁定 / unlock 解锁 /
 *         public-read 开启公开只读 / public-read-off 关闭公开只读
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
        case 'public-read':
          db.run('UPDATE spreadsheets SET is_public_read = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [t.id]);
          docStore.broadcast(t.id, 'docReload', req.session.user.id, req.session.user.username, { meta: true, publicRead: true });
          break;
        case 'public-read-off':
          db.run('UPDATE spreadsheets SET is_public_read = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [t.id]);
          docStore.broadcast(t.id, 'docReload', req.session.user.id, req.session.user.username, { meta: true, publicRead: false });
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

// ============ 文档权限管理 ============

/** 权限弹窗数据：公开只读状态 + 已授权列表 + 全部可选用户（下拉展示用） */
router.get('/spreadsheets/:id/permissions', (req, res) => {
  const db = req.db;
  const sheetId = parseInt(req.params.id, 10);
  const sheet = queryOne(db, 'SELECT id, name, is_public_read, created_by FROM spreadsheets WHERE id = ?', [sheetId]);
  if (!sheet) return res.status(404).json({ success: false, error: '表格不存在' });
  const permissions = queryAll(db, `
    SELECT p.id, p.user_id, p.perm_type, p.created_at, u.username, u.email, u.nickname
    FROM spreadsheet_user_permissions p
    LEFT JOIN users u ON p.user_id = u.id
    WHERE p.spreadsheet_id = ?
    ORDER BY p.created_at DESC
  `, [sheetId]);
  const users = queryAll(db,
    "SELECT id, username, nickname, avatar, email FROM users WHERE status = 'active' ORDER BY username ASC LIMIT 500");
  res.json({
    success: true,
    data: { id: sheetId, name: sheet.name, isPublicRead: sheet.is_public_read === 1, createdBy: sheet.created_by, permissions, users }
  });
});

/** 直接授予用户权限（后台绕过申请流程，与前台 grant 逻辑一致） */
router.post('/spreadsheets/:id/permissions', (req, res) => {
  const db = req.db;
  const sheetId = parseInt(req.params.id, 10);
  const sheet = queryOne(db, 'SELECT id, name, created_by FROM spreadsheets WHERE id = ?', [sheetId]);
  if (!sheet) return res.status(404).json({ success: false, error: '表格不存在' });
  const { user_id, perm_type } = req.body || {};
  if (!PERM_TYPES.includes(perm_type)) return res.status(400).json({ success: false, error: '无效的权限类型' });

  const target = queryOne(db, 'SELECT id, username, status FROM users WHERE id = ?', [parseInt(user_id, 10)]);
  if (!target) return res.status(404).json({ success: false, error: '用户不存在' });
  if (target.status !== 'active') return res.status(400).json({ success: false, error: '该用户已被禁用或注销' });
  if (target.id === sheet.created_by) return res.status(400).json({ success: false, error: '该用户是文档创建者，无需授权' });

  db.run('INSERT OR IGNORE INTO spreadsheet_user_permissions (spreadsheet_id, user_id, perm_type, granted_by) VALUES (?, ?, ?, ?)',
    [sheetId, target.id, perm_type, req.session.user.id]);
  // 该用户如有同类待审批申请，自动置为已通过
  db.run("UPDATE spreadsheet_permission_applications SET status = 'approved', handled_by = ?, handled_at = CURRENT_TIMESTAMP WHERE spreadsheet_id = ? AND user_id = ? AND perm_type = ? AND status = 'pending'",
    [req.session.user.id, sheetId, target.id, perm_type]);
  saveDatabase(db);
  logActivity(db, {
    user_id: req.session.user.id, username: req.session.user.username,
    action: 'perm_grant', target_type: 'spreadsheet', target_id: sheetId,
    target_title: sheet.name,
    detail: `后台直接授予 ${target.username} ${PERM_NAMES[perm_type]}权限`,
    ip: req.ip
  });
  createNotification(db, {
    userId: target.id, type: 'permission_result',
    title: '权限已授予',
    content: `您获得了表格「${sheet.name}」的${PERM_NAMES[perm_type]}权限`,
    fromUserId: req.session.user.id, targetType: 'spreadsheet', targetId: String(sheetId)
  });
  res.json({ success: true, message: `已授予 ${target.username} ${PERM_NAMES[perm_type]}权限` });
});

/** 撤销用户权限（perm_type 可选：缺省撤销该用户全部权限） */
router.delete('/spreadsheets/:id/permissions/:userId', (req, res) => {
  const db = req.db;
  const sheetId = parseInt(req.params.id, 10);
  const userId = parseInt(req.params.userId, 10);
  const sheet = queryOne(db, 'SELECT id, name FROM spreadsheets WHERE id = ?', [sheetId]);
  if (!sheet) return res.status(404).json({ success: false, error: '表格不存在' });
  const { perm_type } = req.body || {};
  if (perm_type && !PERM_TYPES.includes(perm_type)) return res.status(400).json({ success: false, error: '无效的权限类型' });

  if (perm_type) {
    db.run('DELETE FROM spreadsheet_user_permissions WHERE spreadsheet_id = ? AND user_id = ? AND perm_type = ?', [sheetId, userId, perm_type]);
  } else {
    db.run('DELETE FROM spreadsheet_user_permissions WHERE spreadsheet_id = ? AND user_id = ?', [sheetId, userId]);
  }
  saveDatabase(db);
  const target = queryOne(db, 'SELECT username FROM users WHERE id = ?', [userId]);
  logActivity(db, {
    user_id: req.session.user.id, username: req.session.user.username,
    action: 'perm_revoke', target_type: 'spreadsheet', target_id: sheetId,
    target_title: sheet.name,
    detail: `后台撤销 ${(target && target.username) || ('用户#' + userId)} 的${perm_type ? PERM_NAMES[perm_type] : '全部'}权限`,
    ip: req.ip
  });
  res.json({ success: true, message: '权限已撤销' });
});

/** 公开只读开关：开启后所有登录用户至少拥有只读查看权限 */
router.post('/spreadsheets/:id/public-read', (req, res) => {
  const db = req.db;
  const sheetId = parseInt(req.params.id, 10);
  const sheet = queryOne(db, 'SELECT id, name FROM spreadsheets WHERE id = ?', [sheetId]);
  if (!sheet) return res.status(404).json({ success: false, error: '表格不存在' });
  const enabled = req.body.enabled ? 1 : 0;
  db.run('UPDATE spreadsheets SET is_public_read = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [enabled, sheetId]);
  saveDatabase(db);
  docStore.broadcast(sheetId, 'docReload', req.session.user.id, req.session.user.username, { meta: true, publicRead: enabled === 1 });
  logActivity(db, {
    user_id: req.session.user.id, username: req.session.user.username,
    action: 'perm_public', target_type: 'spreadsheet', target_id: sheetId,
    target_title: sheet.name,
    detail: enabled ? '后台开启公开只读：所有登录用户可查看' : '后台关闭公开只读：恢复私有模型（仅授权用户可访问）',
    ip: req.ip
  });
  res.json({ success: true, data: { enabled: enabled === 1 } });
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
