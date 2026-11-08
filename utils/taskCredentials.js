const crypto = require("node:crypto");

class TaskError extends Error {
  constructor(message, code = "DAILY_FAILED", status = 502) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function encryptionKey() {
  const value = process.env.DAILY_ENCRYPTION_KEY;
  if (typeof value !== "string" || !/^[a-fA-F0-9]{64}$/.test(value)) {
    throw new TaskError(
      "任务凭据加密密钥未配置或格式错误",
      "DAILY_KEY_REQUIRED",
      503,
    );
  }
  return Buffer.from(value, "hex");
}

function encryptCredentials(value, accountId, provider) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  cipher.setAAD(Buffer.from(`${accountId}:${provider}`));
  const body = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return [
    // AAD 绑定到「归属账号 + 站点」，不同超管不能复用同一份密文。
    "v2",
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    body.toString("base64"),
  ].join(".");
}

function decryptCredentials(value, accountId, provider) {
  const key = encryptionKey();
  try {
    const [version, iv, tag, body, extra] = value.split(".");
    if (version !== "v2" || extra !== undefined) throw new Error();
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(iv, "base64"),
    );
    decipher.setAAD(Buffer.from(`${accountId}:${provider}`));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return JSON.parse(
      Buffer.concat([
        decipher.update(Buffer.from(body, "base64")),
        decipher.final(),
      ]).toString("utf8"),
    );
  } catch {
    throw new TaskError(
      "任务凭据无法解密，请检查密钥或重新录入",
      "DAILY_DECRYPT_FAILED",
      503,
    );
  }
}

module.exports = {
  TaskError,
  encryptionKey,
  encryptCredentials,
  decryptCredentials,
};
