const crypto = require("node:crypto");

class CheckinError extends Error {
  constructor(message, code = "CHECKIN_FAILED", status = 502) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function encryptionKey() {
  const value = process.env.CHECKIN_ENCRYPTION_KEY;
  if (typeof value !== "string" || !/^[a-fA-F0-9]{64}$/.test(value)) {
    throw new CheckinError(
      "签到加密密钥未配置或格式错误",
      "CHECKIN_KEY_REQUIRED",
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
    "v1",
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    body.toString("base64"),
  ].join(".");
}

function decryptCredentials(value, accountId, provider) {
  const key = encryptionKey();
  try {
    const [version, iv, tag, body, extra] = value.split(".");
    if (version !== "v1" || extra !== undefined) throw new Error();
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
    throw new CheckinError(
      "签到凭据无法解密，请检查密钥或重新录入",
      "CHECKIN_DECRYPT_FAILED",
      503,
    );
  }
}

module.exports = {
  CheckinError,
  encryptionKey,
  encryptCredentials,
  decryptCredentials,
};
