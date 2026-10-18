const test = require("node:test");
const assert = require("node:assert/strict");
const {
  toBoundedInt,
  MAX_PAGE,
  parseIdList,
  MAX_BATCH_IDS,
  isPositiveIntParam,
} = require("../utils/queryParams");

test("非法输入退回 fallback（这正是 NaN 500 的根因）", () => {
  const options = { fallback: 20, max: 50 };
  for (const value of [
    "abc",
    "",
    " ",
    undefined,
    null,
    {},
    [],
    "NaN",
    "-1",
    "0",
    "-0",
    "0.9",
  ]) {
    assert.equal(
      toBoundedInt(value, options),
      20,
      `${JSON.stringify(value)} 应回退到 20`,
    );
  }
});

test("合法输入原样通过，超过 max 才截断", () => {
  assert.equal(toBoundedInt("1", { fallback: 20, max: 50 }), 1);
  assert.equal(toBoundedInt("20", { fallback: 20, max: 50 }), 20);
  assert.equal(toBoundedInt("50", { fallback: 20, max: 50 }), 50);
  assert.equal(toBoundedInt("51", { fallback: 20, max: 50 }), 50);
  assert.equal(toBoundedInt("99999", { fallback: 20, max: 50 }), 50);
});

test("不传 max 时不截断（只做下界收口）", () => {
  assert.equal(toBoundedInt("7", { fallback: 1 }), 7);
  assert.equal(toBoundedInt("999999", { fallback: 1 }), 999999);
});

test("重复 query 参数（数组）取第一个", () => {
  assert.equal(toBoundedInt(["3", "9"], { fallback: 1, max: 50 }), 3);
  assert.equal(toBoundedInt(["abc", "9"], { fallback: 1, max: 50 }), 1);
});

test("超大值被 MAX_PAGE 挡住（否则 OFFSET 溢出成 SQL 语法错误）", () => {
  assert.equal(toBoundedInt("99999999999999999999", { fallback: 1, max: MAX_PAGE }), MAX_PAGE);
  assert.ok(Number.isSafeInteger(MAX_PAGE));
});

test("前导数字按 parseInt 语义解析（与历史行为一致）", () => {
  assert.equal(toBoundedInt("12abc", { fallback: 1, max: 50 }), 12);
  assert.equal(toBoundedInt("  3  ", { fallback: 1, max: 50 }), 3);
});

test("parseIdList：去重、只留正整数、丢弃其它噪声", () => {
  assert.deepEqual(parseIdList("1,2,3"), [1, 2, 3]);
  assert.deepEqual(parseIdList("39,39,39"), [39]);
  assert.deepEqual(parseIdList("1,,2,"), [1, 2]);
  assert.deepEqual(parseIdList(["7", "8"]), [7, 8]);
  assert.deepEqual(parseIdList([7, 8]), [7, 8]);
  for (const value of ["", "abc", "-1", "0", "1.5", undefined, null, []]) {
    assert.deepEqual(parseIdList(value), [], JSON.stringify(value));
  }
});

test("parseIdList：坏输入不靠 parseInt 截断，避免静默删错行", () => {
  // parseInt("1;2;3") === 1 —— 如果用它，这个明显坏掉的输入会被悄悄当成「删 id=1」。
  // 对删除类接口这比直接判空拒绝危险得多，所以整段必须都是数字才算数。
  assert.deepEqual(parseIdList("1;2;3"), []);
  assert.deepEqual(parseIdList("1 2 3"), []);
  assert.deepEqual(parseIdList("1 OR 1=1"), []);
  assert.deepEqual(parseIdList("1e3"), []);
});

test("parseIdList：截断到 MAX_BATCH_IDS", () => {
  const many = Array.from({ length: MAX_BATCH_IDS + 50 }, (_, i) => i + 1).join(",");
  const ids = parseIdList(many);
  assert.equal(ids.length, MAX_BATCH_IDS);
  assert.equal(ids[0], 1);
  assert.equal(ids.at(-1), MAX_BATCH_IDS);
});

/* --------------------- 单个路径参数的正整数判据 --------------------- */

test("isPositiveIntParam：parseInt 会截断的写法一律判否", () => {
  // 这三条正是「拿调用方指定的 id 去操作另一个资源」的来源：
  // parseInt("1.5") / parseInt("1e3") / parseInt("1abc") 全是 1。
  for (const value of ["1.5", "1e3", "1abc", "12px", "1 2", "1;2", "1+2"]) {
    assert.equal(isPositiveIntParam(value), false, `${value} 不该判真`);
  }
  // Number() 同样不行：Number("1e3") 是 1000，指向一个真实存在但没人指定的 id。
  assert.equal(Number("1e3"), 1000);
  assert.equal(isPositiveIntParam("1e3"), false);
});

test("isPositiveIntParam：0 / 负数 / 小数 / 空 / 非数字判否", () => {
  for (const value of ["0", "-0", "-1", "0.5", "", " ", "abc", undefined, null, {}, []]) {
    assert.equal(isPositiveIntParam(value), false, `${JSON.stringify(value)} 不该判真`);
  }
});

test("isPositiveIntParam：超出安全整数范围判否（Number 会丢精度）", () => {
  assert.equal(isPositiveIntParam("9007199254740991"), true);
  assert.equal(isPositiveIntParam("9007199254740992"), false);
  assert.equal(isPositiveIntParam("9007199254740993"), false);
  assert.equal(isPositiveIntParam("99999999999999999999"), false);
});

test("isPositiveIntParam：合法值判真，且 Number() 能还原成同一个整数", () => {
  for (const value of ["1", "7", "12", "123456789"]) {
    assert.equal(isPositiveIntParam(value), true, value);
    assert.equal(Number(value), Number.parseInt(value, 10));
  }
  // 数字入参（body / Express 有时已经解析过）同样可用
  assert.equal(isPositiveIntParam(12), true);
  assert.equal(isPositiveIntParam(1.5), false);
});

test("isPositiveIntParam：前导零判否（与 parseIdList 的宽松不同，路径参数更严）", () => {
  // "007" 与 "7" 是不同的字符串，作为路径参数只在明确写 7 时才该命中 id 7。
  assert.equal(isPositiveIntParam("007"), false);
  assert.equal(isPositiveIntParam("7"), true);
});
