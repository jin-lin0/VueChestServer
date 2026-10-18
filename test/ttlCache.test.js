const test = require("node:test");
const assert = require("node:assert/strict");

const { createTtlCache } = require("../utils/ttlCache");


test("TTL 内命中不调 loader，不同 key 各自独立加载", async () => {
  const cached = createTtlCache();
  const seen = [];
  const load = (tag) => async () => {
    seen.push(tag);
    return tag;
  };

  assert.equal(await cached.get("a", 60_000, load("a")), "a");
  assert.equal(await cached.get("a", 60_000, load("a")), "a");
  assert.equal(await cached.get("b", 60_000, load("b")), "b");
  assert.deepEqual(seen, ["a", "b"], "同 key 第二次必须复用，b 与 a 互不影响");
  assert.equal(cached.size(), 2);
});

test("过期后重新加载，且过期条目在 get 开头被清掉、不占配额", async () => {
  const cached = createTtlCache({ maxEntries: 8 });
  let calls = 0;
  const load = async () => ++calls;

  // ttl=0 → expiresAt 恰好等于写入时刻，下一次 get 的 prune 会判定其已过期
  assert.equal(await cached.get("k", 0, load), 1);
  assert.equal(cached.size(), 1, "ttl=0 也是先写进去再等它过期");
  assert.equal(await cached.get("k", 0, load), 2, "已过期必须重新加载");
  assert.equal(calls, 2);
  assert.equal(cached.size(), 1);
});

test("同一 key 的并发未命中只打一次 loader，且所有调用方拿到同一次结果", async () => {
  const cached = createTtlCache();
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const load = async () => {
    calls += 1;
    await gate;
    return { n: calls };
  };

  const all = [
    cached.get("k", 60_000, load),
    cached.get("k", 60_000, load),
    // 第三个调用方带一个「不一样的 loader」：合并期内它不该被调用
    cached.get("k", 60_000, async () => ({ n: 999 })),
  ];
  assert.equal(calls, 1, "三次并发调用只应触发一次 loader");

  release();
  const results = await Promise.all(all);
  assert.equal(calls, 1);
  assert.deepEqual(results, [{ n: 1 }, { n: 1 }, { n: 1 }], "合并是共用一次结果，不是只服务第一个调用方");
});

test("loader 抛错时不写缓存，且下一次请求能立刻重试", async () => {
  const cached = createTtlCache();
  let calls = 0;
  const failing = async () => {
    calls += 1;
    throw new Error("上游挂了");
  };

  await assert.rejects(() => cached.get("k", 60_000, failing), /上游挂了/);
  assert.equal(cached.size(), 0, "失败结果绝不能进缓存");

  assert.equal(await cached.get("k", 60_000, async () => "ok"), "ok", "失败后必须能重试成功");
  assert.equal(calls, 1, "重试走的是新的 loader，不是复用旧的失败 promise");
});

test("并发未命中失败时：错误同时抛给所有等待方，且 in-flight 槽位被释放", async () => {
  const cached = createTtlCache();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const load = async () => {
    await gate;
    throw new Error("上游挂了");
  };

  const a = cached.get("k", 60_000, load);
  const b = cached.get("k", 60_000, load);
  release();
  await assert.rejects(() => a, /上游挂了/);
  await assert.rejects(() => b, /上游挂了/);
  assert.equal(cached.size(), 0);

  let calls = 0;
  const value = await cached.get("k", 60_000, async () => {
    calls += 1;
    return "ok";
  });
  assert.equal(value, "ok");
  assert.equal(calls, 1, "槽位没释放的话这里会拿到上次的失败 promise");
});

test("超过 maxEntries 时按插入顺序淘汰最旧的一条，且命中不刷新顺序", async () => {
  const cached = createTtlCache({ maxEntries: 3 });
  for (const key of ["a", "b", "c"]) {
    await cached.get(key, 60_000, async () => key);
  }
  assert.equal(cached.size(), 3);
  await cached.get("d", 60_000, async () => "d");
  assert.equal(cached.size(), 3, "size 不得越界");

  const reloaded = [];
  const probe = (key) => async () => {
    reloaded.push(key);
    return key;
  };
  for (const key of ["b", "c", "d", "a"]) {
    await cached.get(key, 60_000, probe(key));
  }
  assert.deepEqual(reloaded, ["a"], "只有最旧的 a 被淘汰；b/c/d 命中不刷新顺序");
});

test("ttl 允许传函数，按刚加载到的值计算", async () => {
  const cached = createTtlCache();
  let calls = 0;
  const load = async () => {
    calls += 1;
    return { updatedAt: calls, slow: calls === 1 };
  };
  const ttl = (value) => (value.slow ? 0 : 60_000);

  assert.equal((await cached.get("k", ttl, load)).updatedAt, 1);
  assert.equal((await cached.get("k", ttl, load)).updatedAt, 2, "第一次算出 ttl=0，必须立刻过期");
  assert.equal((await cached.get("k", ttl, load)).updatedAt, 2, "第二次算出 60s，此后命中");
  assert.equal(calls, 2);
});

test("clear 之后全部重新加载", async () => {
  const cached = createTtlCache();
  let calls = 0;
  const load = async () => ++calls;
  await cached.get("k", 60_000, load);
  cached.clear();
  assert.equal(cached.size(), 0);
  assert.equal(await cached.get("k", 60_000, load), 2);
});

test("maxEntries 非法时立刻抛错，而不是悄悄退化成无上限", () => {
  for (const bad of [0, -1, 1.5, "10", null, NaN]) {
    assert.throws(() => createTtlCache({ maxEntries: bad }), TypeError, `maxEntries=${String(bad)}`);
  }
  assert.equal(createTtlCache().size(), 0, "不传参数走 256 默认值");
});

test("maxValueBytes 默认不限，传了才拦；被拦的值仍然正常返回", async () => {
  // 不传 maxValueBytes = 不额外做一次序列化，大值照缓存
  const unlimited = createTtlCache();
  let calls = 0;
  const big = async () => {
    calls += 1;
    return { blob: "x".repeat(1000) };
  };
  await unlimited.get("k", 60_000, big);
  await unlimited.get("k", 60_000, big);
  assert.equal(calls, 1, "默认不限大小");

  const limited = createTtlCache({ maxValueBytes: 100 });
  let limitedCalls = 0;
  const load = async () => {
    limitedCalls += 1;
    return { blob: "x".repeat(1000) };
  };
  const value = await limited.get("k", 60_000, load);
  assert.equal(value.blob.length, 1000, "超限的值必须原样返回给调用方");
  assert.equal(limited.size(), 0, "超限的值不入缓存");
  await limited.get("k", 60_000, load);
  assert.equal(limitedCalls, 2, "每次都要重新加载");

  // 未超限的照常缓存；字符串按字符数计
  const small = createTtlCache({ maxValueBytes: 100 });
  let smallCalls = 0;
  const loadSmall = async () => {
    smallCalls += 1;
    return "y".repeat(50);
  };
  await small.get("k", 60_000, loadSmall);
  await small.get("k", 60_000, loadSmall);
  assert.equal(smallCalls, 1);
  assert.equal(small.size(), 1);

  for (const bad of [NaN, "100", null]) {
    assert.throws(() => createTtlCache({ maxValueBytes: bad }), TypeError, String(bad));
  }
});

test("循环引用的值算不出大小时按「不可缓存」处理，且不影响返回值", async () => {
  const cached = createTtlCache({ maxValueBytes: 10_000 });
  let calls = 0;
  const load = async () => {
    calls += 1;
    const value = { name: "loop" };
    value.self = value;
    return value;
  };
  const first = await cached.get("k", 60_000, load);
  assert.equal(first.name, "loop");
  assert.equal(cached.size(), 0, "算不出大小的值不入缓存，而不是抛错");
  await cached.get("k", 60_000, load);
  assert.equal(calls, 2);
});
