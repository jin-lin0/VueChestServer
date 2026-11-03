const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");

async function withRouter(run) {
  const previousSecret = process.env.CRON_SECRET;
  process.env.CRON_SECRET = "test-cron-secret";
  let executions = 0;
  const configurations = [];
  const previous = new Map();
  const modules = {
    "../models/checkinState": {},
    "../models/cronRun": {},
    "../services/checkins": {
      createCheckinService: () => ({
        configure: async (task, value) => {
          configurations.push({ task, value });
          return { task, configured: true };
        },
        runAll: async () => {
          executions++;
          return { success: true, results: [] };
        },
      }),
    },
    "../middleware/auth": {
      authMiddleware: () => assert.fail("个人 Cron 不应调用 VueChest 登录鉴权"),
    },
    "../middleware/superAdmin": {
      superAdminOnly: () => assert.fail("个人 Cron 不应依赖管理员角色"),
    },
  };
  const routerPath = require.resolve("../routes/checkins");
  previous.set(routerPath, require.cache[routerPath]);
  for (const [name, exports] of Object.entries(modules)) {
    const path = require.resolve(name);
    previous.set(path, require.cache[path]);
    require.cache[path] = { id: path, filename: path, loaded: true, exports };
  }
  delete require.cache[routerPath];
  const app = express();
  app.use(express.json());
  app.use("/api/checkins", require(routerPath));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try {
    await run({
      executions: () => executions,
      configurations,
      request: (path, options) =>
        fetch(
          `http://127.0.0.1:${server.address().port}/api/checkins${path}`,
          options,
        ),
    });
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    for (const [path, value] of previous) {
      if (value) require.cache[path] = value;
      else delete require.cache[path];
    }
    if (previousSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previousSecret;
  }
}

test("定时 GET 与手动 POST 共用 Cron 密钥，无需 VueChest 登录", async () =>
  withRouter(async ({ request, executions }) => {
    for (const method of ["GET", "POST"]) {
      assert.equal(
        (
          await request("/run", {
            method,
            headers: { Authorization: "Bearer test-cron-secret" },
          })
        ).status,
        200,
      );
    }
    assert.equal(executions(), 2);
  }));

test("普通访问、管理员令牌和缺失 Cron 密钥都不能执行", async () =>
  withRouter(async ({ request, executions }) => {
    for (const method of ["GET", "POST"]) {
      assert.equal((await request("/run", { method })).status, 401);
      assert.equal(
        (
          await request("/run", {
            method,
            headers: { Authorization: "Bearer vuechest-admin-token" },
          })
        ).status,
        401,
      );
    }
    delete process.env.CRON_SECRET;
    assert.equal(
      (
        await request("/run", {
          headers: { Authorization: "Bearer test-cron-secret" },
        })
      ).status,
      401,
    );
    assert.equal(executions(), 0);
  }));

test("非 ASCII 错误密钥按字节比较并拒绝，不抛异常", async () =>
  withRouter(async () => {
    let status;
    require("../middleware/cronAuth")(
      {
        headers: {
          authorization: "Bearer " + "测".repeat("test-cron-secret".length),
        },
      },
      {
        status: (s) => {
          status = s;
          return { json() {} };
        },
      },
      () => assert.fail(),
    );
    assert.equal(status, 401);
  }));

test("不再暴露账号管理、服务列表或执行记录查询接口", async () =>
  withRouter(async ({ request }) => {
    for (const [path, method] of [
      ["/accounts", "GET"],
      ["/accounts", "POST"],
      ["/accounts/id", "PATCH"],
      ["/accounts/id", "DELETE"],
      ["/providers", "GET"],
      ["/runs", "GET"],
    ]) {
      assert.equal(
        (
          await request(path, {
            method,
            headers: { Authorization: "Bearer test-cron-secret" },
          })
        ).status,
        404,
      );
    }
  }));

test("凭据录入仅需 Cron 密钥，拒绝网站管理员令牌且不提供读取接口", async () =>
  withRouter(async ({ request, configurations }) => {
    const value = {
      accessToken: "access-example",
      refreshToken: "refresh-example",
    };
    const options = {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(value),
    };
    const url = "/credentials/workbuddy-cn";
    assert.equal((await request(url, options)).status, 401);
    assert.equal(
      (
        await request(url, {
          ...options,
          headers: {
            ...options.headers,
            Authorization: "Bearer vuechest-admin-token",
          },
        })
      ).status,
      401,
    );
    assert.equal(configurations.length, 0);
    const response = await request(url, {
      ...options,
      headers: { ...options.headers, Authorization: "Bearer test-cron-secret" },
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.ok(
      !text.includes(value.accessToken) && !text.includes(value.refreshToken),
    );
    assert.deepEqual(configurations, [{ task: "workbuddy-cn", value }]);
    assert.equal(
      (
        await request(url, {
          headers: { Authorization: "Bearer test-cron-secret" },
        })
      ).status,
      404,
    );
  }));
