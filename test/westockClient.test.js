const test = require("node:test");
const assert = require("node:assert/strict");
const {
  assertSafeArgs,
  parseOutput,
  describeFailure,
  buildChildEnv,
  runWestock,
  KNOWN_COMMANDS,
} = require("../services/westock/client");

test("assertSafeArgs 放行合法的数据类命令", () => {
  assert.deepEqual(assertSafeArgs(["quote", "sh600519"]), ["quote", "sh600519"]);
  assert.deepEqual(
    assertSafeArgs(["kline", "sh600519", "--period", "day", "--limit", "200", "--fq", "qfq", "--raw"]),
    ["kline", "sh600519", "--period", "day", "--limit", "200", "--fq", "qfq", "--raw"],
  );
});

test("assertSafeArgs 放行选股类命令与目录查询", () => {
  assert.doesNotThrow(() => assertSafeArgs(["strategy", "macd_golden", "--date", "2026-09-23"]));
  assert.doesNotThrow(() => assertSafeArgs(["label", "--list"]));
  assert.doesNotThrow(() => assertSafeArgs(["filter", "--list-presets"]));
  assert.doesNotThrow(() => assertSafeArgs(["ranking", "CompScore", "--asc", "--limit", "20"]));
});

test("assertSafeArgs 放行动态 --min-/--max-<字段> 与负数取值", () => {
  assert.doesNotThrow(() => assertSafeArgs(["ranking", "CompScore", "--min-pe", "10"]));
  assert.doesNotThrow(() => assertSafeArgs(["ranking", "CompScore", "--max-pe", "30"]));
  assert.doesNotThrow(() => assertSafeArgs(["ranking", "CompScore", "--min-pe", "-5"]));
});

test("assertSafeArgs 放行带数字/下划线的动态字段名", () => {
  // 字段名形如 cap_main_5d、chg5d，只允许 [a-z_] 会误杀合法参数
  assert.doesNotThrow(() => assertSafeArgs(["ranking", "CompScore", "--min-cap_main_5d", "100"]));
  assert.doesNotThrow(() => assertSafeArgs(["ranking", "CompScore", "--min-chg5d", "1"]));
  assert.throws(() => assertSafeArgs(["ranking", "X", "--min-", "1"]), /不支持的参数/);
  assert.throws(() => assertSafeArgs(["ranking", "X", "--min-pe;rm", "1"]), /不支持的参数/);
});

test("assertSafeArgs 正确处理 --flag=value 形式", () => {
  assert.doesNotThrow(() => assertSafeArgs(["kline", "sh600519", "--limit=10"]));
  assert.doesNotThrow(() => assertSafeArgs(["kline", "sh600519", "--period=day"]));
  // 白名单外的 flag 即使带 = 也要拦下（先撞到路径校验就按非法字符报）
  assert.throws(() => assertSafeArgs(["quote", "sh600519", "--output=/tmp/x"]), /非法字符/);
  assert.throws(() => assertSafeArgs(["quote", "sh600519", "--exec=id"]), /不支持的参数/);
});

test("assertSafeArgs 拒绝 CLI 并不支持的 --code（代码是位置参数）", () => {
  // CLI 只把股票代码当位置参数，--code 会被它以退出码 1 拒绝；
  // 这里让白名单提前拦下，避免把明显的错误用法发到进程里。
  assert.throws(() => assertSafeArgs(["notice", "list", "--code", "sh600519"]), /不支持的参数/);
});

test("assertSafeArgs 归一化返回值：trim 命令、统一转字符串", () => {
  assert.deepEqual(assertSafeArgs(["  quote  ", "sh600519"]), ["quote", "sh600519"]);
  assert.deepEqual(assertSafeArgs(["quote", 600519, "--limit", 10]), [
    "quote",
    "600519",
    "--limit",
    "10",
  ]);
  // 命令被 trim 后的值参与白名单判断，拒绝带空白的伪造命令
  assert.throws(() => assertSafeArgs([" quote x", "sh600519"]), /未知命令/);
});

test("assertSafeArgs 放行 filter 表达式（含方括号与比较符）", () => {
  assert.doesNotThrow(() =>
    assertSafeArgs(["filter", "intersect([PE_TTM > 0, PE_TTM < 15])", "--market", "hs"]),
  );
});

test("assertSafeArgs 拒绝空参数与非法入参类型", () => {
  assert.throws(() => assertSafeArgs([]), { status: 400, code: "VALIDATION" });
  assert.throws(() => assertSafeArgs(null), { status: 400 });
  assert.throws(() => assertSafeArgs(undefined), { status: 400 });
});

test("assertSafeArgs 拒绝白名单之外的顶层命令", () => {
  assert.throws(() => assertSafeArgs(["rm", "-rf"]), /未知命令/);
  assert.throws(() => assertSafeArgs(["--help"]), /未知命令/);
  assert.throws(() => assertSafeArgs([""]), /未知命令/);
});

test("assertSafeArgs 拒绝白名单之外的长参数", () => {
  assert.throws(() => assertSafeArgs(["quote", "sh600519", "--output", "/tmp/x"]), /不支持的参数/);
  assert.throws(() => assertSafeArgs(["quote", "sh600519", "--exec"]), /不支持的参数/);
  assert.throws(() => assertSafeArgs(["quote", "sh600519", "-e"]), /不支持的参数/);
});

test("assertSafeArgs 拒绝任何形式的文件路径", () => {
  assert.throws(() => assertSafeArgs(["quote", "/etc/passwd"]), /非法字符/);
  assert.throws(() => assertSafeArgs(["quote", "../../etc/passwd"]), /非法字符/);
  assert.throws(() => assertSafeArgs(["quote", "~/secrets"]), /非法字符/);
  assert.throws(() => assertSafeArgs(["quote", ".."]), /非法字符/);
  assert.throws(() => assertSafeArgs(["quote", "."]), /非法字符/);
});

test("assertSafeArgs 拒绝控制字符与换行注入", () => {
  assert.throws(() => assertSafeArgs(["quote", "sh600519\nrm -rf /"]), /非法字符/);
  assert.throws(() => assertSafeArgs(["quote", "sh600519\u0000"]), /非法字符/);
});

test("assertSafeArgs 拒绝超长参数与超量参数", () => {
  assert.throws(() => assertSafeArgs(["quote", "x".repeat(201)]), /过长/);
  assert.throws(() => assertSafeArgs(["quote", ...new Array(41).fill("1")]), /参数过多/);
});

test("runWestock 对未知引擎直接抛 400，不启动子进程", async () => {
  await assert.rejects(() => runWestock("shell", ["quote", "sh600519"]), { status: 400 });
});

test("runWestock 在参数非法时抛 400，不启动子进程", async () => {
  await assert.rejects(() => runWestock("data", ["rm", "-rf"]), { status: 400 });
});

test("KNOWN_COMMANDS 覆盖前端目录加载用到的全部命令", () => {
  for (const command of ["strategy", "ranking", "label", "event", "filter", "search", "kline"]) {
    assert.ok(KNOWN_COMMANDS.has(command), `缺少命令 ${command}`);
  }
});

test("parseOutput 解析 Markdown 表格", () => {
  const parsed = parseOutput(
    "**策略选股** (2026-09-23) - 共 2 只 | 显示 1-2/2\n| code | name |\n| --- | --- |\n| sh600519 | 贵州茅台 |\n| sz000001 | 平安银行 |",
  );
  assert.equal(parsed.kind, "table");
  assert.equal(parsed.title, "策略选股");
  assert.deepEqual(parsed.columns, ["code", "name"]);
  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.rows[0].name, "贵州茅台");
});

test("parseOutput 解析 JSON", () => {
  const parsed = parseOutput('{"code":0,"data":[{"date":"2026-09-23"}]}');
  assert.equal(parsed.kind, "json");
  assert.equal(parsed.data.code, 0);
});

test("parseOutput 对非表格文本回退为 text", () => {
  assert.deepEqual(parseOutput("股票查询工具 - 命令行接口"), {
    kind: "text",
    text: "股票查询工具 - 命令行接口",
  });
  assert.deepEqual(parseOutput("   "), { kind: "text", text: "" });
});

test("describeFailure 优先取 stderr，压缩空白并截断", () => {
  assert.equal(
    describeFailure(1, '\n ❌ 命令 "notice" 收到 1 个未知参数：\n\n  ✗ --code\n', ""),
    '❌ 命令 "notice" 收到 1 个未知参数： ✗ --code',
  );
  // stderr 为空时退回 stdout
  assert.equal(describeFailure(1, "", "  执行失败  "), "执行失败");
  // 两者都为空时给一个带退出码的兜底文案
  assert.equal(describeFailure(7, "  ", ""), "westock CLI 执行失败（exitCode=7）");
  // 超长内容被截断
  assert.equal(describeFailure(1, "x".repeat(2000), "").length, 500);
});

test("buildChildEnv 不透传服务端机密，只放行白名单变量", () => {
  const original = { ...process.env };
  try {
    process.env.JWT_SECRET = "super-secret";
    process.env.DB_PASSWORD = "db-pass";
    process.env.RESEND_KEY = "re_xxx";
    process.env.PATH = "/usr/bin";
    process.env.WESTOCK_MAX_CONCURRENT = "2";
    const env = buildChildEnv();
    assert.equal(env.NODE_NO_WARNINGS, "1");
    assert.equal(env.PATH, "/usr/bin");
    assert.equal(env.WESTOCK_MAX_CONCURRENT, "2");
    assert.equal(env.JWT_SECRET, undefined);
    assert.equal(env.DB_PASSWORD, undefined);
    assert.equal(env.RESEND_KEY, undefined);
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in original)) delete process.env[key];
    }
    Object.assign(process.env, original);
  }
});
