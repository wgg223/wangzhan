let Database = null;
let initSqlJs = null;
let useNativeSql = false;
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const fsSafe = require('../utils/fs-safe');
const { setUseNativeSql, queryOne, queryAll, generateUid } = require('./db-helpers');
const { createTables } = require('./db-schema');
const { insertDefaultDataIfNeeded } = require('./db-seed');
const { createIndexes } = require('./db-indexes');

try {
  Database = require('better-sqlite3');
  useNativeSql = true;
  setUseNativeSql(true);
} catch (err) {
  initSqlJs = require('sql.js');
}

const dbPath = path.join(__dirname, '../../database.sqlite');

let db = null;
let saveTimer = null;
let pendingSaves = 0;
let isSaving = false;

const DEFAULT_CACHE_PAGES = 2000; // 约8MB缓存

function scheduleSave() {
  if (useNativeSql) return;

  pendingSaves++;

  if (isSaving) return;

  if (saveTimer) {
    clearTimeout(saveTimer);
  }

  saveTimer = setTimeout(() => {
    performSave();
  }, 3000);

  if (pendingSaves > 20) {
    if (saveTimer) {
      clearTimeout(saveTimer);
    }
    performSave();
  }
}

function performSave() {
  if (isSaving || !db) return;

  isSaving = true;
  pendingSaves = 0;

  try {
    const data = db.export();
    const buffer = Buffer.from(data);
    const tempPath = dbPath + '.tmp';
    fs.writeFileSync(tempPath, buffer);
    fs.renameSync(tempPath, dbPath);
  } catch (err) {
    console.error('数据库保存失败:', err.message);
  } finally {
    isSaving = false;
    if (pendingSaves > 0) {
      saveTimer = setTimeout(performSave, 100);
    }
  }
}

async function initDatabase() {
  if (!fs.existsSync(dbPath)) {
    fs.writeFileSync(dbPath, '');
  }

  if (useNativeSql) {
    db = new Database(dbPath, {
      fileMustExist: false,
      readonly: false,
      timeout: 5000,
    });

    db.pragma('foreign_keys = ON');
    db.pragma('synchronous = NORMAL');
    db.pragma('journal_mode = WAL');
    db.pragma(`cache_size = -${DEFAULT_CACHE_PAGES}`);
    db.pragma('temp_store = MEMORY');
    db.pragma('journal_size_limit = 1048576');
    db.pragma('locking_mode = NORMAL');

    db.run = function(sql, params) {
      try {
        return this.prepare(sql).run(params || []);
      } catch (err) {
        console.error('SQL执行错误:', err.message, 'SQL:', sql, 'Params:', params);
        throw err;
      }
    };
  } else {
    const SQL = await initSqlJs();

    const tempPath = dbPath + '.tmp';
    if (fs.existsSync(tempPath)) {
      fsSafe.safeUnlinkSync(tempPath);
    }

    if (fs.existsSync(dbPath)) {
      const buffer = fs.readFileSync(dbPath);
      try {
        db = new SQL.Database(buffer);
      } catch (err) {
        console.error('数据库文件损坏，尝试修复或重建:', err.message);
        try {
          fs.copyFileSync(dbPath, dbPath + '.backup.' + Date.now());
        } catch (e) { logger.error('恢复或重建数据库失败:', e && e.message ? e.message : e); }
        db = new SQL.Database();
      }
    } else {
      db = new SQL.Database();
    }

    db.run('PRAGMA foreign_keys = ON');
    db.run('PRAGMA synchronous = NORMAL');
    db.run('PRAGMA journal_mode = WAL');
    db.run(`PRAGMA cache_size = -${DEFAULT_CACHE_PAGES}`);
    db.run('PRAGMA temp_store = MEMORY');
    db.run('PRAGMA journal_size_limit = 1048576');
    db.run('PRAGMA locking_mode = NORMAL');
  }

  // 创建所有表结构
  createTables(db);

  // 检查安装状态
  ensureSetupStatus();

  // 如果已经完成安装，创建默认数据
  if (isSetupCompleted()) {
    insertDefaultDataIfNeeded(db);
  }

  // 创建数据库索引
  createIndexes(db);

  // 初始保存
  saveDatabase();

  return db;
}

/**
 * 确保安装状态正确
 */
function ensureSetupStatus() {
  const fileMarker = path.join(__dirname, '../../.setup_completed');

  const existing = queryOne(db, "SELECT setup_value FROM app_setup WHERE setup_key = 'setup_completed'");

  if (existing) {
    if (existing.setup_value === 'true') {
      try {
        if (!fs.existsSync(fileMarker)) {
          fs.writeFileSync(fileMarker, new Date().toISOString());
          logger.info('[安装状态] 恢复 .setup_completed 文件标记');
        }
      } catch (e) { /* 忽略 */ }
    }
    return;
  }

  if (fs.existsSync(fileMarker)) {
    const now = new Date().toISOString();
    db.run('INSERT OR IGNORE INTO app_setup (setup_key, setup_value) VALUES (?, ?)', ['setup_completed', 'true']);
    db.run('INSERT OR IGNORE INTO app_setup (setup_key, setup_value) VALUES (?, ?)', ['completed_at', now]);
    return;
  }

  let hasData = false;
  try {
    const userCount = queryOne(db, 'SELECT COUNT(*) as count FROM users');
    if (userCount && userCount.count > 0) {
      hasData = true;
    }
  } catch (e) { /* 表刚创建，没有数据 */ }

  if (hasData) {
    const now = new Date().toISOString();
    db.run('INSERT OR IGNORE INTO app_setup (setup_key, setup_value) VALUES (?, ?)', ['setup_completed', 'true']);
    db.run('INSERT OR IGNORE INTO app_setup (setup_key, setup_value) VALUES (?, ?)', ['completed_at', now]);
    try {
      if (!fs.existsSync(fileMarker)) {
        fs.writeFileSync(fileMarker, now);
      }
    } catch (e) { /* 忽略 */ }
  } else {
    const now = new Date().toISOString();
    db.run('INSERT OR IGNORE INTO app_setup (setup_key, setup_value) VALUES (?, ?)', ['setup_completed', 'false']);
    db.run('INSERT OR IGNORE INTO app_setup (setup_key, setup_value) VALUES (?, ?)', ['created_at', now]);
  }

  db.run('INSERT OR IGNORE INTO app_setup (setup_key, setup_value) VALUES (?, ?)', ['db_journal_mode', 'WAL']);
  db.run('INSERT OR IGNORE INTO app_setup (setup_key, setup_value) VALUES (?, ?)', ['db_synchronous', 'NORMAL']);
  db.run('INSERT OR IGNORE INTO app_setup (setup_key, setup_value) VALUES (?, ?)', ['db_cache_size', String(DEFAULT_CACHE_PAGES)]);
}

/**
 * 检查安装是否已完成
 */
function isSetupCompleted() {
  const result = queryOne(db, "SELECT setup_value FROM app_setup WHERE setup_key = 'setup_completed'");
  return result && result.setup_value === 'true';
}

/**
 * 标记安装为已完成
 */
function markSetupCompleted() {
  const now = new Date().toISOString();
  db.run("UPDATE app_setup SET setup_value = ? WHERE setup_key = 'setup_completed'", ['true']);

  const existing = queryOne(db, "SELECT id FROM app_setup WHERE setup_key = 'completed_at'");
  if (existing) {
    db.run("UPDATE app_setup SET setup_value = ? WHERE setup_key = 'completed_at'", [now]);
  } else {
    db.run('INSERT INTO app_setup (setup_key, setup_value) VALUES (?, ?)', ['completed_at', now]);
  }

  const fileMarker = path.join(__dirname, '../../.setup_completed');
  try {
    fs.writeFileSync(fileMarker, now);
  } catch (e) {
    // 文件创建失败不影响主流程
  }

  saveDatabase();
}

/**
 * 应用数据库 PRAGMA 设置
 */
function applyPragmaSettings(pragmaSettings) {
  if (!db) return;

  if (useNativeSql) {
    if (pragmaSettings.journal_mode) {
      db.pragma(`journal_mode = ${pragmaSettings.journal_mode}`);
    }
    if (pragmaSettings.synchronous) {
      db.pragma(`synchronous = ${pragmaSettings.synchronous}`);
    }
    if (pragmaSettings.cache_size) {
      db.pragma(`cache_size = ${pragmaSettings.cache_size}`);
    }
  } else {
    if (pragmaSettings.journal_mode) {
      db.run(`PRAGMA journal_mode = ${pragmaSettings.journal_mode}`);
    }
    if (pragmaSettings.synchronous) {
      db.run(`PRAGMA synchronous = ${pragmaSettings.synchronous}`);
    }
    if (pragmaSettings.cache_size) {
      db.run(`PRAGMA cache_size = ${pragmaSettings.cache_size}`);
    }
  }

  if (pragmaSettings.journal_mode) {
    const existing = queryOne(db, "SELECT id FROM app_setup WHERE setup_key = 'db_journal_mode'");
    if (existing) {
      db.run("UPDATE app_setup SET setup_value = ? WHERE setup_key = 'db_journal_mode'", [pragmaSettings.journal_mode]);
    } else {
      db.run('INSERT INTO app_setup (setup_key, setup_value) VALUES (?, ?)', [pragmaSettings.journal_mode]);
    }
  }

  if (pragmaSettings.synchronous) {
    const existingSync = queryOne(db, "SELECT id FROM app_setup WHERE setup_key = 'db_synchronous'");
    if (existingSync) {
      db.run("UPDATE app_setup SET setup_value = ? WHERE setup_key = 'db_synchronous'", [pragmaSettings.synchronous]);
    } else {
      db.run('INSERT INTO app_setup (setup_key, setup_value) VALUES (?, ?)', [pragmaSettings.synchronous]);
    }
  }

  if (pragmaSettings.cache_size) {
    const existingCache = queryOne(db, "SELECT id FROM app_setup WHERE setup_key = 'db_cache_size'");
    if (existingCache) {
      db.run("UPDATE app_setup SET setup_value = ? WHERE setup_key = 'db_cache_size'", [String(pragmaSettings.cache_size)]);
    } else {
      db.run('INSERT INTO app_setup (setup_key, setup_value) VALUES (?, ?)', [String(pragmaSettings.cache_size)]);
    }
  }

  saveDatabase();
}

/**
 * 保存数据库（sql.js 需要手动保存）
 */
function saveDatabase() {
  if (!useNativeSql && db) {
    scheduleSave();
  }
}

/**
 * 获取当前数据库实例
 */
function getDb() {
  return db;
}

/**
 * 关闭数据库连接
 */
function closeDatabase() {
  if (db) {
    try {
      if (!useNativeSql) {
        performSave();
      }
      db.close();
      db = null;
    } catch (err) {
      // 关闭失败不影响主流程
    }
  }
}

/**
 * 关闭并删除数据库文件（用于重置）
 */
function closeAndDeleteDatabase() {
  closeDatabase();
  try {
    fsSafe.safeUnlinkSync(dbPath);
    const tempPath = dbPath + '.tmp';
    fsSafe.safeUnlinkSync(tempPath);
    const fileMarker = path.join(__dirname, '../../.setup_completed');
    fsSafe.safeUnlinkSync(fileMarker);
    logger.info('数据库文件及相关文件已删除');
  } catch (err) {
    logger.error('删除数据库文件失败:', err && err.message ? err.message : err);
  }
}

/**
 * 获取数据库文件路径
 */
function getDbPath() {
  return dbPath;
}

module.exports = {
  initDatabase,
  createTables: () => createTables(db),
  applyPragmaSettings,
  ensureSetupStatus,
  isSetupCompleted,
  markSetupCompleted,
  insertDefaultDataIfNeeded: () => insertDefaultDataIfNeeded(db),
  saveDatabase,
  queryOne,
  queryAll,
  getDb,
  closeDatabase,
  closeAndDeleteDatabase,
  getDbPath,
  generateUid,
};
