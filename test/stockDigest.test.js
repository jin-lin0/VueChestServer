const test = require("node:test");
const assert = require("node:assert");

const {
  pickSymbol,
  pickName,
  pickSignalDate,
  resolveSignalDate,
  digestStrategies,
  DEFAULT_STRATEGIES,
  ACCURACY_WINDOWS,
  dateMinusDays,
  renderEvaluationSection,
} = require("../services/stockDigest");

test("pickSymbol：带前缀代码直接识别", () => {
  assert.equal(pickSymbol({ 代码: "sh600519", 名称: "贵州茅台" }), "sh600519");
  assert.equal(pickSymbol({ code: "SZ000001" }), "sz000001");
});

test("pickSymbol：裸 6 位代码按首位推断交易所", () => {
  assert.equal(pickSymbol({ 股票代码: "600519" }), "sh600519");
  assert.equal(pickSymbol({ 股票代码: "300750" }), "sz300750");
  // 北交所 8 开头：无法映射到沪深行情，放弃
  assert.equal(pickSymbol({ 股票代码: "830001" }), null);
});

test("pickSymbol：无代码列时从值里嗅探前缀代码", () => {
  assert.equal(pickSymbol({ 排名: "1", 标的: "sh600036" }), "sh600036");
  assert.equal(pickSymbol({ 排名: "1", 涨幅: "3.2%" }), null);
});

test("pickName：优先名称列，否则按像名字的值猜", () => {
  assert.equal(pickName({ 代码: "sh600519", 名称: "贵州茅台" }, "sh600519"), "贵州茅台");
  assert.equal(pickName({ 代码: "sh600519", x: "3.5%", y: "宁德时代" }, "sh600519"), "宁德时代");
  assert.equal(pickName({ 代码: "sh600519", 评分: "95" }, "sh600519"), "");
});

test("pickSignalDate：从 meta/标题取日期", () => {
  assert.equal(pickSignalDate("MACD金叉 (2026-10-02) - 共 187 只 | 显示 1-15/187", ""), "2026-10-02");
  assert.equal(pickSignalDate("", "早晨之星 (2026-09-30)"), "2026-09-30");
  assert.equal(pickSignalDate("无日期", ""), null);
});

test("digestStrategies：环境变量覆盖与兜底", () => {
  const prev = process.env.STOCK_DIGEST_STRATEGIES;
  try {
    delete process.env.STOCK_DIGEST_STRATEGIES;
    assert.deepEqual(digestStrategies(), DEFAULT_STRATEGIES);
    process.env.STOCK_DIGEST_STRATEGIES = "macd_golden, ma_long";
    assert.deepEqual(digestStrategies(), ["macd_golden", "ma_long"]);
    // 非法 id（含路径字符）被过滤，全非法时退回默认
    process.env.STOCK_DIGEST_STRATEGIES = "../etc, x/y";
    assert.deepEqual(digestStrategies(), DEFAULT_STRATEGIES);
  } finally {
    if (prev === undefined) delete process.env.STOCK_DIGEST_STRATEGIES;
    else process.env.STOCK_DIGEST_STRATEGIES = prev;
  }
});

test("dateMinusDays：自然日回退含跨月", () => {
  assert.equal(dateMinusDays("2026-10-31", 1), "2026-10-30");
  assert.equal(dateMinusDays("2026-11-01", 15), "2026-10-17");
});

test("ACCURACY_WINDOWS：覆盖昨日/近3/7/15日", () => {
  assert.deepEqual(
    ACCURACY_WINDOWS.map((w) => w.days),
    [1, 3, 7, 15],
  );
});

test("renderEvaluationSection：按近15日正确率排名并展示各窗口", () => {
  const mkWindows = (d1, d3, d7, d15) => ({
    d1: { total: d1[1], upCount: d1[0] },
    d3: { total: d3[1], upCount: d3[0] },
    d7: { total: d7[1], upCount: d7[0] },
    d15: { total: d15[1], upCount: d15[0] },
  });
  const windowMap = new Map([
    ["a", { strategyId: "a", strategyName: "策略A", windows: mkWindows([5, 10], [10, 20], [20, 40], [30, 60]) }], // 50%
    ["b", { strategyId: "b", strategyName: "策略B", windows: mkWindows([8, 10], [15, 20], [30, 40], [48, 60]) }], // 80%
  ]);
  const accMap = new Map([
    ["a", { strategyId: "a", strategyName: "策略A", total: 100, upCount: 50 }],
    ["b", { strategyId: "b", strategyName: "策略B", total: 100, upCount: 80 }],
    // 窗口内无样本但有累计：也要进表
    ["c", { strategyId: "c", strategyName: "策略C", total: 40, upCount: 10 }],
  ]);
  const html = renderEvaluationSection(windowMap, accMap);
  // B（80%）排在 A（50%）前
  assert.ok(html.indexOf("策略B") < html.indexOf("策略A"));
  assert.ok(html.includes("80.0%"));
  assert.ok(html.includes("昨日") && html.includes("近3日") && html.includes("近15日"));
  // C 进表且窗口列为 —，累计 25.0%
  assert.ok(html.includes("策略C"));
  assert.ok(html.includes("25.0%"));
});

test("renderEvaluationSection：完全无数据时给空态文案", () => {
  const html = renderEvaluationSection(new Map(), new Map());
  assert.ok(html.includes("暂无已评估"));
});

test("resolveSignalDate：以数据所属交易日为准，标题日期只是上限", () => {
  // 周日运行、标题写当天、数据属于周五：取周五
  assert.equal(resolveSignalDate("2026-11-01", "2026-10-30"), "2026-10-30");
  // 收盘后运行：标题与参考日一致
  assert.equal(resolveSignalDate("2026-10-30", "2026-10-30"), "2026-10-30");
  // 参考行情缺失时退回标题
  assert.equal(resolveSignalDate("2026-10-30", null), "2026-10-30");
  // 标题缺失时退回参考日
  assert.equal(resolveSignalDate(null, "2026-10-30"), "2026-10-30");
  assert.equal(resolveSignalDate(null, null), null);
});
