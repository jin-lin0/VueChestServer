const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_KEY_LENGTH = 10;
const MAX_RANGE_DAYS = 365;
const DEFAULT_RANGE_DAYS = 90;

// 下载埋点复用 visit_logs：visitLogger 原样记录 req.path，
// 因此 `/api/market/apps/12/download` 与 `/api/market/apps/12/versions/34/download`
// 各自是一个可聚合的路径桶，无需为统计单独建表。
const DOWNLOAD_PATH = /^\/api\/market\/apps\/(\d+)\/(?:versions\/\d+\/)?download$/;

/** 统一成 YYYY-MM-DD。visitLogger 与 DATEONLY 列都用 UTC 日期，这里保持一致。 */
function toDateKey(value) {
  if (!value) return "";
  if (typeof value === "string") return value.slice(0, DATE_KEY_LENGTH);
  if (value instanceof Date) return value.toISOString().slice(0, DATE_KEY_LENGTH);
  return "";
}

/**
 * 区间天数归一化：缺省 / 非数字 → 默认值；给了数字但越界 → 夹到 [1, MAX]。
 * 刻意区分这两种情况，避免 `days=0` 被当成「没传」而悄悄变成 90 天。
 */
function normalizeDays(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_RANGE_DAYS;
  return Math.min(MAX_RANGE_DAYS, Math.max(1, parsed));
}

/** 生成闭区间 [from, to] 的连续日期轴，保证图表不会因为缺数据而断点。 */
function buildDateRange(days, now = new Date()) {
  const total = normalizeDays(days);
  const end = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const start = new Date(end.getTime() - (total - 1) * DAY_MS);
  const dates = [];
  for (let time = start.getTime(); time <= end.getTime(); time += DAY_MS) {
    dates.push(toDateKey(new Date(time)));
  }
  return { days: total, from: dates[0], to: dates[dates.length - 1], dates };
}

function parseDownloadPath(path) {
  const match = DOWNLOAD_PATH.exec(String(path || ""));
  return match ? Number(match[1]) : null;
}

function emptySeries(range) {
  return new Map(range.dates.map((date) => [date, 0]));
}

function seriesToArray(series, range) {
  return range.dates.map((date) => series.get(date) || 0);
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

/**
 * 按天 + 按应用聚合下载量。
 * 只统计属于当前开发者的 appId：visit_logs 里可能残留已删除应用的路径。
 */
function aggregateDownloads(rows, appIds, range) {
  const allowed = new Set(appIds.map(Number));
  const byDate = emptySeries(range);
  const byApp = new Map();

  for (const row of rows || []) {
    const appId = parseDownloadPath(row.path);
    if (appId === null || !allowed.has(appId)) continue;
    const date = toDateKey(row.date);
    if (!byDate.has(date)) continue;
    const count = Number(row.count) || 0;
    byDate.set(date, byDate.get(date) + count);
    const series = byApp.get(appId) || emptySeries(range);
    series.set(date, series.get(date) + count);
    byApp.set(appId, series);
  }

  return {
    total: sum([...byDate.values()]),
    series: seriesToArray(byDate, range),
    byApp: new Map(
      [...byApp].map(([appId, series]) => [appId, seriesToArray(series, range)]),
    ),
  };
}

/** 把带 createdAt 的记录（评论等）按天落到同一套日期轴上。 */
function countByDay(records, range) {
  const byDate = emptySeries(range);
  const byApp = new Map();

  for (const record of records || []) {
    const date = toDateKey(record.createdAt);
    if (!byDate.has(date)) continue;
    byDate.set(date, byDate.get(date) + 1);
    const appId = Number(record.appId);
    const series = byApp.get(appId) || emptySeries(range);
    series.set(date, series.get(date) + 1);
    byApp.set(appId, series);
  }

  return {
    total: sum([...byDate.values()]),
    series: seriesToArray(byDate, range),
    byApp: new Map(
      [...byApp].map(([appId, series]) => [appId, seriesToArray(series, range)]),
    ),
  };
}

/** 1~5 星分布，始终返回 5 个桶，方便前端画固定长度的条形图。 */
function ratingDistribution(comments) {
  const buckets = new Map([
    [1, 0],
    [2, 0],
    [3, 0],
    [4, 0],
    [5, 0],
  ]);
  for (const comment of comments || []) {
    const rating = Math.round(Number(comment.rating));
    if (!buckets.has(rating)) continue;
    buckets.set(rating, buckets.get(rating) + 1);
  }
  return [...buckets].map(([rating, count]) => ({ rating, count }));
}

function averageRating(comments) {
  const ratings = (comments || [])
    .map((comment) => Number(comment.rating))
    .filter((rating) => Number.isFinite(rating) && rating > 0);
  if (!ratings.length) return null;
  return Math.round((sum(ratings) / ratings.length) * 100) / 100;
}

/** 版本从提交到审核通过的平均时长（小时），用于暴露审核等待成本。 */
function averageReviewHours(versions) {
  const durations = [];
  for (const version of versions || []) {
    if (!version.createdAt || !version.reviewedAt) continue;
    const delta =
      new Date(version.reviewedAt).getTime() -
      new Date(version.createdAt).getTime();
    if (Number.isFinite(delta) && delta >= 0) durations.push(delta / 3600000);
  }
  if (!durations.length) return null;
  return Math.round((sum(durations) / durations.length) * 10) / 10;
}

module.exports = {
  MAX_RANGE_DAYS,
  DEFAULT_RANGE_DAYS,
  DOWNLOAD_PATH,
  toDateKey,
  normalizeDays,
  buildDateRange,
  parseDownloadPath,
  aggregateDownloads,
  countByDay,
  ratingDistribution,
  averageRating,
  averageReviewHours,
};
