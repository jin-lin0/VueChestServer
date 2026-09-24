const express = require("express");
const router = express.Router();
const { runWestock } = require("../services/westock/client");
const { authMiddleware } = require("../middleware/auth");

// 这些接口每个请求都会 spawn 一个子进程，是有状态、有并发上限的昂贵资源，
// 因此与 bilibili / aiChat 等重上游路由一致，整体要求登录后再访问。
router.use(authMiddleware);

const ENGINE_SET = new Set(["data", "screen"]);

// 每个命名接口从 query 构造 westock CLI 参数。
// 说明来自 candlesift 两个 CLI 的 --help（westock-data / westock-tool）。
const COMMAND_SPEC = {
  search: {
    engine: "data",
    label: "股票搜索",
    desc: "统一搜索入口（默认仅股票）",
    example: "search 茅台 --limit 10",
    build: (q) => [
      "search",
      q.q || q.keyword || "",
      "--limit",
      q.limit || 10,
      ...(q.type ? ["--type", q.type] : []),
      ...(q.market ? ["--market", q.market] : []),
    ],
  },
  kline: {
    engine: "data",
    label: "K线",
    desc: "日/周/月 K 线（--raw 返回 JSON）",
    example: "kline sh600519 --period day --limit 200 --fq qfq --raw",
    build: (q) => [
      "kline",
      q.code || "",
      "--period",
      q.period || "day",
      "--limit",
      q.limit || 200,
      "--fq",
      q.fq || "qfq",
      ...(q.start ? ["--start", q.start] : []),
      ...(q.end ? ["--end", q.end] : []),
      "--raw",
    ],
  },
  quote: {
    engine: "data",
    label: "实时行情",
    desc: "个股/指数/ETF/期货/外汇实时或历史行情",
    example: "quote sh600519",
    build: (q) => ["quote", q.code || "", ...(q.date ? ["--date", q.date] : [])],
  },
  minute: {
    engine: "data",
    label: "分时",
    desc: "分时数据",
    example: "minute sh600519 --days 1",
    build: (q) => ["minute", q.code || "", ...(q.days ? ["--days", q.days] : [])],
  },
  technical: {
    engine: "data",
    label: "技术指标",
    desc: "RSI/MACD 等技术指标",
    example: "technical sh600519 --group all",
    build: (q) => [
      "technical",
      q.code || "",
      ...(q.group ? ["--group", q.group] : []),
      ...(q.date ? ["--date", q.date] : []),
      ...(q.start ? ["--start", q.start] : []),
      ...(q.end ? ["--end", q.end] : []),
    ],
  },
  chip: {
    engine: "data",
    label: "筹码成本",
    desc: "筹码成本分析（仅 A 股）",
    example: "chip sh600519",
    build: (q) => [
      "chip",
      q.code || "",
      ...(q.date ? ["--date", q.date] : []),
      ...(q.start ? ["--start", q.start] : []),
      ...(q.end ? ["--end", q.end] : []),
    ],
  },
  finance: {
    engine: "data",
    label: "财务数据",
    desc: "财务报表数据",
    example: "finance sh600519 --type main --num 4",
    build: (q) => [
      "finance",
      q.code || "",
      ...(q.type ? ["--type", q.type] : []),
      ...(q.num ? ["--num", q.num] : []),
    ],
  },
  disclosure: {
    engine: "data",
    label: "财报披露日历",
    desc: "业绩预约披露日",
    example: "disclosure sh600519",
    build: (q) => ["disclosure", q.code || ""],
  },
  rating: {
    engine: "data",
    label: "机构评级",
    desc: "机构评级",
    example: "rating sh600519",
    build: (q) => ["rating", q.code || ""],
  },
  consensus: {
    engine: "data",
    label: "一致预期",
    desc: "一致预期（A股/港股）",
    example: "consensus sh600519",
    build: (q) => ["consensus", q.code || ""],
  },
  report: {
    engine: "data",
    label: "研报",
    desc: "研报列表 / 详情（detail <id>）",
    example: "report sh600519 --limit 5",
    build: (q) =>
      q.id
        ? ["report", "detail", q.id]
        : [
            "report",
            q.code || "",
            ...(q.limit ? ["--limit", q.limit] : []),
            ...(q.offset ? ["--offset", q.offset] : []),
          ],
  },
  dehydrated: {
    engine: "data",
    label: "脱水研报",
    desc: "脱水研报列表 / 详情",
    example: "dehydrated list --limit 5",
    build: (q) =>
      q.id
        ? ["dehydrated", "detail", q.id]
        : [
            "dehydrated",
            "list",
            ...(q.limit ? ["--limit", q.limit] : []),
            ...(q.offset ? ["--offset", q.offset] : []),
          ],
  },
  score: {
    engine: "data",
    label: "股票评分",
    desc: "最新评分及周/月/季变动",
    example: "score sh600519",
    build: (q) => ["score", q.code || "", ...(q.date ? ["--date", q.date] : [])],
  },
  notice: {
    engine: "data",
    label: "公告",
    desc: "公司公告列表 / 内容",
    example: "notice list sh600519 --limit 10",
    build: (q) => [
      "notice",
      q.sub || "list",
      // 股票代码是位置参数（CLI 不认 --code，传了会以退出码 1 报未知参数）。
      ...(q.code ? [q.code] : []),
      ...(q.type ? ["--type", q.type] : []),
      ...(q.limit ? ["--limit", q.limit] : []),
      ...(q.offset ? ["--offset", q.offset] : []),
    ],
  },
  fund: {
    engine: "data",
    label: "资金流向",
    desc: "资金 flow/short/margin/block",
    example: "fund flow sh600519",
    build: (q) => [
      "fund",
      q.sub || "flow",
      // 同上：代码走位置参数。
      ...(q.code ? [q.code] : []),
      ...(q.start ? ["--start", q.start] : []),
      ...(q.end ? ["--end", q.end] : []),
    ],
  },
  shareholder: {
    engine: "data",
    label: "股东研究",
    desc: "股东研究（A股/港股）",
    example: "shareholder sh600519",
    build: (q) => ["shareholder", q.code || ""],
  },
  dividend: {
    engine: "data",
    label: "分红",
    desc: "历史分红与拆合股",
    example: "dividend list sh600519 --years 5",
    build: (q) => [
      "dividend",
      "list",
      q.code || "",
      ...(q.years ? ["--years", q.years] : []),
      ...(q.all ? ["--all"] : []),
    ],
  },
  buyback: {
    engine: "data",
    label: "公司回购",
    desc: "公司回购（A股/港股）",
    example: "buyback sh600519",
    build: (q) => [
      "buyback",
      q.code || "",
      ...(q.start ? ["--start", q.start] : []),
      ...(q.end ? ["--end", q.end] : []),
    ],
  },
  profile: {
    engine: "data",
    label: "股票简况",
    desc: "股票简况",
    example: "profile sh600519",
    build: (q) => ["profile", q.code || ""],
  },
  strategy: {
    engine: "screen",
    label: "策略选股",
    desc: "形态/指标策略选股（输出 Markdown 表）",
    example: "strategy macd_golden --date 2026-09-23 --limit 20",
    build: (q) => [
      "strategy",
      q.id || "",
      ...(q.date ? ["--date", q.date] : []),
      ...(q.start ? ["--start", q.start] : []),
      ...(q.end ? ["--end", q.end] : []),
      ...(q.limit ? ["--limit", q.limit] : []),
      ...(q.offset ? ["--offset", q.offset] : []),
    ],
  },
  filter: {
    engine: "screen",
    label: "高级选股",
    desc: "表达式 / 预设条件选股",
    example: 'filter --preset LowPE --date 2026-09-23 --limit 20',
    build: (q) => [
      "filter",
      q.expr || "",
      ...(q.preset ? ["--preset", q.preset] : []),
      ...(q.date ? ["--date", q.date] : []),
      ...(q.limit ? ["--limit", q.limit] : []),
      ...(q.market ? ["--market", q.market] : []),
    ],
  },
  label: {
    engine: "screen",
    label: "标签选股",
    desc: "标签 / 主题池选股、选基",
    example: "label valuation_lowpb --date 2026-09-23",
    build: (q) => [
      "label",
      q.id || "",
      ...(q.asset ? ["--asset", q.asset] : []),
      ...(q.date ? ["--date", q.date] : []),
      ...(q.start ? ["--start", q.start] : []),
      ...(q.end ? ["--end", q.end] : []),
      ...(q.limit ? ["--limit", q.limit] : []),
    ],
  },
  event: {
    engine: "screen",
    label: "事件选股",
    desc: "事件驱动选股",
    example: "event shareunlock_next_90 --limit 20",
    build: (q) => [
      "event",
      q.id || "",
      ...(q.limit ? ["--limit", q.limit] : []),
      ...(q.offset ? ["--offset", q.offset] : []),
    ],
  },
  ranking: {
    engine: "screen",
    label: "排行榜",
    desc: "综合/资金/估值等横截面排行",
    example: "ranking CompScore --limit 20",
    build: (q) => [
      "ranking",
      q.metric || "",
      ...(q.asset ? ["--asset", q.asset] : []),
      ...(q.date ? ["--date", q.date] : []),
      ...(q.type ? ["--type", q.type] : []),
      ...(q.universe ? ["--universe", q.universe] : []),
      ...(q.orderby ? ["--orderby", q.orderby] : []),
      ...(q.asc ? ["--asc"] : []),
      ...(q.limit ? ["--limit", q.limit] : []),
    ],
  },
};

function cleanArgs(args) {
  // 只做类型归一与去空，不做长度截断：截断会把超长值静默改写成另一个值，
  // 也会让 client.js 里的「参数过长」校验永远不可达。长度由白名单统一把关。
  return args
    .filter((value) => value !== undefined && value !== null && value !== "")
    .map((value) => String(value));
}

// 通用执行器：直接 spawn westock CLI，原样返回解析后的输出。覆盖全部命令。
// 参数白名单 / 长度 / 子进程并发闸门统一在 services/westock/client.js 里强制，
// 这里不再重复校验，避免两处规则漂移。
router.post("/exec", async (req, res, next) => {
  try {
    const body = req.body || {};
    const engine = ENGINE_SET.has(body.engine) ? body.engine : "data";
    const args = cleanArgs(Array.isArray(body.args) ? body.args : []);
    const result = await runWestock(engine, args);
    res.json({ success: result.success, engine, args, ...result });
  } catch (error) {
    next(error);
  }
});

// 命令目录：供前端 UI 动态渲染快捷入口。
router.get("/catalog", (req, res) => {
  const entries = Object.entries(COMMAND_SPEC).map(([id, spec]) => ({
    id,
    engine: spec.engine,
    label: spec.label,
    desc: spec.desc,
    example: spec.example,
  }));
  res.json({
    success: true,
    engines: ["data", "screen"],
    commands: entries,
  });
});

// 命名 GET 接口：每个命令一张表，薄封装到通用执行器。
for (const [id, spec] of Object.entries(COMMAND_SPEC)) {
  router.get(`/${id}`, async (req, res, next) => {
    try {
      const args = cleanArgs(spec.build(req.query));
      // 只剩命令名说明关键定位参数（股票代码/策略名/指标名）全缺，
      // 直接 400，不要白白 spawn 一个必然失败的进程。
      if (args.length <= 1) {
        const error = new Error(`命令 ${id} 缺少必要参数`);
        error.status = 400;
        error.code = "VALIDATION";
        throw error;
      }
      const result = await runWestock(spec.engine, args);
      res.json({ success: result.success, engine: spec.engine, command: id, args, ...result });
    } catch (error) {
      next(error);
    }
  });
}

module.exports = router;
// 供测试断言「每个命名接口在给定 query 下构造出的参数都能通过 client 的白名单」，
// 避免新增命令/参数时静默踩到验证层。
module.exports.COMMAND_SPEC = COMMAND_SPEC;
module.exports.cleanArgs = cleanArgs;
