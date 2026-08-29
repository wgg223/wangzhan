const rateLimits = new Map();
const MAX_ENTRIES = 100000;

setInterval(() => {
  const now = Date.now();
  let deletedCount = 0;

  for (const [key, entry] of rateLimits) {
    if (now - entry.resetTime > entry.windowMs) {
      rateLimits.delete(key);
      deletedCount++;
    }

    if (deletedCount > 5000) {
      break;
    }
  }

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
    const key = keyGenerator(req);
    const now = Date.now();
    let entry = rateLimits.get(key);

    if (!entry || now - entry.resetTime > windowMs) {
      entry = { count: 0, resetTime: now, windowMs };
      rateLimits.set(key, entry);
    }

    entry.count++;

    res.setHeader('X-RateLimit-Limit', max);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, max - entry.count));
    res.setHeader('X-RateLimit-Reset', Math.ceil((entry.resetTime + windowMs) / 1000));

    if (entry.count > max) {
      return res.status(429).json({ error: message });
    }

    if (skipFailedRequests || skipSuccessfulRequests) {
      const originalEnd = res.end;

      res.end = function(chunk, encoding) {
        // 必须在响应结束时读取状态码，此时才是最终值
        const statusCode = this.statusCode;
        if (skipFailedRequests && statusCode >= 400) {
          entry.count = Math.max(0, entry.count - 1);
        }
        if (skipSuccessfulRequests && statusCode < 400) {
          entry.count = Math.max(0, entry.count - 1);
        }
        originalEnd.call(this, chunk, encoding);
      };
    }

    next();
  };
}

const globalLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 600,
  message: '请求过于频繁，请稍后再试'
});

const loginLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 20,
  // 安全加固：key 仅用 IP，不含用户名（防止逐用户名轮换爆破）
  keyGenerator: (req) => 'login:' + req.ip,
  message: '登录尝试次数过多，请稍后再试'
});

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
