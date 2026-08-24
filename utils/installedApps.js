const MAX_INSTALLED_APPS = 100;

function normalizeInstalledAppIds(value) {
  if (!Array.isArray(value)) {
    const error = new Error("installedApps 必须是数组");
    error.status = 400;
    throw error;
  }
  if (value.length > MAX_INSTALLED_APPS) {
    const error = new Error(
      `installedApps 最多包含 ${MAX_INSTALLED_APPS} 个应用`,
    );
    error.status = 400;
    throw error;
  }
  if (value.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    const error = new Error("installedApps 只能包含正整数 ID");
    error.status = 400;
    throw error;
  }
  return [...new Set(value)];
}

function selectExistingAppIds(requestedIds, rows) {
  const existing = new Set(rows.map((row) => Number(row.id)));
  return requestedIds.filter((id) => existing.has(id));
}

module.exports = {
  MAX_INSTALLED_APPS,
  normalizeInstalledAppIds,
  selectExistingAppIds,
};
