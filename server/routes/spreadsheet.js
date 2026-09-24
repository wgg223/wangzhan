/**
 * 在线表格前台路由（Univer 重构版）
 *
 * 页面：
 *   GET  /spreadsheet          —— 表格列表页（需 spreadsheet.access）
 *   GET  /spreadsheet/:id      —— 编辑器页（读/编辑由文档级权限决定）
 *
 * 文档 CRUD：
 *   POST   /api/spreadsheet                     新建空白表格（需编辑能力）
 *   GET    /api/spreadsheet/:id/doc             获取 Univer 文档（惰性迁移 Luckysheet 旧数据）
 *   PUT    /api/spreadsheet/:id/doc             全量保存（乐观锁 baseVersion + 自动版本快照）
 *   PUT    /api/spreadsheet/:id/meta            更新名称/描述
 *   POST   /api/spreadsheet/:id/duplicate       复制表格
 *   DELETE /api/spreadsheet/:id                 删除（软删）
 *
 * 导入导出：
 *   POST   /api/spreadsheet/import              上传 .xlsx/.csv 创建新表格
 *   GET    /api/spreadsheet/:id/export          导出下载（xlsx/csv）
 *
 * 版本历史：
 *   GET  /api/spreadsheet/:id/versions                    版本列表
 *   POST /api/spreadsheet/:id/versions                    手动快照
 *   GET  /api/spreadsheet/:id/versions/:version           获取某版本文档
 *   POST /api/spreadsheet/:id/versions/:version/restore   恢复到某版本
 *
 * 批注（含 @提及 / 回复 / 任务指派 / 解决）：
 *   GET    /api/spreadsheet/:id/comments
 *   POST   /api/spreadsheet/:id/comments
 *   PUT    /api/spreadsheet/:id/comments/:commentId
 *   DELETE /api/spreadsheet/:id/comments/:commentId
 *   GET    /api/spreadsheet/my-tasks              我被指派的任务
 *
 * 图表（自建 ECharts 层）：
 *   GET/POST /api/spreadsheet/:id/charts, PUT/DELETE /api/spreadsheet/:id/charts/:chartId
 *
 * 实时协同（HTTP 轮询 + 内存增量队列）：
 *   POST /api/spreadsheet/:id/presence           上报光标/选区/编辑状态
 *   GET  /api/spreadsheet/:id/presence           获取在线用户
 *   POST /api/spreadsheet/:id/changes            提交单元格值变更批次（实时广播）
 *   GET  /api/spreadsheet/:id/changes?since=     拉取增量变更
 *
 * 权限管理（沿用旧表 + comment 类型）：
 *   GET/POST /api/spreadsheet/:id/permission/*  管理员审批、用户申请
 *
 * 锁定：GET/POST /api/spreadsheet/:id/lock
 *
 * 分享链接（image_shares 通用表，公开页在 /share/:token）：
 *   GET    /api/spreadsheet/:id/share    查询分享状态
 *   POST   /api/spreadsheet/:id/share    创建/启用分享（embed 嵌入页 /share/:token/embed）
 *   DELETE /api/spreadsheet/:id/share    取消分享
 *
 * AI 智能：
 *   POST /api/spreadsheet/:id/ai/formula         自然语言生成公式
 *   POST /api/spreadsheet/:id/ai/generate        AI 生成表格内容与结构
 *   POST /api/spreadsheet/:id/ai/analyze         AI 数据清洗/分析/总结
 *   POST /api/spreadsheet/:id/ai/chart           智能图表推荐
 */
'use strict';
const express = require('express');
const router = express.Router();
const multer = require('multer');
const crypto = require('crypto');
const { isAuthenticated, hasFrontendPermission } = require('../middlewares/auth');
const { queryAll, queryOne, saveDatabase } = require('../config/database');
const { logActivity } = require('../config/activity');
const { createNotification } = require('./community');
const { resolveModel, callChatCompletion } = require('../services/ai-chat/provider');
const { createEmptyUniverDoc } = require('../utils/spreadsheet-migrate');
const { importBufferToUniverDoc, exportUniverDoc } = require('../utils/spreadsheet-univer-io');
const docStore = require('../utils/spreadsheet-doc-store');
const { getClientIp } = require('../utils/client-ip');
const {
  PRESENCE_TTL_MS, CHANGE_TTL_MS, KEEP_VERSIONS,
  loadDoc, persistDocEntry, schedulePersist, writeSnapshot, shouldAutoSnapshot, broadcast, evictDoc,
  docCache, presenceMap, changeQueues
} = docStore;

const MAX_DOC_SIZE = 50 * 1024 * 1024; // 文档 JSON 上限
const MAX_CELLS_PER_BATCH = 500; // 单次变更批次单元格上限
const MAX_CELL_JSON = 4 * 1024; // 单格数据上限

// ============ 权限辅助 ============

// 文档级权限等级：manage > edit > comment/download/copy > view
const PERM_LEVEL = { view: 1, comment: 2, download: 2, copy: 2, edit: 3, manage: 4 };
const PERM_TYPES = ['view', 'comment', 'edit', 'download', 'copy'];
const PERM_NAMES = { view: '查看', comment: '评论', edit: '编辑', download: '下载', copy: '创建副本' };

// 全局管理权限（管理员或 spreadsheet.manage 权限持有者）
function canManageSpreadsheet(req) {
  if (!req.session || !req.session.user) return false;
  if (req.session.user.role === 'super_admin' || req.session.user.role === 'admin') return true;
  const db = req.db;
  if (!db) return false;
  const userPerms = queryAll(db, 'SELECT perm_key FROM user_permissions WHERE user_id = ?', [req.session.user.id]);
  const keys = userPerms.map(p => p.perm_key);
  return keys.includes('spreadsheet.manage') || keys.includes('spreadsheet.*');
}

/**
 * 获取用户对某文档的权限等级（0 无权限；1 查看；2 评论；3 编辑；4 管理）
 * - 管理员 / spreadsheet.manage 持有者 / 创建者 = 4
 * - 文档级授权取最高值；默认 0（私有模型：无授权即不可访问，需经申请/授权获得查看权限）
 * - 公开只读（is_public_read=1）：所有登录用户至少拥有等级 1（只读查看，不可编辑）
 */
function getDocPermLevel(req, sheetId, sheetRow) {
  const user = req.session && req.session.user;
  if (!user) return 0;
  if (canManageSpreadsheet(req)) return 4;
  const db = req.db;
  if (!db) return 0;
  const row = sheetRow || queryOne(db, 'SELECT id, created_by, is_public_read FROM spreadsheets WHERE id = ?', [sheetId]);
  if (!row) return 0;
  if (row.created_by === user.id) return 4; // 创建者可管理自己的文档
  const perms = queryAll(db, 'SELECT perm_type FROM spreadsheet_user_permissions WHERE spreadsheet_id = ? AND user_id = ?', [sheetId, user.id]);
  let level = 0;
  perms.forEach(p => { level = Math.max(level, PERM_LEVEL[p.perm_type] || 0); });
  if (level < 1 && row.is_public_read === 1) level = 1; // 公开只读兜底
  return level;
}

function requireDocPerm(level) {
  return (req, res, next) => {
    const sheetId = parseInt(req.params.id, 10);
    if (!sheetId) return res.status(400).json({ success: false, error: '表格ID无效' });
    const sheet = queryOne(req.db, 'SELECT * FROM spreadsheets WHERE id = ? AND status = ?', [sheetId, 'active']);
    if (!sheet) return res.status(404).json({ success: false, error: '表格不存在' });
    const lvl = getDocPermLevel(req, sheetId, sheet);
    if (lvl < level) {
      // 审计：记录被拒绝的访问尝试
      const denyUser = req.session && req.session.user;
      logActivity(req.db, {
        user_id: denyUser ? denyUser.id : null, username: denyUser ? denyUser.username : '',
        action: 'access_denied', target_type: 'spreadsheet', target_id: sheetId,
        target_title: sheet.name,
        detail: `访问被拒绝：需要权限等级 ${level}，实际 ${lvl}`, ip: getClientIp(req)
      });
      return res.status(403).json({ success: false, error: '您没有执行此操作的权限' });
    }
    req.spreadsheet = sheet;
    req.docPermLevel = lvl;
    next();
  };
}

/** 轻量加载：仅校验表格存在（active），不做权限拦截（供无权限用户也需触达的路由：申请权限/查询状态） */
function loadSheetForRequest(req, res, next) {
  const sheetId = parseInt(req.params.id, 10);
  if (!sheetId) return res.status(400).json({ success: false, error: '表格ID无效' });
  const sheet = queryOne(req.db, 'SELECT * FROM spreadsheets WHERE id = ? AND status = ?', [sheetId, 'active']);
  if (!sheet) return res.status(404).json({ success: false, error: '表格不存在' });
  req.spreadsheet = sheet;
  req.docPermLevel = getDocPermLevel(req, sheetId, sheet);
  next();
}

// ============ 文档内存缓存 / 落库 / 快照 / 广播 / 定时清理 ============
// 全部位于共享模块 server/utils/spreadsheet-doc-store.js（前台 + 后台共用，保证缓存一致）

// ============ 文档结构校验 ============

function validateUniverDoc(doc) {
  if (!doc || typeof doc !== 'object') return '文档必须是对象';
  if (!doc.sheets || typeof doc.sheets !== 'object') return '缺少 sheets';
  if (!Array.isArray(doc.sheetOrder) || doc.sheetOrder.length === 0) return '缺少 sheetOrder';
  if (doc.sheetOrder.length > 100) return '工作表数量超过上限（100）';
  for (const sid of doc.sheetOrder) {
    const sheet = doc.sheets[sid];
    if (!sheet || typeof sheet !== 'object') return `工作表 ${sid} 缺失`;
    if (!sheet.cellData || typeof sheet.cellData !== 'object') return `工作表 ${sid} 缺少 cellData`;
  }
  return null;
}

// ============ 页面路由 ============

// 表格列表页
router.get('/spreadsheet', isAuthenticated, hasFrontendPermission('spreadsheet.access'), (req, res) => {
  const db = req.db;
  const sheets = queryAll(db,
    "SELECT s.id, s.name, s.description, s.created_by, s.status, s.doc_version, s.updated_at, s.created_at, s.is_public_read, u.username AS creator_name FROM spreadsheets s LEFT JOIN users u ON s.created_by = u.id WHERE s.status = 'active' ORDER BY s.updated_at DESC"
  );
  const rows = sheets.map(s => ({ ...s, permLevel: getDocPermLevel(req, s.id, s) }));
  res.render('frontend/spreadsheets', {
    user: req.session.user,
    sheets: rows,
    canManage: canManageSpreadsheet(req),
    settings: res.locals.settings || {}
  });
});

// 在线表格编辑器页（独立布局）
router.get('/spreadsheet/:id(\\d+)', isAuthenticated, hasFrontendPermission('spreadsheet.access'), (req, res) => {
  const db = req.db;
  const sheetId = parseInt(req.params.id, 10);
  const sheet = queryOne(db, 'SELECT id, name, description, is_locked, is_public_read, doc_version, updated_at, created_by FROM spreadsheets WHERE id = ? AND status = ?', [sheetId, 'active']);
  if (!sheet) {
    return res.status(404).render('frontend/error', { message: '页面未找到', error: '表格不存在或已被删除', user: req.session.user, settings: res.locals.settings || {} });
  }
  const permLevel = getDocPermLevel(req, sheetId, sheet);
  // 私有模型：无查看权限 → 渲染无权限页（提供只读权限申请入口）
  if (permLevel < 1) {
    const pendingApp = queryOne(db,
      'SELECT perm_type, status, reason, created_at FROM spreadsheet_permission_applications WHERE spreadsheet_id = ? AND user_id = ? AND status = ? ORDER BY id DESC LIMIT 1',
      [sheetId, req.session.user.id, 'pending']);
    const owner = queryOne(db, 'SELECT nickname, username FROM users WHERE id = ?', [sheet.created_by]);
    logActivity(db, {
      user_id: req.session.user.id, username: req.session.user.username,
      action: 'access_denied', target_type: 'spreadsheet', target_id: sheetId,
      target_title: sheet.name,
      detail: '无访问权限用户尝试打开表格（已引导至申请页）', ip: getClientIp(req)
    });
    return res.render('frontend/spreadsheet-noaccess', {
      user: req.session.user,
      sheet,
      ownerName: (owner && (owner.nickname || owner.username)) || '未知',
      pendingApp,
      settings: res.locals.settings || {}
    });
  }
  res.render('frontend/spreadsheet-editor', {
    layout: false,
    user: req.session.user,
    sheet,
    permLevel,
    canManage: permLevel >= 4,
    canEdit: permLevel >= 3,
    clientIp: getClientIp(req),
    settings: res.locals.settings || {}
  });
});

// ============ 文档 CRUD ============

// 新建空白表格
router.post('/api/spreadsheet', isAuthenticated, hasFrontendPermission('spreadsheet.access'), (req, res) => {
  const db = req.db;
  if (!canManageSpreadsheet(req)) {
    return res.status(403).json({ success: false, error: '您没有创建表格的权限' });
  }
  const name = String(req.body.name || '').trim().slice(0, 100) || '未命名表格';
  const description = String(req.body.description || '').trim().slice(0, 500);
  const doc = createEmptyUniverDoc(name);
  const result = db.run(
    'INSERT INTO spreadsheets (name, description, created_by, doc_data, doc_version) VALUES (?, ?, ?, ?, 1)',
    [name, description, req.session.user.id, JSON.stringify(doc)]
  );
  saveDatabase(db);
  logActivity(db, {
    user_id: req.session.user.id,
    username: req.session.user.username,
    action: 'create',
    target_type: 'spreadsheet',
    target_id: result.lastInsertRowid,
    target_title: name,
    detail: '新建在线表格',
    ip: getClientIp(req)
  });
  res.json({ success: true, data: { id: result.lastInsertRowid } });
});

// 获取 Univer 文档（惰性迁移）
router.get('/api/spreadsheet/:id(\\d+)/doc', isAuthenticated, hasFrontendPermission('spreadsheet.access'), requireDocPerm(1), (req, res) => {
  const entry = loadDoc(req.db, req.spreadsheet.id);
  res.json({
    success: true,
    data: { doc: entry.doc, version: entry.version, locked: req.spreadsheet.is_locked === 1 }
  });
});

// 全量保存（乐观锁 + 自动版本快照 + 广播 docReload）
router.put('/api/spreadsheet/:id(\\d+)/doc', isAuthenticated, hasFrontendPermission('spreadsheet.access'), requireDocPerm(3), (req, res) => {
  const db = req.db;
  const sheetId = req.spreadsheet.id;
  if (req.spreadsheet.is_locked === 1) {
    return res.status(403).json({ success: false, error: '表格已锁定，无法保存' });
  }
  const doc = req.body.doc;
  const err = validateUniverDoc(doc);
  if (err) return res.status(400).json({ success: false, error: '文档数据无效：' + err });

  let json;
  try { json = JSON.stringify(doc); } catch (e) { return res.status(400).json({ success: false, error: '文档序列化失败' }); }
  if (json.length > MAX_DOC_SIZE) {
    return res.status(400).json({ success: false, error: '数据过大，超过50MB限制' });
  }

  const entry = loadDoc(db, sheetId);
  // 乐观锁：服务器版本超前则拒绝，让客户端拉最新文档合并
  const baseVersion = parseInt(req.body.baseVersion, 10);
  if (!isNaN(baseVersion) && entry.version > baseVersion) {
    return res.status(409).json({ success: false, error: '文档已被他人更新，请刷新同步', serverVersion: entry.version });
  }

  const structural = Boolean(req.body.structural);
  entry.doc = doc;
  entry.version += 1;
  entry.dirty = false;
  persistDocEntry(db, sheetId, entry);
  if (shouldAutoSnapshot(entry, structural || req.body.snapshot === true)) {
    writeSnapshot(db, sheetId, entry, req.body.changeDesc || (structural ? '结构性变更' : '自动保存'), req.session.user.id, req.session.user.username);
  }
  saveDatabase(db);
  broadcast(sheetId, 'docReload', req.session.user.id, req.session.user.username, { version: entry.version });
  res.json({ success: true, data: { version: entry.version } });
});

// 更新元数据（名称/描述）
router.put('/api/spreadsheet/:id(\\d+)/meta', isAuthenticated, hasFrontendPermission('spreadsheet.access'), requireDocPerm(4), (req, res) => {
  const db = req.db;
  const sheetId = req.spreadsheet.id;
  const updates = [];
  const params = [];
  const name = req.body.name;
  const description = req.body.description;
  if (name !== undefined) {
    const n = String(name).trim().slice(0, 100);
    if (!n) return res.status(400).json({ success: false, error: '名称不能为空' });
    updates.push('name = ?'); params.push(n);
  }
  if (description !== undefined) {
    updates.push('description = ?'); params.push(String(description).trim().slice(0, 500));
  }
  if (!updates.length) return res.status(400).json({ success: false, error: '没有要更新的字段' });
  updates.push('updated_at = CURRENT_TIMESTAMP');
  params.push(sheetId);
  db.run('UPDATE spreadsheets SET ' + updates.join(', ') + ' WHERE id = ?', params);
  saveDatabase(db);
  logActivity(db, {
    user_id: req.session.user.id, username: req.session.user.username,
    action: 'update', target_type: 'spreadsheet', target_id: sheetId,
    target_title: req.spreadsheet.name, detail: '更新表格信息', ip: getClientIp(req)
  });
  res.json({ success: true });
});

// 复制表格
router.post('/api/spreadsheet/:id(\\d+)/duplicate', isAuthenticated, hasFrontendPermission('spreadsheet.access'), requireDocPerm(2), (req, res) => {
  const db = req.db;
  const sheetId = req.spreadsheet.id;
  const newName = String(req.body.name || (req.spreadsheet.name + ' (副本)')).trim().slice(0, 100) || '未命名表格';
  const entry = loadDoc(db, sheetId);
  const docCopy = JSON.parse(JSON.stringify(entry.doc));
  docCopy.id = `wb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  docCopy.name = newName;
  const result = db.run(
    'INSERT INTO spreadsheets (name, description, created_by, doc_data, doc_version) VALUES (?, ?, ?, ?, 1)',
    [newName, req.spreadsheet.description || '', req.session.user.id, JSON.stringify(docCopy)]
  );
  // 图表一并复制
  db.run(
    'INSERT INTO spreadsheet_charts (spreadsheet_id, sheet_id, name, chart_type, config, anchor, created_by) SELECT ?, sheet_id, name, chart_type, config, anchor, ? FROM spreadsheet_charts WHERE spreadsheet_id = ?',
    [result.lastInsertRowid, req.session.user.id, sheetId]
  );
  saveDatabase(db);
  logActivity(db, {
    user_id: req.session.user.id, username: req.session.user.username,
    action: 'create', target_type: 'spreadsheet', target_id: result.lastInsertRowid,
    target_title: newName, detail: `复制自表格 #${sheetId}`, ip: getClientIp(req)
  });
  res.json({ success: true, data: { id: result.lastInsertRowid } });
});

// 删除（软删）
router.delete('/api/spreadsheet/:id(\\d+)', isAuthenticated, hasFrontendPermission('spreadsheet.access'), requireDocPerm(4), (req, res) => {
  const db = req.db;
  const sheetId = req.spreadsheet.id;
  db.run("UPDATE spreadsheets SET status = 'deleted', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [sheetId]);
  evictDoc(sheetId, true);
  presenceMap.delete(sheetId);
  changeQueues.delete(sheetId);
  saveDatabase(db);
  logActivity(db, {
    user_id: req.session.user.id, username: req.session.user.username,
    action: 'delete', target_type: 'spreadsheet', target_id: sheetId,
    target_title: req.spreadsheet.name, detail: '删除在线表格', ip: getClientIp(req)
  });
  res.json({ success: true });
});

// ============ 导入导出 ============

const importUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// 上传 .xlsx/.csv 创建新表格
router.post('/api/spreadsheet/import', isAuthenticated, hasFrontendPermission('spreadsheet.access'), importUpload.single('file'), (req, res) => {
  const db = req.db;
  if (!canManageSpreadsheet(req)) {
    return res.status(403).json({ success: false, error: '您没有创建表格的权限' });
  }
  if (!req.file) return res.status(400).json({ success: false, error: '请上传 .xlsx 或 .csv 文件' });
  const docName = String(req.body.name || '').trim().slice(0, 100)
    || String(req.file.originalname || '').replace(/\.(xlsx|csv)$/i, '').slice(0, 100)
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
    target_title: docName,
    detail: `导入 ${req.file.originalname}（${imported.stats.sheets} 个工作表，${imported.stats.cells} 个单元格）`,
    ip: getClientIp(req)
  });
  res.json({ success: true, data: { id: result.lastInsertRowid, stats: imported.stats } });
});

// 导出下载
router.get('/api/spreadsheet/:id(\\d+)/export', isAuthenticated, hasFrontendPermission('spreadsheet.access'), requireDocPerm(1), (req, res) => {
  const db = req.db;
  const sheetId = req.spreadsheet.id;
  const format = req.query.format === 'csv' ? 'csv' : 'xlsx';
  // 下载能力：编辑权限或显式 download/copy 授权（permLevel>=2 覆盖 download/copy）
  if (req.docPermLevel < 2) {
    return res.status(403).json({ success: false, error: '您没有导出此表格的权限' });
  }
  const entry = loadDoc(db, sheetId);
  let out;
  try {
    out = exportUniverDoc(entry.doc, format, { sheetId: req.query.sheetId });
  } catch (e) {
    return res.status(400).json({ success: false, error: e.message || '导出失败' });
  }
  const safeName = String(req.spreadsheet.name || '表格').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) || '表格';
  res.setHeader('Content-Type', out.mime);
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(safeName + '.' + out.ext)}`);
  res.send(out.buffer);
});

// ============ 版本历史 ============

// 版本列表（不含 doc_data）
router.get('/api/spreadsheet/:id(\\d+)/versions', isAuthenticated, hasFrontendPermission('spreadsheet.access'), requireDocPerm(1), (req, res) => {
  const versions = queryAll(req.db,
    `SELECT id, version, change_desc, sheet_count, size_bytes, user_id, username, created_at
     FROM spreadsheet_versions WHERE spreadsheet_id = ? ORDER BY version DESC LIMIT ${KEEP_VERSIONS}`,
    [req.spreadsheet.id]
  );
  res.json({ success: true, data: { versions, currentVersion: req.spreadsheet.doc_version || 0 } });
});

// 手动快照
router.post('/api/spreadsheet/:id(\\d+)/versions', isAuthenticated, hasFrontendPermission('spreadsheet.access'), requireDocPerm(3), (req, res) => {
  const db = req.db;
  const sheetId = req.spreadsheet.id;
  const entry = loadDoc(db, sheetId);
  const version = writeSnapshot(db, sheetId, entry, req.body.changeDesc || '手动保存版本', req.session.user.id, req.session.user.username);
  saveDatabase(db);
  logActivity(db, {
    user_id: req.session.user.id, username: req.session.user.username,
    action: 'create', target_type: 'spreadsheet_version', target_id: sheetId,
    target_title: req.spreadsheet.name, detail: `创建版本 v${version}`, ip: getClientIp(req)
  });
  res.json({ success: true, data: { version } });
});

// 获取某版本文档
router.get('/api/spreadsheet/:id(\\d+)/versions/:version(\\d+)', isAuthenticated, hasFrontendPermission('spreadsheet.access'), requireDocPerm(1), (req, res) => {
  const v = queryOne(req.db, 'SELECT version, doc_data, change_desc, sheet_count, user_id, username, created_at FROM spreadsheet_versions WHERE spreadsheet_id = ? AND version = ?', [req.spreadsheet.id, parseInt(req.params.version, 10)]);
  if (!v || !v.doc_data) return res.status(404).json({ success: false, error: '版本不存在' });
  res.json({
    success: true,
    data: {
      version: v.version,
      doc: JSON.parse(v.doc_data),
      changeDesc: v.change_desc,
      username: v.username,
      createdAt: v.created_at
    }
  });
});

// 恢复到某版本
router.post('/api/spreadsheet/:id(\\d+)/versions/:version(\\d+)/restore', isAuthenticated, hasFrontendPermission('spreadsheet.access'), requireDocPerm(3), (req, res) => {
  const db = req.db;
  const sheetId = req.spreadsheet.id;
  if (req.spreadsheet.is_locked === 1) {
    return res.status(403).json({ success: false, error: '表格已锁定，无法恢复' });
  }
  const v = queryOne(db, 'SELECT version, doc_data FROM spreadsheet_versions WHERE spreadsheet_id = ? AND version = ?', [sheetId, parseInt(req.params.version, 10)]);
  if (!v || !v.doc_data) return res.status(404).json({ success: false, error: '版本不存在' });
  try {
    const doc = JSON.parse(v.doc_data);
    const entry = loadDoc(db, sheetId);
    entry.doc = doc;
    entry.version += 1;
    entry.dirty = false;
    persistDocEntry(db, sheetId, entry);
    writeSnapshot(db, sheetId, entry, `恢复到 v${v.version}`, req.session.user.id, req.session.user.username);
    saveDatabase(db);
    broadcast(sheetId, 'docReload', req.session.user.id, req.session.user.username, { version: entry.version });
    logActivity(db, {
      user_id: req.session.user.id, username: req.session.user.username,
      action: 'update', target_type: 'spreadsheet', target_id: sheetId,
      target_title: req.spreadsheet.name, detail: `恢复到版本 v${v.version}`, ip: getClientIp(req)
    });
    res.json({ success: true, data: { version: entry.version } });
  } catch (e) {
    return res.status(500).json({ success: false, error: '版本数据损坏，无法恢复' });
  }
});

// ============ 批注（评论 / @提及 / 任务指派） ============

// 批注列表（含回复，前端按 parent_id 分组）
router.get('/api/spreadsheet/:id(\\d+)/comments', isAuthenticated, hasFrontendPermission('spreadsheet.access'), requireDocPerm(1), (req, res) => {
  const comments = queryAll(req.db,
    `SELECT c.*, u.username AS author_name, a.username AS assignee_name
     FROM spreadsheet_comments c
     LEFT JOIN users u ON c.user_id = u.id
     LEFT JOIN users a ON c.assigned_to = a.id
     WHERE c.spreadsheet_id = ?
     ORDER BY c.id DESC LIMIT 500`,
    [req.spreadsheet.id]
  );
  const rows = comments.map(c => ({
    id: c.id, sheetId: c.sheet_id, row: c.row, col: c.col, parentId: c.parent_id,
    userId: c.user_id, username: c.author_name || c.username, content: c.content,
    mentions: safeParseJson(c.mentions, []), assignedTo: c.assigned_to, assigneeName: c.assignee_name,
    taskStatus: c.task_status, resolved: c.resolved === 1,
    createdAt: c.created_at, updatedAt: c.updated_at
  }));
  res.json({ success: true, data: { comments: rows } });
});

function safeParseJson(text, fallback) {
  try { return JSON.parse(text); } catch (e) { return fallback; }
}

// 添加批注 / 回复（可 @提及、指派任务）
router.post('/api/spreadsheet/:id(\\d+)/comments', isAuthenticated, hasFrontendPermission('spreadsheet.access'), requireDocPerm(2), (req, res) => {
  const db = req.db;
  const sheetId = req.spreadsheet.id;
  const content = String(req.body.content || '').trim();
  if (!content) return res.status(400).json({ success: false, error: '评论内容不能为空' });
  if (content.length > 2000) return res.status(400).json({ success: false, error: '评论内容不能超过2000字符' });

  const univerSheetId = String(req.body.sheetId || '').slice(0, 50);
  const row = parseInt(req.body.row, 10);
  const col = parseInt(req.body.col, 10);
  const parentId = req.body.parentId ? parseInt(req.body.parentId, 10) : null;
  if (isNaN(row) || isNaN(col) || row < 0 || col < 0) {
    return res.status(400).json({ success: false, error: '单元格坐标无效' });
  }
  if (parentId) {
    const parent = queryOne(db, 'SELECT id FROM spreadsheet_comments WHERE id = ? AND spreadsheet_id = ?', [parentId, sheetId]);
    if (!parent) return res.status(404).json({ success: false, error: '被回复的评论不存在' });
  }

  // @提及：前端传 userId 数组（已校验存在），后端再核对一次
  let mentions = [];
  if (Array.isArray(req.body.mentions)) {
    mentions = req.body.mentions.map(Number).filter(n => !isNaN(n) && queryOne(db, 'SELECT id FROM users WHERE id = ?', [n]));
  }
  // 任务指派
  let assignedTo = null;
  if (req.body.assignedTo) {
    const uid = parseInt(req.body.assignedTo, 10);
    if (isNaN(uid) || !queryOne(db, 'SELECT id FROM users WHERE id = ?', [uid])) {
      return res.status(400).json({ success: false, error: '被指派用户不存在' });
    }
    assignedTo = uid;
  }

  const result = db.run(
    'INSERT INTO spreadsheet_comments (spreadsheet_id, sheet_id, row, col, parent_id, user_id, username, content, mentions, assigned_to, task_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [sheetId, univerSheetId, row, col, parentId, req.session.user.id, req.session.user.username, content,
      JSON.stringify(mentions), assignedTo, assignedTo ? 'open' : 'none']
  );
  saveDatabase(db);

  // 通知被提及用户与被指派人
  const notifyIds = new Set(mentions);
  if (assignedTo) notifyIds.add(assignedTo);
  notifyIds.delete(req.session.user.id);
  notifyIds.forEach(uid => {
    createNotification(db, {
      userId: uid,
      type: 'spreadsheet_comment',
      title: assignedTo === uid ? '表格任务指派' : '表格评论提及',
      content: `${req.session.user.username} 在表格「${req.spreadsheet.name}」中${assignedTo === uid ? '指派任务给您' : '@提及您'}：${content.slice(0, 100)}`,
      fromUserId: req.session.user.id,
      targetType: 'spreadsheet',
      targetId: String(sheetId)
    });
  });

  broadcast(sheetId, 'comments', req.session.user.id, req.session.user.username, { commentId: result.lastInsertRowid });
  res.json({ success: true, data: { id: result.lastInsertRowid } });
});

// 更新批注（内容 / 解决状态 / 任务状态 / 指派人）
router.put('/api/spreadsheet/:id(\\d+)/comments/:commentId(\\d+)', isAuthenticated, hasFrontendPermission('spreadsheet.access'), requireDocPerm(1), (req, res) => {
  const db = req.db;
  const comment = queryOne(db, 'SELECT * FROM spreadsheet_comments WHERE id = ? AND spreadsheet_id = ?', [parseInt(req.params.commentId, 10), req.spreadsheet.id]);
  if (!comment) return res.status(404).json({ success: false, error: '评论不存在' });

  const uid = req.session.user.id;
  const isAuthor = comment.user_id === uid;
  const isAssignee = comment.assigned_to === uid;
  const isAdminLevel = req.docPermLevel >= 4;

  const updates = [];
  const params = [];
  if (req.body.content !== undefined) {
    if (!isAuthor && !isAdminLevel) return res.status(403).json({ success: false, error: '只能编辑自己的评论' });
    const content = String(req.body.content).trim().slice(0, 2000);
    if (!content) return res.status(400).json({ success: false, error: '评论内容不能为空' });
    updates.push('content = ?'); params.push(content);
  }
  if (req.body.resolved !== undefined) {
    if (!isAuthor && !isAssignee && !isAdminLevel && req.docPermLevel < 2) {
      return res.status(403).json({ success: false, error: '没有权限操作' });
    }
    updates.push('resolved = ?'); params.push(req.body.resolved ? 1 : 0);
  }
  if (req.body.taskStatus !== undefined) {
    if (!isAssignee && !isAdminLevel && !isAuthor) {
      return res.status(403).json({ success: false, error: '只有被指派人或管理员可更新任务状态' });
    }
    const status = String(req.body.taskStatus);
    if (!['open', 'done', 'none'].includes(status)) {
      return res.status(400).json({ success: false, error: '无效的任务状态' });
    }
    updates.push('task_status = ?'); params.push(status);
  }
  if (req.body.assignedTo !== undefined) {
    if (!isAuthor && !isAdminLevel) return res.status(403).json({ success: false, error: '没有权限变更指派人' });
    if (req.body.assignedTo === null || req.body.assignedTo === '') {
      updates.push('assigned_to = NULL'); updates.push("task_status = 'none'");
    } else {
      const newAssignee = parseInt(req.body.assignedTo, 10);
      if (isNaN(newAssignee) || !queryOne(db, 'SELECT id FROM users WHERE id = ?', [newAssignee])) {
        return res.status(400).json({ success: false, error: '被指派用户不存在' });
      }
      updates.push('assigned_to = ?'); params.push(newAssignee);
      if (!updates.some(u => u.startsWith('task_status'))) { updates.push("task_status = 'open'"); }
      // 新指派通知
      if (newAssignee !== uid) {
        createNotification(db, {
          userId: newAssignee, type: 'spreadsheet_comment', title: '表格任务指派',
          content: `${req.session.user.username} 在表格「${req.spreadsheet.name}」中指派任务给您`,
          fromUserId: uid, targetType: 'spreadsheet', targetId: String(req.spreadsheet.id)
        });
      }
    }
  }
  if (!updates.length) return res.status(400).json({ success: false, error: '没有要更新的字段' });
  updates.push('updated_at = CURRENT_TIMESTAMP');
  params.push(comment.id);
  db.run('UPDATE spreadsheet_comments SET ' + updates.join(', ') + ' WHERE id = ?', params);
  saveDatabase(db);
  broadcast(req.spreadsheet.id, 'comments', uid, req.session.user.username, { commentId: comment.id });
  res.json({ success: true });
});

// 删除批注（连同回复）
router.delete('/api/spreadsheet/:id(\\d+)/comments/:commentId(\\d+)', isAuthenticated, hasFrontendPermission('spreadsheet.access'), requireDocPerm(1), (req, res) => {
  const db = req.db;
  const commentId = parseInt(req.params.commentId, 10);
  const comment = queryOne(db, 'SELECT * FROM spreadsheet_comments WHERE id = ? AND spreadsheet_id = ?', [commentId, req.spreadsheet.id]);
  if (!comment) return res.status(404).json({ success: false, error: '评论不存在' });
  if (comment.user_id !== req.session.user.id && req.docPermLevel < 4) {
    return res.status(403).json({ success: false, error: '只能删除自己的评论' });
  }
  db.run('DELETE FROM spreadsheet_comments WHERE id = ? OR parent_id = ?', [commentId, commentId]);
  saveDatabase(db);
  broadcast(req.spreadsheet.id, 'comments', req.session.user.id, req.session.user.username, { commentId, deleted: true });
  res.json({ success: true });
});

// 我的待办任务（跨表格）
router.get('/api/spreadsheet/my-tasks', isAuthenticated, hasFrontendPermission('spreadsheet.access'), (req, res) => {
  const tasks = queryAll(req.db,
    `SELECT c.id, c.spreadsheet_id, c.sheet_id, c.row, c.col, c.content, c.task_status, c.resolved, c.created_at,
            s.name AS spreadsheet_name, u.username AS author_name
     FROM spreadsheet_comments c
     JOIN spreadsheets s ON c.spreadsheet_id = s.id AND s.status = 'active'
     LEFT JOIN users u ON c.user_id = u.id
     WHERE c.assigned_to = ? AND c.task_status = 'open' AND c.resolved = 0
     ORDER BY c.id DESC LIMIT 200`,
    [req.session.user.id]
  );
  res.json({ success: true, data: { tasks } });
});

// ============ 图表 ============

function validateChartConfig(config) {
  if (!config || typeof config !== 'object') return '图表配置必须是对象';
  const json = JSON.stringify(config);
  if (json.length > 64 * 1024) return '图表配置过大';
  return null;
}

router.get('/api/spreadsheet/:id(\\d+)/charts', isAuthenticated, hasFrontendPermission('spreadsheet.access'), requireDocPerm(1), (req, res) => {
  const charts = queryAll(req.db,
    'SELECT id, sheet_id, name, chart_type, config, anchor, created_by, created_at, updated_at FROM spreadsheet_charts WHERE spreadsheet_id = ? ORDER BY id ASC',
    [req.spreadsheet.id]
  );
  const chartsData = charts.map(c => ({
    ...c,
    config: safeParseJson(c.config, {}),
    anchor: safeParseJson(c.anchor, {})
  }));
  res.json({ success: true, data: { charts: chartsData } });
});

router.post('/api/spreadsheet/:id(\\d+)/charts', isAuthenticated, hasFrontendPermission('spreadsheet.access'), requireDocPerm(3), (req, res) => {
  const db = req.db;
  const chartType = String(req.body.chartType || '').trim();
  const CHART_TYPES = ['bar', 'line', 'pie', 'scatter', 'area', 'radar', 'combo'];
  if (!CHART_TYPES.includes(chartType)) {
    return res.status(400).json({ success: false, error: '无效的图表类型' });
  }
  const configErr = validateChartConfig(req.body.config);
  if (configErr) return res.status(400).json({ success: false, error: configErr });
  const anchor = req.body.anchor && typeof req.body.anchor === 'object' ? req.body.anchor : {};
  const result = db.run(
    'INSERT INTO spreadsheet_charts (spreadsheet_id, sheet_id, name, chart_type, config, anchor, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [req.spreadsheet.id, String(req.body.sheetId || '').slice(0, 50), String(req.body.name || '').trim().slice(0, 100),
      chartType, JSON.stringify(req.body.config), JSON.stringify(anchor), req.session.user.id]
  );
  saveDatabase(db);
  broadcast(req.spreadsheet.id, 'charts', req.session.user.id, req.session.user.username, { chartId: result.lastInsertRowid });
  res.json({ success: true, data: { id: result.lastInsertRowid } });
});

router.put('/api/spreadsheet/:id(\\d+)/charts/:chartId(\\d+)', isAuthenticated, hasFrontendPermission('spreadsheet.access'), requireDocPerm(3), (req, res) => {
  const db = req.db;
  const chartId = parseInt(req.params.chartId, 10);
  const chart = queryOne(db, 'SELECT id FROM spreadsheet_charts WHERE id = ? AND spreadsheet_id = ?', [chartId, req.spreadsheet.id]);
  if (!chart) return res.status(404).json({ success: false, error: '图表不存在' });
  const updates = [];
  const params = [];
  if (req.body.name !== undefined) { updates.push('name = ?'); params.push(String(req.body.name).trim().slice(0, 100)); }
  if (req.body.chartType !== undefined) { updates.push('chart_type = ?'); params.push(String(req.body.chartType)); }
  if (req.body.config !== undefined) {
    const configErr = validateChartConfig(req.body.config);
    if (configErr) return res.status(400).json({ success: false, error: configErr });
    updates.push('config = ?'); params.push(JSON.stringify(req.body.config));
  }
  if (req.body.anchor !== undefined) {
    updates.push('anchor = ?'); params.push(JSON.stringify(req.body.anchor && typeof req.body.anchor === 'object' ? req.body.anchor : {}));
  }
  if (!updates.length) return res.status(400).json({ success: false, error: '没有要更新的字段' });
  updates.push('updated_at = CURRENT_TIMESTAMP');
  params.push(chartId);
  db.run('UPDATE spreadsheet_charts SET ' + updates.join(', ') + ' WHERE id = ?', params);
  saveDatabase(db);
  broadcast(req.spreadsheet.id, 'charts', req.session.user.id, req.session.user.username, { chartId });
  res.json({ success: true });
});

router.delete('/api/spreadsheet/:id(\\d+)/charts/:chartId(\\d+)', isAuthenticated, hasFrontendPermission('spreadsheet.access'), requireDocPerm(3), (req, res) => {
  const db = req.db;
  const chartId = parseInt(req.params.chartId, 10);
  const chart = queryOne(db, 'SELECT id FROM spreadsheet_charts WHERE id = ? AND spreadsheet_id = ?', [chartId, req.spreadsheet.id]);
  if (!chart) return res.status(404).json({ success: false, error: '图表不存在' });
  db.run('DELETE FROM spreadsheet_charts WHERE id = ?', [chartId]);
  saveDatabase(db);
  broadcast(req.spreadsheet.id, 'charts', req.session.user.id, req.session.user.username, { chartId, deleted: true });
  res.json({ success: true });
});

// ============ 实时协同 ============

// 上报光标/选区/编辑状态
router.post('/api/spreadsheet/:id(\\d+)/presence', isAuthenticated, hasFrontendPermission('spreadsheet.access'), requireDocPerm(1), (req, res) => {
  const sheetId = req.spreadsheet.id;
  const uid = req.session.user.id;
  if (!presenceMap.has(sheetId)) presenceMap.set(sheetId, new Map());
  const userMap = presenceMap.get(sheetId);
  const range = req.body.range || {};
  userMap.set(uid, {
    username: req.session.user.username || '用户',
    sheetId: String(req.body.sheetId || '').slice(0, 50),
    row: parseInt(range.row, 10) || 0,
    col: parseInt(range.col, 10) || 0,
    endRow: parseInt(range.endRow, 10) || parseInt(range.row, 10) || 0,
    endCol: parseInt(range.endCol, 10) || parseInt(range.col, 10) || 0,
    mode: ['cursor', 'select', 'edit'].includes(req.body.mode) ? req.body.mode : 'cursor',
    ts: Date.now()
  });
  res.json({ success: true });
});

// 获取在线用户（含光标/选区）
router.get('/api/spreadsheet/:id(\\d+)/presence', isAuthenticated, hasFrontendPermission('spreadsheet.access'), requireDocPerm(1), (req, res) => {
  const sheetId = req.spreadsheet.id;
  const userMap = presenceMap.get(sheetId);
  const now = Date.now();
  const users = [];
  if (userMap) {
    userMap.forEach((info, uid) => {
      if (now - info.ts > PRESENCE_TTL_MS) return;
      if (uid === req.session.user.id) return;
      users.push({
        userId: uid,
        username: info.username,
        sheetId: info.sheetId,
        range: { row: info.row, col: info.col, endRow: info.endRow, endCol: info.endCol },
        mode: info.mode
      });
    });
  }
  const entry = docCache.get(sheetId);
  res.json({ success: true, data: { users, docVersion: entry ? entry.version : (req.spreadsheet.doc_version || 0) } });
});

/**
 * 提交单元格值变更批次（实时协同主通道）
 * body: { sheetId: 'sheet-1', cells: [{ r, c, cell: ICellData|null }] }
 * 仅用于纯值/公式变更；结构性变更（样式/行列/合并/sheet）请走 PUT /doc 全量保存
 */
router.post('/api/spreadsheet/:id(\\d+)/changes', isAuthenticated, hasFrontendPermission('spreadsheet.access'), requireDocPerm(3), (req, res) => {
  const db = req.db;
  const sheetId = req.spreadsheet.id;
  if (req.spreadsheet.is_locked === 1) {
    return res.status(403).json({ success: false, error: '表格已锁定，无法编辑' });
  }
  const univerSheetId = String(req.body.sheetId || '');
  const cells = req.body.cells;
  if (!Array.isArray(cells) || cells.length === 0) {
    return res.status(400).json({ success: false, error: '变更内容无效' });
  }
  if (cells.length > MAX_CELLS_PER_BATCH) {
    return res.status(400).json({ success: false, error: `单次变更不能超过 ${MAX_CELLS_PER_BATCH} 个单元格` });
  }

  const entry = loadDoc(db, sheetId);
  const sheet = entry.doc.sheets[univerSheetId];
  if (!sheet) return res.status(400).json({ success: false, error: '工作表不存在' });

  // 校验 + 应用
  const applied = [];
  const editRows = [];
  for (const op of cells) {
    const r = parseInt(op.r, 10);
    const c = parseInt(op.c, 10);
    if (isNaN(r) || isNaN(c) || r < 0 || c < 0 || r >= 200000 || c >= 10000) {
      return res.status(400).json({ success: false, error: '单元格坐标无效' });
    }
    let cell = op.cell === undefined ? undefined : op.cell;
    if (cell === null) { cell = null; } else if (cell && typeof cell === 'object') {
      const json = JSON.stringify(cell);
      if (json.length > MAX_CELL_JSON) {
        return res.status(400).json({ success: false, error: '单元格数据过大' });
      }
    } else if (cell !== undefined) {
      return res.status(400).json({ success: false, error: '单元格数据类型无效' });
    }
    const cellData = sheet.cellData;
    if (!cellData[r]) cellData[r] = {};
    const oldValue = cellData[r][c] || null;
    if (cell === null) delete cellData[r][c];
    else if (cell !== undefined) cellData[r][c] = cell;
    applied.push({ r, c, cell: cell === undefined ? null : cell });
    if (editRows.length < 200) {
      editRows.push([sheetId, univerSheetId, r, c, req.session.user.id, req.session.user.username,
        oldValue ? JSON.stringify(oldValue).slice(0, 500) : null,
        cell === null || cell === undefined ? null : JSON.stringify(cell).slice(0, 500)]);
    }
  }

  entry.dirty = true;
  schedulePersist(sheetId);
  // 记录单元格级编辑历史（审计用）
  editRows.forEach(row => {
    db.run('INSERT INTO spreadsheet_cell_edits (spreadsheet_id, sheet_index, row, col, user_id, username, old_value, new_value) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', row);
  });
  const seq = broadcast(sheetId, 'cells', req.session.user.id, req.session.user.username, { sheetId: univerSheetId, cells: applied });
  res.json({ success: true, data: { seq } });
});

// 拉取增量变更（基于 seq 序号）
router.get('/api/spreadsheet/:id(\\d+)/changes', isAuthenticated, hasFrontendPermission('spreadsheet.access'), requireDocPerm(1), (req, res) => {
  const sheetId = req.spreadsheet.id;
  const since = parseInt(req.query.since, 10) || 0;
  const queue = changeQueues.get(sheetId) || [];
  const now = Date.now();
  const changes = queue
    .filter(ch => ch.seq > since && ch.ts > now - CHANGE_TTL_MS && ch.userId !== req.session.user.id)
    .map(ch => ({ seq: ch.seq, kind: ch.kind, username: ch.username, ts: ch.ts, payload: ch.payload }));
  const maxSeq = queue.length > 0 ? queue[queue.length - 1].seq : since;
  const entry = docCache.get(sheetId);
  res.json({
    success: true,
    data: {
      since: maxSeq,
      changes,
      docVersion: entry ? entry.version : (req.spreadsheet.doc_version || 0)
    }
  });
});

// ============ 表格锁定 ============

router.get('/api/spreadsheet/:id(\\d+)/lock', isAuthenticated, hasFrontendPermission('spreadsheet.access'), requireDocPerm(1), (req, res) => {
  res.json({ success: true, data: { locked: req.spreadsheet.is_locked === 1, lockedBy: req.spreadsheet.locked_by } });
});

router.post('/api/spreadsheet/:id(\\d+)/lock', isAuthenticated, hasFrontendPermission('spreadsheet.access'), requireDocPerm(4), (req, res) => {
  const db = req.db;
  const locked = req.body.locked ? 1 : 0;
  db.run('UPDATE spreadsheets SET is_locked = ?, locked_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    [locked, locked ? req.session.user.id : null, req.spreadsheet.id]);
  saveDatabase(db);
  broadcast(req.spreadsheet.id, 'docReload', req.session.user.id, req.session.user.username, { locked });
  logActivity(db, {
    user_id: req.session.user.id, username: req.session.user.username,
    action: locked ? 'lock' : 'unlock', target_type: 'spreadsheet', target_id: req.spreadsheet.id,
    target_title: req.spreadsheet.name, detail: locked ? '锁定在线表格' : '解锁在线表格', ip: getClientIp(req)
  });
  res.json({ success: true, data: { locked: locked === 1 } });
});

// 公开只读开关：开启后所有登录用户至少拥有只读查看权限（等级 1，内容保护与水印仍生效）
router.get('/api/spreadsheet/:id(\\d+)/public-read', isAuthenticated, hasFrontendPermission('spreadsheet.access'), requireDocPerm(4), (req, res) => {
  res.json({ success: true, data: { enabled: req.spreadsheet.is_public_read === 1 } });
});
router.post('/api/spreadsheet/:id(\\d+)/public-read', isAuthenticated, hasFrontendPermission('spreadsheet.access'), requireDocPerm(4), (req, res) => {
  const db = req.db;
  const enabled = req.body.enabled ? 1 : 0;
  db.run('UPDATE spreadsheets SET is_public_read = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [enabled, req.spreadsheet.id]);
  saveDatabase(db);
  // 通知在线编辑端刷新（元数据 + 权限态变化）
  broadcast(req.spreadsheet.id, 'docReload', req.session.user.id, req.session.user.username, { meta: true, publicRead: enabled === 1 });
  logActivity(db, {
    user_id: req.session.user.id, username: req.session.user.username,
    action: 'perm_public', target_type: 'spreadsheet', target_id: req.spreadsheet.id,
    target_title: req.spreadsheet.name,
    detail: enabled ? '开启公开只读：所有登录用户可查看' : '关闭公开只读：恢复私有模型（仅授权用户可访问）',
    ip: getClientIp(req)
  });
  res.json({ success: true, data: { enabled: enabled === 1 } });
});

// ============ 文档级权限管理 ============

// 我的权限（无权限用户也可查询，返回等级 0 与待审批申请状态）
router.get('/api/spreadsheet/:id(\\d+)/permission/my', isAuthenticated, hasFrontendPermission('spreadsheet.access'), loadSheetForRequest, (req, res) => {
  const pending = queryOne(req.db,
    'SELECT perm_type, status, created_at FROM spreadsheet_permission_applications WHERE spreadsheet_id = ? AND user_id = ? AND status = ? ORDER BY id DESC LIMIT 1',
    [req.spreadsheet.id, req.session.user.id, 'pending']);
  res.json({
    success: true,
    data: {
      permLevel: req.docPermLevel,
      isAdmin: req.docPermLevel >= 4,
      canEdit: req.docPermLevel >= 3,
      canComment: req.docPermLevel >= 2,
      pendingApp: pending || null
    }
  });
});

// 申请权限（无权限用户可申请 view 只读访问；管理员/创建者审批）
router.post('/api/spreadsheet/:id(\\d+)/permission/apply', isAuthenticated, hasFrontendPermission('spreadsheet.access'), loadSheetForRequest, (req, res) => {
  const db = req.db;
  const sheetId = req.spreadsheet.id;
  const userId = req.session.user.id;
  const { perm_type, reason } = req.body;
  if (!perm_type || !PERM_TYPES.includes(perm_type)) {
    return res.status(400).json({ success: false, error: '无效的权限类型' });
  }
  // 已有同级或更高权限则无需申请
  const level = getDocPermLevel(req, sheetId, req.spreadsheet);
  if (level >= (PERM_LEVEL[perm_type] || 1)) {
    return res.status(400).json({ success: false, error: '您已拥有该权限' });
  }
  const existing = queryOne(db,
    'SELECT id FROM spreadsheet_permission_applications WHERE spreadsheet_id = ? AND user_id = ? AND perm_type = ? AND status = ?',
    [sheetId, userId, perm_type, 'pending']
  );
  if (existing) {
    return res.status(400).json({ success: false, error: '已有待处理的申请，请等待审批' });
  }
  db.run('INSERT INTO spreadsheet_permission_applications (spreadsheet_id, user_id, perm_type, reason) VALUES (?, ?, ?, ?)',
    [sheetId, userId, perm_type, String(reason || '').slice(0, 500)]);
  saveDatabase(db);
  // 审计：记录权限申请
  logActivity(db, {
    user_id: userId, username: req.session.user.username,
    action: 'perm_apply', target_type: 'spreadsheet', target_id: sheetId,
    target_title: req.spreadsheet.name,
    detail: `申请${PERM_NAMES[perm_type]}权限${reason ? '：' + String(reason).slice(0, 100) : ''}`, ip: getClientIp(req)
  });

  // 通知管理员与创建者
  const admins = queryAll(db, `
    SELECT DISTINCT u.id FROM users u
    WHERE u.role IN ('super_admin', 'admin')
    OR u.id IN (SELECT user_id FROM user_permissions WHERE perm_key IN ('spreadsheet.manage', 'spreadsheet.*'))
    OR u.id = ?
  `, [req.spreadsheet.created_by]);
  admins.forEach(admin => {
    createNotification(db, {
      userId: admin.id, type: 'permission_apply', title: '表格权限申请',
      content: `${req.session.user.username} 申请表格「${req.spreadsheet.name}」的${PERM_NAMES[perm_type]}权限${reason ? '：' + String(reason).slice(0, 100) : ''}`,
      fromUserId: userId, targetType: 'spreadsheet', targetId: String(sheetId)
    });
  });
  res.json({ success: true, message: '申请已提交，等待审批' });
});

// 权限列表（管理员）
router.get('/api/spreadsheet/:id(\\d+)/permissions', isAuthenticated, hasFrontendPermission('spreadsheet.access'), requireDocPerm(4), (req, res) => {
  const perms = queryAll(req.db, `
    SELECT p.id, p.user_id, p.perm_type, p.granted_by, p.created_at, u.username, u.email
    FROM spreadsheet_user_permissions p
    LEFT JOIN users u ON p.user_id = u.id
    WHERE p.spreadsheet_id = ?
    ORDER BY p.created_at DESC
  `, [req.spreadsheet.id]);
  res.json({ success: true, data: { permissions: perms } });
});

// 可选用户列表（用于指派/授权选择/@提及）
router.get('/api/spreadsheet/:id(\\d+)/users', isAuthenticated, hasFrontendPermission('spreadsheet.access'), requireDocPerm(2), (req, res) => {
  const users = queryAll(req.db, "SELECT id, username, nickname, avatar, email FROM users WHERE status = 'active' ORDER BY username ASC LIMIT 500");
  res.json({ success: true, data: { users } });
});

// 申请列表（管理员）
router.get('/api/spreadsheet/:id(\\d+)/permission/applications', isAuthenticated, hasFrontendPermission('spreadsheet.access'), requireDocPerm(4), (req, res) => {
  const apps = queryAll(req.db, `
    SELECT a.id, a.user_id, a.perm_type, a.reason, a.status, a.created_at, a.handled_at, u.username, u.email
    FROM spreadsheet_permission_applications a
    LEFT JOIN users u ON a.user_id = u.id
    WHERE a.spreadsheet_id = ?
    ORDER BY a.created_at DESC LIMIT 50
  `, [req.spreadsheet.id]);
  res.json({ success: true, data: { applications: apps } });
});

// 审批申请
router.post('/api/spreadsheet/:id(\\d+)/permission/approve', isAuthenticated, hasFrontendPermission('spreadsheet.access'), requireDocPerm(4), (req, res) => {
  const db = req.db;
  const sheetId = req.spreadsheet.id;
  const { application_id, approved } = req.body;
  const app = queryOne(db, 'SELECT * FROM spreadsheet_permission_applications WHERE id = ? AND spreadsheet_id = ?', [parseInt(application_id, 10), sheetId]);
  if (!app) return res.status(404).json({ success: false, error: '申请不存在' });
  if (app.status !== 'pending') return res.status(400).json({ success: false, error: '申请已处理' });
  if (!PERM_TYPES.includes(app.perm_type)) {
    return res.status(400).json({ success: false, error: '无效的权限类型' });
  }
  db.run('UPDATE spreadsheet_permission_applications SET status = ?, handled_by = ?, handled_at = CURRENT_TIMESTAMP WHERE id = ?',
    [approved ? 'approved' : 'rejected', req.session.user.id, app.id]);
  if (approved) {
    db.run('INSERT OR IGNORE INTO spreadsheet_user_permissions (spreadsheet_id, user_id, perm_type, granted_by) VALUES (?, ?, ?, ?)',
      [sheetId, app.user_id, app.perm_type, req.session.user.id]);
  }
  saveDatabase(db);
  // 审计：记录审批结果
  const applicant = queryOne(db, 'SELECT username FROM users WHERE id = ?', [app.user_id]);
  logActivity(db, {
    user_id: req.session.user.id, username: req.session.user.username,
    action: approved ? 'perm_approve' : 'perm_reject', target_type: 'spreadsheet', target_id: sheetId,
    target_title: req.spreadsheet.name,
    detail: `${approved ? '通过' : '拒绝'} ${(applicant && applicant.username) || ('用户#' + app.user_id)} 的${PERM_NAMES[app.perm_type]}权限申请`,
    ip: getClientIp(req)
  });
  createNotification(db, {
    userId: app.user_id, type: 'permission_result',
    title: approved ? '权限申请已通过' : '权限申请被拒绝',
    content: `您申请的表格「${req.spreadsheet.name}」的${PERM_NAMES[app.perm_type]}权限${approved ? '已通过' : '被拒绝'}`,
    fromUserId: req.session.user.id, targetType: 'spreadsheet', targetId: String(sheetId)
  });
  res.json({ success: true, message: approved ? '已通过申请' : '已拒绝申请' });
});

// 撤销用户权限
router.delete('/api/spreadsheet/:id(\\d+)/permission/:userId(\\d+)', isAuthenticated, hasFrontendPermission('spreadsheet.access'), requireDocPerm(4), (req, res) => {
  const db = req.db;
  const userId = parseInt(req.params.userId, 10);
  const { perm_type } = req.body || {};
  if (perm_type) {
    if (!PERM_TYPES.includes(perm_type)) return res.status(400).json({ success: false, error: '无效的权限类型' });
    db.run('DELETE FROM spreadsheet_user_permissions WHERE spreadsheet_id = ? AND user_id = ? AND perm_type = ?', [req.spreadsheet.id, userId, perm_type]);
  } else {
    db.run('DELETE FROM spreadsheet_user_permissions WHERE spreadsheet_id = ? AND user_id = ?', [req.spreadsheet.id, userId]);
  }
  saveDatabase(db);
  // 审计：记录权限撤销
  const target = queryOne(db, 'SELECT username FROM users WHERE id = ?', [userId]);
  logActivity(db, {
    user_id: req.session.user.id, username: req.session.user.username,
    action: 'perm_revoke', target_type: 'spreadsheet', target_id: req.spreadsheet.id,
    target_title: req.spreadsheet.name,
    detail: `撤销 ${(target && target.username) || ('用户#' + userId)} 的${perm_type ? PERM_NAMES[perm_type] : '全部'}权限`,
    ip: getClientIp(req)
  });
  res.json({ success: true, message: '权限已撤销' });
});

// 直接授予用户权限（管理员/创建者绕过申请流程；可授予只读查看等全部权限类型）
router.post('/api/spreadsheet/:id(\\d+)/permissions', isAuthenticated, hasFrontendPermission('spreadsheet.access'), requireDocPerm(4), (req, res) => {
  const db = req.db;
  const sheetId = req.spreadsheet.id;
  const { username, user_id, perm_type } = req.body || {};
  if (!PERM_TYPES.includes(perm_type)) return res.status(400).json({ success: false, error: '无效的权限类型' });

  // 支持按用户 ID（下拉选择）或用户名/邮箱（手动输入）定位用户
  let target = null;
  if (user_id) {
    target = queryOne(db, 'SELECT id, username, status FROM users WHERE id = ?', [parseInt(user_id, 10)]);
    if (!target) return res.status(404).json({ success: false, error: '用户不存在' });
  } else {
    const kw = String(username || '').trim();
    if (!kw) return res.status(400).json({ success: false, error: '请选择或输入用户' });
    target = queryOne(db, 'SELECT id, username, status FROM users WHERE username = ? OR email = ?', [kw, kw]);
    if (!target) return res.status(404).json({ success: false, error: '用户不存在' });
  }
  if (target.status !== 'active') return res.status(400).json({ success: false, error: '该用户已被禁用或注销' });
  if (target.id === req.spreadsheet.created_by) return res.status(400).json({ success: false, error: '该用户是文档创建者，无需授权' });

  db.run('INSERT OR IGNORE INTO spreadsheet_user_permissions (spreadsheet_id, user_id, perm_type, granted_by) VALUES (?, ?, ?, ?)',
    [sheetId, target.id, perm_type, req.session.user.id]);
  // 该用户如有同类待审批申请，自动置为已通过
  db.run("UPDATE spreadsheet_permission_applications SET status = 'approved', handled_by = ?, handled_at = CURRENT_TIMESTAMP WHERE spreadsheet_id = ? AND user_id = ? AND perm_type = ? AND status = 'pending'",
    [req.session.user.id, sheetId, target.id, perm_type]);
  saveDatabase(db);

  // 审计：记录直接授予
  logActivity(db, {
    user_id: req.session.user.id, username: req.session.user.username,
    action: 'perm_grant', target_type: 'spreadsheet', target_id: sheetId,
    target_title: req.spreadsheet.name,
    detail: `直接授予 ${target.username} ${PERM_NAMES[perm_type]}权限`,
    ip: getClientIp(req)
  });
  createNotification(db, {
    userId: target.id, type: 'permission_result',
    title: '权限已授予',
    content: `您获得了表格「${req.spreadsheet.name}」的${PERM_NAMES[perm_type]}权限`,
    fromUserId: req.session.user.id, targetType: 'spreadsheet', targetId: String(sheetId)
  });
  res.json({ success: true, message: `已授予 ${target.username} ${PERM_NAMES[perm_type]}权限` });
});

// ============ AI 智能功能 ============

// 从文档提取数据矩阵（供 AI 上下文）
function extractSheetMatrix(doc, sheetId, maxRows, maxCols) {
  const sheet = (sheetId && doc.sheets[sheetId]) || doc.sheets[doc.sheetOrder[0]];
  if (!sheet) return null;
  const cd = sheet.cellData || {};
  const rowKeys = Object.keys(cd).map(Number).sort((a, b) => a - b).slice(0, maxRows);
  let maxC = 0;
  const rows = rowKeys.map(r => {
    const rowArr = [];
    Object.keys(cd[r]).forEach(ck => {
      const c = Number(ck);
      const cell = cd[r][ck];
      const v = cell && cell.v !== undefined && cell.v !== null ? cell.v : (cell && cell.f ? cell.f : '');
      rowArr[c] = String(v).slice(0, 200);
      if (c > maxC) maxC = c;
    });
    return rowArr;
  });
  const width = Math.min(maxCols, maxC + 1);
  return {
    name: sheet.name,
    rowCount: sheet.rowCount,
    columnCount: sheet.columnCount,
    rows: rows.map(r => {
      const out = [];
      for (let c = 0; c < width; c++) out.push(r[c] === undefined ? '' : r[c]);
      return out;
    })
  };
}

// 从 AI 回复中提取 JSON
function extractJsonText(text) {
  if (!text) return null;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fence ? fence[1] : text;
  try { return JSON.parse(raw.trim()); } catch (e) { /* 继续尝试 */ }
  const s = raw.indexOf('{');
  const e = raw.lastIndexOf('}');
  if (s !== -1 && e > s) { try { return JSON.parse(raw.slice(s, e + 1)); } catch (e2) { /* 继续尝试 */ } }
  const s2 = raw.indexOf('[');
  const e2 = raw.lastIndexOf(']');
  if (s2 !== -1 && e2 > s2) { try { return JSON.parse(raw.slice(s2, e2 + 1)); } catch (e3) { /* 失败 */ } }
  return null;
}

// 统一 AI 调用入口
async function aiCall(db, userId, messages) {
  const model = resolveModel(db, userId, null);
  const { content } = await callChatCompletion(model, messages, { timeout: 90000 });
  return String(content || '');
}

// 自然语言生成公式
router.post('/api/spreadsheet/:id(\\d+)/ai/formula', isAuthenticated, hasFrontendPermission('spreadsheet.access'), requireDocPerm(2), async (req, res) => {
  try {
    const db = req.db;
    const prompt = String(req.body.prompt || '').trim().slice(0, 2000);
    if (!prompt) return res.status(400).json({ success: false, error: '请描述您想要的公式' });
    const entry = loadDoc(db, req.spreadsheet.id);
    const matrix = extractSheetMatrix(entry.doc, req.body.sheetId, 30, 20);
    const context = matrix
      ? `工作表「${matrix.name}」前几行数据（第一行通常是表头）：\n${matrix.rows.slice(0, 15).map(r => r.join(' | ')).join('\n')}`
      : '工作表为空';
    const messages = [
      { role: 'system', content: '你是 Excel/电子表格公式专家。用户描述需求，你返回一个可直接使用的公式。只输出公式本身（以 = 开头），不要解释。使用标准电子表格函数语法（SUM/IF/VLOOKUP/XLOOKUP/INDEX/MATCH 等），列引用用 A1 样式。' },
      { role: 'user', content: `${context}\n\n用户需求：${prompt}\n\n当前选中的单元格：${req.body.currentCell || '未知'}。请返回公式：` }
    ];
    let formula = (await aiCall(db, req.session.user.id, messages)).trim();
    // 清理常见包裹
    formula = formula.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim();
    if (!formula.startsWith('=')) formula = '=' + formula;
    res.json({ success: true, data: { formula: formula.slice(0, 1000) } });
  } catch (e) {
    res.status(502).json({ success: false, error: 'AI 服务调用失败：' + (e.message || '未知错误') });
  }
});

// 校验 AI 生成的表格数据结构，返回规范化后的 { name, data } 数组或 null
function sanitizeAiSheets(parsed, maxRows, maxCols) {
  let sheets = null;
  if (Array.isArray(parsed)) {
    sheets = [{ name: 'Sheet1', data: parsed }];
  } else if (parsed && typeof parsed === 'object') {
    if (Array.isArray(parsed.sheets)) sheets = parsed.sheets;
    else if (Array.isArray(parsed.data)) sheets = [{ name: parsed.name || 'Sheet1', data: parsed.data }];
  }
  if (!sheets || !sheets.length) return null;
  const out = [];
  for (const s of sheets.slice(0, 20)) {
    if (!Array.isArray(s.data) || !s.data.length) continue;
    const rows = [];
    for (const row of s.data.slice(0, maxRows)) {
      if (!Array.isArray(row)) continue;
      rows.push(row.slice(0, maxCols).map(v => {
        if (v === null || v === undefined) return '';
        if (typeof v === 'number' && isFinite(v)) return v;
        if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
        return String(v).slice(0, 500);
      }));
    }
    if (rows.length) out.push({ name: String(s.name || ('Sheet' + (out.length + 1))).slice(0, 30), data: rows });
  }
  return out.length ? out : null;
}

// AI 生成表格内容与数据结构
router.post('/api/spreadsheet/:id(\\d+)/ai/generate', isAuthenticated, hasFrontendPermission('spreadsheet.access'), requireDocPerm(3), async (req, res) => {
  try {
    const db = req.db;
    const prompt = String(req.body.prompt || '').trim().slice(0, 2000);
    if (!prompt) return res.status(400).json({ success: false, error: '请描述要生成的表格内容' });
    const messages = [
      { role: 'system', content: '你是电子表格数据生成助手。根据用户需求生成表格数据，严格返回 JSON（不要多余文字）：{"sheets":[{"name":"工作表名","data":[["表头1","表头2"],[...数据行...]]}]}。数据要真实合理、符合常识，数字保持数字类型，一个工作表不超过 100 行 50 列。除非用户要求多个工作表，否则只生成一个。' },
      { role: 'user', content: '需求：' + prompt }
    ];
    const content = await aiCall(db, req.session.user.id, messages);
    const sheets = sanitizeAiSheets(extractJsonText(content), 200, 60);
    if (!sheets) return res.status(502).json({ success: false, error: 'AI 未返回有效的表格数据，请重试或换个描述' });
    res.json({ success: true, data: { sheets } });
  } catch (e) {
    res.status(502).json({ success: false, error: 'AI 服务调用失败：' + (e.message || '未知错误') });
  }
});

// AI 数据清洗 / 分析 / 总结
router.post('/api/spreadsheet/:id(\\d+)/ai/analyze', isAuthenticated, hasFrontendPermission('spreadsheet.access'), requireDocPerm(2), async (req, res) => {
  try {
    const db = req.db;
    const task = String(req.body.task || 'analyze').trim();
    if (!['clean', 'analyze', 'summarize'].includes(task)) {
      return res.status(400).json({ success: false, error: '无效的分析任务' });
    }
    const entry = loadDoc(db, req.spreadsheet.id);
    const matrix = extractSheetMatrix(entry.doc, req.body.sheetId, 200, 50);
    if (!matrix) return res.status(404).json({ success: false, error: '工作表不存在' });
    const tableText = matrix.rows.slice(0, 100).map(r => r.join(' | ')).join('\n');
    if (!tableText.trim()) return res.status(400).json({ success: false, error: '工作表没有数据可分析' });
    const context = `工作表「${matrix.name}」（${matrix.rowCount} 行 × ${matrix.columnCount} 列），数据预览：\n${tableText}`;
    let messages;
    if (task === 'clean') {
      messages = [
        { role: 'system', content: '你是数据清洗专家。分析用户提供的表格数据，找出缺失值、重复行、格式不一致、类型错误等问题，并返回清洗后的完整数据。严格返回 JSON：{"sheets":[{"name":"原工作表名","data":[[...清洗后的数据...]]}],"notes":"清洗说明（列出做了哪些修改，简短）"}。保持原有列结构，不要增删列。' },
        { role: 'user', content: context }
      ];
      const content = await aiCall(db, req.session.user.id, messages);
      const parsed = extractJsonText(content);
      const sheets = sanitizeAiSheets(parsed, 500, 60);
      if (!sheets) return res.status(502).json({ success: false, error: 'AI 未返回有效的清洗数据，请重试' });
      res.json({ success: true, data: { task, sheets, notes: parsed && typeof parsed.notes === 'string' ? parsed.notes.slice(0, 2000) : '' } });
    } else if (task === 'summarize') {
      messages = [
        { role: 'system', content: '你是数据分析专家。用简洁的中文对表格数据进行总结，输出 Markdown 格式：先用 2-3 句话概括数据内容，再用要点列表列出关键发现（总计/均值/极值/分布/趋势/异常）。不要罗列原始数据，给出提炼后的结论。' },
        { role: 'user', content: context }
      ];
      const report = await aiCall(db, req.session.user.id, messages);
      res.json({ success: true, data: { task, report: report.slice(0, 8000) } });
    } else {
      messages = [
        { role: 'system', content: '你是数据分析专家。对表格数据进行深入分析，输出 Markdown 格式报告，包含：## 数据概览（行数/列数/数据类型）、## 统计特征（关键数值列的总和/均值/最大最小值，能算的要算出来）、## 数据质量（缺失/重复/异常）、## 洞察与建议（3-5 条可执行的结论）。计算要准确。' },
        { role: 'user', content: context }
      ];
      const report = await aiCall(db, req.session.user.id, messages);
      res.json({ success: true, data: { task, report: report.slice(0, 12000) } });
    }
  } catch (e) {
    res.status(502).json({ success: false, error: 'AI 服务调用失败：' + (e.message || '未知错误') });
  }
});

// AI 智能图表推荐
router.post('/api/spreadsheet/:id(\\d+)/ai/chart', isAuthenticated, hasFrontendPermission('spreadsheet.access'), requireDocPerm(2), async (req, res) => {
  try {
    const db = req.db;
    const entry = loadDoc(db, req.spreadsheet.id);
    const matrix = extractSheetMatrix(entry.doc, req.body.sheetId, 30, 20);
    if (!matrix) return res.status(404).json({ success: false, error: '工作表不存在' });
    const tableText = matrix.rows.map(r => r.join(' | ')).join('\n');
    if (!tableText.trim()) return res.status(400).json({ success: false, error: '工作表没有数据可用于生成图表' });
    const messages = [
      { role: 'system', content: '你是图表推荐专家。根据表格数据推荐最合适的可视化图表。可选类型：bar（柱状图）、line（折线图）、pie（饼图）、scatter（散点图）、area（面积图）、radar（雷达图）、combo（组合图）。严格返回 JSON：{"chartType":"类型","name":"图表标题","reason":"推荐理由（一句话）","config":{"categories":[第1列起非数值列或标签列的取值数组],"series":[{"name":"系列名（来自表头）","type":"与chartType一致","data":[对应列的数值数组]}]}。第一行通常是表头，系列名取表头，categories 取标签列去重后的值，data 必须全部是数字。饼图只需 1 个系列。' },
      { role: 'user', content: `工作表「${matrix.name}」数据：\n${tableText}` }
    ];
    const content = await aiCall(db, req.session.user.id, messages);
    const parsed = extractJsonText(content);
    const CHART_TYPES = ['bar', 'line', 'pie', 'scatter', 'area', 'radar', 'combo'];
    if (!parsed || typeof parsed !== 'object' || !CHART_TYPES.includes(parsed.chartType)) {
      return res.status(502).json({ success: false, error: 'AI 未返回有效的图表配置，请重试' });
    }
    const config = parsed.config && typeof parsed.config === 'object' ? parsed.config : {};
    const json = JSON.stringify(config);
    if (json.length > 64 * 1024) return res.status(502).json({ success: false, error: 'AI 返回的图表配置过大' });
    res.json({
      success: true,
      data: {
        chartType: parsed.chartType,
        name: String(parsed.name || 'AI 推荐图表').slice(0, 100),
        reason: String(parsed.reason || '').slice(0, 500),
        config: config,
        sheetId: req.body.sheetId ? String(req.body.sheetId).slice(0, 50) : ''
      }
    });
  } catch (e) {
    res.status(502).json({ success: false, error: 'AI 服务调用失败：' + (e.message || '未知错误') });
  }
});

// ============ 分享链接（image_shares 通用表，source_type = 'spreadsheet'） ============

// 查询文档当前分享状态（无分享返回 shared: false）
router.get('/api/spreadsheet/:id(\\d+)/share', isAuthenticated, hasFrontendPermission('spreadsheet.access'), requireDocPerm(4), (req, res) => {
  const db = req.db;
  const share = queryOne(db,
    'SELECT share_token, status, view_count, created_at FROM image_shares WHERE source_type = ? AND source_id = ?',
    ['spreadsheet', req.spreadsheet.id]
  );
  if (!share) return res.json({ success: true, data: { shared: false } });
  res.json({
    success: true,
    data: {
      shared: true,
      status: share.status,
      token: share.share_token,
      url: '/share/' + share.share_token,
      embedUrl: '/share/' + share.share_token + '/embed',
      viewCount: share.view_count || 0,
      createdAt: share.created_at
    }
  });
});

// 创建 / 启用分享链接（文档管理权限：管理员 / spreadsheet.manage / 创建者）
router.post('/api/spreadsheet/:id(\\d+)/share', isAuthenticated, hasFrontendPermission('spreadsheet.access'), requireDocPerm(4), (req, res) => {
  const db = req.db;
  const sheetId = req.spreadsheet.id;
  if (req.spreadsheet.status !== 'active') {
    return res.status(400).json({ success: false, error: '仅 active 状态的表格可分享' });
  }
  let share = queryOne(db, 'SELECT * FROM image_shares WHERE source_type = ? AND source_id = ?', ['spreadsheet', sheetId]);
  if (!share) {
    const token = crypto.randomBytes(12).toString('base64url');
    db.run('INSERT INTO image_shares (source_type, source_id, share_token, status, created_by) VALUES (?, ?, ?, 1, ?)',
      ['spreadsheet', sheetId, token, req.session.user.id]);
  } else if (share.status !== 1) {
    db.run('UPDATE image_shares SET status = 1 WHERE id = ?', [share.id]);
  }
  saveDatabase(db);
  logActivity(db, {
    user_id: req.session.user.id, username: req.session.user.username,
    action: 'create', target_type: 'spreadsheet', target_id: sheetId,
    target_title: req.spreadsheet.name, detail: share ? '启用分享链接' : '创建分享链接', ip: getClientIp(req)
  });
  const row = queryOne(db, 'SELECT share_token FROM image_shares WHERE source_type = ? AND source_id = ?', ['spreadsheet', sheetId]);
  res.json({
    success: true,
    data: {
      shared: true,
      status: 1,
      token: row.share_token,
      url: '/share/' + row.share_token,
      embedUrl: '/share/' + row.share_token + '/embed'
    }
  });
});

// 取消分享（删除记录，链接立即失效）
router.delete('/api/spreadsheet/:id(\\d+)/share', isAuthenticated, hasFrontendPermission('spreadsheet.access'), requireDocPerm(4), (req, res) => {
  const db = req.db;
  const sheetId = req.spreadsheet.id;
  db.run('DELETE FROM image_shares WHERE source_type = ? AND source_id = ?', ['spreadsheet', sheetId]);
  saveDatabase(db);
  logActivity(db, {
    user_id: req.session.user.id, username: req.session.user.username,
    action: 'delete', target_type: 'spreadsheet', target_id: sheetId,
    target_title: req.spreadsheet.name, detail: '取消分享链接', ip: getClientIp(req)
  });
  res.json({ success: true, data: { shared: false } });
});

module.exports = router;
