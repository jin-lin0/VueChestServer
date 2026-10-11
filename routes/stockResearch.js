const express = require("express");
const { instrument, fetchQuotes } = require("../services/tencentQuotes");

const router = express.Router();

const REQUEST_TIMEOUT_MS = 10000;
const cache = new Map();
const inFlight = new Map();
const MAX_CACHE_ENTRIES = 256;

const CACHE_TTL = {
  market: 30 * 1000,
  quote: 60 * 1000,
  kline: 5 * 60 * 1000,
};

const KLINE_DEFAULT_COUNT = 2000;

function session(now = Date.now()) {
  const local = new Date(now + 8 * 3600000);
  const date = local.toISOString().slice(0, 10);
  const closed = local.getUTCHours() >= 15;
  const previous = new Date(`${date}T00:00:00Z`);
  previous.setUTCDate(previous.getUTCDate() - 1);
  return {
    key: `${date}:${closed}`,
    completedThrough: closed ? date : previous.toISOString().slice(0, 10),
  };
}

async function fetchJson(url, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/json,text/plain,*/*",
        "User-Agent": "Mozilla/5.0 VueChest/1.0",
      },
    });
    if (!response.ok) throw new Error(`上游返回 ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function cached(key, ttl, loader) {
  const now = Date.now();
  for (const [entryKey, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(entryKey);
  }
  const hit = cache.get(key);
  if (hit) return hit.value;
  if (inFlight.has(key)) return inFlight.get(key);
  const pending = (async () => {
    const value = await loader();
    if (cache.size >= MAX_CACHE_ENTRIES)
      cache.delete(cache.keys().next().value);
    cache.set(key, {
      expiresAt: Date.now() + (typeof ttl === "function" ? ttl(value) : ttl),
      value,
    });
    return value;
  })();
  inFlight.set(key, pending);
  try {
    return await pending;
  } finally {
    inFlight.delete(key);
  }
}

async function quoteBatch(symbols) {
  const data = await cached(
    `quotes:${symbols.join(",")}`,
    CACHE_TTL.quote,
    async () => {
      const rows = await fetchQuotes(symbols);
      if (!rows.length) throw new Error("未找到有效的腾讯行情");
      return rows;
    },
  );
  return data;
}

router.get("/quotes", async (req, res, next) => {
  try {
    const raw = String(req.query.symbols || "").split(",");
    if (raw.length > 100) {
      const error = new Error("单次最多查询 100 个标的");
      error.status = 400;
      throw error;
    }
    const symbols = [
      ...new Set(raw.map((value) => instrument(value).symbol)),
    ].sort();
    const data = await quoteBatch(symbols);
    res.json({ success: true, data, source: "tencent" });
  } catch (error) {
    next(error);
  }
});

router.get("/search", async (req, res, next) => {
  try {
    const query = String(req.query.q || "")
      .trim()
      .slice(0, 80);
    if (!query) return res.json({ success: true, data: [] });
    const data = await cached(`search:${query}`, CACHE_TTL.quote, async () => {
      const response = await fetch(
        `https://smartbox.gtimg.cn/s3/?v=2&q=${encodeURIComponent(query)}&t=all&c=1`,
        {
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
      );
      if (!response.ok) throw new Error(`腾讯搜索返回 ${response.status}`);
      const text = await response.text();
      const hint = text.match(/v_hint="([^"]*)"/)?.[1] || "";
      return hint
        .split("^")
        .flatMap((row) => {
          const [market, code, rawName, , type] = row.split("~");
          if (
            !/^(sh|sz)$/.test(market) ||
            !/^\d{6}$/.test(code) ||
            !["GP", "ZS", "JJ", "ETF", "1"].includes(type)
          )
            return [];
          const name = (rawName || "").replace(
            /\\u([0-9a-fA-F]{4})/g,
            (_, hex) => String.fromCharCode(parseInt(hex, 16)),
          );
          try {
            return [{ ...instrument(`${market}${code}`), name }];
          } catch {
            return [];
          }
        })
        .slice(0, 10);
    });
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

const MARKET_INDICES = [
  { symbol: "sh000001", code: "000001", name: "上证指数" },
  { symbol: "sz399001", code: "399001", name: "深证成指" },
  { symbol: "sz399006", code: "399006", name: "创业板指" },
];

async function fetchTencentIndices() {
  const quotes = await quoteBatch(
    MARKET_INDICES.map((item) => item.symbol).sort(),
  );
  return MARKET_INDICES.flatMap((meta) => {
    const row = quotes.find((quote) => quote.symbol === meta.symbol);
    return row
      ? [
          {
            symbol: row.symbol,
            code: row.code,
            market: row.market,
            type: row.type,
            name: row.name || meta.name,
            price: row.price,
            change: row.change,
            changePercent: row.changePercent,
          },
        ]
      : [];
  });
}

router.get("/market-overview", async (req, res, next) => {
  try {
    const data = await cached(
      "market-overview",
      CACHE_TTL.market,
      fetchTencentIndices,
    );
    res.json({ success: true, data, source: "tencent" });
  } catch (error) {
    next(error);
  }
});

router.get("/:symbol/kline", async (req, res, next) => {
  try {
    const { symbol, type } = instrument(req.params.symbol);
    const adjustment = type === "index" ? "none" : "qfq";
    const period = ["day", "week", "month"].includes(String(req.query.period))
      ? String(req.query.period)
      : "day";
    const count = Math.min(
      2000,
      Math.max(10, Number.parseInt(req.query.count, 10) || KLINE_DEFAULT_COUNT),
    );
    const boundary = session();
    const snapshot = await cached(
      `kline:${adjustment}:${symbol}:${period}:${count}:${boundary.key}`,
      (packet) =>
        packet.completedThrough < boundary.completedThrough
          ? 15000
          : CACHE_TTL.kline,
      async () => {
        // fqkline caps one response at 640 bars, including requests for larger counts.
        // All pages use the same current forward-adjustment basis.
        const history = new Map();
        const deadline = Date.now() + REQUEST_TIMEOUT_MS;
        let end = "";
        let confirmedThrough = boundary.completedThrough;
        while (history.size < count) {
          const pageSize = Math.min(640, count - history.size);
          const remainingMs = deadline - Date.now();
          if (remainingMs <= 0) throw new Error("K 线历史加载超时");
          const payload = await fetchJson(
            `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${symbol},${period},,${end},${pageSize},qfq`,
            remainingMs,
          );
          const upstream = payload?.data?.[symbol];
          const rows = upstream?.[type === "index" ? period : `qfq${period}`];
          if (!Array.isArray(rows))
            throw new Error("上游没有返回声明复权方式的 K 线数据");
          const quoteTime = upstream?.qt?.[symbol]?.[30];
          if (typeof quoteTime !== "string" || !/^\d{14}$/.test(quoteTime))
            throw new Error("上游没有返回有效的行情确认时间");
          const date = `${quoteTime.slice(0, 4)}-${quoteTime.slice(4, 6)}-${quoteTime.slice(6, 8)}`;
          const localTime = `${date}T${quoteTime.slice(8, 10)}:${quoteTime.slice(10, 12)}:${quoteTime.slice(12, 14)}`;
          const quoteMillis = Date.parse(`${localTime}+08:00`);
          if (
            !Number.isFinite(quoteMillis) ||
            new Date(quoteMillis + 8 * 3600000).toISOString().slice(0, 19) !== localTime
          )
            throw new Error("上游行情确认时间无效");
          const through = session(quoteMillis).completedThrough;
          if (through < confirmedThrough) confirmedThrough = through;
          if (!rows.length) break;
          const before = history.size;
          for (const row of rows) {
            if (
              !Array.isArray(row) ||
              !/^\d{4}-\d{2}-\d{2}$/.test(String(row[0]))
            )
              throw new Error("上游 K 线格式无效");
            history.set(row[0], row);
          }
          if (history.size === before) throw new Error("上游历史分页没有推进");
          const earliest = [...history.keys()].sort()[0];
          if (end && earliest >= end)
            throw new Error("上游没有返回更早的历史数据");
          const previous = new Date(`${earliest}T00:00:00Z`);
          if (!Number.isFinite(previous.getTime()))
            throw new Error("上游交易日期无效");
          previous.setUTCDate(previous.getUTCDate() - 1);
          end = previous.toISOString().slice(0, 10);
          if (rows.length < pageSize) break;
        }
        if (!history.size) throw new Error("未找到 K 线数据");
        return {
          data: [...history.values()]
            .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
            .slice(-count),
          fetchedAt: Date.now(),
          completedThrough: confirmedThrough,
        };
      },
    );
    res.json({
      success: true,
      ...snapshot,
      symbol,
      source: "tencent",
      period,
      adjustment,
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
