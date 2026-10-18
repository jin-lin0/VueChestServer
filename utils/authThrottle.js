// 认证限流使用进程内存，多实例不共享计数。
// 登录失败按账号累计，IP 额度辅助限制请求；惰性清理并限制容量。

const crypto = require("crypto");

/**
 * 优先取 X-Forwarded-For 最右一跳；仅适用于可信代理覆盖该位置的部署。
 * 无此请求头时使用连接地址；允许绕过代理直连时，请求头不能视为可信来源。
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

/** 定期惰性清理过期项；超过硬上限时按插入顺序淘汰至容量的 90%。 */
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
 * 超过 freeAttempts 次失败后指数退避，最长 maxDelayMs；退避过期后清除记录。
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

/** 账号标识归一化后哈希为固定长度，避免明文存储和超长键。 */
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
