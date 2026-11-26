/**
 * 内存版限流中间件（Rate Limiter）
 * 作用：基于内存 Map 实现滑动窗口计数限流，防止暴力破解、接口滥用。
 * 特点：
 *   - 无第三方依赖，纯内存实现，适合单进程部署；
 *   - 每个限流器独立 Map，分散内存压力；
 *   - 每 1 分钟清理过期窗口，分批删除避免阻塞事件循环；
 *   - 支持自定义 key（默认按 IP）、窗口大小、最大次数；
 *   - 可选"跳过失败/成功请求"：响应结束时按状态码回退计数。
 * 注意：内存实现不跨进程共享，多实例部署时需改用 Redis 方案。
 */

const MAX_ENTRIES_PER_LIMITER = 50000;   // 每个限流器内存条数上限
const CLEANUP_INTERVAL_MS = 60 * 1000;   // 清理间隔：1 分钟（原 5 分钟过长）
const CLEANUP_BATCH_SIZE = 3000;         // 单次清理最多删除条数（避免阻塞事件循环）
const { alertAdminsOnce } = require('../services/notify');

/**
 * 构造限流告警回调：触发 429 时通知全部管理员（同一类限流 10 分钟内只告警一次）
 * @param {string} label 限流器名称（全站/登录/API）
 */
function createLimitReporter(label) {
  return function (req, info) {
    if (!req || !req.db) return;
    try {
      const requestPath = String(req.originalUrl || req.path || '/').split('?')[0];
      const windowMinutes = Math.max(1, Math.round((info.windowMs || 60000) / 60000));
      alertAdminsOnce(req.db, 'rate-limit:' + label, 10 * 60 * 1000, {
        title: '限流告警：' + label + '触发',
        content: 'IP ' + (req.ip || '未知') + ' 在 ' + windowMinutes + ' 分钟内请求达到 ' +
          info.count + ' 次（上限 ' + info.max + ' 次），已触发限流拦截。路径：' + requestPath,
        targetType: 'server_alert',
        emailDetails: [
          { label: '限流器', value: label },
          { label: '触发 IP', value: req.ip || '未知' },
          { label: '请求路径', value: requestPath },
          { label: '请求方法', value: req.method || '' },
          { label: '窗口计数', value: info.count + ' / ' + info.max },
          { label: 'User-Agent', value: req.headers && req.headers['user-agent'] ? req.headers['user-agent'] : '' }
        ],
        emailActionPath: '/admin/activity-logs',
        emailActionText: '查看安全日志'
      });
    } catch (err) {
      // 告警失败不影响限流响应
    }
  };
}

/**
 * 创建限流中间件
 * @param {Object} options - 配置项
 * @param {number} options.windowMs - 窗口时长（毫秒），默认 15 分钟
 * @param {number} options.max - 窗口内最大请求次数，默认 100
 * @param {Function} options.keyGenerator - 生成限流 key 的函数，默认用 req.ip
 * @param {string} options.message - 超限时的返回提示
 * @param {boolean} options.skipFailedRequests - 是否不计入失败的请求（状态码>=400）
 * @param {boolean} options.skipSuccessfulRequests - 是否不计入成功的请求（状态码<400）
 * @returns {Function} Express 中间件
 */
function createRateLimiter(options) {
  const {
    windowMs = 15 * 60 * 1000,
    max = 100,
    keyGenerator = (req) => req.ip,
    message = '请求过于频繁，请稍后再试',
    skipFailedRequests = false,
    skipSuccessfulRequests = false,
    onExceeded = null
  } = options;

  // 每个限流器独立 Map，分散内存压力
  const rateLimits = new Map();

  // 定时清理：每个限流器独立定时器，间隔 1 分钟
  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    let deletedCount = 0;

    for (const [key, entry] of rateLimits) {
      if (now - entry.resetTime > entry.windowMs) {
        rateLimits.delete(key);
        deletedCount++;
      }
      // 分批清理，避免单次遍历阻塞事件循环
      if (deletedCount >= CLEANUP_BATCH_SIZE) break;
    }

    // FIFO 兜底：超过上限时淘汰最早条目
    if (rateLimits.size > MAX_ENTRIES_PER_LIMITER) {
      const entriesToDelete = rateLimits.size - MAX_ENTRIES_PER_LIMITER;
      let deleted = 0;
      for (const key of rateLimits.keys()) {
        if (deleted >= entriesToDelete) break;
        rateLimits.delete(key);
        deleted++;
      }
    }
  }, CLEANUP_INTERVAL_MS);

  // 不阻止进程退出
  if (cleanupTimer.unref) {
    cleanupTimer.unref();
  }

  const middleware = (req, res, next) => {
    const key = keyGenerator(req);   // 计算限流 key（默认客户端 IP）
    const now = Date.now();
    let entry = rateLimits.get(key);

    // 首次请求或窗口已过期：初始化新窗口
    if (!entry || now - entry.resetTime > windowMs) {
      entry = { count: 0, resetTime: now, windowMs };
      rateLimits.set(key, entry);
    }

    entry.count++;   // 当前窗口计数 +1

    // 响应头中透出限流状态（供前端展示/调试）
    res.setHeader('X-RateLimit-Limit', max);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, max - entry.count));
    res.setHeader('X-RateLimit-Reset', Math.ceil((entry.resetTime + windowMs) / 1000));

    // 超过上限：直接返回 429 并终止请求链
    if (entry.count > max) {
      if (typeof onExceeded === 'function') {
        try {
          onExceeded(req, { key, count: entry.count, max, windowMs, message });
        } catch (err) {
          // 告警回调异常不能影响 429 响应
        }
      }
      return res.status(429).json({ error: message });
    }

    // 若配置了"跳过失败/成功请求"，包装 res.end 在响应结束时回退计数
    if (skipFailedRequests || skipSuccessfulRequests) {
      const originalEnd = res.end;

      res.end = function(chunk, encoding) {
        // 必须在响应结束时读取状态码，此时才是最终值
        const statusCode = this.statusCode;
        if (skipFailedRequests && statusCode >= 400) {
          entry.count = Math.max(0, entry.count - 1);   // 失败请求不计入限额
        }
        if (skipSuccessfulRequests && statusCode < 400) {
          entry.count = Math.max(0, entry.count - 1);   // 成功请求不计入限额
        }
        originalEnd.call(this, chunk, encoding);
      };
    }

    next();   // 未超限，放行
  };

  // 暴露内部状态供调试/健康检查使用
  middleware._rateLimits = rateLimits;
  middleware._cleanupTimer = cleanupTimer;

  return middleware;
}

// 全局限流：所有路由共用，每分钟最多 600 次
const globalLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 600,
  message: '请求过于频繁，请稍后再试',
  onExceeded: createLimitReporter('全站')
});

// 登录限流：每分钟最多 20 次尝试
const loginLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 20,
  // 安全加固：key 仅用 IP，不含用户名（防止逐用户名轮换爆破）
  keyGenerator: (req) => 'login:' + req.ip,
  message: '登录尝试次数过多，请稍后再试',
  onExceeded: createLimitReporter('登录')
});

// API 限流：API 路由专用，每分钟最多 1000 次
const apiLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 1000,
  message: 'API请求过于频繁，请稍后再试',
  onExceeded: createLimitReporter('API')
});

module.exports = {
  createRateLimiter,
  globalLimiter,
  loginLimiter,
  apiLimiter
};
