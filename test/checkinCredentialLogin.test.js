const test = require("node:test");
const assert = require("node:assert/strict");
const provider = require("../scripts/checkin-credentials/workbuddy-cn");

function jwt(claims) {
  return `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
}

function fakeFetch(responses) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, headers: options.headers, body: JSON.parse(options.body) });
    const next = responses.shift();
    assert.ok(next, `意外的请求：${url}`);
    return { status: 200, json: async () => next };
  };
  return { calls, fetchImpl };
}

const askStub = (answers) => async () => answers.shift();

test("无验证码时发送短信，校验并写入轮换后的令牌", async () => {
  const at = jwt({ sub: "u1", preferred_username: "13800000000", exp: 1796116652 });
  const nextAt = jwt({ sub: "u1", exp: 1796289452 });
  const { calls, fetchImpl } = fakeFetch([
    { code: 0, data: { expires_in: 300 } },
    { code: 0, data: { accessToken: at, refreshToken: "rt-1" } },
    { code: 0, data: { accessToken: nextAt, refreshToken: "rt-2" } },
  ]);

  const { credentials, account } = await provider.obtain({
    phone: "",
    code: "",
    ask: askStub(["13800000000", "552397"]),
    fetchImpl,
  });

  assert.equal(calls.length, 3);
  assert.match(calls[0].url, /\/v2\/plugin\/login\/send-sms$/);
  assert.deepEqual(calls[0].body, { phone: "13800000000" });
  assert.deepEqual(calls[1].body, {
    login_method: "phone",
    phone: "13800000000",
    sms_code: "552397",
  });
  assert.equal(calls[2].headers["X-Refresh-Token"], "rt-1");
  assert.equal(account, "13800000000");
  assert.deepEqual(credentials, { accessToken: nextAt, refreshToken: "rt-2" });
});

test("命令行直接给出验证码时跳过发送短信", async () => {
  const at = jwt({ sub: "u1" });
  const { calls, fetchImpl } = fakeFetch([
    { code: 0, data: { accessToken: at, refreshToken: "rt-1" } },
  ]);

  await provider.obtain({
    phone: "13800000000",
    code: "552397",
    ask: askStub([]),
    fetchImpl,
    verify: false,
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/v2\/plugin\/login\/token$/);
});

test("跳过校验时不会请求续期接口", async () => {
  const at = jwt({ sub: "u1" });
  const { calls, fetchImpl } = fakeFetch([
    { code: 0, data: { accessToken: at, refreshToken: "rt-1" } },
  ]);
  const { credentials } = await provider.obtain({
    phone: "13800000000",
    code: "552397",
    ask: askStub([]),
    fetchImpl,
    verify: false,
  });
  assert.equal(calls.length, 1);
  assert.equal(credentials.refreshToken, "rt-1");
});

test("上游返回错误码时抛出可读失败原因", async () => {
  const { fetchImpl } = fakeFetch([{ code: 4001, msg: "验证码已过期" }]);
  await assert.rejects(
    provider.obtain({
      phone: "13800000000",
      code: "552397",
      ask: askStub([]),
      fetchImpl,
      verify: false,
    }),
    /登录失败：验证码已过期/,
  );
});

test("登录响应缺少令牌时立刻失败，不写入半份凭据", async () => {
  const { fetchImpl } = fakeFetch([{ code: 0, data: { accessToken: jwt({ sub: "u1" }) } }]);
  await assert.rejects(
    provider.obtain({
      phone: "13800000000",
      code: "552397",
      ask: askStub([]),
      fetchImpl,
      verify: false,
    }),
    /缺少 accessToken \/ refreshToken/,
  );
});

test("站点脚本自己解析 --phone / --code / --no-verify", async () => {
  const at = jwt({ sub: "u1", preferred_username: "13800000000" });
  const { calls, fetchImpl } = fakeFetch([
    { code: 0, data: { accessToken: at, refreshToken: "rt-1" } },
  ]);

  const { credentials } = await provider.run(
    ["--phone", "13800000000", "--code", "552397", "--no-verify"],
    { ask: askStub([]), fetchImpl },
  );

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body, {
    login_method: "phone",
    phone: "13800000000",
    sms_code: "552397",
  });
  assert.equal(credentials.refreshToken, "rt-1");
});

test("未知参数由站点脚本拒绝，不会静默忽略", () => {
  assert.throws(() => provider.parseOptions(["--cookie", "abc"]), /不支持参数：--cookie/);
});
