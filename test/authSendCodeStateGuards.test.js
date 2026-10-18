const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");

/**
 * 「被拒绝的请求不许改动状态」这一类缺陷在验证码发送接口上的两个表现。
 *
 * `/send-code` 与 `/forgot-password` 原来的顺序是：
 *
 *   1. `createCode(email)`      ← **先写 store**：铸新码、并把 60 秒重发冷却重新计时
 *   2. `mailIpLimiter.hit(ip)`  ← 再判 IP 配额，被拒就 429 返回
 *
 * 于是「被 IP 闸门拒绝」这个请求**已经**改动了状态：它把用户手上那个还没用掉、
 * 也还没过期的验证码换成了一个新的（还没发出去、用户永远看不到的）码，
 * 同时把重发冷却重新计时到未来。
 *
 * 用户看到的是两件坏事：
 *   - 手上收到的那个码失效了（拿它去注册会被判「验证码错误」）；
 *   - 再点一次重发，接口回「验证码已发送，请 N 秒后再试」——**谎报已发送**，
 *     而这期间一封信都没发出去。
 *
 * 正确顺序是「先只读地判冷却 → 再判 IP 闸门 → 最后才写 store」。判冷却必须早于
 * IP 闸门，否则用户连点几下重发就会把整点 IP 配额烧光、被锁一小时（那是真回退）。
 */

const authRouterPath = require.resolve("../routes/auth");
const throttlePath = require.resolve("../utils/authThrottle");
const codePath = require.resolve("../utils/verificationCode");

/**
 * 起一个真实挂载 `/api/auth` 的路由，把碰数据库/发邮件的模块换成桩。
 * `routes/auth`、`utils/authThrottle`、`utils/verificationCode` 每个用例都重新加载，
 * 让 IP 配额与验证码 store 在用例之间互不污染（沿用 authLoginThrottle.test.js 的写法）。
 */
async function withAuthRouter(run, options = {}) {
  const sent = [];
  const stubbed = {
    "../models/user": {
      findOne: async () => options.user ?? null,
      findByPk: async () => null,
    },
    "../utils/mail": {
      sendVerificationEmail: async (to, code) => {
        sent.push({ to, code, kind: "register" });
        return { success: true };
      },
      sendResetCodeEmail: async (to, code) => {
        sent.push({ to, code, kind: "reset" });
        return { success: true };
      },
    },
  };

  const reloaded = [authRouterPath, throttlePath, codePath];
  const previous = new Map();
  for (const key of [...Object.keys(stubbed), ...reloaded]) {
    const path = require.resolve(key);
    previous.set(path, require.cache[path]);
    delete require.cache[path];
  }
  for (const [key, exports] of Object.entries(stubbed)) {
    const path = require.resolve(key);
    require.cache[path] = { id: path, filename: path, loaded: true, exports };
  }

  const router = require(authRouterPath);
  // 与路由拿到的是同一个实例（require 缓存），所以能直接验「用户手上那个码还算不算数」。
  const codes = require(codePath);

  const app = express();
  app.use(express.json());
  app.use("/api/auth", router);

  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise((resolve) => server.once("listening", resolve));
    const { port } = server.address();

    const request = async (path, body) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/auth${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const text = await response.text();
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
      return { status: response.status, body: parsed, headers: response.headers };
    };

    await run({ request, sent, codes });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    for (const [path, cached] of previous) {
      if (cached) require.cache[path] = cached;
      else delete require.cache[path];
    }
  }
}

/** 只在这一次请求期间把 `Date.now()` 往前推，用来跨过 60 秒重发冷却（IP 窗口是 1 小时，不受影响）。 */
async function shiftedBy(ms, fn) {
  const real = Date.now;
  Date.now = () => real() + ms;
  try {
    return await fn();
  } finally {
    Date.now = real;
  }
}

/** 把某个 IP 的邮件配额（5 次 / 小时）用满：每个邮箱都是新的，所以不会撞上 60 秒冷却。 */
async function exhaustMailQuota(request, sent, { skip = [] } = {}) {
  const names = ["quota-b", "quota-c", "quota-d", "quota-e", "quota-f"].filter(
    (name) => !skip.includes(name),
  );
  let used = sent.length;
  for (const name of names) {
    if (used >= 5) break;
    const res = await request("/send-code", { email: `${name}@example.com` });
    assert.equal(res.status, 200, `配额内的 ${name} 这一发应当成功`);
    used += 1;
  }
  assert.equal(sent.length, 5, "配额应当正好被用满 5 次");
}

test("被 IP 限流拒绝的 /send-code 不能换掉用户手上那个还没用过的验证码", async () => {
  await withAuthRouter(async ({ request, sent, codes }) => {
    const email = "state-a@example.com";

    const first = await request("/send-code", { email });
    assert.equal(first.status, 200);
    const delivered = sent.find((item) => item.to === email).code;
    assert.match(delivered, /^\d{6}$/);

    await exhaustMailQuota(request, sent);

    // 时间推过 60 秒冷却，于是这次请求会走到「要不要铸新码」那一步；IP 闸门必然拒绝。
    const rejected = await shiftedBy(61_000, () => request("/send-code", { email }));
    assert.equal(rejected.status, 429);
    assert.equal(rejected.body.code, "TOO_MANY_ATTEMPTS");
    assert.equal(sent.length, 5, "被拒绝的请求不该发信");

    // 核心断言：被拒绝的请求什么都没改，用户手上那个码仍然算数。
    assert.equal(
      codes.verifyCode(email, delivered).valid,
      true,
      "被 IP 限流拒绝的请求把已经发出去的验证码换掉了，用户拿手上的码注册会被判「验证码错误」",
    );
  });
});

test("被 IP 限流拒绝之后的重试不能谎报「验证码已发送」", async () => {
  await withAuthRouter(async ({ request, sent }) => {
    const email = "state-b@example.com";

    const first = await request("/send-code", { email });
    assert.equal(first.status, 200);

    await exhaustMailQuota(request, sent);

    const rejected = await shiftedBy(61_000, () => request("/send-code", { email }));
    assert.equal(rejected.status, 429);
    assert.equal(sent.length, 5);

    // 紧接着再点一次重发：冷却确实已过，所以必须如实报「请求过于频繁」，
    // 而不是拿一个「刚刚才发过」的假状态回「验证码已发送」。
    const retry = await shiftedBy(61_000, () => request("/send-code", { email }));
    assert.equal(retry.status, 429);
    assert.doesNotMatch(
      retry.body.error,
      /验证码已发送/,
      "一封信都没发出去，却告诉用户「验证码已发送」",
    );
    assert.match(retry.body.error, /验证码请求过于频繁/);
    assert.equal(sent.length, 5);
  });
});

test("重发冷却的判定必须早于 IP 闸门，否则连点几下就把整点配额烧光", async () => {
  await withAuthRouter(async ({ request, sent }) => {
    const email = "order@example.com";

    const first = await request("/send-code", { email });
    assert.equal(first.status, 200);
    assert.equal(sent.length, 1);

    // 用户在 60 秒冷却里连点 10 次：全部应当被邮箱冷却挡回，且**一次 IP 配额都不消耗**。
    for (let i = 0; i < 10; i++) {
      const res = await request("/send-code", { email });
      assert.equal(res.status, 429);
      assert.equal(res.body.code, "RATE_LIMITED");
    }
    assert.equal(sent.length, 1, "冷却期内不该真发信");

    // 可观测的后果：配额还剩 4 次，换一个邮箱必须还能发出去。
    // 如果冷却判定排在 IP 闸门之后，这 10 次点击会把 5 次/小时的额度用尽。
    const other = await request("/send-code", { email: "order-other@example.com" });
    assert.equal(other.status, 200, "连点几下重发就把整点 IP 配额烧光了");
    assert.equal(sent.length, 2);
  });
});

test("重置验证码接口同样：被 IP 限流拒绝不得换掉已发出的码", async () => {
  await withAuthRouter(
    async ({ request, sent, codes }) => {
      const email = "state-reset@example.com";

      const first = await request("/forgot-password", { email });
      assert.equal(first.status, 200);
      const delivered = sent.find((item) => item.to === email).code;

      // 打满配额：重置接口与注册接口共用同一个按 IP 的邮件闸门。
      let used = sent.length;
      for (const name of ["r-b", "r-c", "r-d", "r-e", "r-f"]) {
        if (used >= 5) break;
        const res = await request("/forgot-password", { email: `${name}@example.com` });
        assert.equal(res.status, 200);
        used += 1;
      }
      assert.equal(sent.length, 5);

      const rejected = await shiftedBy(61_000, () => request("/forgot-password", { email }));
      assert.equal(rejected.status, 429);
      assert.equal(rejected.body.code, "TOO_MANY_ATTEMPTS");
      assert.equal(sent.length, 5);

      assert.equal(
        codes.verifyCode(email, delivered, "reset").valid,
        true,
        "被 IP 限流拒绝的重置请求把已经发出去的重置码换掉了",
      );
    },
    { user: { id: 3 } },
  );
});
