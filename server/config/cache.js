/**
 * 增强型内存缓存模块
 * 针对2核2G服务器优化，减少数据库重复查询
 * 支持 LRU 淘汰、最大容量限制、分层 TTL
 */

class MemoryCache {
  constructor(ttlSeconds = 30, maxSize = 500) {
    this.cache = new Map();
    this.ttl = ttlSeconds * 1000; // 毫秒
    this.maxSize = maxSize;
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;

    // 每5分钟清理过期缓存
    this._cleanupTimer = setInterval(() => this.cleanup(), 5 * 60 * 1000);
    // 每30分钟输出缓存统计
    this._statsTimer = setInterval(() => {
      if (process.env.NODE_ENV === 'development') {
        console.log('[Cache]', JSON.stringify(this.getStats()));
      }
    }, 30 * 60 * 1000);
  }

  /**
   * 获取缓存值
   * @param {string} key
   * @returns {*} 缓存的值或 null
   */
  get(key) {
    const item = this.cache.get(key);
    if (!item) {
      this.misses++;
      return null;
    }

    if (Date.now() > item.expiry) {
      this.cache.delete(key);
      this.misses++;
      return null;
    }

    // LRU: 更新访问时间
    item.lastAccess = Date.now();
    this.hits++;
    return item.value;
  }

  /**
   * 设置缓存
   * @param {string} key
   * @param {*} value
   * @param {number} [ttl] 可选的自定义TTL（秒）
   */
  set(key, value, ttl) {
    // 如果缓存已满，执行 LRU 淘汰
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      this._evictLRU();
    }

    const expiry = Date.now() + (ttl ? ttl * 1000 : this.ttl);
    this.cache.set(key, {
      value,
      expiry,
      lastAccess: Date.now(),
      createdAt: Date.now()
    });
  }

  /**
   * LRU 淘汰：删除最久未访问的条目
   */
  _evictLRU() {
    let oldest = Infinity;
    let oldestKey = null;

    for (const [key, item] of this.cache.entries()) {
      if (item.lastAccess < oldest) {
        oldest = item.lastAccess;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.cache.delete(oldestKey);
      this.evictions++;
    }
  }

  /**
   * 删除缓存
   * @param {string} key
   */
  delete(key) {
    this.cache.delete(key);
  }

  /**
   * 批量删除匹配前缀的缓存
   * @param {string} prefix
   */
  deleteByPrefix(prefix) {
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * 清空所有缓存
   */
  flush() {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
  }

  /**
   * 清理过期缓存
   */
  cleanup() {
    const now = Date.now();
    let expired = 0;
    for (const [key, item] of this.cache.entries()) {
      if (now > item.expiry) {
        this.cache.delete(key);
        expired++;
      }
    }
    if (expired > 0 && process.env.NODE_ENV === 'development') {
      console.log(`[Cache] 清理了 ${expired} 个过期条目`);
    }
  }

  /**
   * 获取缓存统计
   */
  getStats() {
    const total = this.hits + this.misses;
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      hitRate: total > 0
        ? (this.hits / total * 100).toFixed(1) + '%'
        : '0%'
    };
  }

  /**
   * 获取或设置缓存 (getOrSet 模式)
   * 如果缓存命中则直接返回，否则调用 fn 获取数据并缓存
   * @param {string} key
   * @param {Function} fn 数据获取函数
   * @param {number} [ttl] 可选的自定义TTL（秒）
   * @returns {*} 缓存或新获取的数据
   */
  getOrSet(key, fn, ttl) {
    const cached = this.get(key);
    if (cached !== null) {
      return cached;
    }

    const result = fn();
    this.set(key, result, ttl);
    return result;
  }

  /**
   * 包装一个异步函数，添加缓存层
   * @param {string} cacheKeyPrefix
   * @param {Function} fn 要缓存的异步函数
   * @param {number} ttl 缓存时间（秒）
   */
  wrap(cacheKeyPrefix, fn, ttl) {
    const cache = this;
    return async function(...args) {
      const key = `${cacheKeyPrefix}:${JSON.stringify(args)}`;
      const cached = cache.get(key);
      if (cached !== null) {
        return cached;
      }

      const result = await fn.apply(this, args);
      cache.set(key, result, ttl);
      return result;
    };
  }

  /**
   * 销毁缓存实例，清理定时器
   */
  destroy() {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
    }
    if (this._statsTimer) {
      clearInterval(this._statsTimer);
    }
    this.flush();
  }
}

// 创建全局缓存实例
// settings缓存60秒，导航缓存60秒，其他短时间缓存30秒
const settingsCache = new MemoryCache(60, 100);
const queryCache = new MemoryCache(15, 300);
const pageCache = new MemoryCache(60, 100);

module.exports = {
  settingsCache,
  queryCache,
  pageCache,
  MemoryCache
};
