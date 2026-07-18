"use strict";

const I = require("./indicators");

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}
function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
// 评分收敛：所有形态评分统一落在 [lo, hi] 区间，避免各处手写 clamp(base+bonus) 边界漂移
function scoreClamp(base, bonus, lo, hi) {
  return clamp(base + bonus, lo, hi);
}
function yi(v) {
  // 元 -> 亿，保留 2 位
  return (v / 1e8).toFixed(2);
}

// ============ 形态一：放量长上影 ============
function detectLongUpperShadow(klines, meta) {
  if (klines.length < 40) return null;
  const n = klines.length;
  const closes = klines.map((k) => k.close); // 预提取收盘价数组，供 ma 计算复用
  // 只在最近 10 个交易日寻找信号：长上影必须「新鲜」、用户在盘面上肉眼可见，
  // 否则推荐一个 2 周前的信号没有任何操作意义。
  const windowStart = Math.max(0, n - 10);
  let best = null;

  for (let i = windowStart; i < n; i++) {
    const bar = klines[i];
    if (I.totalRange(bar) <= 0) continue;
    const vr = I.volumeRatio(klines, i, 20);
    const usr = I.upperShadowRatio(bar);
    const usLen = I.upperShadow(bar);
    const lsLen = I.lowerShadow(bar);
    const price = Math.max(bar.open, bar.close);

    // 硬条件1：明显放量（量比 ≥ 1.8）
    if (vr < 1.8) continue;
    // 硬条件2：上影线占振幅比足够大 —— 实体偏下、高位被砸，这才是「长上影」形态。
    //   （阈值 0.55：上影占全振幅过半，且实体落在下半区）
    if (usr < 0.55) continue;
    // 硬条件3：上影线必须明显长于下影线，排除上下影均衡的十字星 / 纺锤线
    //   （关键修复：旧逻辑用 usLen ≥ 1.2*body，当实体趋零时几乎恒为真，
    //    导致大量十字星被误判为「长上影」）
    if (lsLen > 1e-6 && usLen < 1.5 * lsLen) continue;
    // 硬条件4：上影线在价格上具备可观测幅度，排除几分钱的微型影线（伪长上影）
    if (usLen < 0.02 * price) continue;

    // 排除纯下跌趋势中的放量长上影
    const ret20 = I.returnPct(klines, i - 20, i);
    if (ret20 < -0.08) continue;
    // M2: 正面判断"横盘 / 上涨初期"（旧逻辑仅排除急跌，会漏选下跌中继反弹）
    //   横盘：近 60 日振幅 (高-低)/低 < 30%
    //   上涨初期：当前价站上 20 日均线，且 20 日均线 5 日内未明显下行（斜率非负-2%内）
    //   二者满足其一即符合"长期横盘整理或上涨初期"
    const rangeStart = Math.max(0, i - 60);
    let rangeHigh = -Infinity;
    let rangeLow = Infinity;
    for (let k = rangeStart; k < i; k++) {
      if (klines[k].high > rangeHigh) rangeHigh = klines[k].high;
      if (klines[k].low < rangeLow) rangeLow = klines[k].low;
    }
    const rangePct = rangeLow > 0 ? (rangeHigh - rangeLow) / rangeLow : 1;
    const isConsolidation = rangePct < 0.3;
    const ma20Now = I.ma(closes, 20, i);
    const ma20Prev = I.ma(closes, 20, Math.max(19, i - 5));
    const isUptrendStart =
      ma20Now != null &&
      ma20Prev != null &&
      bar.close > ma20Now &&
      ma20Now >= ma20Prev * 0.98;
    if (!isConsolidation && !isUptrendStart) continue;
    // 位置：接近前高（横盘/上涨初期试盘）
    const prior = I.maxHigh(klines, Math.max(0, i - 60), i - 1);
    const nearHigh = bar.high >= 0.9 * prior.high;
    if (!nearHigh) continue;
    // L1: 触及前高时，成交量需明显超过前高压力位成交量
    //   （旧逻辑取 prior.idx 单日量，代表性弱；改为前高附近 3 日均量）
    let pressureOk = true;
    let priorVolAvg = 0;
    if (bar.high >= 0.98 * prior.high && prior.idx >= 0) {
      const pIdx = prior.idx;
      const volStart = Math.max(0, pIdx - 1);
      const volEnd = Math.min(i - 1, pIdx + 1);
      let vs = 0;
      let vc = 0;
      for (let k = volStart; k <= volEnd; k++) {
        vs += klines[k].volume;
        vc++;
      }
      priorVolAvg = vc > 0 ? vs / vc : klines[pIdx].volume;
      pressureOk = bar.volume > priorVolAvg * 1.05;
    }
    if (!pressureOk) continue;
    // L3: 加分项——涨停后回调形成的长上影
    //   （旧逻辑 findLimitUps(klines, i, ...) 传 i 当 count 语义混淆，改用 findLimitUpsBefore 语义明确）
    const recentLu = I.findLimitUpsBefore(klines, i, 12, meta.code, meta.name);
    const postLimitUp =
      recentLu.length > 0 &&
      bar.close < klines[recentLu[recentLu.length - 1]].close;

    const tech = scoreClamp(
      55,
      Math.min(25, usr * 30) +
        (nearHigh ? 8 : 0) +
        (postLimitUp ? 10 : 0) +
        (isConsolidation ? 3 : 0) +
        (isUptrendStart ? 5 : 0),
      55,
      96,
    );
    const vol = scoreClamp(60, Math.min(35, (vr - 1.8) * 25), 55, 96);

    // 取「最近一根」满足条件的 K 线（信号新鲜、用户能在图上看到），而非历史最强的一根
    if (!best || i > best.i) {
      best = {
        tech,
        vol,
        i,
        vr,
        usr,
        nearHigh,
        postLimitUp,
        isConsolidation,
        isUptrendStart,
        bar,
        priorHigh: prior.high,
      };
    }
  }

  if (!best) return null;
  const b = best.bar;
  const posLabel = best.isConsolidation
    ? "横盘整理"
    : best.isUptrendStart
      ? "上涨初期"
      : "横盘/上涨初期";
  const behavior = `放量长上影：上影线占振幅比 ${best.usr.toFixed(2)}，成交量达 20 日均量 ${best.vr.toFixed(1)} 倍，资金在${
    best.nearHigh ? "前高压力位" : "相对高位"
  }主动试盘、冲高回落${best.postLimitUp ? "（涨停后回调结构）" : ""}，存在主力测试抛压行为。`;
  const reason = `近 10 日出现显著放量长上影（实体上方影线占比 ${best.usr.toFixed(
    2,
  )}，量比 ${best.vr.toFixed(1)}），处于${posLabel}且${
    best.nearHigh ? "逼近前高" : "相对高位"
  }试盘${best.postLimitUp ? "，且由前期涨停回调形成，结构更佳" : ""}。`;
  return {
    type: "放量长上影",
    techScore: Math.round(best.tech),
    volumeScore: Math.round(best.vol),
    capitalScore: best.postLimitUp ? 80 : 70,
    capitalBehavior: behavior,
    reason,
    detail: {
      vr: +best.vr.toFixed(1),
      usr: +best.usr.toFixed(2),
      date: b.date,
    },
  };
}

// ============ 形态二：一进二潜力股 ============
function detectFirstToSecond(klines, meta) {
  // 市值需 < 100 亿
  if (!meta.totalMv || meta.totalMv >= 1e10) return null;
  if (klines.length < 30) return null;
  const lu = I.findLimitUps(klines, 25, meta.code, meta.name);
  if (!lu.length) return null;
  const luIdx = lu[lu.length - 1]; // 最近一次涨停作为启动板
  const limitLow = klines[luIdx].low;
  const limitClose = klines[luIdx].close;
  const limitHigh = klines[luIdx].high;
  // 涨停后不能跌破涨停日最低价
  let minLowAfter = Infinity;
  for (let j = luIdx + 1; j < klines.length; j++) {
    if (klines[j].low < limitLow) return null;
    if (klines[j].low < minLowAfter) minLowAfter = klines[j].low;
  }
  // 维持强势结构：当前收盘价仍在涨停价 90% 以上
  const curClose = klines[klines.length - 1].close;
  if (curClose < limitClose * 0.9) return null;

  const daysSince = klines.length - 1 - luIdx;
  const recencyBonus = daysSince <= 5 ? 15 : daysSince <= 12 ? 9 : 4;
  const structureMargin = (minLowAfter - limitLow) / (limitLow || 1);
  const breakout = klines.slice(luIdx).some((k) => k.high > limitHigh * 1.005);
  const consolidation = !breakout && daysSince >= 3;
  const vrLu = I.volumeRatio(klines, luIdx, 20);
  // H1: mainNetInflow 恒 0（腾讯报价无此字段），改用量价代理判断"资金持续关注"：
  //   ① 涨停日放量（量比 ≥ 1.5，涨停伴随资金涌入）
  //   ② 涨停后未极度缩量（涨停后日均量 ≥ 涨停日量 35%，资金未完全撤退）
  //   两条同时满足才视为资金持续关注，否则只给基础分。
  const afterLu = klines.slice(luIdx + 1);
  const afterVolAvg = afterLu.length
    ? mean(afterLu.map((k) => k.volume))
    : klines[luIdx].volume;
  const capitalOk = vrLu >= 1.5 && afterVolAvg >= klines[luIdx].volume * 0.35;

  const tech = scoreClamp(
    65,
    recencyBonus +
      Math.min(8, structureMargin * 100) +
      (breakout ? 10 : 0) +
      (consolidation ? 6 : 0) +
      (capitalOk ? 5 : 0),
    65,
    96,
  );
  const vol = scoreClamp(60, Math.min(32, (vrLu - 1.5) * 22), 55, 96);

  const behavior = `小盘股（总市值 ${yi(meta.totalMv)} 亿），近期（${klines[luIdx].date}）涨停（量比 ${vrLu.toFixed(
    1,
  )}），涨停后股价未跌破涨停日最低价，维持强势整理结构${
    breakout ? "，并已突破前高" : ""
  }${capitalOk ? "，涨停后量能维持（资金持续关注）" : "，量能有所萎缩"}，具备一进二连板潜力。`;
  const reason = `市值 ${yi(meta.totalMv)} 亿（<100 亿），${klines[luIdx].date} 涨停后 ${
    daysSince
  } 个交易日内未破涨停最低价，结构强势${breakout ? "且突破前高" : ""}，符合一进二启动形态。`;
  return {
    type: "一进二",
    techScore: Math.round(tech),
    volumeScore: Math.round(vol),
    capitalScore: capitalOk ? 82 : 72,
    capitalBehavior: behavior,
    reason,
    detail: {
      limitDate: klines[luIdx].date,
      daysSince,
      breakout,
      minLowAfter: +minLowAfter.toFixed(2),
    },
  };
}

// ============ 形态三：强势股回调机会 ============
function detectStrongPullback(klines, meta, ctx) {
  if (klines.length < 40) return null;
  const n = klines.length;
  // 前期强度：近 30 日存在涨停 或 阶段涨幅 > 25%
  const lu = I.findLimitUps(klines, 30, meta.code, meta.name);
  let peakIdx = n - 30;
  for (let i = n - 30; i < n; i++)
    if (klines[i].close > klines[peakIdx].close) peakIdx = i;
  const stageGain =
    (klines[peakIdx].close - klines[Math.max(0, n - 30)].close) /
    klines[Math.max(0, n - 30)].close;
  const hasStrength = lu.length > 0 || stageGain > 0.25;
  if (!hasStrength) return null;

  const peakClose = klines[peakIdx].close;
  const curClose = klines[n - 1].close;
  const pullback = (peakClose - curClose) / peakClose;
  // 当前处于回调区间且回调幅度合理（非崩塌）
  if (pullback < 0.03 || pullback > 0.4) return null;
  // M3: 近期确实在回落/横盘——近 10 日未创近 30 日新高
  //   （旧逻辑 curClose < klines[n-10].close 强制 10 日必跌，漏掉横盘整理；
  //    改为"近 10 日最高价 < 近 30 日最高价"，覆盖横盘调整形态）
  const high30Start = Math.max(0, n - 30);
  const high10Start = Math.max(0, n - 10);
  let high30 = -Infinity;
  let high10 = -Infinity;
  for (let k = high30Start; k < n; k++)
    if (klines[k].high > high30) high30 = klines[k].high;
  for (let k = high10Start; k < n; k++)
    if (klines[k].high > high10) high10 = klines[k].high;
  if (high10 >= high30) return null;

  // 抗跌：与上证指数对比
  let resilient = false;
  let stockDrawdown = pullback;
  let indexDrawdown = 0;
  let avgStockDown = 0;
  let avgIndexDown = 0;
  const indexKlines = ctx && ctx.indexKlines;
  if (indexKlines && indexKlines.length) {
    const idxByDate = new Map(indexKlines.map((k) => [k.date, k.close]));
    const window = Math.min(15, n - 1);
    const pairs = [];
    for (let i = n - window; i < n; i++) {
      const ic = idxByDate.get(klines[i].date);
      if (ic == null) continue;
      pairs.push({ k: klines[i], ic });
    }
    if (pairs.length >= 5) {
      const stockRetOnDown = [];
      const indexRetOnDown = [];
      let maxStock = -Infinity;
      let maxIdx = -Infinity;
      for (const p of pairs) {
        if (p.k.close > maxStock) maxStock = p.k.close;
        if (p.ic > maxIdx) maxIdx = p.ic;
      }
      for (let i = 1; i < pairs.length; i++) {
        const sRet =
          (pairs[i].k.close - pairs[i - 1].k.close) / pairs[i - 1].k.close;
        const iRet = (pairs[i].ic - pairs[i - 1].ic) / pairs[i - 1].ic;
        if (iRet < -0.001) {
          stockRetOnDown.push(sRet);
          indexRetOnDown.push(iRet);
        }
      }
      stockDrawdown = (curClose - maxStock) / maxStock;
      indexDrawdown = (pairs[pairs.length - 1].ic - maxIdx) / maxIdx;
      avgStockDown = mean(stockRetOnDown);
      avgIndexDown = mean(indexRetOnDown);
      resilient =
        stockDrawdown > indexDrawdown &&
        (stockRetOnDown.length ? avgStockDown > avgIndexDown - 0.005 : true);
    }
  }
  if (!resilient) return null;

  // L4: 缩量调整——近 5 日均量 < 前段 5 日均量（阈值从 0.9 收紧到 0.75，要求缩量 25%+）
  const recentVol = mean(klines.slice(n - 5).map((k) => k.volume));
  const prevVol = mean(klines.slice(n - 15, n - 10).map((k) => k.volume));
  const volRatio = prevVol > 0 ? recentVol / prevVol : 1;
  if (volRatio > 0.75) return null; // 必须明显缩量

  // M4: 底部反复确认——近 10 日内 ≥ 2 次"下影线 > 实体 2 倍"的企稳 K 线
  let bottomConfirm = 0;
  for (let k = Math.max(0, n - 10); k < n; k++) {
    const bk = klines[k];
    const bBody = I.body(bk);
    const bLower = I.lowerShadow(bk);
    if (bBody > 1e-9 && bLower > bBody * 2) bottomConfirm++;
    else if (bBody <= 1e-9 && bLower > 0.01 * bk.close) bottomConfirm++; // 十字星 + 下影也算
  }
  // M4: 量价背离——近 5 日收盘价创近 20 日新低，但近 5 日均量未创近 20 日新低
  const recent5MinClose = Math.min(...klines.slice(n - 5).map((k) => k.close));
  const prev15MinClose = Math.min(
    ...klines.slice(Math.max(0, n - 20), n - 5).map((k) => k.close),
  );
  const prev15AvgVol = mean(
    klines.slice(Math.max(0, n - 20), n - 5).map((k) => k.volume),
  );
  const volDivergence =
    recent5MinClose < prev15MinClose && recentVol > prev15AvgVol * 0.9;

  // H1: 资金重新流入——mainNetInflow 恒 0，改用量价代理：
  //   近 3 日存在"收盘上涨且量比 > 1"的 K 线（资金主动买入信号）
  let capitalBack = false;
  for (let k = Math.max(1, n - 3); k < n; k++) {
    const up = klines[k].close > klines[k - 1].close;
    const vrK = I.volumeRatio(klines, k, 20);
    if (up && vrK > 1) {
      capitalBack = true;
      break;
    }
  }
  // 企稳：更高的低点
  const higherLow = klines[n - 1].low > klines[n - 6]?.low;

  // 用户要求四选一企稳信号：底部反复确认 OR 量价背离 OR 资金重新流入 OR 更高低点
  if (!capitalBack && !higherLow && !volDivergence && bottomConfirm < 2)
    return null;

  const tech = scoreClamp(
    60,
    Math.min(20, (stockDrawdown - indexDrawdown) * 100) +
      (higherLow ? 6 : 0) +
      (bottomConfirm >= 2 ? 6 : 0) +
      (volDivergence ? 5 : 0) +
      (capitalBack ? 5 : 0) +
      (pullback < 0.2 ? 4 : 0),
    60,
    94,
  );
  const vol = scoreClamp(
    60,
    (volRatio < 0.5 ? 32 : volRatio < 0.75 ? 22 : 15) + (capitalBack ? 8 : 0),
    55,
    95,
  );

  const stabilizeSignals = [];
  if (capitalBack) stabilizeSignals.push("资金量价齐升");
  if (bottomConfirm >= 2)
    stabilizeSignals.push(`底部 ${bottomConfirm} 次企稳确认`);
  if (volDivergence) stabilizeSignals.push("量价背离");
  if (higherLow) stabilizeSignals.push("低点抬高");
  const stabilizeText = stabilizeSignals.length
    ? stabilizeSignals.join("、")
    : "低位整理";
  const behavior = `前期存在${
    lu.length ? "涨停" : "明显上涨趋势"
  }（阶段涨幅约 ${(stageGain * 100).toFixed(0)}%），回调中表现抗跌：大盘下跌时段个股跌幅明显小于指数，呈缩量洗盘（量比前段 ${(
    volRatio * 100
  ).toFixed(0)}%），出现${stabilizeText}，存在再度启动迹象。`;
  const reason = `前期${
    lu.length ? "涨停/" : ""
  }阶段涨幅约 ${(stageGain * 100).toFixed(0)}%，回调 ${(pullback * 100).toFixed(
    0,
  )}% 且明显抗跌（个股回撤 ${(-stockDrawdown * 100).toFixed(
    0,
  )}% vs 指数 ${(-indexDrawdown * 100).toFixed(0)}%），缩量至前段 ${(
    volRatio * 100
  ).toFixed(0)}%，${stabilizeText}。`;
  return {
    type: "强势回调",
    techScore: Math.round(tech),
    volumeScore: Math.round(vol),
    capitalScore: capitalBack || bottomConfirm >= 2 || volDivergence ? 80 : 74,
    capitalBehavior: behavior,
    reason,
    detail: {
      stageGain: +(stageGain * 100).toFixed(0),
      pullback: +(pullback * 100).toFixed(0),
      stockDrawdown: +(-stockDrawdown * 100).toFixed(0),
      indexDrawdown: +(-indexDrawdown * 100).toFixed(0),
      volRatio: +volRatio.toFixed(2),
      bottomConfirm,
      volDivergence,
      capitalBack,
      higherLow,
    },
  };
}

// 运行全部检测器，返回匹配结果数组
function analyzeStock(klines, meta, ctx = {}) {
  const results = [];
  const a = detectLongUpperShadow(klines, meta);
  const b = detectFirstToSecond(klines, meta);
  const c = detectStrongPullback(klines, meta, ctx);
  if (a) results.push(a);
  if (b) results.push(b);
  if (c) results.push(c);
  return results;
}

module.exports = {
  detectLongUpperShadow,
  detectFirstToSecond,
  detectStrongPullback,
  analyzeStock,
};
