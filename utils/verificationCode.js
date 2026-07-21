// 验证码内存存储（带 TTL + 重发冷却）
// 注意：内存存储适用于单实例部署；多实例/Serverless 环境建议改用 Redis 或数据库存储。
const crypto = require("crypto");
const store = new Map(); // key: email → { code, expiresAt, sentAt }

const CODE_TTL_MS = 5 * 60 * 1000; // 验证码有效期 5 分钟
const RESEND_COOLDOWN_MS = 60 * 1000; // 重发冷却 60 秒
const VERIFY_WINDOW_MS = 10 * 60 * 1000; // 验证后保留窗口（防止并发注册）
const MAX_VERIFY_ATTEMPTS = 5;

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
 * 生成并存入验证码
 * @param {string} email
 * @returns {{ code: string, cooldown: number }} cooldown 为还需等待的毫秒数（0 表示可发）
 */
function createCode(email) {
  const emailKey = email.toLowerCase().trim();
  const now = Date.now();

  const existing = store.get(emailKey);
  if (existing && now - existing.sentAt < RESEND_COOLDOWN_MS) {
    return {
      code: existing.code,
      cooldown: RESEND_COOLDOWN_MS - (now - existing.sentAt),
    };
  }

  const code = generate6DigitCode();
  store.set(emailKey, {
    code,
    expiresAt: now + CODE_TTL_MS,
    sentAt: now,
    attempts: 0,
  });
  return { code, cooldown: 0 };
}

/**
 * 校验验证码（校验通过后会清除，一次性使用）
 * @param {string} email
 * @param {string} code
 * @returns {{ valid: boolean, reason?: string }}
 */
function verifyCode(email, code) {
  const emailKey = email.toLowerCase().trim();
  const entry = store.get(emailKey);

  if (!entry) {
    return { valid: false, reason: "请先获取验证码" };
  }

  if (Date.now() > entry.expiresAt) {
    store.delete(emailKey);
    return { valid: false, reason: "验证码已过期，请重新获取" };
  }

  entry.attempts += 1;
  if (entry.code !== String(code).trim()) {
    if (entry.attempts >= MAX_VERIFY_ATTEMPTS) {
      store.delete(emailKey);
      return { valid: false, reason: "验证码错误次数过多，请重新获取验证码" };
    }
    return { valid: false, reason: "验证码错误" };
  }

  // 校验通过，清除记录
  store.delete(emailKey);
  return { valid: true };
}

/**
 * 清理过期记录（可定期调用）
 */
function cleanup() {
  const now = Date.now();
  for (const [key, entry] of store.entries()) {
    if (now > entry.expiresAt + VERIFY_WINDOW_MS) {
      store.delete(key);
    }
  }
}

// 每 10 分钟清理一次过期记录
setInterval(cleanup, 10 * 60 * 1000).unref?.();

module.exports = { createCode, verifyCode, CODE_TTL_MS, RESEND_COOLDOWN_MS };
