/**
 * 在线Office文档共享存储（前台路由 + 后台管理路由共用）
 *
 * 职责：
 *  - 文档内存缓存（docCache），保证同一进程内所有模块读写同一份文档
 *  - 支持多种文档类型：spreadsheet（表格）、document（文档）、presentation（演示文稿）
 *  - 大文档自动文件存储（>10MB 存文件系统，SQLite 只存路径）
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
const officeDocStore = require('./office-doc-store');

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

/** 获取文档（优先内存缓存，其次数据库/文件；Luckysheet 旧数据惰性迁移） */
function loadDoc(db, sheetId) {
  const cached = docCache.get(sheetId);
  if (cached) {
    cached.lastAccess = Date.now();
    return cached;
  }
  const row = queryOne(db,
    'SELECT doc_data, doc_version, doc_file, doc_type, luckysheet_data FROM spreadsheets WHERE id = ?',
    [sheetId]);
  if (!row) return null;

  let doc = null;

  // 优先从文件存储加载（大文档）
  if (row.doc_file) {
    const result = officeDocStore.readDocFile(sheetId);
    if (result.data) {
      try { doc = JSON.parse(result.data); } catch (e) { doc = null; }
    }
  } else if (row.doc_data) {
    try { doc = JSON.parse(row.doc_data); } catch (e) { doc = null; }
  }

  // 惰性迁移：Luckysheet 旧数据 → Univer（仅 spreadsheet 类型）
  let migrated = null;
  const docType = row.doc_type || 'spreadsheet';
  if (!doc && row.luckysheet_data && docType === 'spreadsheet') {
    const result = migrateLuckysheetToUniver(row.luckysheet_data);
    if (result && result.workbook) {
      doc = result.workbook;
      migrated = result;
    }
  }

  // 空文档：根据类型创建默认模板
  if (!doc) {
    if (docType === 'spreadsheet') {
      doc = createEmptyUniverDoc('');
    } else if (docType === 'document') {
      doc = createEmptyDocument();
    } else if (docType === 'presentation') {
      doc = createEmptyPresentation();
    } else {
      doc = createEmptyUniverDoc('');
    }
  }

  const jsonStr = JSON.stringify(doc);
  const entry = {
    doc,
    docType,
    version: row.doc_version || 0,
    lastAccess: Date.now(),
    dirty: false,
    lastPersistAt: Date.now(),
    lastSnapshotAt: 0,
    size: jsonStr.length,
    useFileStorage: !!row.doc_file,
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

/** 全量持久化文档（立即写库/文件，大文档自动使用文件存储） */
function persistDocEntry(db, sheetId, entry) {
  const json = JSON.stringify(entry.doc);
  const result = officeDocStore.saveDoc(db, sheetId, json, entry.version);
  entry.dirty = false;
  entry.size = json.length;
  entry.useFileStorage = result.useFile;
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

/** 创建空文档模板（Univer Docs 格式） */
function createEmptyDocument(title) {
  return {
    id: 'doc_' + Date.now(),
    appVersion: '1.0.0',
    name: title || '未命名文档',
    docType: 'document',
    body: {
      dataStream: '\r\n',
      sectionBreaks: [{ startIndex: 0 }],
      paragraphs: [{ startIndex: 0, paragraphStyle: {} }],
      textRuns: [],
    },
    documentStyle: {
      pageSize: { width: 595, height: 842 }, // A4
      marginTop: 72, marginBottom: 72, marginLeft: 90, marginRight: 90,
    },
    drawings: {},
    drawingsOrder: [],
    resources: '[]',
  };
}

// ============ 页面设置（纸张 / 页边距 / 页眉页脚 / 分栏） ============

// Univer 自有的 documentStyle 只保证 pageSize 与边距，其余字段是本项目扩展的。
// 编辑器每次保存都会回传 Univer 快照，扩展字段可能被丢掉，所以保存前先留住库里的版本。
const PAGE_SETUP_KEYS = [
  'pageSize', 'marginTop', 'marginBottom', 'marginLeft', 'marginRight',
  'pageOrient', 'columnProperties', 'pageNumberStart', 'headerFooterConfig'
];

const PAGE_PRESETS = {
  A4: { width: 595, height: 842 },
  A5: { width: 420, height: 595 },
  B5: { width: 499, height: 709 },
  LETTER: { width: 612, height: 792 }
};

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function readPageSetup(doc) {
  const ds = (doc && doc.documentStyle) || {};
  const size = ds.pageSize || PAGE_PRESETS.A4;
  const cols = Array.isArray(ds.columnProperties) ? ds.columnProperties.length : 1;
  const hf = ds.headerFooterConfig || {};
  const orient = ds.pageOrient === 'landscape' || size.width > size.height ? 'landscape' : 'portrait';
  return {
    paper: nameOfPaper(size),
    width: num(size.width, 595),
    height: num(size.height, 842),
    orientation: orient,
    margins: {
      top: num(ds.marginTop, 72), bottom: num(ds.marginBottom, 72),
      left: num(ds.marginLeft, 90), right: num(ds.marginRight, 90),
    },
    columns: Math.max(1, Math.min(4, cols || 1)),
    pageNumberStart: num(ds.pageNumberStart, 1),
    header: { enabled: Boolean(hf.header && hf.header.enabled), content: (hf.header && hf.header.content) || '' },
    footer: { enabled: Boolean(hf.footer && hf.footer.enabled), content: (hf.footer && hf.footer.content) || '' },
  };
}

function nameOfPaper(size) {
  const w = num(size.width, 0), h = num(size.height, 0);
  const long = Math.max(w, h), short = Math.min(w, h);
  let best = 'CUSTOM', bestDiff = Infinity;
  Object.keys(PAGE_PRESETS).forEach(name => {
    const p = PAGE_PRESETS[name];
    const diff = Math.abs(p.height - long) + Math.abs(p.width - short);
    if (diff <= 2 && diff < bestDiff) { best = name; bestDiff = diff; }
  });
  return best;
}

function applyPageSetup(doc, setup) {
  if (!doc || !setup) return readPageSetup(doc);
  const ds = doc.documentStyle || (doc.documentStyle = {});
  const orient = setup.orientation === 'landscape' ? 'landscape' : 'portrait';
  const preset = PAGE_PRESETS[String(setup.paper || 'A4').toUpperCase()] || PAGE_PRESETS.A4;
  let w = preset.width, h = preset.height;
  if (String(setup.paper || '').toUpperCase() === 'CUSTOM') {
    const cur = ds.pageSize || {};
    w = num(setup.width, num(cur.width, w));
    h = num(setup.height, num(cur.height, h));
  }
  ds.pageSize = orient === 'landscape'
    ? { width: Math.max(w, h), height: Math.min(w, h) }
    : { width: Math.min(w, h), height: Math.max(w, h) };
  ds.pageOrient = orient;
  const m = setup.margins || {};
  ds.marginTop = num(m.top, 72); ds.marginBottom = num(m.bottom, 72);
  ds.marginLeft = num(m.left, 90); ds.marginRight = num(m.right, 90);
  const colCount = Math.max(1, Math.min(4, num(setup.columns, 1)));
  ds.columnProperties = [];
  for (let i = 0; i < colCount; i++) ds.columnProperties.push({ width: 0, gap: 18 });
  ds.pageNumberStart = num(setup.pageNumberStart, 1);
  ds.headerFooterConfig = {
    header: { enabled: Boolean(setup.header && setup.header.enabled), content: String((setup.header && setup.header.content) || '') },
    footer: { enabled: Boolean(setup.footer && setup.footer.enabled), content: String((setup.footer && setup.footer.content) || '') },
  };
  return readPageSetup(doc);
}

/** 把库里已有的页面设置补回 Univer 回传的快照，避免编辑器保存后丢配置 */
function preservePageSetup(incomingDoc, existingDoc) {
  if (!incomingDoc || !existingDoc) return incomingDoc;
  const from = existingDoc.documentStyle;
  const to = incomingDoc.documentStyle;
  if (!from) return incomingDoc;
  if (!to) {
    incomingDoc.documentStyle = from;
    return incomingDoc;
  }
  PAGE_SETUP_KEYS.forEach(key => {
    if (to[key] === undefined && from[key] !== undefined) to[key] = from[key];
  });
  return incomingDoc;
}

/** 创建空演示文稿模板（版式与 public/js/ppt-scene.js 的 LAYOUTS 保持一致，改动需同步） */
function pptElement(id, role, x, y, width, height, content, style) {
  return { id: id, type: 'text', x: x, y: y, width: width, height: height, content: content, style: style, role: role };
}

function createEmptyPresentation(title) {
  const name = title || '未命名演示文稿';
  return {
    id: 'ppt_' + Date.now(),
    appVersion: '1.0.0',
    name: name,
    docType: 'presentation',
    slideWidth: 960,
    slideHeight: 540,
    slides: [
      {
        id: 'slide_1',
        title: '点击添加标题',
        layout: 'title',
        background: '#ffffff',
        elements: [
          pptElement('title_1', 'title', 80, 150, 800, 110, '点击添加标题', {
            fontSize: 44, fontWeight: 'bold', textAlign: 'center', valign: 'middle', color: '#1f2937'
          }),
          pptElement('subtitle_1', 'subtitle', 140, 280, 680, 70, name, {
            fontSize: 24, textAlign: 'center', valign: 'middle', color: '#6b7280'
          })
        ],
        notes: '开场页：介绍主题和演讲人。',
        transition: { type: 'fade', duration: 400 },
        hidden: false
      },
      {
        id: 'slide_2',
        title: '点击添加标题',
        layout: 'title-content',
        background: '#ffffff',
        elements: [
          pptElement('title_2', 'title', 60, 40, 840, 80, '点击添加标题', {
            fontSize: 32, fontWeight: 'bold', textAlign: 'left', valign: 'middle', color: '#1f2937'
          }),
          pptElement('body_2', 'body', 60, 140, 840, 350, '点击输入内容', {
            fontSize: 20, textAlign: 'left', valign: 'top', color: '#374151', lineHeight: 1.5
          })
        ],
        notes: '',
        transition: { type: 'fade', duration: 400 },
        hidden: false
      },
      {
        id: 'slide_3',
        title: '点击添加章节标题',
        layout: 'section',
        background: '#4472C4',
        elements: [
          pptElement('title_3', 'title', 80, 200, 620, 100, '点击添加章节标题', {
            fontSize: 40, fontWeight: 'bold', textAlign: 'left', valign: 'middle', color: '#ffffff'
          }),
          pptElement('subtitle_3', 'subtitle', 80, 310, 620, 60, '点击添加副标题', {
            fontSize: 20, textAlign: 'left', valign: 'middle', color: '#e5e7eb'
          })
        ],
        notes: '',
        transition: { type: 'slide', duration: 400 },
        hidden: false
      }
    ],
    slideOrder: ['slide_1', 'slide_2', 'slide_3'],
    masters: [],
    themes: [{ name: '默认', primaryColor: '#4472C4', backgroundColor: '#ffffff' }],
    resources: '[]',
  };
}

/**
 * 新建文档并落库（导入/创建共用）
 * 大文档 JSON 超过阈值时改走文件存储，避免单条 SQLite 记录过大撑爆内存
 * @param {object} db
 * @param {{name, description, createdBy, docType, doc}} opts
 * @returns {number} 新文档 id
 */
function insertDoc(db, opts) {
  const json = JSON.stringify(opts.doc);
  const result = db.run(
    'INSERT INTO spreadsheets (name, description, created_by, doc_data, doc_version, doc_type) VALUES (?, ?, ?, ?, 1, ?)',
    [opts.name, opts.description || '', opts.createdBy, json, opts.docType]
  );
  const id = result.lastInsertRowid;
  const saved = officeDocStore.saveDoc(db, id, json, 1);
  if (!saved.success) {
    // 文件写入失败则回滚该行，避免留下无数据的空文档
    db.run('DELETE FROM spreadsheets WHERE id = ?', [id]);
    throw new Error(saved.error || '文档保存失败');
  }
  return id;
}

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
  createEmptyDocument,
  createEmptyPresentation,
  readPageSetup,
  applyPageSetup,
  preservePageSetup,
  insertDoc,
  // 共享内存状态（路由直接读写，保证跨模块一致性）
  docCache,
  presenceMap,
  changeQueues,
};
