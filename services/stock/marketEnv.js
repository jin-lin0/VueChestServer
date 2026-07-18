"use strict";

// 基于全市场股票列表统计市场环境（情绪 + 资金活跃度）
function analyzeMarketEnv(list) {
  if (!list.length) {
    return {
      regime: "unknown",
      sentimentScore: 50,
      activityScore: 50,
      breadth: 0.5,
      up: 0,
      down: 0,
      limitUp: 0,
      limitDown: 0,
      avgChange: 0,
      totalAmountYi: 0,
      totalMainInflowYi: null,
      recommendCount: 15,
      description: "无市场数据",
    };
  }

  let up = 0;
  let down = 0;
  let limitUp = 0;
  let limitDown = 0;
  let sumChange = 0;
  let totalAmount = 0;
  let sumTurnover = 0;

  for (const s of list) {
    const c = s.changePct;
    sumChange += c;
    sumTurnover += s.turnoverRate || 0;
    totalAmount += s.amount || 0;
    if (c > 0) up++;
    else if (c < 0) down++;
    if (c >= 9.8) limitUp++;
    if (c <= -9.8) limitDown++;
  }

  const total = list.length;
  const breadth = up + down > 0 ? up / (up + down) : 0.5;
  const avgChange = sumChange / total;
  const avgTurnover = sumTurnover / total;
  const totalAmountYi = totalAmount / 1e8;
  // 主力净流入：腾讯报价不含该数据，标记为 null（前端展示「—」）
  const totalMainInflowYi = null;

  // 情绪评分 0-100
  let sentimentScore;
  if (avgChange >= 1 && breadth >= 0.6 && limitUp >= 50) sentimentScore = 85;
  else if (avgChange >= 0.3 && breadth >= 0.5) sentimentScore = 70;
  else if (avgChange > -0.5 && breadth >= 0.4) sentimentScore = 58;
  else if (avgChange <= -1 && breadth < 0.4) sentimentScore = 38;
  else if (avgChange <= -2 || breadth < 0.25 || limitDown > limitUp * 2)
    sentimentScore = 22;
  else sentimentScore = 48;

  // 活跃度评分：成交额 + 涨停家数 + 平均换手
  let activityScore = 50;
  if (totalAmountYi > 12000) activityScore += 20;
  else if (totalAmountYi > 8000) activityScore += 12;
  else if (totalAmountYi < 5000) activityScore -= 15;
  if (limitUp >= 80) activityScore += 12;
  else if (limitUp >= 40) activityScore += 6;
  if (avgTurnover > 3) activityScore += 8;
  activityScore = Math.max(10, Math.min(100, activityScore));

  // 环境分级与推荐数量（极端弱势降低推荐数量）
  let regime;
  let recommendCount;
  let description;
  if (sentimentScore >= 75) {
    regime = "strong";
    recommendCount = 25;
    description = "市场情绪高涨、资金活跃，可适当扩大关注范围";
  } else if (sentimentScore >= 58) {
    regime = "normal";
    recommendCount = 18;
    description = "市场情绪中性偏暖，按常态筛选";
  } else if (sentimentScore >= 38) {
    regime = "weak";
    recommendCount = 10;
    description = "市场偏弱，控制推荐数量、提高入选标准";
  } else {
    regime = "extreme_weak";
    recommendCount = 5;
    description = "市场极端弱势，仅保留最确定性机会，严格控制数量";
  }

  return {
    regime,
    sentimentScore: Math.round(sentimentScore),
    activityScore: Math.round(activityScore),
    breadth: +breadth.toFixed(3),
    up,
    down,
    limitUp,
    limitDown,
    avgChange: +avgChange.toFixed(2),
    totalAmountYi: +totalAmountYi.toFixed(0),
    totalMainInflowYi,
    recommendCount,
    description,
  };
}

module.exports = { analyzeMarketEnv };
