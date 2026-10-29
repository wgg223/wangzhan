/**
 * SQLite 会话存储（express-session 自定义 Store）
 * 作用：把会话数据从进程内存（默认 MemoryStore）迁移到 SQLite 表，
 *       降低 V8 堆内存驻留（会话不再常驻内存），同时让会话在服务重启后保持有效（用户不掉线）。
 * 说明：
 *   - 仅在 better-sqlite3 原生模式下启用；sql.js 回退模式继续使用内存存储；
 *   - 会话以 JSON 文本存储，expires 为毫秒时间戳，与 cookie maxAge（24 小时）对齐；
 *   - 定期清理过期会话，防止 sessions 表无限增长；
 *   - store 通过 getDb 延迟取数据库实例（初始化发生在模块加载之后）；
 *   - 优化：预创建 prepared statement 缓存，会话操作（每请求热路径）无需重复编译 SQL。
 */

const { queryOne } = require('./db-helpers');
const session = require('express-session'); // 基类 session.Store（EventEmitter），express-session 要求自定义 Store 具备 on/emit

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 默认 24 小时，与会话 cookie maxAge 一致
const DEFAULT_CLEANUP_MS = 15 * 60 * 1000; // 过期会话清理周期：15 分钟

class SqliteSessionStore extends session.Store {
  /**
   * @param {Function} getDb - 返回当前数据库实例的函数（延迟取，兼容启动顺序）
   * @param {Object} [options] - { ttlMs, cleanupIntervalMs }
   */
  constructor(getDb, options = {}) {
    super(); // 初始化 EventEmitter（express-session 会调用 store.on/emit）
    this.getDb = getDb;
    this.ttlMs = options.ttlMs || DEFAULT_TTL_MS;
    this.cleanupIntervalMs = options.cleanupIntervalMs || DEFAULT_CLEANUP_MS;
    this._tableReady = false;
    // 预编译 prepared statement 缓存（延迟到 _db() 首次成功时创建）
    this._stmts = {
      get: null,
      set: null,
      destroy: null,
      touch: null,
      cleanup: null
    };

    // 定时清理过期会话
    this._cleanupTimer = setInterval(() => this._cleanup(), this.cleanupIntervalMs);
    if (this._cleanupTimer.unref) {
      this._cleanupTimer.unref(); // 不阻止进程退出
    }
  }

  /**
   * 确保 sessions 表存在并预编译 prepared statement（延迟到首次使用）
   * @returns {Object|null} 数据库实例（未就绪返回 null）
   */
  _db() {
    const db = this.getDb();
    if (!db) return null;
    if (!this._tableReady) {
      try {
        db.run(`CREATE TABLE IF NOT EXISTS sessions (
          sid TEXT PRIMARY KEY,
          data TEXT NOT NULL,
          expires INTEGER NOT NULL
        )`);
        db.run('CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires)');
        this._tableReady = true;

        // 预编译高频操作的 prepared statement（better-sqlite3 模式）
        if (typeof db.prepare === 'function' && db.prepare.length <= 1) {
          try {
            this._stmts.get = db.prepare('SELECT data, expires FROM sessions WHERE sid = ?');
            this._stmts.set = db.prepare(
              'INSERT INTO sessions (sid, data, expires) VALUES (?, ?, ?) ' +
              'ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires = excluded.expires'
            );
            this._stmts.destroy = db.prepare('DELETE FROM sessions WHERE sid = ?');
            this._stmts.touch = db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?');
            this._stmts.cleanup = db.prepare('DELETE FROM sessions WHERE expires <= ?');
          } catch (stmtErr) {
            // prepared statement 创建失败时回退到普通 db.run（sql.js 兼容路径）
            this._stmts.get = null;
          }
        }
      } catch (err) {
        console.error('[session] sessions 表初始化失败:', err.message);
      }
    }
    return db;
  }

  /**
   * 计算会话过期时间戳（优先取 session.cookie.maxAge，缺省用默认 TTL）
   */
  _getExpiry(session) {
    const maxAge = session && session.cookie &&
      typeof session.cookie.maxAge === 'number' && session.cookie.maxAge > 0
      ? session.cookie.maxAge
      : this.ttlMs;
    return Date.now() + maxAge;
  }

  get(sid, callback) {
    try {
      const db = this._db();
      if (!db) return callback && callback(null, null);

      // 优先使用预编译的 prepared statement
      let row;
      if (this._stmts.get) {
        row = this._stmts.get.get(sid) || null;
      } else {
        row = queryOne(db, 'SELECT data, expires FROM sessions WHERE sid = ?', [sid]);
      }

      if (!row) return callback && callback(null, null);
      if (row.expires <= Date.now()) {
        this.destroy(sid, () => {});
        return callback && callback(null, null);
      }
      let session = null;
      try {
        session = JSON.parse(row.data);
      } catch (e) {
        session = null;
      }
      callback && callback(null, session);
    } catch (err) {
      callback && callback(err);
    }
  }

  set(sid, session, callback) {
    try {
      const db = this._db();
      if (!db) return callback && callback(new Error('数据库未就绪'));
      const data = JSON.stringify(session);
      const expires = this._getExpiry(session);

      if (this._stmts.set) {
        this._stmts.set.run(sid, data, expires);
      } else {
        db.run(
          'INSERT INTO sessions (sid, data, expires) VALUES (?, ?, ?) ' +
          'ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires = excluded.expires',
          [sid, data, expires]
        );
      }
      callback && callback(null);
    } catch (err) {
      callback && callback(err);
    }
  }

  destroy(sid, callback) {
    try {
      const db = this._db();
      if (!db) return callback && callback(new Error('数据库未就绪'));

      if (this._stmts.destroy) {
        this._stmts.destroy.run(sid);
      } else {
        db.run('DELETE FROM sessions WHERE sid = ?', [sid]);
      }
      callback && callback(null);
    } catch (err) {
      callback && callback(err);
    }
  }

  touch(sid, session, callback) {
    try {
      const db = this._db();
      if (!db) return callback && callback(new Error('数据库未就绪'));
      const expires = this._getExpiry(session);

      if (this._stmts.touch) {
        this._stmts.touch.run(expires, sid);
      } else {
        db.run('UPDATE sessions SET expires = ? WHERE sid = ?', [expires, sid]);
      }
      callback && callback(null);
    } catch (err) {
      callback && callback(err);
    }
  }

  /**
   * 清理过期会话（定时 + 进程退出前调用）
   */
  _cleanup() {
    try {
      const db = this._db();
      if (!db) return;

      if (this._stmts.cleanup) {
        this._stmts.cleanup.run(Date.now());
      } else {
        db.run('DELETE FROM sessions WHERE expires <= ?', [Date.now()]);
      }
    } catch (err) {
      // 清理失败不影响主流程
    }
  }

  close() {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }
    this._cleanup();
  }
}

module.exports = { SqliteSessionStore, DEFAULT_TTL_MS };
