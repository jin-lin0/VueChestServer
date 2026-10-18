// 未鉴权上游代理的按 IP 请求额度。
//
// 背景：/api/netease/* 与 /api/research-stocks/* 是唯二『不要求登录』的对外路由，
// 每个请求都会打到第三方（网易云 / 腾讯行情）。没有额度时，它们等于一台免费公共代理：
// 任何人写个脚本就能用本服务的出口 IP 无限次抓取，代价（上游限频、出口被封）由我们承担。
//
// 为什么是「限流」而不是「要求登录」：这两条路由服务的是**游客也能用**的内置应用
// （音乐播放、股票查询），加 authMiddleware 会把未登录用户直接挡在外面，那是功能回退。
//
// 额度定多少：按真实用量测算，取「高出人类用量一个量级」而非「刚好卡住人类」。
//   - 股票页每 60 秒轮询一次（src/apps/stock/App.vue），一次 refreshData 并发 3 个请求，
//     其中日线受 5 分钟节流（src/stores/stock.ts:321），故稳态约 2~3 请求/分钟、上限约 130 请求/小时。
//   - 音乐页无轮询，搜索联想有防抖，一次交互 1~3 个请求，重度浏览也不到 10 请求/分钟。
// 600 次 / 30 分钟的均值是 20 次/分钟，约等于真实用量的 7~10 倍，正常使用碰不到；
// 而脚本化抓取会被砍掉两三个数量级（从「每秒几百」变成「每分钟 20」）。
//
// 存储是进程内存，与 utils/authThrottle.js、utils/verificationCode.js 同一取舍：
// 单实例完全生效，Serverless 多实例下每个实例各自计数。
//
// 限流键取 X-Forwarded-For 的**最右一跳**（见 utils/authThrottle.js 的 clientIpOf），
// 前提是「最右跳由可信边缘写入」——线上由 Vercel 边缘写入客户端真实 IP，客户端伪造不了。
// 但这层保护依赖这个前提：绕过边缘直连源站，就能靠轮换这个头换桶绕过限流。
// 真要在直连场景也兜住，得按连接来源地址（req.socket.remoteAddress）而不是请求头计数。

const { clientIpOf, createWindowLimiter } = require("../utils/authThrottle");

/** 未鉴权上游代理的默认额度（见上面的用量测算，改这个数字前先重新确认轮询频率） */
const UNAUTH_PROXY_BUDGET = { limit: 600, windowMs: 30 * 60 * 1000 };

/**
 * 统一的 429 响应契约：Retry-After 头 + retryAfter 字段，让客户端知道「等多久」而不是只看到失败。
 * 认证接口（routes/auth.js）与上游代理限流共用这一处实现，避免出现两份略有出入的 429。
 */
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
