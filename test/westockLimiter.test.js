const test = require("node:test");
const assert = require("node:assert/strict");
const { createLimiter, positiveInt } = require("../services/westock/limiter");

test("positiveInt 对非法值回退到默认，避免 env 误配把闸门锁死", () => {
  assert.equal(positiveInt("8", 4), 8);
  assert.equal(positiveInt(undefined, 4), 4);
  assert.equal(positiveInt("0", 4), 4);
  assert.equal(positiveInt("-1", 4), 4);
  assert.equal(positiveInt("abc", 4), 4);
  assert.equal(positiveInt("", 4), 4);
});

test("createLimiter 允许到上限，超出后进入排队", async () => {
  const limiter = createLimiter({ max: 2, maxQueue: 2, waitMs: 200 });
  await limiter.acquire();
  await limiter.acquire();
  assert.deepEqual(limiter.stats(), { active: 2, queued: 0, max: 2, maxQueue: 2 });

  const third = limiter.acquire();
  const fourth = limiter.acquire();
  assert.equal(limiter.stats().queued, 2);

  // 队列已满，第五个直接拒绝，且不入队
  await assert.rejects(() => limiter.acquire(), { status: 503, code: "BUSY" });
  assert.equal(limiter.stats().queued, 2);

  // 释放时名额移交给排队者：active 不变，只是队列变短
  limiter.release();
  await third;
  assert.equal(limiter.stats().active, 2);
  assert.equal(limiter.stats().queued, 1);

  limiter.release();
  await fourth;
  limiter.release();
  limiter.release();
  assert.equal(limiter.stats().active, 0);
  assert.equal(limiter.stats().queued, 0);
});

test("createLimiter 排队超时后自行出队并归还名额", async () => {
  const limiter = createLimiter({ max: 1, maxQueue: 5, waitMs: 30 });
  await limiter.acquire();
  await assert.rejects(() => limiter.acquire(), { status: 503, code: "BUSY" });
  assert.equal(limiter.stats().queued, 0, "超时的排队者必须从队列里摘掉");

  limiter.release();
  assert.equal(limiter.stats().active, 0);
});

test("createLimiter 多次 release 不会把 active 压成负数", async () => {
  const limiter = createLimiter({ max: 1 });
  limiter.release();
  limiter.release();
  assert.equal(limiter.stats().active, 0);
  await limiter.acquire();
  assert.equal(limiter.stats().active, 1);
  limiter.release();
  assert.equal(limiter.stats().active, 0);
});

test("createLimiter 反复 acquire/release 不泄漏名额", async () => {
  const limiter = createLimiter({ max: 3, maxQueue: 8, waitMs: 200 });
  for (let round = 0; round < 5; round++) {
    await Promise.all([limiter.acquire(), limiter.acquire(), limiter.acquire()]);
    assert.equal(limiter.stats().active, 3);
    limiter.release();
    limiter.release();
    limiter.release();
    assert.equal(limiter.stats().active, 0);
  }
});
