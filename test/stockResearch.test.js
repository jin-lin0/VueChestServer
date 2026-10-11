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
  app.use((_req, _res, next) => { requests += 1; next(); });
  app.use("/api/research-stocks", require(routePath));
  app.use((error, _req, res, _next) => res.status(error.status || 502).json({ success: false, error: error.message }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/research-stocks`;
  try {
    await run((path) => originalFetch(base + path), () => requests);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    global.fetch = originalFetch;
    if (previous) require.cache[routePath] = previous;
    else delete require.cache[routePath];
  }
}

const json = (value) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });

test("daily, weekly and monthly routes use declared forward-adjusted rows", async () => {
  const rows = [["2026-10-09", "10", "11", "12", "9", "1000"]];
  await withRouter(async (url) => {
    assert.ok(String(url).includes("/fqkline/get?"));
    const period = String(url).match(/,([a-z]+),,,/)?.[1];
    assert.ok(String(url).endsWith(",qfq"));
    return json({ data: { sh600000: { [`qfq${period}`]: rows, [period]: [["2026-10-09", "100", "110", "120", "90", "1000"]] } } });
  }, async (get) => {
    for (const period of ["day", "week", "month"]) {
      const result = await (await get(`/600000/kline?period=${period}`)).json();
      assert.deepEqual(result.data, rows);
      assert.equal(result.period, period);
      assert.equal(result.adjustment, "qfq");
    }
  });
});

test("unadjusted-only upstream payload is rejected instead of silently relabeled", async () => {
  await withRouter(async () => json({ data: { sh600000: { day: [["2026-10-09", "10", "11", "12", "9", "1000"]] } } }), async (get) => {
    const result = await get("/600000/kline");
    assert.equal(result.status, 502);
    assert.equal((await result.json()).success, false);
  });
});

test("history pagination keeps long adjusted history in chronological order", async () => {
  const history = Array.from({ length: 800 }, (_, index) => [
    new Date(Date.UTC(2022, 0, index + 1)).toISOString().slice(0, 10), "10", "11", "12", "9", "1000",
  ]);
  const requestedEnds = [];
  await withRouter(async (url) => {
    const params = new URL(String(url)).searchParams.get("param").split(",");
    const end = params[3];
    requestedEnds.push(end);
    const rows = history.filter((row) => !end || row[0] <= end).slice(-Number(params[4]));
    return json({ data: { sh600000: { qfqday: rows } } });
  }, async (get) => {
    const result = await (await get("/600000/kline?count=700")).json();
    assert.deepEqual(result.data, history.slice(-700));
    assert.equal(requestedEnds.length, 2);
    assert.equal(requestedEnds[0], "");
    assert.ok(requestedEnds[1] < history.at(-640)[0]);
  });
});

test("history pagination fails rather than accepting a non-advancing page", async () => {
  const rows = Array.from({ length: 640 }, (_, index) => [new Date(Date.UTC(2022, 0, index + 1)).toISOString().slice(0, 10), "10", "11", "12", "9", "1000"]);
  await withRouter(async () => json({ data: { sh600000: { qfqday: rows } } }), async (get) => {
    const result = await get("/600000/kline?count=700");
    assert.equal(result.status, 502);
    assert.match((await result.json()).error, /没有推进/);
  });
});

test("market overview uses Tencent directly", async () => {
  await withRouter(async (url, options) => {
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
    return new Response([
      index("sh000001", "SH Index", "3813.79", "1.89", "0.05"),
      index("sz399001", "SZ Index", "12641.86", "20.96", "0.17"),
      index("sz399006", "ChiNext", "3043.33", "6.67", "0.22"),
    ].join("\n"));
  }, async (get) => {
    const result = await (await get("/market-overview")).json();
    assert.equal(result.success, true);
    assert.equal(result.source, "tencent");
    assert.deepEqual(result.data, [
      { code: "000001", name: "SH Index", price: 3813.79, change: 1.89, changePercent: 0.05 },
      { code: "399001", name: "SZ Index", price: 12641.86, change: 20.96, changePercent: 0.17 },
      { code: "399006", name: "ChiNext", price: 3043.33, change: 6.67, changePercent: 0.22 },
    ]);
  });
});

test("market overview rejects empty Tencent quotes without caching the failure", async () => {
  let calls = 0;
  await withRouter(async (url) => {
    assert.equal(new URL(String(url)).hostname, "qt.gtimg.cn");
    calls += 1;
    return new Response('');
  }, async (get) => {
    assert.equal((await get("/market-overview")).status, 502);
    assert.equal((await get("/market-overview")).status, 502);
    assert.equal(calls, 2);
  });
});

test("summary uses Tencent directly and preserves missing values and quote time", async () => {
  await withRouter(async (url, options) => {
    assert.equal(new URL(String(url)).hostname, "qt.gtimg.cn");
    assert.ok(options.signal);
    const fields = Array(60).fill("10");
    fields[30] = "20261009150000";
    fields[39] = "";
    fields[46] = " ";
    fields[49] = "0";
    return new Response(`v_sh600000="${fields.join("~")}";`);
  }, async (get) => {
    const result = await (await get("/600000/summary")).json();
    assert.equal(result.source, "tencent");
    assert.equal(result.data.asOf, "20261009150000");
    assert.equal(result.data.pe, null);
    assert.equal(result.data.pb, null);
    assert.equal(result.data.volumeRatio, 0);
    assert.equal(typeof result.fetchedAt, "number");
  });
});

test("concurrent cache misses share one upstream request", async () => {
  let resolve;
  const pending = new Promise((yes) => { resolve = yes; });
  let calls = 0;
  await withRouter(async () => { calls += 1; return pending; }, async (get, requests) => {
    const first = get("/600000/summary");
    const second = get("/600000/summary");
    while (requests() < 2) await new Promise(setImmediate);
    assert.equal(calls, 1);
    const fields = Array(60).fill("10");
    fields[30] = "20261009150000";
    resolve(new Response(`v_sh600000="${fields.join("~")}";`));
    const responses = await Promise.all([first, second]);
    assert.deepEqual(await responses[0].json(), await responses[1].json());
  });
});

test("a failed cache fill is released so the next request can retry", async () => {
  let calls = 0;
  await withRouter(async () => {
    calls += 1;
    const fields = Array(60).fill("10");
    fields[30] = "20261009150000";
    return calls === 1 ? new Response("failed", { status: 503 }) : new Response(`v_sh600000="${fields.join("~")}";`);
  }, async (get) => {
    assert.equal((await get("/600000/summary")).status, 502);
    assert.equal((await get("/600000/summary")).status, 200);
    assert.equal(calls, 2);
  });
});

test("removed financial and notice routes never contact an upstream provider", async () => {
  let calls = 0;
  await withRouter(async () => { calls += 1; throw new Error("unexpected upstream call"); }, async (get) => {
    assert.equal((await get("/600000/financials")).status, 404);
    assert.equal((await get("/600000/notices")).status, 404);
    assert.equal(calls, 0);
  });
});
