const SHA256_RE = /^[a-f0-9]{64}$/;

function normalizeSha256(value, required = false) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (!normalized && !required) return null;
  if (!SHA256_RE.test(normalized)) {
    const error = new Error("应用包 SHA-256 无效");
    error.status = 400;
    throw error;
  }
  return normalized;
}

function storedObjectSha256(object) {
  return normalizeSha256(
    object?.Metadata?.sha256 || object?.Metadata?.SHA256,
    false,
  );
}

function assertObjectIntegrity(object, expected, required = true) {
  const normalized = normalizeSha256(expected, required);
  if (!normalized) return null;
  const stored = storedObjectSha256(object);
  if (!stored || stored !== normalized) {
    const error = new Error("上传对象的 SHA-256 元数据不匹配");
    error.status = 400;
    throw error;
  }
  return normalized;
}

module.exports = { normalizeSha256, storedObjectSha256, assertObjectIntegrity };
