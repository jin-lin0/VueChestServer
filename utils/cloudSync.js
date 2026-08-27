const SYNC_CATEGORY_KEYS = [
  "workspace",
  "toolbox",
  "interview",
  "api-manager",
  "music",
  "stock",
];

const SYNC_CATEGORY_SET = new Set(SYNC_CATEGORY_KEYS);
const MAX_SYNC_PAYLOAD_BYTES = 1024 * 1024;
const MAX_CATEGORY_BYTES = 320 * 1024;

function validationError(message, status = 400, code = "VALIDATION_ERROR") {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function byteLength(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    throw validationError("同步数据必须是可序列化的 JSON");
  }
}

function splitCloudEnvelope(raw) {
  if (raw && raw.version === 2 && !Array.isArray(raw)) {
    return {
      workspace:
        raw.workspace && typeof raw.workspace === "object"
          ? raw.workspace
          : null,
      selectiveSync:
        raw.selectiveSync && typeof raw.selectiveSync === "object"
          ? raw.selectiveSync
          : null,
    };
  }

  // v1 直接把工作区配置存放在 config 根节点。读取时透明升级，兼容已有数据。
  if (raw && typeof raw === "object" && Array.isArray(raw.workspaces)) {
    return { workspace: raw, selectiveSync: null };
  }

  return { workspace: null, selectiveSync: null };
}

function createCloudEnvelope(workspace, selectiveSync) {
  return {
    version: 2,
    workspace: workspace || null,
    selectiveSync: selectiveSync || null,
  };
}

function sanitizeSelectiveSyncConfig(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw validationError("同步配置格式错误");
  }
  if (byteLength(raw) > MAX_SYNC_PAYLOAD_BYTES) {
    throw validationError("同步数据不能超过 1MB", 413, "PAYLOAD_TOO_LARGE");
  }

  const selection = Array.isArray(raw.selection)
    ? [
        ...new Set(
          raw.selection.map(String).filter((id) => SYNC_CATEGORY_SET.has(id)),
        ),
      ]
    : [];
  const sourceCategories =
    raw.categories &&
    typeof raw.categories === "object" &&
    !Array.isArray(raw.categories)
      ? raw.categories
      : {};
  const categories = {};

  for (const id of SYNC_CATEGORY_KEYS) {
    if (id === "workspace") continue;
    const entry = sourceCategories[id];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const data = entry.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) continue;
    if (byteLength(data) > MAX_CATEGORY_BYTES) {
      throw validationError(
        `“${id}”同步数据不能超过 320KB`,
        413,
        "PAYLOAD_TOO_LARGE",
      );
    }
    categories[id] = {
      updatedAt: Number.isFinite(Number(entry.updatedAt))
        ? Number(entry.updatedAt)
        : Date.now(),
      data,
    };
  }

  return {
    version: 1,
    selection,
    categories,
    updatedAt: Number.isFinite(Number(raw.updatedAt))
      ? Number(raw.updatedAt)
      : Date.now(),
  };
}

module.exports = {
  SYNC_CATEGORY_KEYS,
  splitCloudEnvelope,
  createCloudEnvelope,
  sanitizeSelectiveSyncConfig,
};
