const APP_KEY_RE = /^(builtin|market):\d+$/;

function validationError(message, status = 400, code = "VALIDATION_ERROR") {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function sanitizeWorkspaceConfig(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw validationError("工作台配置格式错误");
  }

  const payloadSize = Buffer.byteLength(JSON.stringify(raw), "utf8");
  if (payloadSize > 100 * 1024) {
    throw validationError("工作台配置不能超过 100KB", 413, "PAYLOAD_TOO_LARGE");
  }

  if (
    !Array.isArray(raw.workspaces) ||
    raw.workspaces.length < 1 ||
    raw.workspaces.length > 8
  ) {
    throw validationError("工作区数量必须在 1 到 8 个之间");
  }

  const workspaces = raw.workspaces.map((workspace, index) => {
    if (!workspace || typeof workspace !== "object") {
      throw validationError(`第 ${index + 1} 个工作区格式错误`);
    }

    const id = String(workspace.id || "").slice(0, 64);
    const name = String(workspace.name || "")
      .trim()
      .slice(0, 20);
    if (!id || !name) throw validationError("工作区 ID 和名称不能为空");

    const items = Array.isArray(workspace.items)
      ? workspace.items
          .filter((item) => item && APP_KEY_RE.test(String(item.appKey || "")))
          .slice(0, 100)
          .map((item) => ({ appKey: String(item.appKey) }))
      : [];

    return {
      id,
      name,
      icon: String(workspace.icon || "◫").slice(0, 8),
      items,
    };
  });

  return {
    version: 1,
    workspaces,
    updatedAt: Number.isFinite(Number(raw.updatedAt))
      ? Number(raw.updatedAt)
      : Date.now(),
  };
}

module.exports = { APP_KEY_RE, sanitizeWorkspaceConfig };
