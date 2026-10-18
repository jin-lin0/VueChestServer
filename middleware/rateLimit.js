// 上游代理按 IP 限流，保留游客访问。计数仅在当前进程内共享。
// 来源 IP 的可信代理要求见 clientIpOf。

const { clientIpOf, createWindowLimiter } = require("../utils/authThrottle");

/** 未鉴权上游代理的默认额度（见上面的用量测算，改这个数字前先重新确认轮询频率） */
const UNAUTH_PROXY_BUDGET = { limit: 600, windowMs: 30 * 60 * 1000 };

/** 认证与代理接口共用 429 响应，携带 Retry-After 和 retryAfter。 */
function tooManyRequests(res, retryAfterMs, action, code = "TOO_MANY_ATTEMPTS") {
  const retryAfter = Math.max(1, Math.ceil(retryAfterMs / 1000));
  res.set("Retry-After", String(retryAfter));
  return res.status(429).json({
    error: `${action}过于频繁，请 ${retryAfter} 秒后重试`,
    code,
    retryAfter,
  });
}

/**
 * 按客户端 IP 计数的固定窗口限流中间件。
 *
 * @param {object} [options]
 * @param {string} [options.scope]    出现在错误文案里的对象名，如「音乐接口」
 * @param {number} [options.limit]    窗口内允许的请求数
 * @param {number} [options.windowMs] 窗口长度
 */
function createIpRateLimit(options = {}) {
  const scope = options.scope || "接口";
  const limiter = createWindowLimiter({
    limit: options.limit ?? UNAUTH_PROXY_BUDGET.limit,
    windowMs: options.windowMs ?? UNAUTH_PROXY_BUDGET.windowMs,
  });

  return function ipRateLimit(req, res, next) {
    // CORS 预检不消耗额度：它是浏览器自动发出、用户看不见的请求，
    // 把它计入额度只会制造「明明没点几次却被限流」这种难以解释的现场。
    if (req.method === "OPTIONS") return next();

    const gate = limiter.hit(clientIpOf(req));
    if (!gate.allowed)
      return tooManyRequests(res, gate.retryAfterMs, scope, "TOO_MANY_REQUESTS");
    return next();
  };
}

module.exports = { createIpRateLimit, tooManyRequests, UNAUTH_PROXY_BUDGET };
