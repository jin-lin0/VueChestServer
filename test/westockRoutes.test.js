const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const realClient = require("../services/westock/client");

// 真实的 middleware/auth 会去连数据库校验 JWT 与会话，这里按项目既有测试做法换成桩：
// 本文件验证的是「路由挂上了鉴权」「参数进不到 spawn」「路由到 CLI 的参数映射正确」，
// 不是复测 jwt 解析本身（那属于 middleware/auth 的职责）。
//
// 注意：参数白名单在 client.runWestock 内部，所以默认**不**替换 client 模块，
// 否则会连校验一起绕过去，测试变成自证。只有需要捕获调用参数的用例才传 options.client。
async function withWestockRouter(run, options = {}) {
  const authPath = require.resolve("../middleware/auth");
  const clientPath = require.resolve("../services/westock/client");
  const routePath = require.resolve("../routes/westock");
  const previous = new Map(
    [authPath, clientPath, routePath].map((path) => [path, require.cache[path]]),
  );
  const put = (path, exports) => {
    require.cache[path] = { id: path, filename: path, loaded: true, exports };
  };

  put(authPath, {
    authMiddleware: (req, res, next) => {
      if (!req.headers.authorization) {
        res
          .status(401)
          .json({ success: false, error: "未授权，请先登录", code: "UNAUTHORIZED" });
        return;
      }
      req.user = { id: 1 };
      next();
    },
  });
  if (options.client) {
    put(clientPath, { ...realClient, ...options.client });
  }
  delete require.cache[routePath];

  const router = require(routePath);
  const app = express();
  app.use(express.json());
  app.use("/api/westock", router);
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({
      success: false,
      error: err.message,
      code: err.code || "SERVER_ERROR",
    });
  });

  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`, router);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    for (const [path, cached] of previous) {
      if (cached) require.cache[path] = cached;
      else delete require.cache[path];
    }
  }
}

function postExec(baseUrl, args, headers = {}) {
  return fetch(`${baseUrl}/api/westock/exec`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ engine: "data", args }),
  });
}

const AUTH = { Authorization: "Bearer test" };

test(
  "westock 接口未登录一律 401",
  { concurrency: false },
  async () => {
    await withWestockRouter(async (baseUrl) => {
      const catalog = await fetch(`${baseUrl}/api/westock/catalog`);
      assert.equal(catalog.status, 401);
      assert.equal((await catalog.json()).code, "UNAUTHORIZED");

      const exec = await postExec(baseUrl, ["quote", "sh600519"]);
      assert.equal(exec.status, 401);
      assert.equal((await exec.json()).code, "UNAUTHORIZED");

      // 命名接口同样受保护
      const named = await fetch(`${baseUrl}/api/westock/kline?code=sh600519`);
      assert.equal(named.status, 401);
    });
  },
);

test(
  "westock exec 拒绝白名单外的命令，且不触发 spawn",
  { concurrency: false },
  async () => {
    await withWestockRouter(async (baseUrl) => {
      const response = await postExec(baseUrl, ["rm", "-rf", "/"], AUTH);
      assert.equal(response.status, 400);
      const body = await response.json();
      assert.equal(body.code, "VALIDATION");
      assert.match(body.error, /未知命令/);
    });
  },
);

test(
  "westock exec 拒绝携带文件路径的参数",
  { concurrency: false },
  async () => {
    await withWestockRouter(async (baseUrl) => {
      const response = await postExec(baseUrl, ["quote", "/etc/passwd"], AUTH);
      assert.equal(response.status, 400);
      assert.equal((await response.json()).code, "VALIDATION");
    });
  },
);

test(
  "westock exec 拒绝白名单外的 flag",
  { concurrency: false },
  async () => {
    await withWestockRouter(async (baseUrl) => {
      const response = await postExec(baseUrl, ["quote", "sh600519", "--output", "x"], AUTH);
      assert.equal(response.status, 400);
      const body = await response.json();
      assert.equal(body.code, "VALIDATION");
      assert.match(body.error, /不支持的参数/);
    });
  },
);

test(
  "westock exec 拒绝空 args",
  { concurrency: false },
  async () => {
    await withWestockRouter(async (baseUrl) => {
      const response = await postExec(baseUrl, [], AUTH);
      assert.equal(response.status, 400);
      assert.equal((await response.json()).code, "VALIDATION");
    });
  },
);

test(
  "COMMAND_SPEC 里每个命令构造出的参数都能通过白名单",
  { concurrency: false },
  async () => {
    const full = {
      q: "茅台", keyword: "茅台", code: "sh600519", limit: "10", offset: "0",
      type: "main", market: "hs", period: "day", fq: "qfq", group: "all",
      num: "4", sub: "list", id: "macd_golden", preset: "LowPE",
      expr: "PE_TTM > 0", asset: "stock", date: "2026-09-23",
      start: "2026-09-01", end: "2026-09-23", years: "5", all: "1",
      metric: "CompScore", universe: "hs", orderby: "ROETTM", asc: "1",
      days: "1",
    };
    await withWestockRouter(async (_baseUrl, router) => {
      const entries = Object.entries(router.COMMAND_SPEC);
      assert.ok(entries.length > 0, "COMMAND_SPEC 不应为空");
      for (const [id, spec] of entries) {
        for (const query of [full, { code: "sh600519" }]) {
          const args = router.cleanArgs(spec.build(query));
          assert.doesNotThrow(
            () => realClient.assertSafeArgs(args),
            `命令 ${id} 构造出白名单不接受的参数：${JSON.stringify(args)}`,
          );
        }
      }
    });
  },
);

test(
  "命名接口把 query 映射成正确的 CLI 参数（代码走位置参数）",
  { concurrency: false },
  async () => {
    const calls = [];
    await withWestockRouter(
      async (baseUrl) => {
        const kline = await fetch(
          `${baseUrl}/api/westock/kline?code=sh600519&period=week&limit=50&fq=hfq`,
          { headers: AUTH },
        );
        assert.equal(kline.status, 200);

        const notice = await fetch(`${baseUrl}/api/westock/notice?code=sh600519&limit=5`, {
          headers: AUTH,
        });
        assert.equal(notice.status, 200);

        const fund = await fetch(`${baseUrl}/api/westock/fund?sub=flow&code=sh600519`, {
          headers: AUTH,
        });
        assert.equal(fund.status, 200);

        assert.deepEqual(calls[0], {
          engine: "data",
          args: ["kline", "sh600519", "--period", "week", "--limit", "50", "--fq", "hfq", "--raw"],
        });
        // 代码必须是位置参数：CLI 不认 --code，传了会直接报未知参数退出
        assert.deepEqual(calls[1], {
          engine: "data",
          args: ["notice", "list", "sh600519", "--limit", "5"],
        });
        assert.deepEqual(calls[2], {
          engine: "data",
          args: ["fund", "flow", "sh600519"],
        });
      },
      {
        client: {
          runWestock: async (engine, args) => {
            calls.push({ engine, args });
            return { success: true, engine, args, exitCode: 0, kind: "text", text: "stub" };
          },
        },
      },
    );
  },
);

test(
  "命名接口缺少必要参数时返回 400",
  { concurrency: false },
  async () => {
    await withWestockRouter(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/westock/quote`, { headers: AUTH });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).code, "VALIDATION");
    });
  },
);
