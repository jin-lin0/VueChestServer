"use strict";

const { getAshareList, getKline, getIndexKline } = require("./data");
const { analyzeMarketEnv } = require("./marketEnv");
const { analyzeStock } = require("./patterns");
const { getDailyCache, setDailyCache, mapLimit } = require("./http");

const CONCURRENCY = 8;
// 候选上限：0 表示不限制。分析范围 = 全市场列表中的「主板 + 非 ST」股票
// （getAshareList 本身只枚举主板代码，故天然不含创业板/科创板/北交所）。
// 前端可通过 limit 参数限制扫描只数（性能护栏）。
const CANDIDATE_CAP_DEFAULT = 0;

// 综合分权重（技术/量价/资金）与等级阈值，集中管理便于调参
const SCORE_WEIGHTS = { tech: 0.45, vol: 0.35, cap: 0.2 };
const LEVEL = { high: 82, mid: 68 };

function isExcluded(name) {
  return /ST|退|\*/.test(name || "");
}

function levelOf(combined, regime) {
  let level =
    combined >= LEVEL.high ? "高" : combined >= LEVEL.mid ? "中" : "低";
  if (regime === "extreme_weak" && level === "高") level = "中";
  return level;
}

async function getRecommendations(options = {}) {
  const { limit = CANDIDATE_CAP_DEFAULT, refresh = false } = options;

  const cacheKey = `recommend:${limit}`;
  if (!refresh) {
    const cached = getDailyCache(cacheKey);
    if (cached) return cached;
  }

  const list = await getAshareList();
  const marketEnv = analyzeMarketEnv(list);

  // 分析范围：全市场列表中的「主板 + 非 ST」股票。
  // getAshareList 本身只枚举主板代码（sh600-605 / sz000-004），天然不含
  // 创业板(300/301)/科创板(688)/北交所(8/4 开头)；再按名称剔除 ST/*/退市股。
  const candidates = list.filter((s) => s.code && !isExcluded(s.name));
  if (limit > 0 && candidates.length > limit)
    candidates = candidates.slice(0, limit);

  let indexKlines = [];
  try {
    indexKlines = await getIndexKline("000001", 120);
  } catch (e) {
    console.warn(
      "[stock/recommend] 上证指数 K线拉取失败，强势回调抗跌对比将失效:",
      e.message,
    );
    indexKlines = [];
  }

  // 统计 K 线拉取失败数，若大面积失败则警告（避免 fqkline 501 那类静默吞错再现）
  let klineFailCount = 0;
  const analyzed = await mapLimit(candidates, CONCURRENCY, async (meta) => {
    let klines = [];
    try {
      klines = await getKline(meta.code, 250);
    } catch (e) {
      klineFailCount++;
      return null;
    }
    if (!klines || klines.length < 30) return null;
    const matches = analyzeStock(klines, meta, { indexKlines });
    if (!matches.length) return null;
    return { meta, matches };
  });
  if (klineFailCount > candidates.length * 0.5) {
    console.warn(
      `[stock/recommend] K线拉取失败率过高: ${klineFailCount}/${candidates.length}，可能数据源异常`,
    );
  }

  // 展开匹配、计算综合分与等级、按股票去重（保留最高分形态）
  const byCode = new Map();
  for (const item of analyzed) {
    if (!item) continue;
    const { meta, matches } = item;
    for (const m of matches) {
      const combined = Math.round(
        m.techScore * SCORE_WEIGHTS.tech +
          m.volumeScore * SCORE_WEIGHTS.vol +
          m.capitalScore * SCORE_WEIGHTS.cap,
      );
      const entry = {
        code: meta.code,
        name: meta.name,
        patternType: m.type,
        capitalBehavior: m.capitalBehavior,
        techScore: m.techScore,
        volumeScore: m.volumeScore,
        combined,
        level: levelOf(combined, marketEnv.regime),
        reason: m.reason,
        price: meta.price,
        changePct: meta.changePct,
        totalMvYi: +(meta.totalMv / 1e8).toFixed(1),
        turnoverRate: meta.turnoverRate,
        mainNetInflowYi: +(meta.mainNetInflow / 1e8).toFixed(2),
        detail: m.detail,
      };
      const prev = byCode.get(meta.code);
      if (!prev || combined > prev.combined) byCode.set(meta.code, entry);
    }
  }

  const stocks = [...byCode.values()].sort((a, b) => b.combined - a.combined);
  const top = stocks.slice(0, marketEnv.recommendCount);

  const result = {
    marketEnv,
    totalMatched: stocks.length,
    count: top.length,
    scanned: candidates.length,
    stocks: top,
    updatedAt: new Date().toISOString(),
  };
  setDailyCache(cacheKey, result);
  return result;
}

module.exports = { getRecommendations };
