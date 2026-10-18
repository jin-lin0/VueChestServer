const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { setTimeout: delay } = require("node:timers/promises");
const {
  createIpRateLimit,
  tooManyRequests,
  UNAUTH_PROXY_BUDGET,
} = require("../middleware/rateLimit");

// 起一个只挂限流中间件的真实 express 应用，用真 HTTP 打它，
// 这样断言的是「中间件在真实请求链里的行为」，而不是直接调用函数。
async function withServer(middleware, run) {
  const app = express();
  app.use(middleware);
  app.get("/ping", (_req, res) => res.json({ ok: true }));
  app.use((error, _req, res, _next) =>
    res.status(error.status || 500).json({ error: error.message }),
  );

  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const url = `http://127.0.0.1:${server.address().port}/ping`;
  const request = (headers = {}) => fetch(url, { headers });

  try {
    await run(request, url);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("窗口内放行 limit 次，第 limit+1 次返回 429", async () => {
  await withServer(createIpRateLimit({ limit: 3, windowMs: 60000 }), async (request) => {
    for (let i = 0; i < 3; i += 1) {
      const response = await request({ "x-forwarded-for": "1.1.1.1" });
      assert.equal(response.status, 200, `第 ${i + 1} 次应放行`);
    }
    const blocked = await request({ "x-forwarded-for": "1.1.1.1" });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers.get("retry-after"), "60");
    const body = await blocked.json();
    assert.equal(body.code, "TOO_MANY_REQUESTS");
    assert.equal(body.retryAfter, 60);
    assert.match(body.error, /过于频繁/);
  });
});

test("不同来源 IP 各自计数，互不牵连", async () => {
  await withServer(createIpRateLimit({ limit: 1, windowMs: 60000 }), async (request) => {
    assert.equal((await request({ "x-forwarded-for": "1.1.1.1" })).status, 200);
    assert.equal((await request({ "x-forwarded-for": "1.1.1.1" })).status, 429);
    // 换成另一个最右跳，是一个新的桶
    assert.equal((await request({ "x-forwarded-for": "2.2.2.2" })).status, 200);
  });
});

test("限流键取 X-Forwarded-For 最右一跳：改写最左跳不能重置计数", async () => {
  await withServer(createIpRateLimit({ limit: 2, windowMs: 60000 }), async (request) => {
    // 真实部署里最左跳由客户端自己塞，最右跳是最近的反向代理写入的、客户端伪造不了。
    assert.equal((await request({ "x-forwarded-for": "9.9.9.9, 4.4.4.4" })).status, 200);
    assert.equal((await request({ "x-forwarded-for": "8.8.8.8, 4.4.4.4" })).status, 200);
    // 前两次只换了最左跳，仍是同一个客户端 → 额度应该已经用完
    const blocked = await request({ "x-forwarded-for": "7.7.7.7, 4.4.4.4" });
    assert.equal(blocked.status, 429, "轮换最左跳不应绕过限流");
  });
});

test("OPTIONS 预检不消耗额度", async () => {
  await withServer(createIpRateLimit({ limit: 1, windowMs: 60000 }), async (request, url) => {
    for (let i = 0; i < 5; i += 1) {
      const response = await fetch(url, { method: "OPTIONS" });
      assert.ok(response.status < 400, `预检不应被限流（第 ${i + 1} 次）`);
    }
    // 预检跑完，GET 的额度仍是满的
    assert.equal((await request({ "x-forwarded-for": "5.5.5.5" })).status, 200);
    assert.equal((await request({ "x-forwarded-for": "5.5.5.5" })).status, 429);
  });
});

test("窗口到期后额度重置（固定窗口）", async () => {
  await withServer(createIpRateLimit({ limit: 1, windowMs: 40 }), async (request) => {
    assert.equal((await request({ "x-forwarded-for": "6.6.6.6" })).status, 200);
    assert.equal((await request({ "x-forwarded-for": "6.6.6.6" })).status, 429);
    await delay(60);
    assert.equal((await request({ "x-forwarded-for": "6.6.6.6" })).status, 200);
  });
});

test("429 契约与认证接口共用一处实现", async () => {
  const app = express();
  app.get("/auth-like", (_req, res) => tooManyRequests(res, 2500, "验证码请求"));
  app.get("/proxy-like", (_req, res) =>
    tooManyRequests(res, 500, "音乐接口", "TOO_MANY_REQUESTS"),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    // 认证接口的历史契约必须逐字不变
    const auth = await fetch(`${base}/auth-like`);
    assert.equal(auth.status, 429);
    assert.equal(auth.headers.get("retry-after"), "3");
    assert.deepEqual(await auth.json(), {
      error: "验证码请求过于频繁，请 3 秒后重试",
      code: "TOO_MANY_ATTEMPTS",
      retryAfter: 3,
    });

    const proxy = await fetch(`${base}/proxy-like`);
    assert.equal(proxy.status, 429);
    assert.equal(proxy.headers.get("retry-after"), "1");
    assert.deepEqual(await proxy.json(), {
      error: "音乐接口过于频繁，请 1 秒后重试",
      code: "TOO_MANY_REQUESTS",
      retryAfter: 1,
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("默认额度对真实用量留足余量（股票页 60 秒轮询）", () => {
  // 真实用量：src/apps/stock/App.vue 每 60 秒 refreshData 一次，
  // 一次并发 /quotes + /market-overview + /kline（日线另有 5 分钟节流）→ 稳态约 2~3 请求/分钟。
  const requestsPerMinute = 3;
  const windowMinutes = UNAUTH_PROXY_BUDGET.windowMs / 60000;
  const worstCaseForHuman = requestsPerMinute * windowMinutes;
  assert.ok(
    UNAUTH_PROXY_BUDGET.limit >= worstCaseForHuman * 3,
    `额度 ${UNAUTH_PROXY_BUDGET.limit} 对「${windowMinutes} 分钟 × ${requestsPerMinute} 请求/分钟」的真实用量余量不足 3 倍`,
  );
});
