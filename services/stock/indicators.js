"use strict";

// 各类技术指标与形态判断的纯函数工具

// 涨停幅度：主板/中小板 10%，创业板(300/301)/科创板(688) 20%，ST 5%
function limitPct(code, name = "") {
  const n = String(name);
  if (n.includes("ST") || n.includes("*")) return 0.05;
  if (
    code.startsWith("688") ||
    code.startsWith("300") ||
    code.startsWith("301")
  )
    return 0.2;
  return 0.1;
}

// 是否涨停：收盘价达到涨停价（允许 1 分误差）
function isLimitUp(close, prevClose, pct) {
  if (!prevClose || prevClose <= 0) return false;
  const limitPrice = Math.round(prevClose * (1 + pct) * 100) / 100;
  return close >= limitPrice - 0.01;
}

// 简单移动平均
function ma(arr, n, i) {
  if (i < n - 1) return null;
  let s = 0;
  for (let k = i - n + 1; k <= i; k++) s += arr[k];
  return s / n;
}

// 量比：当前成交量 / 前 n 日平均成交量（排除当日）
// 容错：若 i 前不足 n 根 K 线，用所有可用日数算均量（避免越界返 0 压低评分）
function volumeRatio(klines, i, n = 20) {
  const end = i - 1;
  const start = Math.max(0, end - n + 1);
  if (end < start) return 0;
  let s = 0;
  let cnt = 0;
  for (let k = start; k <= end; k++) {
    s += klines[k].volume;
    cnt++;
  }
  if (!cnt || s <= 0) return 0;
  return klines[i].volume / (s / cnt);
}

// 上影线长度
function upperShadow(bar) {
  return bar.high - Math.max(bar.open, bar.close);
}
// 下影线长度
function lowerShadow(bar) {
  return Math.min(bar.open, bar.close) - bar.low;
}
// 实体长度
function body(bar) {
  return Math.abs(bar.close - bar.open);
}
// 总振幅
function totalRange(bar) {
  return bar.high - bar.low || 1e-9;
}

// 上影线占比（上影 / 总振幅），越大说明高位被砸/试盘越明显
function upperShadowRatio(bar) {
  return upperShadow(bar) / totalRange(bar);
}

// 找出最近 count 根 K 线中的涨停位置（返回索引数组，相对于 klines）
// 等价于 findLimitUpsBefore(klines, klines.length, count, ...) —— 收敛到单一实现
function findLimitUps(klines, count, code, name) {
  return findLimitUpsBefore(klines, klines.length, count, code, name);
}

// 找 endIdx 之前（不含 endIdx）的 window 根 K 线内的涨停位置（返回索引数组，相对于 klines）
// 语义明确：用于"某根 K 线之前的涨停"，替代 findLimitUps(klines, endIdx, ...) 传 endIdx 当 count 的混淆写法
function findLimitUpsBefore(klines, endIdx, window, code, name) {
  const pct = limitPct(code, name);
  const res = [];
  const start = Math.max(0, endIdx - window);
  for (let i = start; i < endIdx; i++) {
    const prev = i > 0 ? klines[i - 1].close : klines[i].open;
    if (isLimitUp(klines[i].close, prev, pct)) res.push(i);
  }
  return res;
}

// 区间最高价与对应索引
function maxHigh(klines, from, to) {
  let m = -Infinity;
  let idx = from;
  for (let i = from; i <= to; i++) {
    if (klines[i].high > m) {
      m = klines[i].high;
      idx = i;
    }
  }
  return { high: m, idx };
}

// N 日收益率（基于收盘价）
function returnPct(klines, from, to) {
  if (from < 0 || to >= klines.length || from >= to) return 0;
  const base = klines[from].close;
  if (!base) return 0;
  return (klines[to].close - base) / base;
}

module.exports = {
  limitPct,
  isLimitUp,
  ma,
  volumeRatio,
  upperShadow,
  lowerShadow,
  body,
  totalRange,
  upperShadowRatio,
  findLimitUps,
  findLimitUpsBefore,
  maxHigh,
  returnPct,
};
