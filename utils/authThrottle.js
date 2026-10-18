// 认证接口的滥用抑制：登录防爆破 + 验证码邮件防刷。
//
// 存储是**进程内存**：与 utils/verificationCode.js 同一取舍——本地/常驻单实例完全生效，
// Serverless 多实例下每个实例各自计数，只能拦到落到同一个热实例的那部分流量。
// 跨实例生效需要 Redis 或落库；这里先把「完全没有节流」补上，并把接口留在原地方便替换存储。
//
// 两个刻意为之的取舍：
// 1. 登录失败计数**以账号标识为主键**（大小写归一），它攻击者伪造不了；IP 只是辅助维度。
// 2. 不用 setInterval 清理：惰性清扫 + 容量上限，行为可预测、没有后台定时器，
//    也不会在模块被重新加载（测试/热重载）后留下多份定时器。
//    utils/verificationCode.js 原本用 setInterval，已改成同一套做法（惰性清扫 + 上限）。

const crypto = require("crypto");

/**
 * 取客户端 IP，用于限流键。
 *
 * 取 X-Forwarded-For 的**最右侧**一跳：它是最近的反向代理写入的，客户端伪造不了；
 * 最左侧那一跳是客户端自己塞进来的原值，用它可以随手换 IP 绕过限流。
 * （middleware/visitLogger.js 取最左侧，那是埋点记录来源，跟限流的目的不同，故不共用。）
 */
function clientIpOf(req) {
  const forwarded = req.headers && req.headers["x-forwarded-for"];
  const raw = Array.isArray(forwarded) ? forwarded[forwarded.length - 1] : forwarded;
  if (raw) {
    const hops = String(raw)
      .split(",")
      .map((hop) => hop.trim())
      .filter(Boolean);
    if (hops.length) return hops[hops.length - 1];
  }
  return req.ip || (req.socket && req.socket.remoteAddress) || "unknown";
}

/**
 * 惰性清扫：每 SWEEP_INTERVAL 次写入做一次全量过期检查（避免每次请求都 O(n)）。
 * 容量则是**硬上限**：一超过就按插入顺序淘汰到 90%，下一次再触发要等长回来 10%，
 * 所以摊还下来每次写入仍是 O(1)，同时不会出现「上限 + 255」这种实际可到 5k+ 的假上限。
 */
const SWEEP_INTERVAL = 256;
const CAPACITY_TARGET_RATIO = 0.9;

function sweepExpired(entries, now, isExpired) {
  for (const [key, entry] of entries) {
    if (isExpired(entry, now)) entries.delete(key);
  }
}

function enforceCapacity(entries, maxEntries) {
  if (entries.size <= maxEntries) return;
  const target = Math.max(1, Math.floor(maxEntries * CAPACITY_TARGET_RATIO));
  for (const key of entries.keys()) {
    entries.delete(key);
    if (entries.size <= target) break;
  }
}

/**
 * 失败退避：前 freeAttempts 次失败不拦，之后每次失败按 2 的幂退避，封顶 maxDelayMs。
 * 命中退避期间不发新请求；退避窗口内不再有失败记录则整条作废（正常用户不会被长期牵连）。
 *
 * @returns {{ check: Function, registerFailure: Function, reset: Function, size: Function }}
 */
function createFailureBackoff(options = {}) {
  const freeAttempts = options.freeAttempts ?? 5;
  const baseDelayMs = options.baseDelayMs ?? 1000;
  const maxDelayMs = options.maxDelayMs ?? 15 * 60 * 1000;
  const windowMs = options.windowMs ?? 60 * 60 * 1000;
  const maxEntries = options.maxEntries ?? 5000;

  const entries = new Map(); // key → { failures, blockedUntil, expiresAt }
  let opsSinceSweep = 0;

  const tick = (now) => {
    opsSinceSweep += 1;
    if (opsSinceSweep >= SWEEP_INTERVAL) {
      opsSinceSweep = 0;
      sweepExpired(entries, now, (entry, at) => at >= entry.expiresAt);
    }
    enforceCapacity(entries, maxEntries);
  };

  return {
    /** 查当前是否处于退避期，不修改状态 */
    check(key, now = Date.now()) {
      const entry = entries.get(key);
      if (!entry || now >= entry.expiresAt) {
        return { blocked: false, retryAfterMs: 0, failures: 0 };
      }
      if (entry.blockedUntil > now) {
        return {
          blocked: true,
          retryAfterMs: entry.blockedUntil - now,
          failures: entry.failures,
        };
      }
      return { blocked: false, retryAfterMs: 0, failures: entry.failures };
    },

    /** 记一次失败，返回这次失败之后是否需要等待 retryAfterMs */
    registerFailure(key, now = Date.now()) {
      const existing = entries.get(key);
      const entry =
        existing && now < existing.expiresAt
          ? existing
          : { failures: 0, blockedUntil: 0, expiresAt: 0 };

      entry.failures += 1;
      let retryAfterMs = 0;
      if (entry.failures > freeAttempts) {
        retryAfterMs = Math.min(
          baseDelayMs * 2 ** (entry.failures - freeAttempts - 1),
          maxDelayMs,
        );
        entry.blockedUntil = now + retryAfterMs;
      }
      entry.expiresAt = now + windowMs;
      entries.set(key, entry);
      tick(now);
      return { blocked: retryAfterMs > 0, retryAfterMs, failures: entry.failures };
    },

    /** 成功后清掉这个账号的失败记录（只清自己这一条，不动 IP 维度） */
    reset(key) {
      entries.delete(key);
    },

    size: () => entries.size,
  };
}

/**
 * 固定窗口计数限流：窗口内超过 limit 次即拒绝。
 * 命中被拒的请求也会计数，但不会延长窗口（固定窗口，到期即放行）。
 */
function createWindowLimiter(options = {}) {
  const limit = options.limit ?? 60;
  const windowMs = options.windowMs ?? 10 * 60 * 1000;
  const maxEntries = options.maxEntries ?? 5000;

  const entries = new Map(); // key → { count, windowStart }
  let opsSinceSweep = 0;

  const tick = (now) => {
    opsSinceSweep += 1;
    if (opsSinceSweep >= SWEEP_INTERVAL) {
      opsSinceSweep = 0;
      sweepExpired(entries, now, (entry, at) => at - entry.windowStart >= windowMs);
    }
    enforceCapacity(entries, maxEntries);
  };

  return {
    hit(key, now = Date.now()) {
      tick(now);

      let entry = entries.get(key);
      if (!entry || now - entry.windowStart >= windowMs) {
        entry = { count: 0, windowStart: now };
        entries.set(key, entry);
      }
      entry.count += 1;

      if (entry.count > limit) {
        return {
          allowed: false,
          remaining: 0,
          retryAfterMs: Math.max(1, entry.windowStart + windowMs - now),
        };
      }
      return { allowed: true, remaining: limit - entry.count, retryAfterMs: 0 };
    },

    size: () => entries.size,
  };
}

// ── 认证端点的具体策略 ──────────────────────────────────────────────────────
// 登录：同一账号连续失败 5 次后开始退避（1s→2s→4s…封顶 15 分钟），成功后清零。
const loginBackoff = createFailureBackoff({
  freeAttempts: 5,
  baseDelayMs: 1000,
  maxDelayMs: 15 * 60 * 1000,
  windowMs: 60 * 60 * 1000,
});

// 登录：单个 IP 10 分钟内最多 60 次请求（含成功），挡住换账号枚举。
const loginIpLimiter = createWindowLimiter({ limit: 60, windowMs: 10 * 60 * 1000 });

// 邮件：单个 IP 1 小时内最多 5 次验证码/重置码请求。
// 只靠「按邮箱冷却」挡不住换邮箱刷 Resend 额度，必须再加一层与收件人无关的上限。
const mailIpLimiter = createWindowLimiter({ limit: 5, windowMs: 60 * 60 * 1000 });

/**
 * 登录失败计数的键：大小写归一是为了不让 A/a 变化绕过计数；
 * 再哈希一层是为了不把账号标识以明文长期留在内存里，同时把键长钉死在 64 字符
 * （客户端可以塞一个超长 identifier，直接当 Map 键会放大内存占用）。
 */
function loginAttemptKey(identifier) {
  return crypto.createHash("sha256").update(identifier.toLowerCase()).digest("hex");
}

module.exports = {
  clientIpOf,
  createFailureBackoff,
  createWindowLimiter,
  loginAttemptKey,
  loginBackoff,
  loginIpLimiter,
  mailIpLimiter,
};
