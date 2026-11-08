const test = require("node:test");
const assert = require("node:assert/strict");
const { moveIndex, optionLines } = require("../scripts/site-login/prompt-select");

test("方向键在首尾循环，不会越界", () => {
  assert.equal(moveIndex(0, -1, 3), 2);
  assert.equal(moveIndex(2, 1, 3), 0);
  assert.equal(moveIndex(1, 1, 3), 2);
  assert.strictEqual(moveIndex(0, 0, 1), 0);
});

test("只有当前项带指针和高亮，其余项保持纯文本", () => {
  const options = [
    { label: "WorkBuddy 国内版", hint: "短信验证码" },
    { label: "掘金", hint: "Cookie" },
  ];
  const lines = optionLines(options, 1);

  assert.equal(lines.length, 2);
  assert.ok(!lines[0].includes("❯"));
  assert.ok(lines[1].includes("❯"));
  assert.ok(lines[0].includes("短信验证码"));
  assert.ok(lines[1].includes("掘金"));
});
