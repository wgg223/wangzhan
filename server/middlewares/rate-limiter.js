/**
 * 内存版限流中间件（Rate Limiter）
 * 作用：基于内存 Map 实现滑动窗口计数限流，防止暴力破解、接口滥用。
 * 特点：
 *   - 无第三方依赖，纯内存实现，适合单进程部署；
 *   - 每 5 分钟清理过期窗口与超量条目，控制内存上限（10 万条）；
 *   - 支持自定义 key（默认按 IP）、窗口大小、最大次数；
 *   - 可选"跳过失败/成功请求"：响应结束时按状态码回退计数。
 * 注意：内存实现不跨进程共享，多实例部署时需改用 Redis 方案。
 */

// 全局限流计数表：key（默认 IP）→ { count, resetTime, windowMs }
const rateLimits = new Map();
const MAX_ENTRIES = 100000;   // 内存条数上限，防止恶意 IP 池撑爆内存

// 每 5 分钟定时清理：过期条目 + 超量条目
setInterval(() => {
  const now = Date.now();
  let deletedCount = 0;

  // 清理已过期的窗口条目（超过窗口时间未活动的 key）
  for (const [key, entry] of rateLimits) {
    if (now - entry.resetTime > entry.windowMs) {
      rateLimits.delete(key);
      deletedCount++;
    }

    if (deletedCount > 5000) {   // 单次最多清 5000 条，避免长时间阻塞事件循环
      break;
    }
  }

  // 条目数仍超过上限时，按插入顺序删除最早的条目（FIFO 兜底）
  if (rateLimits.size > MAX_ENTRIES) {
    const entriesToDelete = rateLimits.size - MAX_ENTRIES;
    let deleted = 0;
    for (const [key, entry] of rateLimits) {
      if (deleted >= entriesToDelete) break;
      rateLimits.delete(key);
      deleted++;
    }
    console.warn(`[rate-limiter] 内存使用过高，已清理 ${deleted} 个过期条目`);
  }
}, 5 * 60 * 1000);

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
    skipSuccessfulRequests = false
  } = options;

  return (req, res, next) => {
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
}

// 全局限流：所有路由共用，每分钟最多 600 次
const globalLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 600,
  message: '请求过于频繁，请稍后再试'
});

// 登录限流：每分钟最多 20 次尝试
const loginLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 20,
  // 安全加固：key 仅用 IP，不含用户名（防止逐用户名轮换爆破）
  keyGenerator: (req) => 'login:' + req.ip,
  message: '登录尝试次数过多，请稍后再试'
});

// API 限流：API 路由专用，每分钟最多 1000 次
const apiLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 1000,
  message: 'API请求过于频繁，请稍后再试'
});

module.exports = {
  createRateLimiter,
  globalLimiter,
  loginLimiter,
  apiLimiter
};
