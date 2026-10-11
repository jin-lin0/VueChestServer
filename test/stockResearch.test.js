const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");

async function withRouter(mockFetch, run) {
  const originalFetch = global.fetch;
  const routePath = require.resolve("../routes/stockResearch");
  const previous = require.cache[routePath];
  delete require.cache[routePath];
  global.fetch = mockFetch;
  const app = express();
  let requests = 0;
  app.use((_req, _res, next) => {
    requests += 1;
    next();
  });
  app.use("/api/research-stocks", require(routePath));
  app.use((error, _req, res, _next) =>
    res
      .status(error.status || 502)
      .json({ success: false, error: error.message }),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/research-stocks`;
  try {
    await run(
      (path) => originalFetch(base + path),
      () => requests,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    global.fetch = originalFetch;
    if (previous) require.cache[routePath] = previous;
    else delete require.cache[routePath];
  }
}

const json = (value) =>
  new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
  });

function quoteClock(symbol, stamp = "20261009150000") {
  const fields = Array(31).fill("");
  fields[30] = stamp;
  return { [symbol]: fields };
}

test("daily, weekly and monthly routes use declared forward-adjusted rows", async () => {
  const rows = [["2026-10-09", "10", "11", "12", "9", "1000"]];
  await withRouter(
    async (url) => {
      assert.ok(String(url).includes("/fqkline/get?"));
      const period = String(url).match(/,([a-z]+),,,/)?.[1];
      assert.ok(String(url).endsWith(",qfq"));
      return json({
        data: {
          sh600000: {
            [`qfq${period}`]: rows,
            qt: quoteClock("sh600000"),
            [period]: [["2026-10-09", "100", "110", "120", "90", "1000"]],
          },
        },
      });
    },
    async (get) => {
      for (const period of ["day", "week", "month"]) {
        const result = await (
          await get(`/sh600000/kline?period=${period}`)
        ).json();
        assert.deepEqual(result.data, rows);
        assert.equal(result.period, period);
        assert.equal(result.adjustment, "qfq");
      }
    },
  );
});

test("unadjusted-only upstream payload is rejected instead of silently relabeled", async () => {
  await withRouter(
    async () =>
      json({
        data: {
          sh600000: { day: [["2026-10-09", "10", "11", "12", "9", "1000"]] },
        },
      }),
    async (get) => {
      const result = await get("/sh600000/kline");
      assert.equal(result.status, 502);
      assert.equal((await result.json()).success, false);
    },
  );
});

test("history pagination keeps long adjusted history in chronological order", async () => {
  const history = Array.from({ length: 800 }, (_, index) => [
    new Date(Date.UTC(2022, 0, index + 1)).toISOString().slice(0, 10),
    "10",
    "11",
    "12",
    "9",
    "1000",
  ]);
  const requestedEnds = [];
  await withRouter(
    async (url) => {
      const params = new URL(String(url)).searchParams.get("param").split(",");
      const end = params[3];
      requestedEnds.push(end);
      const rows = history
        .filter((row) => !end || row[0] <= end)
        .slice(-Number(params[4]));
      return json({ data: { sh600000: { qfqday: rows, qt: quoteClock("sh600000") } } });
    },
    async (get) => {
      const result = await (await get("/sh600000/kline?count=700")).json();
      assert.deepEqual(result.data, history.slice(-700));
      assert.equal(requestedEnds.length, 2);
      assert.equal(requestedEnds[0], "");
      assert.ok(requestedEnds[1] < history.at(-640)[0]);
    },
  );
});

test("history pagination fails rather than accepting a non-advancing page", async () => {
  const rows = Array.from({ length: 640 }, (_, index) => [
    new Date(Date.UTC(2022, 0, index + 1)).toISOString().slice(0, 10),
    "10",
    "11",
    "12",
    "9",
    "1000",
  ]);
  await withRouter(
    async () => json({ data: { sh600000: { qfqday: rows, qt: quoteClock("sh600000") } } }),
    async (get) => {
      const result = await get("/sh600000/kline?count=700");
      assert.equal(result.status, 502);
      assert.match((await result.json()).error, /没有推进/);
    },
  );
});

test("market overview uses Tencent directly", async () => {
  await withRouter(
    async (url, options) => {
      assert.equal(new URL(String(url)).hostname, "qt.gtimg.cn");
      assert.ok(options.signal);
      const index = (symbol, name, price, change, changePercent) => {
        const fields = Array(60).fill("0");
        fields[1] = name;
        fields[3] = price;
        fields[31] = change;
        fields[32] = changePercent;
        return `v_${symbol}="${fields.join("~")}";`;
      };
      // 上游是 GBK 字节，mock 只放 ASCII 名称，避免用 UTF-8 字符串冒充 GBK 响应。
      return new Response(
        [
          index("sh000001", "SH Index", "3813.79", "1.89", "0.05"),
          index("sz399001", "SZ Index", "12641.86", "20.96", "0.17"),
          index("sz399006", "ChiNext", "3043.33", "6.67", "0.22"),
        ].join("\n"),
      );
    },
    async (get) => {
      const result = await (await get("/market-overview")).json();
      assert.equal(result.success, true);
      assert.equal(result.source, "tencent");
      assert.deepEqual(result.data, [
        {
          symbol: "sh000001",
          code: "000001",
          market: "sh",
          type: "index",
          name: "SH Index",
          price: 3813.79,
          change: 1.89,
          changePercent: 0.05,
        },
        {
          symbol: "sz399001",
          code: "399001",
          market: "sz",
          type: "index",
          name: "SZ Index",
          price: 12641.86,
          change: 20.96,
          changePercent: 0.17,
        },
        {
          symbol: "sz399006",
          code: "399006",
          market: "sz",
          type: "index",
          name: "ChiNext",
          price: 3043.33,
          change: 6.67,
          changePercent: 0.22,
        },
      ]);
    },
  );
});

test("market overview rejects empty Tencent quotes without caching the failure", async () => {
  let calls = 0;
  await withRouter(
    async (url) => {
      assert.equal(new URL(String(url)).hostname, "qt.gtimg.cn");
      calls += 1;
      return new Response("");
    },
    async (get) => {
      assert.equal((await get("/market-overview")).status, 502);
      assert.equal((await get("/market-overview")).status, 502);
      assert.equal(calls, 2);
    },
  );
});

test("quotes use Tencent directly and preserve missing values and quote time", async () => {
  await withRouter(
    async (url, options) => {
      assert.equal(new URL(String(url)).hostname, "qt.gtimg.cn");
      assert.ok(options.signal);
      const fields = Array(60).fill("10");
      fields[30] = "20261009150000";
      fields[39] = "";
      fields[46] = " ";
      fields[49] = "0";
      return new Response(`v_sh600000="${fields.join("~")}";`);
    },
    async (get) => {
      const result = await (await get("/quotes?symbols=sh600000")).json();
      assert.equal(result.source, "tencent");
      assert.equal(result.data[0].asOf, "20261009150000");
      assert.equal(result.data[0].pe, null);
      assert.equal(result.data[0].pb, null);
      assert.equal(result.data[0].volumeRatio, 0);
      assert.equal(typeof result.data[0].fetchedAt, "number");
    },
  );
});

test("concurrent cache misses share one upstream request", async () => {
  let resolve;
  const pending = new Promise((yes) => {
    resolve = yes;
  });
  let calls = 0;
  await withRouter(
    async () => {
      calls += 1;
      return pending;
    },
    async (get, requests) => {
      const first = get("/quotes?symbols=sh600000");
      const second = get("/quotes?symbols=sh600000");
      while (requests() < 2) await new Promise(setImmediate);
      assert.equal(calls, 1);
      const fields = Array(60).fill("10");
      fields[30] = "20261009150000";
      resolve(new Response(`v_sh600000="${fields.join("~")}";`));
      const responses = await Promise.all([first, second]);
      assert.deepEqual(await responses[0].json(), await responses[1].json());
    },
  );
});

test("a failed cache fill is released so the next request can retry", async () => {
  let calls = 0;
  await withRouter(
    async () => {
      calls += 1;
      const fields = Array(60).fill("10");
      fields[30] = "20261009150000";
      return calls === 1
        ? new Response("failed", { status: 503 })
        : new Response(`v_sh600000="${fields.join("~")}";`);
    },
    async (get) => {
      assert.equal((await get("/quotes?symbols=sh600000")).status, 502);
      assert.equal((await get("/quotes?symbols=sh600000")).status, 200);
      assert.equal(calls, 2);
    },
  );
});

test("removed summary, financial and notice routes never contact an upstream provider", async () => {
  let calls = 0;
  await withRouter(
    async () => {
      calls += 1;
      throw new Error("unexpected upstream call");
    },
    async (get) => {
      assert.equal((await get("/600000/financials")).status, 404);
      assert.equal((await get("/600000/notices")).status, 404);
      assert.equal((await get("/600000/summary")).status, 404);
      assert.equal((await get("/sh600000/summary")).status, 404);
      assert.equal(calls, 0);
    },
  );
});

test("bare codes are rejected before requesting upstream data", async () => {
  await withRouter(
    async () => { throw new Error("unexpected upstream call"); },
    async (get) => {
      for (const path of ["/600000/kline", "/quotes?symbols=600000", "/quotes?symbols=000001"])
        assert.equal((await get(path)).status, 400);
    },
  );
});

test("K line responses require a valid upstream confirmation time", async () => {
  let stamp;
  await withRouter(
    async () => json({
      data: {
        sh600000: {
          qfqday: [["2026-10-09", "10", "11", "12", "9", "1000"]],
          qt: quoteClock("sh600000", stamp),
        },
      },
    }),
    async (get) => {
      for (stamp of [null, "20260230150000", "20261009990000"])
        assert.equal((await get("/sh600000/kline")).status, 502);
      stamp = "20261009150000";
      const response = await get("/sh600000/kline");
      assert.equal(response.status, 200);
      assert.equal((await response.json()).completedThrough, "2026-10-09");
    },
  );
});

const quoteText = (symbol, price = "10", stamp = "20261009150000") => {
  const fields = Array(60).fill("10");
  fields[1] = symbol;
  fields[3] = price;
  fields[30] = stamp;
  return `v_${symbol}="${fields.join("~")}";`;
};

test("batched quotes retain exchange identity and share numeric units", async () => {
  let calls = 0;
  await withRouter(
    async (url) => {
      calls++;
      assert.equal(
        String(url),
        "https://qt.gtimg.cn/q=sh000001,sh510300,sz000001",
      );
      return new Response(
        quoteText("sh000001", "3800") +
          quoteText("sz000001", "12") +
          quoteText("sh510300", "4"),
      );
    },
    async (get) => {
      const result = await (
        await get("/quotes?symbols=sz000001,sh000001,sh510300,sz000001")
      ).json();
      const bySymbol = new Map(result.data.map((row) => [row.symbol, row]));
      assert.equal(bySymbol.get("sh000001").price, 3800);
      assert.equal(bySymbol.get("sz000001").price, 12);
      assert.equal(bySymbol.get("sh510300").type, "fund");
      assert.equal(bySymbol.get("sh000001").pe, null);
      assert.equal(bySymbol.get("sh510300").totalMarketCap, null);
      assert.equal(bySymbol.get("sz000001").volume, 1000);
      assert.equal(bySymbol.get("sz000001").amount, 100000);
      assert.equal(calls, 1);
      assert.equal((await get("/quotes?symbols=bj430047")).status, 400);
      assert.equal(
        (await get("/quotes?symbols=" + Array(101).fill("sh600000").join(",")))
          .status,
        400,
      );
      assert.equal(calls, 1);
    },
  );
});

test("indices use actual unadjusted index candles without labeling them qfq", async () => {
  const rows = [["2026-10-09", "3800", "3810", "3820", "3790", "1000"]];
  await withRouter(
    async (url) => {
      assert.match(String(url), /sh000001/);
      return json({ data: { sh000001: { day: rows, qt: quoteClock("sh000001") } } });
    },
    async (get) => {
      const result = await (await get("/sh000001/kline")).json();
      assert.equal(result.symbol, "sh000001");
      assert.equal(result.adjustment, "none");
      assert.deepEqual(result.data, rows);
    },
  );
});

test("search preserves index and ETF markets and excludes unsupported types", async () => {
  await withRouter(
    async (url) => {
      assert.equal(new URL(String(url)).hostname, "smartbox.gtimg.cn");
      return new Response(
        'v_hint="sh~000001~Index~index~ZS^sz~000001~Bank~bank~GP^sh~510300~ETF~etf~JJ^sh~113000~Bond~bond~ZQ^bj~430047~BJ~bj~GP";',
      );
    },
    async (get) => {
      const { data } = await (await get("/search?q=test")).json();
      assert.deepEqual(
        data.map((row) => [row.symbol, row.type]),
        [
          ["sh000001", "index"],
          ["sz000001", "stock"],
          ["sh510300", "fund"],
        ],
      );
    },
  );
});

test("closing session invalidates the intraday candle cache, and respects upstream quote time", async () => {
  const originalNow = Date.now;
  let now = Date.parse("2026-10-09T06:59:00Z");
  Date.now = () => now;
  let calls = 0;
  try {
    await withRouter(
      async () => {
        calls++;
        const stamp = calls < 3 ? "20261009145900" : "20261009150000";
        return json({
          data: {
            sh600000: {
              qfqday: [
                ["2026-10-09", "10", String(10 + calls), "14", "9", "1000"],
              ],
              qt: {
                sh600000: (() => {
                  const fields = Array(60).fill("");
                  fields[30] = stamp;
                  return fields;
                })(),
              },
            },
          },
        });
      },
      async (get) => {
        const before = await (await get("/sh600000/kline")).json();
        assert.equal(before.completedThrough, "2026-10-08");
        now = Date.parse("2026-10-09T07:00:00Z");
        const closing = await (await get("/sh600000/kline")).json();
        assert.equal(calls, 2);
        assert.equal(closing.completedThrough, "2026-10-08");
        now += 16000;
        const confirmed = await (await get("/sh600000/kline")).json();
        assert.equal(calls, 3);
        assert.equal(confirmed.completedThrough, "2026-10-09");
        assert.equal(confirmed.data[0][2], "13");
      },
    );
  } finally {
    Date.now = originalNow;
  }
});
