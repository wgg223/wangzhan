/**
 * 在线表格文档共享存储（前台路由 + 后台管理路由共用）
 *
 * 职责：
 *  - 文档内存缓存（docCache），保证同一进程内所有模块读写同一份文档
 *  - Luckysheet 旧数据惰性迁移（loadDoc）
 *  - 防抖落库 / 全量持久化（schedulePersist / persistDocEntry）
 *  - 版本快照（writeSnapshot / shouldAutoSnapshot）
 *  - 协同广播队列（broadcast，changeSeq 单调递增）
 *  - 在线状态 / 变更队列 / 空闲缓存的定时清理
 *  - evictDoc：删除/强制迁移前先落库并失效缓存（跨模块缓存一致性的关键）
 */
'use strict';
const { queryOne, saveDatabase, getDb } = require('../config/database');
const { migrateLuckysheetToUniver, createEmptyUniverDoc } = require('./spreadsheet-migrate');

const PERSIST_DEBOUNCE_MS = 2000; // 变更落库防抖
const SNAPSHOT_INTERVAL_MS = 10 * 60 * 1000; // 自动版本快照最小间隔
const CHANGE_TTL_MS = 10 * 60 * 1000; // 变更队列保留时长
const PRESENCE_TTL_MS = 10 * 1000; // 在线状态有效期
const KEEP_VERSIONS = 50; // 每个文档保留的版本数
const MAX_CACHE_BYTES = 128 * 1024 * 1024; // 文档缓存总大小预算（按 doc_data JSON 字节估算，超限按 LRU 逐出）
const CACHE_MIN_IDLE_MS = 2 * 60 * 1000; // 大小预算逐出时的最小空闲时间（避免逐出正在编辑的文档）

// docCache: sheetId -> { doc, version, lastAccess, dirty, lastPersistAt, lastSnapshotAt, size }
const docCache = new Map();
// presenceMap: sheetId -> Map(userId -> { username, sheetId, range, mode, ts })
const presenceMap = new Map();
// changeQueues: sheetId -> [{ seq, kind, userId, username, ts, payload }]
const changeQueues = new Map();
// persistTimers: sheetId -> setTimeout 句柄
const persistTimers = new Map();
let changeSeq = Date.now(); // 单调递增序号（跨重启单调，避免旧序号覆盖）

/** 获取文档（优先内存缓存，其次数据库；Luckysheet 旧数据惰性迁移） */
function loadDoc(db, sheetId) {
  const cached = docCache.get(sheetId);
  if (cached) {
    cached.lastAccess = Date.now();
    return cached;
  }
  const row = queryOne(db, 'SELECT doc_data, doc_version, luckysheet_data FROM spreadsheets WHERE id = ?', [sheetId]);
  if (!row) return null;

  let doc = null;
  if (row.doc_data) {
    try { doc = JSON.parse(row.doc_data); } catch (e) { doc = null; }
  }
  // 惰性迁移：Luckysheet 旧数据 → Univer
  let migrated = null;
  if (!doc && row.luckysheet_data) {
    const result = migrateLuckysheetToUniver(row.luckysheet_data);
    if (result && result.workbook) {
      doc = result.workbook;
      migrated = result;
    }
  }
  if (!doc) doc = createEmptyUniverDoc('');

  const entry = {
    doc,
    version: row.doc_version || 0,
    lastAccess: Date.now(),
    dirty: false,
    lastPersistAt: Date.now(),
    lastSnapshotAt: 0,
    size: row.doc_data ? row.doc_data.length : 0, // JSON 字节估算（缓存大小预算用）
  };
  docCache.set(sheetId, entry);

  // 迁移落库（含批注导入）
  if (migrated) {
    persistDocEntry(db, sheetId, entry);
    db.run('UPDATE spreadsheets SET doc_version = 1 WHERE id = ?', [sheetId]);
    entry.version = 1;
    importMigratedComments(db, sheetId, migrated.comments || [], doc);
    saveDatabase(db);
  }
  return entry;
}

/** Luckysheet 批注 → spreadsheet_comments 表 */
function importMigratedComments(db, sheetId, comments, doc) {
  if (!Array.isArray(comments) || comments.length === 0) return;
  // 批注按 Luckysheet sheet 名匹配 Univer sheetId
  const nameToId = {};
  Object.keys(doc.sheets || {}).forEach(sid => {
    nameToId[doc.sheets[sid].name] = sid;
  });
  comments.forEach(cm => {
    if (cm.sheetName && !nameToId[cm.sheetName]) return;
    db.run(
      'INSERT INTO spreadsheet_comments (spreadsheet_id, sheet_id, row, col, user_id, username, content) VALUES (?, ?, ?, ?, 0, ?, ?)',
      [sheetId, nameToId[cm.sheetName] || '', cm.row, cm.col, '迁移导入', String(cm.content || '').slice(0, 2000)]
    );
  });
}

/** 全量持久化文档（立即写库） */
function persistDocEntry(db, sheetId, entry) {
  const json = JSON.stringify(entry.doc);
  db.run('UPDATE spreadsheets SET doc_data = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [json, sheetId]);
  entry.dirty = false;
  entry.size = json.length;
  entry.lastPersistAt = Date.now();
}

/** 变更防抖落库 */
function schedulePersist(sheetId) {
  if (persistTimers.has(sheetId)) return;
  const timer = setTimeout(() => {
    persistTimers.delete(sheetId);
    const db = getDb();
    const entry = docCache.get(sheetId);
    if (!db || !entry || !entry.dirty) return;
    try {
      persistDocEntry(db, sheetId, entry);
      saveDatabase(db);
    } catch (e) {
      console.error('[spreadsheet] 变更落库失败:', e.message);
    }
  }, PERSIST_DEBOUNCE_MS);
  if (typeof timer.unref === 'function') timer.unref();
  persistTimers.set(sheetId, timer);
}

/** 写入版本快照（保留最近 KEEP_VERSIONS 个） */
function writeSnapshot(db, sheetId, entry, changeDesc, userId, username) {
  const json = JSON.stringify(entry.doc);
  const sheetCount = Array.isArray(entry.doc.sheetOrder) ? entry.doc.sheetOrder.length : 1;
  const maxVer = queryOne(db, 'SELECT MAX(version) AS v FROM spreadsheet_versions WHERE spreadsheet_id = ?', [sheetId]);
  const version = (maxVer && maxVer.v ? maxVer.v : 0) + 1;
  db.run(
    'INSERT INTO spreadsheet_versions (spreadsheet_id, version, doc_data, change_desc, sheet_count, size_bytes, user_id, username) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [sheetId, version, json, String(changeDesc || '').slice(0, 500), sheetCount, json.length, userId || null, username || '']
  );
  db.run(
    'DELETE FROM spreadsheet_versions WHERE spreadsheet_id = ? AND id NOT IN (SELECT id FROM spreadsheet_versions WHERE spreadsheet_id = ? ORDER BY version DESC LIMIT ?)',
    [sheetId, sheetId, KEEP_VERSIONS]
  );
  entry.lastSnapshotAt = Date.now();
  return version;
}

/** 是否需要自动快照（间隔超限或结构性变更） */
function shouldAutoSnapshot(entry, structural) {
  if (structural) return true;
  if (!entry.lastSnapshotAt) return true;
  return Date.now() - entry.lastSnapshotAt >= SNAPSHOT_INTERVAL_MS;
}

/** 广播一条变更信号 */
function broadcast(sheetId, kind, userId, username, payload) {
  if (!changeQueues.has(sheetId)) changeQueues.set(sheetId, []);
  const queue = changeQueues.get(sheetId);
  changeSeq += 1;
  queue.push({ seq: changeSeq, kind, userId, username, ts: Date.now(), payload: payload || {} });
  if (queue.length > 1000) queue.splice(0, queue.length - 1000);
  return changeSeq;
}

/** 失效缓存（脏数据先落库；force=true 时直接丢弃不落库，用于硬删除/强制迁移） */
function evictDoc(sheetId, force) {
  const entry = docCache.get(sheetId);
  if (!entry) return;
  if (!force && entry.dirty) {
    const db = getDb();
    if (db) {
      try { persistDocEntry(db, sheetId, entry); saveDatabase(db); } catch (e) { /* 忽略 */ }
    }
  }
  const timer = persistTimers.get(sheetId);
  if (timer) { clearTimeout(timer); persistTimers.delete(sheetId); }
  docCache.delete(sheetId);
}

/** 重新从数据库加载文档（外部直接修改 doc_data 后调用，放弃内存副本） */
function reloadDoc(db, sheetId) {
  evictDoc(sheetId, true);
  return loadDoc(db, sheetId);
}

// 定时清理：在线状态 / 变更队列 / 空闲缓存
setInterval(() => {
  const now = Date.now();
  presenceMap.forEach((userMap, sheetId) => {
    userMap.forEach((info, uid) => { if (now - info.ts > PRESENCE_TTL_MS) userMap.delete(uid); });
    if (userMap.size === 0) presenceMap.delete(sheetId);
  });
  changeQueues.forEach((queue, sheetId) => {
    for (let i = queue.length - 1; i >= 0; i--) {
      if (now - queue[i].ts > CHANGE_TTL_MS) queue.splice(i, 1);
    }
    if (queue.length === 0) changeQueues.delete(sheetId);
  });
  // 空闲缓存逐出（先落库再删除）
  const db = getDb();
  if (docCache.size > 16) {
    const sorted = Array.from(docCache.entries()).sort((a, b) => a[1].lastAccess - b[1].lastAccess);
    for (const [sheetId, entry] of sorted.slice(0, docCache.size - 16)) {
      if (now - entry.lastAccess > 10 * 60 * 1000) {
        if (entry.dirty && db) {
          try { persistDocEntry(db, sheetId, entry); saveDatabase(db); } catch (e) { /* 忽略 */ }
        }
        docCache.delete(sheetId);
      }
    }
  }

  // 大小预算逐出：缓存文档 JSON 总量超限时按 LRU 逐出（脏数据先落库），防止大文档长期驻留内存
  let cachedBytes = 0;
  docCache.forEach(e => { cachedBytes += e.size || 0; });
  if (cachedBytes > MAX_CACHE_BYTES) {
    const byAge = Array.from(docCache.entries()).sort((a, b) => a[1].lastAccess - b[1].lastAccess);
    for (const [sheetId, entry] of byAge) {
      if (cachedBytes <= MAX_CACHE_BYTES) break;
      if (now - entry.lastAccess < CACHE_MIN_IDLE_MS) continue; // 最近活跃的文档不逐出
      if (entry.dirty && db) {
        try { persistDocEntry(db, sheetId, entry); saveDatabase(db); } catch (e) { /* 忽略 */ }
      }
      cachedBytes -= entry.size || 0;
      const timer = persistTimers.get(sheetId);
      if (timer) { clearTimeout(timer); persistTimers.delete(sheetId); }
      docCache.delete(sheetId);
    }
  }
}, 10000).unref();

module.exports = {
  PRESENCE_TTL_MS,
  CHANGE_TTL_MS,
  KEEP_VERSIONS,
  loadDoc,
  persistDocEntry,
  schedulePersist,
  writeSnapshot,
  shouldAutoSnapshot,
  broadcast,
  evictDoc,
  reloadDoc,
  // 共享内存状态（路由直接读写，保证跨模块一致性）
  docCache,
  presenceMap,
  changeQueues,
};
