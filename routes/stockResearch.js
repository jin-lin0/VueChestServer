const express = require("express");

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

function validateCode(raw) {
  const code = String(raw || "").trim();
  if (!/^\d{6}$/.test(code)) {
    const error = new Error("股票代码必须是 6 位数字");
    error.status = 400;
    error.code = "VALIDATION";
    throw error;
  }
  return code;
}

function marketFor(code) {
  return code.startsWith("6") || code.startsWith("688") ? "SH" : "SZ";
}

function finite(value, divisor = 1) {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number / divisor : null;
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
    if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
    cache.set(key, { expiresAt: Date.now() + ttl, value });
    return value;
  })();
  inFlight.set(key, pending);
  try {
    return await pending;
  } finally {
    inFlight.delete(key);
  }
}

async function fetchTencentSummary(code) {
  const symbol = `${marketFor(code).toLowerCase()}${code}`;
  const response = await fetch(`https://qt.gtimg.cn/q=${symbol}`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`腾讯行情返回 ${response.status}`);
  const text = new TextDecoder("gbk").decode(await response.arrayBuffer());
  const match = text.match(/="([^"]+)"/);
  const fields = match?.[1]?.split("~") || [];
  if (fields.length < 50) throw new Error("未找到股票行情摘要");
  return {
    code,
    source: "tencent",
    asOf: /^\d{14}$/.test(fields[30] || "") ? fields[30] : null,
    fetchedAt: Date.now(),
    name: fields[1] || code,
    price: finite(fields[3]),
    high: finite(fields[33]),
    low: finite(fields[34]),
    open: finite(fields[5]),
    previousClose: finite(fields[4]),
    volume: finite(fields[36], 0.01),
    amount: finite(fields[57], 0.0001),
    outerVolume: finite(fields[7], 0.01),
    volumeRatio: finite(fields[49]),
    totalMarketCap: finite(fields[45], 1e-8),
    floatMarketCap: finite(fields[44], 1e-8),
    pe: finite(fields[39]),
    pb: finite(fields[46]),
    turnover: finite(fields[38]),
    changePercent: finite(fields[32]),
    amplitude: finite(fields[43]),
  };
}

const MARKET_INDICES = [
  { symbol: "sh000001", code: "000001", name: "上证指数" },
  { symbol: "sz399001", code: "399001", name: "深证成指" },
  { symbol: "sz399006", code: "399006", name: "创业板指" },
];

async function fetchTencentIndices() {
  const symbols = MARKET_INDICES.map((item) => item.symbol).join(",");
  const response = await fetch(`https://qt.gtimg.cn/q=${symbols}`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`腾讯指数行情返回 ${response.status}`);
  const text = new TextDecoder("gbk").decode(await response.arrayBuffer());
  const quotes = new Map(
    [...text.matchAll(/v_([a-z]{2}\d{6})="([^"]*)"/g)].map((match) => [
      match[1],
      match[2].split("~"),
    ]),
  );
  const rows = MARKET_INDICES.map((meta) => {
    const fields = quotes.get(meta.symbol) || [];
    const price = finite(fields[3]);
    if (price === null || price <= 0) return null;
    return {
      code: meta.code,
      name: fields[1] || meta.name,
      price,
      change: finite(fields[31]),
      changePercent: finite(fields[32]),
    };
  }).filter(Boolean);
  if (!rows.length) throw new Error("未找到指数行情");
  return rows;
}

router.get("/market-overview", async (req, res, next) => {
  try {
    const data = await cached("market-overview", CACHE_TTL.market, fetchTencentIndices);
    res.json({ success: true, data, source: "tencent" });
  } catch (error) {
    next(error);
  }
});

router.get("/:code/summary", async (req, res, next) => {
  try {
    const code = validateCode(req.params.code);
    const data = await cached(`summary:${code}`, CACHE_TTL.quote, () => fetchTencentSummary(code));
    res.json({ success: true, data, source: data.source, fetchedAt: data.fetchedAt });
  } catch (error) {
    next(error);
  }
});

router.get("/:code/kline", async (req, res, next) => {
  try {
    const code = validateCode(req.params.code);
    const period = ["day", "week", "month"].includes(String(req.query.period))
      ? String(req.query.period)
      : "day";
    const count = Math.min(
      2000,
      Math.max(10, Number.parseInt(req.query.count, 10) || KLINE_DEFAULT_COUNT),
    );
    const symbol = `${marketFor(code).toLowerCase()}${code}`;
    const data = await cached(
      `kline:qfq:${code}:${period}:${count}`,
      CACHE_TTL.kline,
      async () => {
        // fqkline caps one response at 640 bars, including requests for larger counts.
        // All pages use the same current forward-adjustment basis.
        const history = new Map();
        const deadline = Date.now() + REQUEST_TIMEOUT_MS;
        let end = "";
        while (history.size < count) {
          const pageSize = Math.min(640, count - history.size);
          const remainingMs = deadline - Date.now();
          if (remainingMs <= 0) throw new Error("K 线历史加载超时");
          const payload = await fetchJson(
            `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${symbol},${period},,${end},${pageSize},qfq`,
            remainingMs,
          );
          const rows = payload?.data?.[symbol]?.[`qfq${period}`];
          if (!Array.isArray(rows)) throw new Error("上游没有返回前复权 K 线数据");
          if (!rows.length) break;
          const before = history.size;
          for (const row of rows) {
            if (!Array.isArray(row) || !/^\d{4}-\d{2}-\d{2}$/.test(String(row[0]))) throw new Error("上游 K 线格式无效");
            history.set(row[0], row);
          }
          if (history.size === before) throw new Error("上游历史分页没有推进");
          const earliest = [...history.keys()].sort()[0];
          if (end && earliest >= end) throw new Error("上游没有返回更早的历史数据");
          const previous = new Date(`${earliest}T00:00:00Z`);
          if (!Number.isFinite(previous.getTime())) throw new Error("上游交易日期无效");
          previous.setUTCDate(previous.getUTCDate() - 1);
          end = previous.toISOString().slice(0, 10);
          if (rows.length < pageSize) break;
        }
        if (!history.size) throw new Error("未找到 K 线数据");
        return [...history.values()].sort((a, b) => String(a[0]).localeCompare(String(b[0]))).slice(-count);
      },
    );
    res.json({ success: true, data, source: "tencent", period, adjustment: "qfq" });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
