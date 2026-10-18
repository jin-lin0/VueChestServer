// 验证码内存存储（带 TTL + 重发冷却 + 条目上限）
// 注意：内存存储适用于单实例部署；多实例/Serverless 环境建议改用 Redis 或数据库存储。
//
// 三条与 utils/authThrottle.js 对齐的取舍：
//
// 1. 惰性清扫 + 硬容量上限，**不挂后台定时器**。原来用 setInterval 每 10 分钟清一次；
//    模块一旦被重新加载（测试里 delete require.cache、热重载、将来换 ESM），
//    就会多留下一份定时器，而它扫的还是旧闭包里的那个 Map —— 既漏扫又常驻。
// 2. 条目数是硬上限。发送入口虽然是「登录前」，但按 IP 的邮件闸门是 5 次/小时，
//    换 IP（或直连源站时伪造 XFF）就能持续写入；没有上限的表最终会把进程撑死。
//    淘汰按插入顺序，摊还下来每次写入仍是 O(1)。
// 3. 「判能不能发」与「真去写」分成两个函数。`cooldownRemaining()` 只读，
//    让调用方能在被别的闸门拒绝时**不留下任何状态改动**（见 routes/auth.js）。
const crypto = require("crypto");

const CODE_TTL_MS = 5 * 60 * 1000; // 验证码有效期 5 分钟
const RESEND_COOLDOWN_MS = 60 * 1000; // 重发冷却 60 秒
const VERIFY_WINDOW_MS = 10 * 60 * 1000; // 验证后保留窗口（防止并发注册）
const MAX_VERIFY_ATTEMPTS = 5;

/** 条目数硬上限：超过就按插入顺序淘汰到 CAPACITY_TARGET_RATIO，避免表被撑爆。 */
const MAX_ENTRIES = 5000;
const CAPACITY_TARGET_RATIO = 0.9;
/** 每多少次写入做一次全量过期检查（避免每次请求都 O(n)）。 */
const SWEEP_INTERVAL = 256;

const store = new Map(); // key: `${type}:${email}` → { code, expiresAt, sentAt, attempts }
let opsSinceSweep = 0;

const keyOf = (email, type) => `${type}:${String(email).toLowerCase().trim()}`;
const isStale = (entry, now) => now > entry.expiresAt + VERIFY_WINDOW_MS;

/**
 * 写入之后的维护：惰性清扫过期条目 + 硬容量淘汰。
 * 与 utils/authThrottle.js 的 sweepExpired/enforceCapacity 同一套语义。
 */
function maintain(now) {
  opsSinceSweep += 1;
  if (opsSinceSweep >= SWEEP_INTERVAL) {
    opsSinceSweep = 0;
    for (const [key, entry] of store) {
      if (isStale(entry, now)) store.delete(key);
    }
  }
  if (store.size <= MAX_ENTRIES) return;
  const target = Math.max(1, Math.floor(MAX_ENTRIES * CAPACITY_TARGET_RATIO));
  for (const key of store.keys()) {
    store.delete(key);
    if (store.size <= target) break;
  }
}

/**
 * 生成 6 位数字验证码
 */
function generate6DigitCode() {
  // crypto 随机，避免 Math.random 可预测
  const buf = crypto.randomBytes(3);
  const num = buf.readUIntBE(0, 3) % 1000000;
  return String(num).padStart(6, "0");
}

/**
 * 只读：距可以再次发送还需等待多少毫秒（0 表示现在就能发）。
 *
 * 存在的意义是让调用方在「还要不要继续」的判定上**不改动状态**：
 * 被 IP 闸门拒绝的请求不该顺手铸掉新码、重记冷却（那会让用户手上那个
 * 已经收到、还没用掉的码作废，同时让重发谎报「验证码已发送」）。
 *
 * @param {string} email
 * @param {string} [type] 用途命名空间，须与 createCode 一致
 * @returns {number} 剩余冷却毫秒数
 */
function cooldownRemaining(email, type = "register") {
  const entry = store.get(keyOf(email, type));
  if (!entry) return 0;
  const remaining = RESEND_COOLDOWN_MS - (Date.now() - entry.sentAt);
  return remaining > 0 ? remaining : 0;
}

/**
 * 生成并存入验证码
 * @param {string} email
 * @param {string} [type] 用途命名空间，隔离不同场景的码（如 'register' / 'reset'）
 * @returns {{ code: string, cooldown: number }} cooldown 为还需等待的毫秒数（0 表示可发）
 */
function createCode(email, type = "register") {
  const key = keyOf(email, type);
  const now = Date.now();

  const existing = store.get(key);
  if (existing && now - existing.sentAt < RESEND_COOLDOWN_MS) {
    return {
      code: existing.code,
      cooldown: RESEND_COOLDOWN_MS - (now - existing.sentAt),
    };
  }

  const code = generate6DigitCode();
  store.set(key, {
    code,
    expiresAt: now + CODE_TTL_MS,
    sentAt: now,
    attempts: 0,
  });
  maintain(now);
  return { code, cooldown: 0 };
}

/**
 * 校验验证码（校验通过后会清除，一次性使用）
 * @param {string} email
 * @param {string} code
 * @param {string} [type] 用途命名空间，须与 createCode 时一致
 * @returns {{ valid: boolean, reason?: string }}
 */
function verifyCode(email, code, type = "register") {
  const key = keyOf(email, type);
  const entry = store.get(key);

  if (!entry) {
    return { valid: false, reason: "请先获取验证码" };
  }

  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return { valid: false, reason: "验证码已过期，请重新获取" };
  }

  entry.attempts += 1;
  if (entry.code !== String(code).trim()) {
    if (entry.attempts >= MAX_VERIFY_ATTEMPTS) {
      store.delete(key);
      return { valid: false, reason: "验证码错误次数过多，请重新获取验证码" };
    }
    return { valid: false, reason: "验证码错误" };
  }

  // 校验通过，清除记录
  store.delete(key);
  return { valid: true };
}

/** 当前在存的条目数（供测试与观测用，与 authThrottle 的 size() 同义）。 */
function storeSize() {
  return store.size;
}

module.exports = {
  createCode,
  verifyCode,
  cooldownRemaining,
  storeSize,
  CODE_TTL_MS,
  RESEND_COOLDOWN_MS,
  VERIFY_WINDOW_MS,
  MAX_ENTRIES,
};
