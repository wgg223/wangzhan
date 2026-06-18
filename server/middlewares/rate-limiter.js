const rateLimits = new Map();
const MAX_ENTRIES = 100000;
const REQUEST_TIMEOUT = 60 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  let deletedCount = 0;

  for (const [key, entry] of rateLimits) {
    if (now - entry.resetTime > REQUEST_TIMEOUT) {
      rateLimits.delete(key);
      deletedCount++;
    }

    if (deletedCount > 100) {
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
      const originalStatus = res.statusCode;

      res.end = function(chunk, encoding) {
        if (skipFailedRequests && originalStatus >= 400) {
          entry.count = Math.max(0, entry.count - 1);
        }
        if (skipSuccessfulRequests && originalStatus < 400) {
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
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => `login:${req.ip}:${req.body?.username || 'unknown'}`,
  message: '登录尝试次数过多，请15分钟后再试'
});

const apiLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 30,
  message: 'API请求过于频繁，请稍后再试'
});

module.exports = {
  createRateLimiter,
  globalLimiter,
  loginLimiter,
  apiLimiter
};
