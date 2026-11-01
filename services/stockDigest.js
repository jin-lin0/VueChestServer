const { Op } = require("sequelize");
const { runWestock } = require("./westock/client");
const { positiveInt } = require("./westock/limiter");
const { fetchQuotes } = require("./tencentQuotes");
const StockStrategySignal = require("../models/stockStrategySignal");
const { sendHtmlMail } = require("../utils/mail");

// Vercel 函数硬上限 60s（vercel.json maxDuration），且生产区域到国内上游的网络
// 明显慢于本地（实测本地全流程约 13s，线上曾整单 504）。因此按「整体预算 +
// 单步预算」两层收口：预算耗尽就跳过剩余策略并照常发邮件，宁可日报不全，
// 也不能超时导致一封都发不出去。
const TOTAL_BUDGET_MS = positiveInt(process.env.STOCK_DIGEST_BUDGET_MS, 40000);
const EVAL_BUDGET_MS = positiveInt(process.env.STOCK_DIGEST_EVAL_BUDGET_MS, 12000);
const STRATEGY_TIMEOUT_MS = positiveInt(
  process.env.STOCK_DIGEST_STRATEGY_TIMEOUT_MS,
  15000,
);

// ── 策略集合 ─────────────────────────────────────────────────
// 默认跑前端「热门策略」同一批（见 VueChest westock-discover.ts 的 HOT_ITEMS），
// 可用 STOCK_DIGEST_STRATEGIES 覆盖（逗号分隔策略 id，仅支持下表内已知名称映射，
// 未知 id 名称退回 id 本身，不影响执行）。
const STRATEGY_NAMES = {
  morning_star: "早晨之星",
  macd_golden: "MACD 金叉",
  over_drop_rebound: "超跌反弹",
  ma_long: "均线多头发散",
  major_force: "主力抢筹",
  buffet: "价值龙头（巴菲特）",
  profit_preannounce: "业绩预增",
};
const DEFAULT_STRATEGIES = Object.keys(STRATEGY_NAMES);

// 每个策略最多入库/推送的候选数。太多会拖慢评估（行情按 100 只分批）且邮件冗长。
const MAX_PICKS = 15;

function digestStrategies() {
  const raw = (process.env.STOCK_DIGEST_STRATEGIES || "").trim();
  if (!raw) return DEFAULT_STRATEGIES;
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^[a-z0-9_]+$/i.test(s));
  return ids.length ? ids : DEFAULT_STRATEGIES;
}

// ── 信号采集 ─────────────────────────────────────────────────

const PREFIXED_CODE = /^(sh|sz)\d{6}$/i;
const BARE_CODE = /^\d{6}$/;

/** 从结果行里抽 sh/sz 规范代码；北交所/认不出的行跳过（评估依赖腾讯沪深行情）。 */
function pickSymbol(row) {
  const entries = Object.entries(row);
  const codeEntries = entries.filter(([key]) =>
    /^(code|symbol|股票代码|证券代码|代码)$/i.test(key),
  );
  const candidates = codeEntries.length
    ? codeEntries
    : entries.filter(([, value]) => PREFIXED_CODE.test(String(value ?? "").trim()));
  for (const [, value] of candidates) {
    const text = String(value ?? "").trim().toLowerCase();
    if (PREFIXED_CODE.test(text)) return text;
    if (BARE_CODE.test(text)) {
      // 裸代码按首位猜交易所：6/5 沪、0/3 深，其余（北交所等）放弃
      if (/^[56]/.test(text)) return `sh${text}`;
      if (/^[03]/.test(text)) return `sz${text}`;
      return null;
    }
  }
  return null;
}

/** 名称列不统一，按「像中文/字母名字且不是代码、不是纯数字」猜。 */
function pickName(row, symbol) {
  const nameEntry = Object.entries(row).find(([key]) =>
    /^(name|股票名称|证券名称|名称|简称)$/i.test(key),
  );
  if (nameEntry && String(nameEntry[1]).trim()) return String(nameEntry[1]).trim();
  for (const value of Object.values(row)) {
    const text = String(value ?? "").trim();
    if (!text || text === symbol) continue;
    if (PREFIXED_CODE.test(text) || BARE_CODE.test(text)) continue;
    if (/[一-龥A-Za-z]/.test(text) && !/^\d+(\.\d+)?%?$/.test(text)) return text;
  }
  return "";
}

/** 结果 meta 标题形如「MACD金叉 (2026-10-02) - 共 187 只」，日期即信号交易日。 */
function pickSignalDate(meta, title) {
  const m = `${title || ""} ${meta || ""}`.match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

/**
 * 信号日期以「数据所属交易日」为准，取标题日期与参考行情日期的较早者。
 * 实测：CLI 不传 --date 时标题用的是**运行当天**（周末也照写），而数据其实是
 * 最近一个收盘交易日。若直接用标题日期，周一早盘采集的信号会被记成周一，
 * 次日评估就会错位一天。采集时已显式传 --date，这里只做双重保险。
 */
function resolveSignalDate(titleDate, effectiveDate) {
  if (titleDate && effectiveDate) return titleDate < effectiveDate ? titleDate : effectiveDate;
  return titleDate || effectiveDate || null;
}

/**
 * 最近一个已完成收盘的交易日。
 * 早盘 cron（北京时间 8:30 左右）运行时，上证指数行情的 asOf 仍停在上一个
 * 收盘交易日，用它作为策略查询日期，结果才是确定且可复现的。
 * 行情不可用时返回 null，退回 CLI 默认日期。
 */
async function latestCompletedDate() {
  try {
    const rows = await fetchQuotes(["sh000001"]);
    const asOf = rows[0]?.asOf;
    if (!/^\d{14}$/.test(asOf || "")) return null;
    return `${asOf.slice(0, 4)}-${asOf.slice(4, 6)}-${asOf.slice(6, 8)}`;
  } catch (error) {
    console.warn("[stock-digest] 参考行情获取失败，退回 CLI 默认日期:", error.message);
    return null;
  }
}

/**
 * 跑一个策略并把结果落库（(strategyId, signalDate) 幂等）。
 * 返回 { strategyId, strategyName, signalDate, picks } 或 null（无结果/格式异常）。
 */
async function collectStrategy(strategyId, effectiveDate = null, timeoutMs = undefined) {
  const strategyName = STRATEGY_NAMES[strategyId] || strategyId;
  const args = ["strategy", strategyId];
  // 显式指定交易日：CLI 默认用运行当天当标题（周末也照写），不可依赖
  if (effectiveDate) args.push("--date", effectiveDate);
  args.push("--limit", String(MAX_PICKS));
  const result = await runWestock("screen", args, { timeoutMs });
  if (!result.success || result.kind !== "table" || !Array.isArray(result.rows)) {
    console.warn(`[stock-digest] 策略 ${strategyId} 无有效结果：${result.error || result.kind}`);
    return null;
  }
  const signalDate = resolveSignalDate(
    pickSignalDate(result.meta, result.title),
    effectiveDate,
  );
  if (!signalDate) {
    console.warn(`[stock-digest] 策略 ${strategyId} 结果缺少信号日期，跳过`);
    return null;
  }
  const seen = new Set();
  const picks = [];
  for (const row of result.rows) {
    const symbol = pickSymbol(row);
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);
    picks.push({ symbol, name: pickName(row, symbol) });
    if (picks.length >= MAX_PICKS) break;
  }
  if (!picks.length) return null;

  const [record, created] = await StockStrategySignal.findOrCreate({
    where: { strategyId, signalDate },
    defaults: { strategyName, picks },
  });
  // 同一信号日重跑时刷新候选（CLI 结果盘中可能变化，以最新为准；已评估的不动）
  if (!created && !record.evaluated) {
    await record.update({ picks, strategyName });
  }
  return { strategyId, strategyName, signalDate, picks };
}

// ── 预测评估 ─────────────────────────────────────────────────

async function batchQuotes(symbols, deadline = Infinity) {
  const unique = [...new Set(symbols)];
  const map = new Map();
  for (let i = 0; i < unique.length; i += 100) {
    // 预算耗尽就带着已取到的样本继续：部分评估好过整单失败
    if (Date.now() > deadline) {
      console.warn(
        `[stock-digest] 评估预算耗尽，仅取到 ${map.size}/${unique.size} 只行情`,
      );
      break;
    }
    try {
      const rows = await fetchQuotes(unique.slice(i, i + 100));
      for (const row of rows) map.set(row.symbol, row);
    } catch (error) {
      // 单批失败不影响其他批次，只是样本少一些
      console.warn(`[stock-digest] 行情批次获取失败，已跳过: ${error.message}`);
    }
  }
  return map;
}

/**
 * 评估所有未评估的历史信号。
 *
 * 原理：早盘 cron 运行时（开盘前），腾讯行情的 asOf 还停留在最近一个已收盘
 * 交易日 D，changePercent 即 D 当日涨跌幅。因此凡 signalDate < D 的信号，
 * 都能用这批行情回看「信号次一交易日」的表现（严格说是回看 D 当日；
 * 对每天运行的 cron 而言 D 正是信号日的次一交易日）。
 * signalDate >= D 的信号（今早刚采集的）留到之后的 cron 评估。
 */
async function evaluatePending(deadline = Infinity) {
  const pending = await StockStrategySignal.findAll({
    where: { evaluated: false },
    order: [["signalDate", "ASC"]],
    limit: 100,
  });
  if (!pending.length) return [];

  const symbols = pending.flatMap((r) => r.picks.map((p) => p.symbol));
  const quotes = await batchQuotes(symbols, deadline);

  const results = [];
  const updates = [];
  for (const record of pending) {
    let evalDate = null;
    let total = 0;
    let upCount = 0;
    let changeSum = 0;
    for (const pick of record.picks) {
      const quote = quotes.get(pick.symbol);
      if (!quote || typeof quote.changePercent !== "number" || !quote.asOf) continue;
      const quoteDate = `${quote.asOf.slice(0, 4)}-${quote.asOf.slice(4, 6)}-${quote.asOf.slice(6, 8)}`;
      // 行情还停留在信号日当天（或更早）：这只股票的「次日」还没发生
      if (quoteDate <= record.signalDate) continue;
      evalDate = evalDate && evalDate > quoteDate ? evalDate : quoteDate;
      total += 1;
      changeSum += quote.changePercent;
      if (quote.changePercent > 0) upCount += 1;
    }
    // 整批都没有新交易日数据（今天停牌日/周末重跑）：保持未评估，下次再看
    if (!total) continue;
    // 状态回写并行：Vercel 的 MySQL 连接池只有 1 个连接，串行 100 次往返
    // 在远程库上足以吃掉十几秒预算。
    updates.push(
      record
        .update({
          evaluated: true,
          evalDate,
          total,
          upCount,
          avgChangePercent: changeSum / total,
        })
        .catch((error) => {
          console.error(
            `[stock-digest] 信号 ${record.strategyId}@${record.signalDate} 回写失败:`,
            error.message,
          );
        }),
    );
    results.push(record);
  }
  await Promise.all(updates);
  return results;
}

/** 历史正确率：按策略聚合全部已评估样本（股票级 upCount/total）。 */
async function historicalAccuracy() {
  const rows = await StockStrategySignal.findAll({
    where: { evaluated: true },
    attributes: ["strategyId", "strategyName", "total", "upCount"],
  });
  const map = new Map();
  for (const row of rows) {
    const entry = map.get(row.strategyId) || {
      strategyId: row.strategyId,
      strategyName: row.strategyName,
      total: 0,
      upCount: 0,
    };
    entry.total += row.total || 0;
    entry.upCount += row.upCount || 0;
    entry.strategyName = row.strategyName;
    map.set(row.strategyId, entry);
  }
  return map;
}

// ── 多窗口正确率 ─────────────────────────────────────────────

/** 排名表展示的回看窗口（天数按自然日，相对今天北京时间）。 */
const ACCURACY_WINDOWS = [
  { key: "d1", label: "昨日", days: 1 },
  { key: "d3", label: "近3日", days: 3 },
  { key: "d7", label: "近7日", days: 7 },
  { key: "d15", label: "近15日", days: 15 },
];

function beijingToday() {
  return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
}

function dateMinusDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/**
 * 按策略 × 窗口聚合已评估样本的正确率。
 * 窗口按 evalDate（表现发生的交易日）过滤：「近 3 日」即最近 3 个自然日内
 * 完成评估的信号表现，节假日自然没有样本，不做交易日历换算。
 * 返回 Map<strategyId, { strategyName, windows: { d1: {total,upCount}, ... } }>
 */
async function windowedAccuracy(today = beijingToday()) {
  const maxDays = Math.max(...ACCURACY_WINDOWS.map((w) => w.days));
  const rows = await StockStrategySignal.findAll({
    where: {
      evaluated: true,
      evalDate: { [Op.gte]: dateMinusDays(today, maxDays) },
    },
    attributes: ["strategyId", "strategyName", "evalDate", "total", "upCount"],
  });
  const map = new Map();
  for (const row of rows) {
    const entry = map.get(row.strategyId) || {
      strategyId: row.strategyId,
      strategyName: row.strategyName,
      windows: Object.fromEntries(
        ACCURACY_WINDOWS.map((w) => [w.key, { total: 0, upCount: 0 }]),
      ),
    };
    entry.strategyName = row.strategyName;
    for (const w of ACCURACY_WINDOWS) {
      if (row.evalDate >= dateMinusDays(today, w.days)) {
        entry.windows[w.key].total += row.total || 0;
        entry.windows[w.key].upCount += row.upCount || 0;
      }
    }
    map.set(row.strategyId, entry);
  }
  return map;
}

// ── 邮件渲染 ─────────────────────────────────────────────────

function escapeHtml(text) {
  return String(text ?? "").replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch],
  );
}

function pct(numerator, denominator) {
  if (!denominator) return "—";
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

const TABLE_STYLE =
  'style="border-collapse:collapse;width:100%;font-size:13px;margin:8px 0 20px"';
const TH_STYLE =
  'style="text-align:left;padding:6px 10px;background:#f1f5f9;border:1px solid #e2e8f0;color:#334155"';
const TD_STYLE = 'style="padding:6px 10px;border:1px solid #e2e8f0;color:#1f2937"';

function renderEvaluationSection(windowAccuracyMap, accuracyMap) {
  const entries = [...windowAccuracyMap.values()];
  // 窗口内一个样本都没有时，退回展示累计数据是否也为空
  if (!entries.length && !accuracyMap.size) {
    return '<p style="color:#6b7280;font-size:13px">暂无已评估的策略信号（节假日或首次运行）。</p>';
  }
  // 补全：窗口内无样本但有累计数据的策略也进表（各窗口显示 —）
  for (const [id, acc] of accuracyMap) {
    if (!windowAccuracyMap.has(id)) {
      entries.push({
        strategyId: id,
        strategyName: acc.strategyName,
        windows: Object.fromEntries(
          ACCURACY_WINDOWS.map((w) => [w.key, { total: 0, upCount: 0 }]),
        ),
      });
    }
  }
  const rate = (cell) => (cell && cell.total ? cell.upCount / cell.total : -1);
  // 排序优先级：近15日 → 近7日 → 累计，让样本多的窗口主导排名
  const sorted = entries.sort((a, b) => {
    const diff15 = rate(b.windows.d15) - rate(a.windows.d15);
    if (diff15) return diff15;
    const diff7 = rate(b.windows.d7) - rate(a.windows.d7);
    if (diff7) return diff7;
    const accA = accuracyMap.get(a.strategyId);
    const accB = accuracyMap.get(b.strategyId);
    return rate(accB) - rate(accA);
  });
  const cell = (c) =>
    c && c.total
      ? `<strong>${pct(c.upCount, c.total)}</strong><br><span style="color:#9ca3af;font-size:11px">${c.upCount}/${c.total}</span>`
      : "—";
  const rows = sorted
    .map((entry, i) => {
      const acc = accuracyMap.get(entry.strategyId);
      return `<tr>
        <td ${TD_STYLE}>${i + 1}</td>
        <td ${TD_STYLE}>${escapeHtml(entry.strategyName)}</td>
        ${ACCURACY_WINDOWS.map((w) => `<td ${TD_STYLE}>${cell(entry.windows[w.key])}</td>`).join("")}
        <td ${TD_STYLE}>${cell(acc)}</td>
      </tr>`;
    })
    .join("");
  return `<table ${TABLE_STYLE}>
    <tr><th ${TH_STYLE}>排名</th><th ${TH_STYLE}>策略</th>${ACCURACY_WINDOWS.map((w) => `<th ${TH_STYLE}>${w.label}</th>`).join("")}<th ${TH_STYLE}>累计</th></tr>
    ${rows}
  </table>`;
}

function renderPicksSection(collected, accuracyMap) {
  if (!collected.length) {
    return '<p style="color:#6b7280;font-size:13px">今日各策略均未产生有效候选。</p>';
  }
  const sorted = [...collected].sort((a, b) => {
    const accA = accuracyMap.get(a.strategyId);
    const accB = accuracyMap.get(b.strategyId);
    const rateA = accA && accA.total ? accA.upCount / accA.total : -1;
    const rateB = accB && accB.total ? accB.upCount / accB.total : -1;
    return rateB - rateA;
  });
  return sorted
    .map((item) => {
      const acc = accuracyMap.get(item.strategyId);
      const accText =
        acc && acc.total
          ? `历史正确率 <strong>${pct(acc.upCount, acc.total)}</strong>（${acc.upCount}/${acc.total} 样本）`
          : "暂无历史正确率数据";
      const rows = item.picks
        .map(
          (p) => `<tr>
            <td ${TD_STYLE}>${escapeHtml(p.symbol)}</td>
            <td ${TD_STYLE}>${escapeHtml(p.name || "—")}</td>
          </tr>`,
        )
        .join("");
      return `<h3 style="margin:20px 0 4px;font-size:15px;color:#1f2937">${escapeHtml(item.strategyName)}
          <span style="font-weight:400;font-size:12px;color:#6b7280">· 信号日 ${escapeHtml(item.signalDate)} · ${accText}</span>
        </h3>
        <table ${TABLE_STYLE}>
          <tr><th ${TH_STYLE}>代码</th><th ${TH_STYLE}>名称</th></tr>
          ${rows}
        </table>`;
    })
    .join("");
}

function renderEmail({ dateLabel, windowAccuracyMap, collected, accuracyMap }) {
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:640px;margin:0 auto;padding:24px;background:#f8fafc;border-radius:12px">
    <div style="background:white;padding:28px;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,0.06)">
      <h2 style="margin:0 0 4px;color:#1f2937">VueChest 策略选股日报</h2>
      <p style="color:#6b7280;margin:0 0 20px;font-size:13px">${escapeHtml(dateLabel)} · 自动生成，仅供研究参考，不构成投资建议</p>
      <h3 style="margin:0 0 4px;font-size:16px;color:#1f2937">① 策略预测正确率排名（昨日 / 近3日 / 近7日 / 近15日 / 累计）</h3>
      <p style="color:#6b7280;font-size:12px;margin:0">口径：信号日候选股在次一交易日收涨的比例；窗口按评估日回看</p>
      ${renderEvaluationSection(windowAccuracyMap, accuracyMap)}
      <h3 style="margin:8px 0 4px;font-size:16px;color:#1f2937">② 今日策略推荐（按历史正确率排序）</h3>
      ${renderPicksSection(collected, accuracyMap)}
    </div>
    <p style="text-align:center;color:#9ca3af;font-size:12px;margin-top:16px">VueChest · 请勿直接回复此邮件</p>
  </div>`;
}

// ── 入口 ─────────────────────────────────────────────────────

/**
 * 日报主流程：评估昨日 → 采集今日 → 聚合历史正确率 → 发邮件。
 * 三步彼此尽量独立：单个策略采集失败不影响其余策略与邮件发送。
 */
async function runDailyDigest() {
  const startedAt = Date.now();
  const deadline = startedAt + TOTAL_BUDGET_MS;
  const phase = (label) => console.log(`[stock-digest] ${label} +${Date.now() - startedAt}ms`);

  // 1) 先评估：今天新采集的信号 signalDate 等于最新交易日，不会被误评
  let evaluatedRecords = [];
  try {
    // 评估单独封顶，避免历史积压把采集预算吃光
    const evalDeadline = Math.min(deadline, Date.now() + EVAL_BUDGET_MS);
    evaluatedRecords = await evaluatePending(evalDeadline);
    phase(`评估完成（${evaluatedRecords.length} 批）`);
  } catch (error) {
    console.error("[stock-digest] 评估历史信号失败:", error.message);
  }

  // 2) 采集今日信号。先确定「数据所属交易日」，避免把运行日当成信号日。
  // 用 Promise.allSettled 并行：client.js 内部已有并发闸门（默认 4），
  // 7 个策略并行只需两批，比串行更不容易触发函数 60s 超时。
  const effectiveDate = await latestCompletedDate();
  phase(`参考交易日 ${effectiveDate || "未知"}`);
  const settled = await Promise.allSettled(
    digestStrategies().map(async (strategyId) => {
      const remaining = deadline - Date.now();
      if (remaining < 3000) {
        console.warn(`[stock-digest] 预算耗尽，跳过策略 ${strategyId}`);
        return null;
      }
      try {
        return await collectStrategy(
          strategyId,
          effectiveDate,
          Math.min(STRATEGY_TIMEOUT_MS, remaining),
        );
      } catch (error) {
        console.error(`[stock-digest] 策略 ${strategyId} 采集失败:`, error.message);
        return null;
      }
    }),
  );
  const collected = settled
    .map((item) => (item.status === "fulfilled" ? item.value : null))
    .filter(Boolean);
  phase(`采集完成（${collected.length}/${digestStrategies().length} 个策略）`);

  // 3) 正确率统计：累计（推荐区排序用）+ 多窗口（排名表用，含刚评估完的样本）
  const accuracyMap = await historicalAccuracy();
  const windowAccuracyMap = await windowedAccuracy();
  phase("正确率聚合完成");

  const to = (process.env.STOCK_DIGEST_TO || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!to.length) {
    throw Object.assign(new Error("未配置 STOCK_DIGEST_TO 环境变量（收件人）"), {
      status: 500,
    });
  }

  const dateLabel = beijingToday();
  const mail = await sendHtmlMail({
    to,
    subject: `【VueChest】策略选股日报 ${dateLabel}`,
    html: renderEmail({ dateLabel, windowAccuracyMap, collected, accuracyMap }),
  });
  phase(mail.success ? "邮件已发送" : `邮件发送失败：${mail.error}`);

  return {
    date: dateLabel,
    durationMs: Date.now() - startedAt,
    requested: digestStrategies().length,
    evaluated: evaluatedRecords.map((r) => ({
      strategyId: r.strategyId,
      signalDate: r.signalDate,
      upCount: r.upCount,
      total: r.total,
    })),
    collected: collected.map((c) => ({
      strategyId: c.strategyId,
      signalDate: c.signalDate,
      picks: c.picks.length,
    })),
    mail,
  };
}

/**
 * 历史战绩查询（给前端「策略战绩」页用，与邮件同口径）：
 * - strategies：各策略多窗口正确率 + 累计
 * - recent：最近 N 天已评估的信号明细（画正确率曲线的原始点）
 */
async function digestHistory({ days = 30 } = {}) {
  const today = beijingToday();
  const since = dateMinusDays(today, Math.min(Math.max(Number(days) || 30, 1), 90));
  const [windowMap, accMap, recent] = await Promise.all([
    windowedAccuracy(today),
    historicalAccuracy(),
    StockStrategySignal.findAll({
      where: { evaluated: true, evalDate: { [Op.gte]: since } },
      order: [["evalDate", "ASC"]],
      attributes: [
        "strategyId",
        "strategyName",
        "signalDate",
        "evalDate",
        "total",
        "upCount",
        "avgChangePercent",
      ],
    }),
  ]);
  const strategies = [];
  const ids = new Set([...windowMap.keys(), ...accMap.keys()]);
  for (const id of ids) {
    const win = windowMap.get(id);
    const acc = accMap.get(id);
    strategies.push({
      strategyId: id,
      strategyName: (win || acc).strategyName,
      windows:
        win?.windows ||
        Object.fromEntries(ACCURACY_WINDOWS.map((w) => [w.key, { total: 0, upCount: 0 }])),
      allTime: acc ? { total: acc.total, upCount: acc.upCount } : { total: 0, upCount: 0 },
    });
  }
  const rate = (c) => (c.total ? c.upCount / c.total : -1);
  strategies.sort(
    (a, b) =>
      rate(b.windows.d15) - rate(a.windows.d15) ||
      rate(b.allTime) - rate(a.allTime),
  );
  return { since, strategies, recent };
}

module.exports = {
  runDailyDigest,
  digestHistory,
  // 导出内部函数供单测
  pickSymbol,
  pickName,
  pickSignalDate,
  resolveSignalDate,
  latestCompletedDate,
  collectStrategy,
  digestStrategies,
  DEFAULT_STRATEGIES,
  ACCURACY_WINDOWS,
  dateMinusDays,
  renderEvaluationSection,
};
