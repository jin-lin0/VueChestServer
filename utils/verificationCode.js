// 验证码按用途隔离，带 TTL、重发冷却和容量上限，采用惰性清理。
// 存储仅在当前进程有效，多实例共享需外部存储。
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

/** 写入后清理过期条目，并按插入顺序控制容量。 */
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
 * 只读查询重发冷却，不生成新码或更新状态。
 * @param {string} email
 * @param {string} [type] 用途命名空间，须与 createCode 一致
 * @returns {number} 剩余冷却毫秒数，0 表示可发送
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
