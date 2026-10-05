const test = require("node:test");
const assert = require("node:assert/strict");
const {
  MAX_RANGE_DAYS,
  DEFAULT_RANGE_DAYS,
  toDateKey,
  normalizeDays,
  buildDateRange,
  parseDownloadPath,
  aggregateDownloads,
  countByDay,
  ratingDistribution,
  averageRating,
  averageReviewHours,
} = require("../services/developerAnalytics");

test("buildDateRange 生成闭区间连续日期轴", () => {
  const range = buildDateRange(7, new Date("2026-10-04T15:30:00Z"));
  assert.equal(range.days, 7);
  assert.equal(range.from, "2026-09-28");
  assert.equal(range.to, "2026-10-04");
  assert.equal(range.dates.length, 7);
  assert.equal(range.dates[0], "2026-09-28");
  assert.equal(range.dates[6], "2026-10-04");
});

test("buildDateRange 对非法与超界入参做兜底", () => {
  // 没传 / 传了非数字 → 用默认值
  assert.equal(normalizeDays(undefined), DEFAULT_RANGE_DAYS);
  assert.equal(normalizeDays("abc"), DEFAULT_RANGE_DAYS);
  assert.equal(normalizeDays(null), DEFAULT_RANGE_DAYS);
  // 传了数字但越界 → 夹到合法区间，而不是回退成默认值
  assert.equal(normalizeDays(0), 1);
  assert.equal(normalizeDays(-5), 1);
  assert.equal(normalizeDays(99999), MAX_RANGE_DAYS);
  assert.equal(normalizeDays("30"), 30);
  assert.equal(buildDateRange(0).days, 1);
  assert.equal(buildDateRange("30").dates.length, 30);
});

test("toDateKey 兼容 DATEONLY 字符串与 Date 对象", () => {
  assert.equal(toDateKey("2026-08-16"), "2026-08-16");
  assert.equal(toDateKey("2026-08-16T00:00:00.000Z"), "2026-08-16");
  assert.equal(toDateKey(new Date("2026-08-16T00:00:00Z")), "2026-08-16");
  assert.equal(toDateKey(null), "");
  assert.equal(toDateKey(undefined), "");
});

test("parseDownloadPath 识别应用与版本两类下载路径", () => {
  assert.equal(parseDownloadPath("/api/market/apps/9/download"), 9);
  assert.equal(parseDownloadPath("/api/market/apps/44/versions/7/download"), 44);
  assert.equal(parseDownloadPath("/api/market/apps/9"), null);
  assert.equal(parseDownloadPath("/api/market/ranking"), null);
  assert.equal(parseDownloadPath(""), null);
});

test("aggregateDownloads 只统计自己的应用并区分按天 / 按应用", () => {
  const range = buildDateRange(3, new Date("2026-10-04T00:00:00Z"));
  // 轴：2026-10-02 / 10-03 / 10-04
  const rows = [
    { date: "2026-10-02", path: "/api/market/apps/1/download", count: 2 },
    { date: "2026-10-02", path: "/api/market/apps/1/versions/5/download", count: 3 },
    { date: "2026-10-04", path: "/api/market/apps/2/download", count: 4 },
    // 不属于当前开发者（已删除或他人应用），必须被忽略
    { date: "2026-10-03", path: "/api/market/apps/99/download", count: 100 },
    // 超出区间
    { date: "2026-09-01", path: "/api/market/apps/1/download", count: 50 },
    // 非下载路径
    { date: "2026-10-03", path: "/api/market/apps/1", count: 7 },
  ];

  const result = aggregateDownloads(rows, [1, 2], range);
  assert.equal(result.total, 9);
  assert.deepEqual(result.series, [5, 0, 4]);
  assert.deepEqual(result.byApp.get(1), [5, 0, 0]);
  assert.deepEqual(result.byApp.get(2), [0, 0, 4]);
});

test("aggregateDownloads 在无数据时返回全零轴", () => {
  const range = buildDateRange(3, new Date("2026-10-04T00:00:00Z"));
  const result = aggregateDownloads([], [1], range);
  assert.equal(result.total, 0);
  assert.deepEqual(result.series, [0, 0, 0]);
  assert.equal(result.byApp.size, 0);
});

test("countByDay 把记录按 createdAt 落到日期轴", () => {
  const range = buildDateRange(3, new Date("2026-10-04T00:00:00Z"));
  const result = countByDay(
    [
      { appId: 1, createdAt: new Date("2026-10-02T03:00:00Z") },
      { appId: 1, createdAt: "2026-10-02T11:00:00.000Z" },
      { appId: 2, createdAt: new Date("2026-10-04T23:00:00Z") },
      { appId: 1, createdAt: new Date("2026-01-01T00:00:00Z") },
    ],
    range,
  );
  assert.equal(result.total, 3);
  assert.deepEqual(result.series, [2, 0, 1]);
  assert.deepEqual(result.byApp.get(1), [2, 0, 0]);
});

test("ratingDistribution 固定返回 1~5 星五个桶并忽略异常值", () => {
  const distribution = ratingDistribution([
    { rating: 5 },
    { rating: 5 },
    { rating: 3 },
    { rating: 0 },
    { rating: 9 },
    { rating: null },
  ]);
  assert.deepEqual(distribution, [
    { rating: 1, count: 0 },
    { rating: 2, count: 0 },
    { rating: 3, count: 1 },
    { rating: 4, count: 0 },
    { rating: 5, count: 2 },
  ]);
});

test("averageRating 无有效评分时返回 null", () => {
  assert.equal(averageRating([]), null);
  assert.equal(averageRating([{ rating: 0 }, { rating: null }]), null);
  assert.equal(averageRating([{ rating: 5 }, { rating: 4 }]), 4.5);
  assert.equal(averageRating([{ rating: 5 }, { rating: 4 }, { rating: 4 }]), 4.33);
});

test("averageReviewHours 忽略未审核与异常时序", () => {
  assert.equal(averageReviewHours([]), null);
  assert.equal(
    averageReviewHours([
      { createdAt: "2026-10-01T00:00:00Z", reviewedAt: null },
      { createdAt: "2026-10-02T00:00:00Z", reviewedAt: "2026-10-01T00:00:00Z" },
    ]),
    null,
  );
  assert.equal(
    averageReviewHours([
      { createdAt: "2026-10-01T00:00:00Z", reviewedAt: "2026-10-01T06:00:00Z" },
      { createdAt: "2026-10-02T00:00:00Z", reviewedAt: "2026-10-02T12:00:00Z" },
    ]),
    9,
  );
});
