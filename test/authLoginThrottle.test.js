const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");

// 起一个只挂 /api/auth 的真实路由，把碰数据库/发邮件的模块换成桩（沿用 westockRoutes.test.js 的写法）。
// routes/auth 与 utils/authThrottle 每个用例都重新加载，拿到全新的进程内计数，用例之间互不污染。
async function withAuthRouter(run, options = {}) {
  const stubbed = {
    "../models/user": {
      findOne: async () => (typeof options.user === "function" ? options.user() : (options.user ?? null)),
      findByPk: async () => null,
    },
    "../utils/mail": {
      sendVerificationEmail: async () => ({ success: true }),
      sendResetCodeEmail: async () => ({ success: true }),
    },
    "../services/authSessionService": {
      createLoginSession: async () => ({ token: "test-token", session: { id: 1 } }),
    },
  };
  // 需要断言「到底发没发信」的用例可以换掉 mail 桩
  if (options.mail) stubbed["../utils/mail"] = options.mail;
  const reloaded = ["../routes/auth", "../utils/authThrottle"];

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

  const router = require("../routes/auth");
  const app = express();
  app.use(express.json());
  app.use("/api/auth", router);

  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();

  const request = async (path, body, headers = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/auth${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
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

  try {
    await run(request);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    for (const [path, cached] of previous) {
      if (cached) require.cache[path] = cached;
      else delete require.cache[path];
    }
  }
}

function fakeUser({ password = "correct", isActive = true } = {}) {
  return {
    id: 1,
    role: "admin",
    isActive,
    validatePassword: async (candidate) => candidate === password,
    update: async () => {},
    toJSON: () => ({ id: 1, role: "admin" }),
  };
}

const IP_A = { "x-forwarded-for": "203.0.113.1" };
const IP_B = { "x-forwarded-for": "203.0.113.2" };

/**
 * 退避走的是真实时钟，所以不能在固定次数上写死：
 * 第 6 次失败记下 1s 退避，紧接着的这次请求可能刚好落在窗口内（429），
 * 也可能窗口已过（401，并记下第 7 次失败 → 2s 窗口）。
 * 但「最多再试 3 次必然被拦」是确定的：1s 窗口过期后下一次失败会把窗口翻倍到 2s，
 * 紧接着的那一次不可能跨过 2s。精确的退避时长由 authThrottle.test.js 用注入时钟断言。
 */
async function expectBlockedWithin(request, attempts, body, headers) {
  const statuses = [];
  for (let i = 0; i < attempts; i += 1) {
    const res = await request("/login", body, headers);
    statuses.push(res.status);
    if (res.status === 429) return res;
  }
  assert.fail(`连续 ${attempts} 次尝试都没有被限流：${statuses.join(",")}`);
}

// ── 登录防爆破 ──────────────────────────────────────────────────────────────

test("登录：同一账号连续失败 5 次内不拦，之后开始退避并返回 429 + Retry-After", async () => {
  await withAuthRouter(
    async (request) => {
      const statuses = [];
      for (let i = 0; i < 6; i += 1) {
        const res = await request("/login", { username: "alice", password: "wrong" }, IP_A);
        statuses.push(res.status);
      }
      // 前 6 次都还是正常的「凭证错误」，退避从第 7 次请求开始生效
      assert.deepEqual(statuses, [401, 401, 401, 401, 401, 401]);

      const blocked = await expectBlockedWithin(
        request,
        3,
        { username: "alice", password: "wrong" },
        IP_A,
      );
      assert.equal(blocked.body.code, "TOO_MANY_ATTEMPTS");
      assert.equal(blocked.body.retryAfter, 1);
      assert.equal(blocked.headers.get("retry-after"), "1");
      assert.match(blocked.body.error, /登录尝试过于频繁/);
    },
    { user: null },
  );
});

test("登录：退避只作用于失败的那个账号，其他账号不受牵连", async () => {
  await withAuthRouter(
    async (request) => {
      for (let i = 0; i < 6; i += 1) {
        await request("/login", { username: "alice", password: "wrong" }, IP_A);
      }
      await expectBlockedWithin(request, 3, { username: "alice", password: "wrong" }, IP_A);

      // 同 IP 换账号仍然能正常走到凭证校验（IP 维度上限是 60 次，这里远没到）
      const bob = await request("/login", { username: "bob", password: "wrong" }, IP_A);
      assert.equal(bob.status, 401);
      assert.equal(bob.body.code, "INVALID_CREDENTIALS");
    },
    { user: null },
  );
});

test("登录：成功后清掉该账号的失败计数，失败次数不会跨成功累计", async () => {
  let current = null;
  await withAuthRouter(
    async (request) => {
      for (let i = 0; i < 3; i += 1) {
        current = null;
        const res = await request("/login", { username: "alice", password: "wrong" }, IP_A);
        assert.equal(res.status, 401);
      }

      current = fakeUser({ password: "correct" });
      const ok = await request("/login", { username: "alice", password: "correct" }, IP_A);
      assert.equal(ok.status, 200);
      assert.equal(ok.body.data.token, "test-token");

      // 计数已清零：再失败 5 次仍然只是 401，不会因为之前的 3 次提前进入退避
      current = null;
      for (let i = 0; i < 5; i += 1) {
        const res = await request("/login", { username: "alice", password: "wrong" }, IP_A);
        assert.equal(res.status, 401, `成功登录后的第 ${i + 1} 次失败应仍是 401`);
      }
    },
    { user: () => current },
  );
});

test("登录：账号是否存在/被禁用的判定顺序不泄露账号状态", async () => {
  await withAuthRouter(
    async (request) => {
      // 被禁用的账号 + 错密码 → 与「账号不存在」完全一致的 401
      const disabledWrong = await request(
        "/login",
        { username: "ghost", password: "wrong" },
        IP_A,
      );
      assert.equal(disabledWrong.status, 401);
      assert.equal(disabledWrong.body.code, "INVALID_CREDENTIALS");
      assert.equal(disabledWrong.body.error, "用户名/邮箱或密码错误");

      // 被禁用的账号 + 正确密码 → 明确告诉用户账号被禁用
      const disabledRight = await request(
        "/login",
        { username: "ghost", password: "correct" },
        IP_A,
      );
      assert.equal(disabledRight.status, 403);
      assert.equal(disabledRight.body.code, "ACCOUNT_DISABLED");
    },
    { user: fakeUser({ isActive: false }) },
  );
});

test("登录：单个 IP 换账号爆破被 IP 维度上限拦住，另一个 IP 不受影响", async () => {
  await withAuthRouter(
    async (request) => {
      for (let i = 0; i < 60; i += 1) {
        const res = await request("/login", { username: `user-${i}`, password: "x" }, IP_A);
        assert.equal(res.status, 401, `第 ${i + 1} 次请求应仍在配额内`);
      }
      const blocked = await request("/login", { username: "user-60", password: "x" }, IP_A);
      assert.equal(blocked.status, 429);
      assert.match(blocked.body.error, /登录尝试过于频繁/);

      const otherIp = await request("/login", { username: "someone", password: "x" }, IP_B);
      assert.equal(otherIp.status, 401);
    },
    { user: null },
  );
});

// ── 验证码邮件防刷 ──────────────────────────────────────────────────────────

test("验证码：换邮箱也绕不过 IP 上限，且被拒的请求不会再发邮件", async () => {
  const sent = [];
  const mail = {
    sendVerificationEmail: async (email) => {
      sent.push(email);
      return { success: true };
    },
    sendResetCodeEmail: async () => ({ success: true }),
  };

  await withAuthRouter(
    async (request) => {
      for (let i = 0; i < 5; i += 1) {
        const res = await request("/send-code", { email: `user${i}@example.com` }, IP_A);
        assert.equal(res.status, 200, `第 ${i + 1} 个邮箱应能发信`);
      }
      const blocked = await request("/send-code", { email: "user5@example.com" }, IP_A);
      assert.equal(blocked.status, 429);
      assert.equal(blocked.body.code, "TOO_MANY_ATTEMPTS");
      assert.match(blocked.body.error, /验证码请求过于频繁/);
      assert.equal(sent.length, 5, "被限流的请求不应该真的发信");

      const otherIp = await request("/send-code", { email: "user6@example.com" }, IP_B);
      assert.equal(otherIp.status, 200);
      assert.equal(sent.length, 6);
    },
    { user: null, mail },
  );
});

test("验证码：已注册邮箱的枚举路径同样计入 IP 配额", async () => {
  const sent = [];
  await withAuthRouter(
    async (request) => {
      for (let i = 0; i < 5; i += 1) {
        const res = await request("/send-code", { email: `taken${i}@example.com` }, IP_A);
        assert.equal(res.status, 409);
        assert.equal(res.body.code, "EMAIL_USED");
      }
      const blocked = await request("/send-code", { email: "taken5@example.com" }, IP_A);
      assert.equal(blocked.status, 429);
      assert.equal(sent.length, 0);
    },
    {
      user: fakeUser(),
      mail: {
        sendVerificationEmail: async (email) => {
          sent.push(email);
          return { success: true };
        },
        sendResetCodeEmail: async () => ({ success: true }),
      },
    },
  );
});

test("验证码：伪造 X-Forwarded-For 最左侧一跳不能换 IP 绕过限流", async () => {
  await withAuthRouter(
    async (request) => {
      for (let i = 0; i < 5; i += 1) {
        // 每次伪造不同的最左侧地址，最右侧（代理写入的真实出口）保持不变
        const res = await request(
          "/send-code",
          { email: `spoof${i}@example.com` },
          { "x-forwarded-for": `198.51.100.${i}, 203.0.113.9` },
        );
        assert.equal(res.status, 200);
      }
      const blocked = await request(
        "/send-code",
        { email: "spoof5@example.com" },
        { "x-forwarded-for": "198.51.100.200, 203.0.113.9" },
      );
      assert.equal(blocked.status, 429);
    },
    { user: null },
  );
});
