const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { UNAUTH_PROXY_BUDGET } = require("../middleware/rateLimit");

// 把某个模块换成桩，并且在这次 run 期间强制重新加载指定的模块（沿用 test/authLoginThrottle.test.js 的写法）。
// 目的：拿到全新的进程内计数器，用例之间互不污染；同时避免真的去打网易云 / 腾讯。
async function withStubs(modules, reload, run) {
  const previous = new Map();
  for (const key of [...Object.keys(modules), ...reload]) {
    const path = require.resolve(key);
    previous.set(path, require.cache[path]);
    delete require.cache[path];
  }
  for (const [key, exports] of Object.entries(modules)) {
    const path = require.resolve(key);
    require.cache[path] = { id: path, filename: path, loaded: true, exports };
  }

  const app = express();
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    await run(app, base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    for (const [path, cached] of previous) {
      if (cached) require.cache[path] = cached;
      else delete require.cache[path];
    }
  }
}

function mount(app, prefix, router) {
  app.use(prefix, router);
  app.use((error, _req, res, _next) =>
    res
      .status(error.status || 500)
      .json({ success: false, error: error.message, code: error.code }),
  );
}

async function withNeteaseRouter(run) {
  let upstreamCalls = 0;
  const stub = {
    cloudsearch: async () => {
      upstreamCalls += 1;
      return { body: { result: { songs: [] } } };
    },
  };
  await withStubs({ NeteaseCloudMusicApi: stub }, ["../routes/netease"], async (app, base) => {
    mount(app, "/api/netease", require("../routes/netease"));
    await run({
      base,
      upstream: () => upstreamCalls,
      path: (i) => `/api/netease/search?keywords=k${i}`,
    });
  });
}

async function withStockRouter(run) {
  let upstreamCalls = 0;
  const stub = {
    instrument: (value) => ({ symbol: String(value) }),
    fetchQuotes: async (symbols) => {
      upstreamCalls += 1;
      return symbols.map((symbol) => ({ symbol }));
    },
  };
  await withStubs(
    { "../services/tencentQuotes": stub },
    ["../routes/stockResearch"],
    async (app, base) => {
      mount(app, "/api/research-stocks", require("../routes/stockResearch"));
      await run({
        base,
        upstream: () => upstreamCalls,
        // 每次换一个 symbol：绕过 60 秒缓存，逼出真实的「每个请求都打上游」
        path: (i) => `/api/research-stocks/quotes?symbols=TEST${i}`,
      });
    },
  );
}

// 两条零鉴权上游代理的共同契约：窗口内放行 limit 次，之后 429，且被拒的请求绝不落到上游。
async function assertProxyBudget(route) {
  const limit = UNAUTH_PROXY_BUDGET.limit;
  const headers = { "x-forwarded-for": "10.0.0.1" };

  for (let i = 0; i < limit; i += 1) {
    const response = await fetch(route.base + route.path(i), { headers });
    assert.equal(response.status, 200, `第 ${i + 1} 次请求应放行`);
  }
  assert.equal(route.upstream(), limit, "额度内的请求都应该真的打到上游");

  const blocked = await fetch(route.base + route.path(limit), { headers });
  assert.equal(blocked.status, 429);

  // Retry-After 是「窗口剩余秒数」，而本测例自己串行发 600 次 fetch 要花 ~1 秒，
  // 于是剩余秒数必然比完整窗口少一点（跨过 1 秒边界就 1800 → 1799）。
  // 这里曾经写死 `assert.equal(retryAfter, "1800")`，机器一忙就红 —— 断言的应该是
  // 「接近窗口剩余时间且为正整数」，不是被测例自身耗时决定的精确值。
  const budgetSeconds = UNAUTH_PROXY_BUDGET.windowMs / 1000;
  const retryAfter = Number(blocked.headers.get("retry-after"));
  assert.ok(Number.isInteger(retryAfter), `Retry-After 应是整数秒，实际 ${blocked.headers.get("retry-after")}`);
  assert.ok(retryAfter > 0, "Retry-After 必须为正，否则客户端会立刻重试");
  assert.ok(
    retryAfter <= budgetSeconds && retryAfter >= budgetSeconds - 5,
    `Retry-After 应接近窗口剩余秒数（实际 ${retryAfter}，窗口 ${budgetSeconds}）`,
  );

  const body = await blocked.json();
  assert.equal(body.code, "TOO_MANY_REQUESTS");
  assert.equal(body.retryAfter, retryAfter, "响应体的 retryAfter 应与 Retry-After 头一致");
  assert.equal(route.upstream(), limit, "被限流的请求不应再打上游");

  // 一个来源被打满，不能影响其他来源
  const other = await fetch(route.base + route.path(limit + 1), {
    "x-forwarded-for": "10.0.0.2",
  });
  assert.equal(other.status, 200, "另一个 IP 应不受影响");
}

test("/api/netease 超出额度后拒绝，且不再打上游", async () => {
  await withNeteaseRouter(assertProxyBudget);
});

test("/api/research-stocks 超出额度后拒绝，且不再打上游", async () => {
  await withStockRouter(assertProxyBudget);
});

// 上面两个用例是从常量现算期望值的，所以「窗口被改小」它们察觉不到。
// middleware/rateLimit.js 的注释说「改这个数字前先重新确认轮询频率」——
// 这条用例把那句话变成一道闸：真要改额度，必须同时更新这里和注释里的测算。
test("未鉴权上游代理的额度就是注释里测算的 600 次 / 30 分钟", () => {
  assert.deepEqual(UNAUTH_PROXY_BUDGET, {
    limit: 600,
    windowMs: 30 * 60 * 1000,
  });
});
