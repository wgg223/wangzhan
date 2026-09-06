/**
 * 数据库核心模块（SQLite 双驱动支持）
 * 作用：统一管理数据库连接、初始化、迁移、保存与关闭。
 * 双驱动设计：
 *   - better-sqlite3（原生，首选）：同步 API、性能好，启动时自动加载；
 *   - sql.js（WASM 回退）：better-sqlite3 不可用（如纯 pkg 打包/无原生模块）
 *     时使用，内存数据库 + 手动 export 落盘。
 * 关键特性：
 *   - 数据库文件不存在时自动创建空文件；
 *   - sql.js 模式下所有写操作通过 scheduleSave 节流落盘（3 秒合并 + 超 20 次立即存）；
 *   - 启动时依次执行：建表 → 安装状态检查 → 默认数据 → 索引 → 去重；
 *   - 损坏的数据库文件自动备份后重建。
 */

let Database = null;       // better-sqlite3 构造函数（原生模式）
let initSqlJs = null;      // sql.js 初始化函数（WASM 模式）
let useNativeSql = false;  // 当前是否使用原生 better-sqlite3
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const fsSafe = require('../utils/fs-safe');
const { setUseNativeSql, queryOne, queryAll, generateUid } = require('./db-helpers');
const { createTables } = require('./db-schema');        // 建表
const { insertDefaultDataIfNeeded } = require('./db-seed'); // 默认数据
const { createIndexes } = require('./db-indexes');      // 索引
const { deduplicateDatabase, ensureUniqueConstraints } = require('./db-dedup'); // 去重

// 尝试加载原生驱动，失败则回退 WASM
try {
  Database = require('better-sqlite3');
  useNativeSql = true;
  setUseNativeSql(true);
} catch (err) {
  initSqlJs = require('sql.js');   // WASM 回退
}

const dbPath = require('./app-root').databasePath;   // 数据库文件绝对路径

let db = null;          // 当前数据库实例（全局单例）
let saveTimer = null;   // 落盘防抖定时器
let pendingSaves = 0;   // 等待落盘的写操作计数
let isSaving = false;   // 是否正在落盘（防重入）

const DEFAULT_CACHE_PAGES = 4000; // SQLite 页缓存：约16MB缓存（原8MB）

/**
 * 调度一次数据库落盘（仅 sql.js 模式使用）
 * 逻辑：累积写操作计数，3 秒内合并为一次落盘；
 *       若 3 秒内写操作超过 20 次则立即落盘，防止写放大。
 */
function scheduleSave() {
  if (useNativeSql) return;   // 原生模式自动持久化，无需手动保存

  pendingSaves++;

  if (isSaving) return;       // 正在落盘时只计数，由落盘完成回调再触发

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

/**
 * 执行数据库落盘：导出内存数据库 → 写入 .tmp 临时文件 → 原子重命名替换正式文件
 * 说明：先写临时文件再 rename，避免中途崩溃导致正式文件损坏。
 */
function performSave() {
  if (isSaving || !db) return;

  isSaving = true;
  pendingSaves = 0;

  try {
    const data = db.export();          // sql.js 导出完整数据库二进制
    const buffer = Buffer.from(data);
    const tempPath = dbPath + '.tmp';  // 临时文件
    fs.writeFile(tempPath, buffer, (writeErr) => {
      if (writeErr) {
        console.error('数据库保存失败(写入):', writeErr.message);
        isSaving = false;
        return;
      }
      fs.rename(tempPath, dbPath, (renameErr) => {   // 原子替换
        if (renameErr) {
          console.error('数据库保存失败(重命名):', renameErr.message);
        }
        isSaving = false;
        if (pendingSaves > 0) {          // 落盘期间又有新写操作，稍后再存一次
          saveTimer = setTimeout(performSave, 100);
        }
      });
    });
  } catch (err) {
    console.error('数据库保存失败:', err.message);
    isSaving = false;
    if (pendingSaves > 0) {
      saveTimer = setTimeout(performSave, 100);
    }
  }
}

/**
 * 初始化数据库（应用启动时调用）
 * 流程：确保文件存在 → 打开连接（原生/WASM）→ PRAGMA 优化 →
 *       建表 → 安装状态检查 → 默认数据 → 索引/唯一约束 → 去重 → 首次保存
 * @returns {Promise<Object>} 数据库实例
 */
async function initDatabase() {
  // 数据库文件不存在时先创建空文件（better-sqlite3 需要文件存在）
  if (!fs.existsSync(dbPath)) {
    fs.writeFileSync(dbPath, '');
  }

  if (useNativeSql) {
    // 原生 better-sqlite3：打开文件数据库
    db = new Database(dbPath, {
      fileMustExist: false,
      readonly: false,
      timeout: 10000,   // 锁等待超时 10 秒
    });

    // 安全与性能优化 PRAGMA 设置
    db.pragma('foreign_keys = ON');          // 启用外键约束（保证引用完整性）
    db.pragma('synchronous = NORMAL');       // 平衡性能与安全（WAL 模式下足够）
    db.pragma('journal_mode = WAL');         // WAL 日志模式（读写并发更好）
    db.pragma(`cache_size = -${DEFAULT_CACHE_PAGES}`);  // 页缓存 16MB（负数=按KB计）
    db.pragma('temp_store = MEMORY');        // 临时表/排序放内存
    db.pragma('journal_size_limit = 2097152'); // 2MB journal limit
    db.pragma('locking_mode = NORMAL');      // 默认锁模式
    db.pragma('wal_autocheckpoint = 1000');  // WAL 每 1000 页自动检查点
    db.pragma('secure_delete = FAST');       // 安全删除，平衡性能
    db.pragma('busy_timeout = 5000');        // 忙等待 5 秒

    // 包装 db.run：统一异常处理（duplicate column 是迁移正常噪音，静默）
    db.run = function(sql, params) {
      try {
        return this.prepare(sql).run(params || []);
      } catch (err) {
        // duplicate column name 是存量库 ALTER TABLE 迁移的正常噪音，静默处理
        if (!err.message || !err.message.includes('duplicate column name')) {
          console.error('SQL执行错误:', err.message, 'SQL:', sql);
        }
        throw err;
      }
    };
  } else {
    // WASM 回退：加载 sql.js，读取现有数据库文件（损坏则备份后重建）
    const SQL = await initSqlJs();

    // 清理上次崩溃残留的临时文件
    const tempPath = dbPath + '.tmp';
    if (fs.existsSync(tempPath)) {
      fsSafe.safeUnlinkSync(tempPath);
    }

    if (fs.existsSync(dbPath)) {
      const buffer = fs.readFileSync(dbPath);
      try {
        db = new SQL.Database(buffer);
      } catch (err) {
        // 文件损坏：先备份再重建空库
        console.error('数据库文件损坏，尝试修复或重建:', err.message);
        try {
          fs.copyFileSync(dbPath, dbPath + '.backup.' + Date.now());
        } catch (e) { logger.error('恢复或重建数据库失败:', e && e.message ? e.message : e); }
        db = new SQL.Database();
      }
    } else {
      db = new SQL.Database();   // 全新空库
    }

    // 同样的 PRAGMA 优化（sql.js 部分参数不支持则忽略）
    db.run('PRAGMA foreign_keys = ON');
    db.run('PRAGMA synchronous = NORMAL');
    db.run('PRAGMA journal_mode = WAL');
    db.run(`PRAGMA cache_size = -${DEFAULT_CACHE_PAGES}`);
    db.run('PRAGMA temp_store = MEMORY');
    db.run('PRAGMA journal_size_limit = 2097152');
    db.run('PRAGMA locking_mode = NORMAL');
    db.run('PRAGMA secure_delete = FAST');
  }

  // 创建所有表结构（CREATE TABLE IF NOT EXISTS）
  createTables(db);

  // 检查安装状态（app_setup 表与 .setup_completed 文件标记对齐）
  ensureSetupStatus();

  // 如果已经完成安装，创建默认数据
  if (isSetupCompleted()) {
    insertDefaultDataIfNeeded(db);
  }

  // 创建数据库索引和唯一约束
  createIndexes(db);
  ensureUniqueConstraints(db);

  // 自动去重 - 清理更新过程中产生的重复数据
  deduplicateDatabase(db);

  // 初始保存（WASM 模式下落盘一次）
  saveDatabase();

  return db;
}

/**
 * 确保安装状态正确（app_setup 表 ↔ .setup_completed 文件标记双向对齐）
 * 规则：
 *   - 表已有记录且为 true → 补文件标记；
 *   - 表无记录但文件标记存在 → 表写 true；
 *   - 两者都无 → 依据 users 表是否有数据判断：有数据=已安装，无数据=未安装；
 *   - 顺带记录数据库 PRAGMA 运行参数。
 */
function ensureSetupStatus() {
  const fileMarker = path.join(require('./app-root').projectRoot, '.setup_completed');

  // 查 app_setup 表中的安装状态
  const existing = queryOne(db, "SELECT setup_value FROM app_setup WHERE setup_key = 'setup_completed'");

  if (existing) {
    // 表已有状态：若为 true 且文件标记丢失，则补写文件标记
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

  // 表无状态但文件标记存在：以文件标记为准，写入表
  if (fs.existsSync(fileMarker)) {
    const now = new Date().toISOString();
    db.run('INSERT OR IGNORE INTO app_setup (setup_key, setup_value) VALUES (?, ?)', ['setup_completed', 'true']);
    db.run('INSERT OR IGNORE INTO app_setup (setup_key, setup_value) VALUES (?, ?)', ['completed_at', now]);
    return;
  }

  // 两者都无：用 users 表是否有数据作为安装完成的依据（升级场景兼容）
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
    // 全新安装：标记为未完成，等待 /setup 页面完成初始化
    const now = new Date().toISOString();
    db.run('INSERT OR IGNORE INTO app_setup (setup_key, setup_value) VALUES (?, ?)', ['setup_completed', 'false']);
    db.run('INSERT OR IGNORE INTO app_setup (setup_key, setup_value) VALUES (?, ?)', ['created_at', now]);
  }

  // 记录当前数据库运行参数（后台设置页可读）
  db.run('INSERT OR IGNORE INTO app_setup (setup_key, setup_value) VALUES (?, ?)', ['db_journal_mode', 'WAL']);
  db.run('INSERT OR IGNORE INTO app_setup (setup_key, setup_value) VALUES (?, ?)', ['db_synchronous', 'NORMAL']);
  db.run('INSERT OR IGNORE INTO app_setup (setup_key, setup_value) VALUES (?, ?)', ['db_cache_size', String(DEFAULT_CACHE_PAGES)]);
}

/**
 * 检查安装是否已完成
 * @returns {boolean} true=已安装（app_setup.setup_completed = 'true'）
 */
function isSetupCompleted() {
  const result = queryOne(db, "SELECT setup_value FROM app_setup WHERE setup_key = 'setup_completed'");
  return result && result.setup_value === 'true';
}

/**
 * 标记安装为已完成（安装向导最后一步调用）
 * 同时更新 app_setup 表与 .setup_completed 文件标记。
 */
function markSetupCompleted() {
  const now = new Date().toISOString();
  db.run("UPDATE app_setup SET setup_value = ? WHERE setup_key = 'setup_completed'", ['true']);

  // 记录完成时间（存在则更新，不存在则插入）
  const existing = queryOne(db, "SELECT id FROM app_setup WHERE setup_key = 'completed_at'");
  if (existing) {
    db.run("UPDATE app_setup SET setup_value = ? WHERE setup_key = 'completed_at'", [now]);
  } else {
    db.run('INSERT INTO app_setup (setup_key, setup_value) VALUES (?, ?)', ['completed_at', now]);
  }

  // 写文件标记（安装完成的持久凭证）
  const fileMarker = path.join(require('./app-root').projectRoot, '.setup_completed');
  try {
    fs.writeFileSync(fileMarker, now);
  } catch (e) {
    // 文件创建失败不影响主流程
  }

  saveDatabase();
}

/**
 * 应用数据库 PRAGMA 设置（后台"数据库优化"功能调用）
 * @param {Object} pragmaSettings - { journal_mode, synchronous, cache_size }
 * 说明：同时把生效的参数写回 app_setup 表持久化，下次启动沿用。
 */
function applyPragmaSettings(pragmaSettings) {
  if (!db) return;

  // 按驱动分别执行 PRAGMA
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

  // 把生效的 journal_mode 写回 app_setup 持久化
  if (pragmaSettings.journal_mode) {
    const existing = queryOne(db, "SELECT id FROM app_setup WHERE setup_key = 'db_journal_mode'");
    if (existing) {
      db.run("UPDATE app_setup SET setup_value = ? WHERE setup_key = 'db_journal_mode'", [pragmaSettings.journal_mode]);
    } else {
      db.run('INSERT INTO app_setup (setup_key, setup_value) VALUES (?, ?)', ['db_journal_mode', pragmaSettings.journal_mode]);
    }
  }

  // 同步写回 synchronous
  if (pragmaSettings.synchronous) {
    const existingSync = queryOne(db, "SELECT id FROM app_setup WHERE setup_key = 'db_synchronous'");
    if (existingSync) {
      db.run("UPDATE app_setup SET setup_value = ? WHERE setup_key = 'db_synchronous'", [pragmaSettings.synchronous]);
    } else {
      db.run('INSERT INTO app_setup (setup_key, setup_value) VALUES (?, ?)', ['db_synchronous', pragmaSettings.synchronous]);
    }
  }

  // 同步写回 cache_size
  if (pragmaSettings.cache_size) {
    const existingCache = queryOne(db, "SELECT id FROM app_setup WHERE setup_key = 'db_cache_size'");
    if (existingCache) {
      db.run("UPDATE app_setup SET setup_value = ? WHERE setup_key = 'db_cache_size'", [String(pragmaSettings.cache_size)]);
    } else {
      db.run('INSERT INTO app_setup (setup_key, setup_value) VALUES (?, ?)', ['db_cache_size', String(pragmaSettings.cache_size)]);
    }
  }

  saveDatabase();
}

/**
 * 保存数据库（sql.js 需要手动保存；原生模式为空操作）
 */
function saveDatabase() {
  if (!useNativeSql && db) {
    scheduleSave();
  }
}

/**
 * 获取当前数据库实例
 * @returns {Object|null} 数据库实例
 */
function getDb() {
  return db;
}

/**
 * 关闭数据库连接（优雅退出时调用）
 * sql.js 模式先同步落盘再关闭，避免异步保存未完成就退出丢数据。
 */
function closeDatabase() {
  if (db) {
    try {
      if (!useNativeSql) {
        // 同步保存确保数据落盘，避免异步 performSave 未完成就 close
        try {
          const data = db.export();
          const buffer = Buffer.from(data);
          const tempPath = dbPath + '.tmp';
          fs.writeFileSync(tempPath, buffer);
          fs.renameSync(tempPath, dbPath);
        } catch (saveErr) {
          logger.error('关闭时数据库保存失败:', saveErr.message);
        }
      }
      db.close();   // 关闭连接
      db = null;
    } catch (err) {
      logger.error('关闭数据库失败:', err.message);
    }
  }
}

/**
 * 关闭并删除数据库文件（用于"重置系统"功能）
 * 同时删除数据库、临时文件与 .setup_completed 标记，使系统回到未安装状态。
 */
function closeAndDeleteDatabase() {
  closeDatabase();
  try {
    fsSafe.safeUnlinkSync(dbPath);           // 删除数据库文件
    const tempPath = dbPath + '.tmp';
    fsSafe.safeUnlinkSync(tempPath);         // 删除临时文件
    const fileMarker = path.join(require('./app-root').projectRoot, '.setup_completed');
    fsSafe.safeUnlinkSync(fileMarker);       // 删除安装标记
    logger.info('数据库文件及相关文件已删除');
  } catch (err) {
    logger.error('删除数据库文件失败:', err && err.message ? err.message : err);
  }
}

/**
 * 获取数据库文件路径
 * @returns {string} 数据库文件绝对路径
 */
function getDbPath() {
  return dbPath;
}

// 导出数据库模块的全部公共 API
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
