const test = require("node:test");
const assert = require("node:assert/strict");

const {
  clientIpOf,
  createFailureBackoff,
  createWindowLimiter,
  loginAttemptKey,
} = require("../utils/authThrottle");

// ── clientIpOf ─────────────────────────────────────────────────────────────

test("clientIpOf 取 X-Forwarded-For 最右侧一跳（代理写入、客户端伪造不了）", () => {
  assert.equal(
    clientIpOf({
      headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" },
      ip: "10.0.0.1",
      socket: { remoteAddress: "10.0.0.1" },
    }),
    "5.6.7.8",
  );
});

test("clientIpOf 在客户端自带伪造串时仍取最右侧", () => {
  // 客户端塞了 1.2.3.4，最近的代理在后面补了真实出口 203.0.113.9
  assert.equal(
    clientIpOf({ headers: { "x-forwarded-for": "1.2.3.4, 203.0.113.9" }, ip: "10.0.0.1" }),
    "203.0.113.9",
  );
});

test("clientIpOf 无 X-Forwarded-For 时回落到 req.ip，再回落到 socket", () => {
  assert.equal(clientIpOf({ headers: {}, ip: "127.0.0.1" }), "127.0.0.1");
  assert.equal(
    clientIpOf({ headers: {}, socket: { remoteAddress: "::1" } }),
    "::1",
  );
  assert.equal(clientIpOf({ headers: {} }), "unknown");
});

test("clientIpOf 兼容 header 被解析成数组与多余空白的写法", () => {
  assert.equal(clientIpOf({ headers: { "x-forwarded-for": ["9.9.9.9"] } }), "9.9.9.9");
  assert.equal(
    clientIpOf({ headers: { "x-forwarded-for": " 1.1.1.1 ,  2.2.2.2  , " }, ip: "x" }),
    "2.2.2.2",
  );
});

test("loginAttemptKey 大小写归一且不定长暴露原文", () => {
  assert.equal(loginAttemptKey("Admin"), loginAttemptKey("admin"));
  assert.notEqual(loginAttemptKey("admin"), loginAttemptKey("root"));
  assert.equal(loginAttemptKey("a".repeat(10000)).length, 64);
});

// ── createFailureBackoff ───────────────────────────────────────────────────

test("失败退避：前 freeAttempts 次不拦，之后按 2 的幂增长并封顶", () => {
  const backoff = createFailureBackoff({
    freeAttempts: 3,
    baseDelayMs: 1000,
    maxDelayMs: 8000,
  });

  for (let i = 1; i <= 3; i += 1) {
    const result = backoff.registerFailure("k", 0);
    assert.equal(result.blocked, false, `第 ${i} 次失败不应拦`);
    assert.equal(result.failures, i);
  }

  // 第 4 次失败 → 1s，第 5 次 → 2s，第 6 次 → 4s，继续翻倍到封顶 8s
  const expected = [1000, 2000, 4000, 8000, 8000];
  expected.forEach((delay, index) => {
    const result = backoff.registerFailure("k", 0);
    assert.equal(result.retryAfterMs, delay, `第 ${index + 4} 次失败的退避时长`);
    assert.equal(result.blocked, true);
  });
});

test("失败退避：退避期内 check 返回剩余等待，到期后放行", () => {
  const backoff = createFailureBackoff({ freeAttempts: 0, baseDelayMs: 1000 });
  backoff.registerFailure("k", 0);

  assert.deepEqual(backoff.check("k", 0), {
    blocked: true,
    retryAfterMs: 1000,
    failures: 1,
  });
  assert.equal(backoff.check("k", 400).retryAfterMs, 600);
  assert.equal(backoff.check("k", 1000).blocked, false);
  assert.equal(backoff.check("k", 1000).failures, 1);
});

test("失败退避：键之间互不影响", () => {
  const backoff = createFailureBackoff({ freeAttempts: 0, baseDelayMs: 5000 });
  backoff.registerFailure("alice", 0);
  assert.equal(backoff.check("alice", 0).blocked, true);
  assert.equal(backoff.check("bob", 0).blocked, false);
});

test("失败退避：成功后 reset 清空，且不牵连别的键", () => {
  const backoff = createFailureBackoff({ freeAttempts: 0, baseDelayMs: 60_000 });
  backoff.registerFailure("alice", 0);
  backoff.registerFailure("bob", 0);

  backoff.reset("alice");
  assert.equal(backoff.check("alice", 0).blocked, false);
  assert.equal(backoff.check("alice", 0).failures, 0);
  assert.equal(backoff.check("bob", 0).blocked, true);
});

test("失败退避：窗口内不再有失败记录则整条作废，不做长期封禁", () => {
  const backoff = createFailureBackoff({
    freeAttempts: 0,
    baseDelayMs: 1000,
    windowMs: 10_000,
  });
  backoff.registerFailure("k", 0);
  assert.equal(backoff.check("k", 5_000).failures, 1);
  // 超过 windowMs 后重新计数，避免把偶发失败累计成长期封锁
  assert.equal(backoff.check("k", 10_001).failures, 0);
  assert.equal(backoff.registerFailure("k", 10_001).failures, 1);
});

test("失败退避：条目数有上限，不会随请求量无界增长", () => {
  const backoff = createFailureBackoff({ freeAttempts: 5, maxEntries: 4, windowMs: 3_600_000 });
  for (let i = 0; i < 256; i += 1) backoff.registerFailure(`ip-${i}`, 0);
  // 第 256 次写入触发清扫：无过期条目，按插入顺序裁到 maxEntries 的 90%
  assert.ok(backoff.size() <= 4, `size=${backoff.size()} 应被裁到上限内`);
});

test("失败退避：清扫会丢掉已过期条目", () => {
  const backoff = createFailureBackoff({ freeAttempts: 0, windowMs: 100, maxEntries: 1000 });
  for (let i = 0; i < 255; i += 1) backoff.registerFailure(`old-${i}`, 0);
  assert.equal(backoff.size(), 255);
  // 再写一条（now 远大于旧条目的 expiresAt）触发清扫，旧条目全部过期
  backoff.registerFailure("fresh", 1_000_000);
  assert.equal(backoff.size(), 1);
});

// ── createWindowLimiter ────────────────────────────────────────────────────

test("窗口限流：窗口内放行 limit 次，第 limit+1 次拒绝并给出剩余等待", () => {
  const limiter = createWindowLimiter({ limit: 3, windowMs: 60_000 });

  assert.deepEqual(limiter.hit("ip", 0), { allowed: true, remaining: 2, retryAfterMs: 0 });
  assert.deepEqual(limiter.hit("ip", 100), { allowed: true, remaining: 1, retryAfterMs: 0 });
  assert.deepEqual(limiter.hit("ip", 200), { allowed: true, remaining: 0, retryAfterMs: 0 });

  const blocked = limiter.hit("ip", 1_000);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterMs, 59_000);

  // 窗口内继续打也还是被拒，且窗口不因被拒请求而延长
  assert.equal(limiter.hit("ip", 30_000).allowed, false);
  assert.equal(limiter.hit("ip", 30_000).retryAfterMs, 30_000);

  // 窗口到期即放行
  assert.equal(limiter.hit("ip", 60_000).allowed, true);
});

test("窗口限流：键之间互不影响，且条目数有上限", () => {
  const limiter = createWindowLimiter({ limit: 1, windowMs: 1000, maxEntries: 4 });
  limiter.hit("a", 0);
  assert.equal(limiter.hit("a", 0).allowed, false);
  assert.equal(limiter.hit("b", 0).allowed, true);

  for (let i = 0; i < 256; i += 1) limiter.hit(`k-${i}`, 0);
  assert.ok(limiter.size() <= 4, `size=${limiter.size()} 应被裁到上限内`);
});
