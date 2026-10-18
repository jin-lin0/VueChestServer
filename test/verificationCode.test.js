const test = require("node:test");
const assert = require("node:assert/strict");

const codes = require("../utils/verificationCode");
const codePath = require.resolve("../utils/verificationCode");


function withClockShift(shiftMs, fn) {
  const real = Date.now;
  Date.now = () => real() + shiftMs;
  try {
    return fn();
  } finally {
    Date.now = real;
  }
}

/** 每个用例用独立 namespace，避免彼此污染（store 是模块级单例）。 */
let ns = 0;
const freshNs = () => `ns${++ns}`;

/** 重新加载模块以隔离验证码记录和清理计数。 */
function freshModule() {
  const cached = require.cache[codePath];
  delete require.cache[codePath];
  try {
    return require(codePath);
  } finally {
    delete require.cache[codePath];
    if (cached) require.cache[codePath] = cached;
  }
}

test("模块加载时不挂后台定时器（重新 require 也不该多出一份）", () => {
  const cached = require.cache[codePath];
  delete require.cache[codePath];

  const realSetInterval = global.setInterval;
  let spawned = 0;
  global.setInterval = (...args) => {
    spawned += 1;
    return realSetInterval(...args);
  };
  try {
    require(codePath);
  } finally {
    global.setInterval = realSetInterval;
    delete require.cache[codePath];
    if (cached) require.cache[codePath] = cached;
  }

  assert.equal(
    spawned,
    0,
    "仍在使用 setInterval：模块每被重新加载一次就多留一份定时器，且扫的是旧闭包里的 Map",
  );
});

test("生成的码是 6 位数字，且同一冷却期内重发不会换码", () => {
  const type = freshNs();
  const email = "basic@example.com";

  const first = codes.createCode(email, type);
  assert.match(first.code, /^\d{6}$/);
  assert.equal(first.cooldown, 0);

  const again = codes.createCode(email, type);
  assert.equal(again.code, first.code, "冷却期内重发必须返回同一个码，否则用户手上那个就作废了");
  assert.ok(again.cooldown > 0 && again.cooldown <= codes.RESEND_COOLDOWN_MS);

  // 冷却过后才允许换码
  const later = withClockShift(codes.RESEND_COOLDOWN_MS + 1000, () =>
    codes.createCode(email, type),
  );
  assert.notEqual(later.code, first.code);
  assert.equal(later.cooldown, 0);
});

test("校验通过后一次性失效；错误次数到上限后整条作废", () => {
  const type = freshNs();

  const ok = codes.createCode("use-once@example.com", type);
  assert.equal(codes.verifyCode("use-once@example.com", ok.code, type).valid, true);
  assert.equal(
    codes.verifyCode("use-once@example.com", ok.code, type).valid,
    false,
    "同一个码不能用第二次",
  );

  const capped = codes.createCode("attempts@example.com", type);
  for (let i = 1; i < 5; i++) {
    const res = codes.verifyCode("attempts@example.com", "000000", type);
    assert.equal(res.valid, false);
    assert.equal(res.reason, "验证码错误");
  }
  const fifth = codes.verifyCode("attempts@example.com", "000000", type);
  assert.equal(fifth.valid, false);
  assert.match(fifth.reason, /次数过多/);
  // 作废之后连正确的码也不认
  assert.equal(codes.verifyCode("attempts@example.com", capped.code, type).valid, false);
});

test("超过有效期后失效，并说明原因", () => {
  const type = freshNs();
  const issued = codes.createCode("expire@example.com", type);

  const late = withClockShift(codes.CODE_TTL_MS + 1000, () =>
    codes.verifyCode("expire@example.com", issued.code, type),
  );
  assert.equal(late.valid, false);
  assert.match(late.reason, /已过期/);
});

test("type 命名空间隔离，邮箱大小写与空白归一", () => {
  const type = freshNs();

  const registerCode = codes.createCode("space@example.com", type);
  assert.equal(
    codes.verifyCode("space@example.com", registerCode.code, `${type}-other`).valid,
    false,
    "不同用途的码不能互相通过",
  );

  const upper = codes.createCode("  MiXeD@Example.com  ", type);
  assert.equal(codes.verifyCode("mixed@example.com", upper.code, type).valid, true);

  const lower = codes.createCode("norm@example.com", type);
  assert.equal(codes.verifyCode("NORM@EXAMPLE.COM ", lower.code, type).valid, true);
});

test("cooldownRemaining 只读：不写表、不推进冷却、不换掉已发出的码", () => {
  const type = freshNs();
  const email = "peek@example.com";

  assert.equal(codes.cooldownRemaining(email, type), 0);

  const sizeBefore = codes.storeSize();
  codes.cooldownRemaining(email, type);
  codes.cooldownRemaining(email, type);
  assert.equal(codes.storeSize(), sizeBefore, "只读查询不该往表里写东西");

  const issued = codes.createCode(email, type);
  const sizeAfterCreate = codes.storeSize();

  const first = codes.cooldownRemaining(email, type);
  assert.ok(first > 0 && first <= codes.RESEND_COOLDOWN_MS);

  const second = codes.cooldownRemaining(email, type);
  assert.ok(second <= first, "冷却只会随时间递减");
  assert.ok(second > first - 1000, "连续读取之间不该大幅跳变");
  assert.equal(codes.storeSize(), sizeAfterCreate);

  assert.equal(
    codes.verifyCode(email, issued.code, type).valid,
    true,
    "只是问了一下冷却，不该把用户手上的码问没了",
  );
});

test("惰性清扫：超过保留窗口的条目会在写入累积到清扫间隔时被清掉", () => {
  const c = freshModule();
  const type = freshNs();
  const stale = "sweep-stale@example.com";

  c.createCode(stale, type);
  assert.equal(c.storeSize(), 1);

  // 有效期 5 分钟 + 验证后保留窗口 10 分钟 → 16 分钟必定算 stale。
  // 一次写满清扫间隔（256 次），期间必然触发一次清扫。
  withClockShift(16 * 60 * 1000, () => {
    for (let i = 0; i < 256; i++) c.createCode(`sweep-fresh-${i}@example.com`, type);
  });

  assert.equal(
    c.storeSize(),
    256,
    "过期那条应当被清掉（1 + 256 - 1），而不是无限期留在表里",
  );
});

test("条目数是硬上限：写爆之后表有界，且最新的那条还在", () => {
  const c = freshModule();
  const type = freshNs();
  const total = c.MAX_ENTRIES + 1;

  for (let i = 0; i < total; i++) c.createCode(`cap-${i}@example.com`, type);

  assert.ok(
    c.storeSize() <= c.MAX_ENTRIES,
    `写完 ${total} 条之后表仍有 ${c.storeSize()} 条，超过上限 ${c.MAX_ENTRIES}`,
  );
  assert.equal(
    c.storeSize(),
    Math.floor(c.MAX_ENTRIES * 0.9),
    "超出上限时按插入顺序淘汰到 90%，摊还每次写入仍是 O(1)",
  );

  // 最早那条被淘汰
  assert.equal(c.cooldownRemaining("cap-0@example.com", type), 0);
  // 最新那条必须还在（否则等于「刚发出去的码立刻不可用」）
  assert.ok(c.cooldownRemaining(`cap-${total - 1}@example.com`, type) > 0);
});
