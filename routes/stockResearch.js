const express = require("express");

const router = express.Router();

const REQUEST_TIMEOUT_MS = 10000;
const cache = new Map();

const CACHE_TTL = {
  market: 30 * 1000,
  quote: 60 * 1000,
  financials: 30 * 60 * 1000,
  notices: 10 * 60 * 1000,
};

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

function secIdFor(code) {
  return `${marketFor(code) === "SH" ? 1 : 0}.${code}`;
}

function finite(value, divisor = 1) {
  const number = Number(value);
  return Number.isFinite(number) ? number / divisor : null;
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/json,text/plain,*/*",
        Referer: "https://quote.eastmoney.com/",
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
  const hit = cache.get(key);
  if (hit && Date.now() - hit.savedAt < ttl) return hit.value;
  const value = await loader();
  cache.set(key, { savedAt: Date.now(), value });
  return value;
}

async function fetchTencentSummary(code) {
  const symbol = `${marketFor(code).toLowerCase()}${code}`;
  const response = await fetch(`http://qt.gtimg.cn/q=${symbol}`);
  if (!response.ok) throw new Error(`腾讯行情返回 ${response.status}`);
  const text = new TextDecoder("gbk").decode(await response.arrayBuffer());
  const match = text.match(/="([^"]+)"/);
  const fields = match?.[1]?.split("~") || [];
  if (fields.length < 50) throw new Error("未找到股票行情摘要");
  return {
    code,
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

router.get("/market-overview", async (req, res, next) => {
  try {
    const data = await cached("market-overview", CACHE_TTL.market, async () => {
      const fields = "f2,f3,f4,f12,f13,f14";
      const secids = "1.000001,0.399001,0.399006";
      const payload = await fetchJson(
        `https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&secids=${secids}&fields=${fields}`,
      );
      return (payload?.data?.diff || []).map((item) => ({
        code: String(item.f12 || ""),
        name: String(item.f14 || "指数"),
        price: finite(item.f2),
        change: finite(item.f4),
        changePercent: finite(item.f3),
      }));
    });
    res.json({ success: true, data, source: "eastmoney" });
  } catch (error) {
    next(error);
  }
});

router.get("/:code/summary", async (req, res, next) => {
  try {
    const code = validateCode(req.params.code);
    const data = await cached(`summary:${code}`, CACHE_TTL.quote, async () => {
      const fields = [
        "f43",
        "f44",
        "f45",
        "f46",
        "f47",
        "f48",
        "f49",
        "f50",
        "f57",
        "f58",
        "f60",
        "f116",
        "f117",
        "f162",
        "f167",
        "f168",
        "f170",
        "f171",
      ].join(",");
      try {
        const payload = await fetchJson(
          `https://push2.eastmoney.com/api/qt/stock/get?secid=${secIdFor(code)}&fields=${fields}`,
        );
        const item = payload?.data;
        if (!item) throw new Error("未找到股票研究摘要");
        return {
          code,
          name: String(item.f58 || code),
          price: finite(item.f43, 100),
          high: finite(item.f44, 100),
          low: finite(item.f45, 100),
          open: finite(item.f46, 100),
          previousClose: finite(item.f60, 100),
          volume: finite(item.f47),
          amount: finite(item.f48),
          outerVolume: finite(item.f49),
          volumeRatio: finite(item.f50, 100),
          totalMarketCap: finite(item.f116),
          floatMarketCap: finite(item.f117),
          pe: finite(item.f162, 100),
          pb: finite(item.f167, 100),
          turnover: finite(item.f168, 100),
          changePercent: finite(item.f170, 100),
          amplitude: finite(item.f171, 100),
        };
      } catch {
        return fetchTencentSummary(code);
      }
    });
    res.json({ success: true, data, source: "eastmoney" });
  } catch (error) {
    next(error);
  }
});

router.get("/:code/financials", async (req, res, next) => {
  try {
    const code = validateCode(req.params.code);
    const data = await cached(
      `financials:${code}`,
      CACHE_TTL.financials,
      async () => {
        const symbol = `${marketFor(code)}${code}`;
        const payload = await fetchJson(
          `https://emweb.securities.eastmoney.com/PC_HSF10/NewFinanceAnalysis/ZYZBAjaxNew?type=0&code=${symbol}`,
        );
        return (payload?.data || []).slice(0, 8).map((item) => ({
          reportDate: String(item.REPORT_DATE || "").slice(0, 10),
          reportName: String(
            item.REPORT_DATE_NAME || item.REPORT_TYPE || "财报",
          ),
          revenue: finite(item.TOTALOPERATEREVE),
          revenueGrowth: finite(item.TOTALOPERATEREVETZ),
          netProfit: finite(item.PARENTNETPROFIT),
          netProfitGrowth: finite(item.PARENTNETPROFITTZ),
          eps: finite(item.EPSJB),
          roe: finite(item.ROEJQ),
          grossMargin: finite(item.XSMLL),
          netMargin: finite(item.XSJLL),
          debtRatio: finite(item.ZCFZL),
          currentRatio: finite(item.LD),
          cashflowPerShare: finite(item.MGJYXJJE),
        }));
      },
    );
    res.json({ success: true, data, source: "eastmoney" });
  } catch (error) {
    next(error);
  }
});

router.get("/:code/notices", async (req, res, next) => {
  try {
    const code = validateCode(req.params.code);
    const limit = Math.min(
      20,
      Math.max(1, Number.parseInt(req.query.limit, 10) || 10),
    );
    const data = await cached(
      `notices:${code}:${limit}`,
      CACHE_TTL.notices,
      async () => {
        const params = new URLSearchParams({
          sr: "-1",
          page_size: String(limit),
          page_index: "1",
          ann_type: "A",
          client_source: "web",
          stock_list: code,
        });
        const payload = await fetchJson(
          `https://np-anotice-stock.eastmoney.com/api/security/ann?${params}`,
        );
        return (payload?.data?.list || []).map((item) => ({
          id: String(item.art_code || ""),
          title: String(item.title_ch || item.title || "公司公告"),
          date: String(item.notice_date || item.display_time || "").slice(
            0,
            10,
          ),
          category: String(item.columns?.[0]?.column_name || "公告"),
          url: item.art_code
            ? `https://data.eastmoney.com/notices/detail/${code}/${item.art_code}.html`
            : "",
        }));
      },
    );
    res.json({ success: true, data, source: "eastmoney" });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
