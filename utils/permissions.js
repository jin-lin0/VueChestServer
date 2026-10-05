/**
 * 市场应用「能力权限」的服务端归一化。
 *
 * 与前端 src/lib/sandbox-permissions.ts 的键集合保持一致：
 * 应用在 meta.permissions 里声明，服务端只接受白名单内的键，
 * 其余一律丢弃，避免客户端伪造出未定义的能力。
 */

const ALLOWED_PERMISSIONS = [
  "notify",
  "clipboard",
  "profile",
  "cloud",
  "ai",
  "files",
];

const ALLOWED_SET = new Set(ALLOWED_PERMISSIONS);

/** 把任意输入（数组 / JSON 字符串）归一化为去重后的合法权限键数组。 */
function parsePermissions(raw) {
  let list = raw;
  if (typeof raw === "string") {
    try {
      list = JSON.parse(raw);
    } catch {
      list = [];
    }
  }
  if (!Array.isArray(list)) return [];
  return [
    ...new Set(
      list.filter((item) => typeof item === "string" && ALLOWED_SET.has(item)),
    ),
  ];
}

/** 存库前统一序列化为 JSON 字符串。 */
function serializePermissions(raw) {
  return JSON.stringify(parsePermissions(raw));
}

module.exports = {
  ALLOWED_PERMISSIONS,
  parsePermissions,
  serializePermissions,
};
