const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { Op } = require("sequelize");

const task = {
  id: "workbuddy-cn",
  name: "WorkBuddy 国内版",
  description: "每日签到领积分",
  timeZone: "Asia/Shanghai",
  credentialFields: [
    { key: "accessToken", label: "Access Token", type: "password", required: true },
    { key: "refreshToken", label: "Refresh Token", type: "password", required: true },
  ],
};

// 未配置凭据的任务：列表里必须显示 configured=false，不能因为同页有已配置任务而误报。
const unconfiguredTask = {
  id: "juejin",
  name: "掘金",
  description: "每日签到 + 免费抽奖",
  timeZone: "Asia/Shanghai",
  executor: "worker",
  credentialFields: [{ key: "cookie", label: "Cookie", type: "textarea", required: true }],
};

function sortRuns(rows) {
  return [...rows].sort((a, b) => b.id - a.id);
}

function escapeLike(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function likeMatcher(pattern) {
  const body = String(pattern)
    .split("%")
    .map(escapeLike)
    .join(".*");
  return new RegExp(`^${body}$`);
}

function matches(row, where) {
  for (const key of Reflect.ownKeys(where)) {
    const cond = where[key];
    if (key === Op.and) {
      if (!cond.every((item) => matches(row, item))) return false;
      continue;
    }
    if (key === Op.or) {
      if (!cond.some((item) => matches(row, item))) return false;
      continue;
    }
    const value = row[key];
    if (cond && typeof cond === "object" && !(cond instanceof Date)) {
      for (const op of Reflect.ownKeys(cond)) {
        const arg = cond[op];
        if (op === Op.like && !likeMatcher(arg).test(String(value))) return false;
        if (op === Op.notLike && likeMatcher(arg).test(String(value))) return false;
        if (op === Op.ne && value === arg) return false;
      }
      continue;
    }
    if (value !== cond) return false;
  }
  return true;
}

async function withRouter(run) {
  const previousSecret = process.env.CRON_SECRET;
  process.env.CRON_SECRET = "test-cron-secret";

  const runRows = [
    {
      id: 8,
      job: "daily-config:workbuddy-cn",
      ownerId: 2,
      success: true,
      durationMs: 0,
      detail: "admin#2 更新凭据",
      createdAt: "2026-11-08T02:00:00.000Z",
    },
    {
      id: 7,
      job: "daily:workbuddy-cn",
      ownerId: 2,
      success: true,
      durationMs: 100,
      detail: "success: 另一个超管完成",
      createdAt: "2026-11-08T01:30:00.000Z",
    },
    {
      id: 6,
      job: "daily:workbuddy-cn",
      ownerId: 1,
      success: false,
      durationMs: 800,
      detail: "failed: 上游超时",
      createdAt: "2026-11-08T01:00:00.000Z",
    },
    {
      id: 5,
      job: "daily-config:workbuddy-cn",
      ownerId: 1,
      success: true,
      durationMs: 0,
      detail: "admin#1 更新凭据",
      createdAt: "2026-11-07T01:00:00.000Z",
    },
    {
      id: 4,
      job: "daily:workbuddy-cn",
      ownerId: 1,
      success: false,
      durationMs: 700,
      detail: "failed: 网络错误",
      createdAt: "2026-11-06T01:00:00.000Z",
    },
    {
      id: 3,
      job: "daily:other-site",
      ownerId: 1,
      success: true,
      durationMs: 300,
      detail: "success: 完成",
      createdAt: "2026-11-05T01:00:00.000Z",
    },
    {
      id: 2,
      job: "daily-config:other-site",
      ownerId: 1,
      success: true,
      durationMs: 0,
      detail: "admin#1 更新凭据",
      createdAt: "2026-11-04T01:00:00.000Z",
    },
    {
      id: 1,
      job: "daily:workbuddy-cn",
      ownerId: 1,
      success: true,
      durationMs: 500,
      detail: "success: 完成",
      createdAt: "2026-11-03T01:00:00.000Z",
    },
  ];
  let nextId = 100;
  const configurations = [];
  const cleared = [];
  const executed = [];
  const toggled = [];
  const globalStates = [];

  const State = {
    async findByPk(id) {
      if (id !== "1:workbuddy-cn") return null;
      return {
        id,
        lastCompletedDate: "2026-11-08",
        leaseUntil: null,
      };
    },
    async findOrCreate({ where, defaults }) {
      const created = { id: where.id, ...defaults };
      globalStates.push(created);
      return [created, true];
    },
    async update() {
      return [0];
    },
  };

  const Run = {
    async create(value) {
      const row = {
        id: nextId++,
        createdAt: new Date().toISOString(),
        ...value,
      };
      runRows.unshift(row);
      return row;
    },
    async findOne({ where }) {
      return sortRuns(runRows.filter((row) => matches(row, where)))[0] || null;
    },
    async findAll({ where, limit, offset }) {
      return sortRuns(runRows.filter((row) => matches(row, where))).slice(
        offset,
        offset + limit,
      );
    },
    async count({ where }) {
      return runRows.filter((row) => matches(row, where)).length;
    },
  };

  const service = {
    configure: async (ownerId, id, value) => {
      configurations.push({ ownerId, id, value });
      return { task: id, ownerId, configured: true };
    },
    clear: async (ownerId, id) => {
      cleared.push({ ownerId, id });
      return { task: id, ownerId, configured: false };
    },
    setEnabled: async (ownerId, id, enabled) => {
      toggled.push({ ownerId, id, enabled });
      return { task: id, ownerId, enabled };
    },
    runOne: async (ownerId, id, options) => {
      executed.push({ ownerId, id, options });
      return {
        success: false,
        results: [
          {
            task: id,
            ownerId,
            status: "failed",
            summary: "上游超时",
            recorded: true,
          },
        ],
      };
    },
    runAll: async () => {
      throw new Error("admin 路由不应触发整轮执行");
    },
  };

  const modules = {
    "../models/dailyTaskState": State,
    "../models/cronRun": Run,
    "../services/daily": {
      tasks: [task, unconfiguredTask],
      globalTasks: [
        {
          id: "stock-digest",
          name: "策略选股日报",
          description: "工作日生成策略报告并发送到每个超管邮箱",
          timeZone: "Asia/Shanghai",
          executor: "global",
          requiresCredentials: false,
          credentialFields: [],
          run: async () => ({
            success: true,
            status: "success",
            summary: "发送 1 封",
          }),
        },
      ],
      dayKey: () => "2026-11-08",
      accountId: (ownerId, taskId) => `${ownerId}:${taskId}`,
      createDailyTaskService: () => service,
    },
    "../middleware/auth": {
      authMiddleware(req, res, next) {
        const authorization = req.headers.authorization;
        if (authorization === "Bearer super") {
          req.user = { id: 1, username: "root", role: "super_admin" };
          return next();
        }
        if (authorization === "Bearer admin") {
          req.user = { id: 2, username: "manager", role: "admin" };
          return next();
        }
        return res.status(401).json({ success: false, error: "未授权" });
      },
    },
    "../middleware/superAdmin": {
      superAdminOnly(req, res, next) {
        if (req.user?.role !== "super_admin")
          return res.status(403).json({ success: false, error: "需要超级管理员权限" });
        next();
      },
    },
  };

  const routerPath = require.resolve("../routes/daily");
  const previous = new Map([[routerPath, require.cache[routerPath]]]);
  for (const [name, exports] of Object.entries(modules)) {
    const path = require.resolve(name);
    previous.set(path, require.cache[path]);
    require.cache[path] = { id: path, filename: path, loaded: true, exports };
  }
  delete require.cache[routerPath];

  const app = express();
  app.use(express.json());
  app.use("/api/daily", require(routerPath));
  app.use((error, req, res, next) => {
    res.status(error.status || 500).json({
      success: false,
      error: error.message,
      code: error.code,
    });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/daily`;
  try {
    await run({
      request: (path, options = {}) =>
        fetch(`${base}${path}`, {
          ...options,
          headers: {
            Authorization: "Bearer super",
            ...(options.headers || {}),
          },
        }),
      runRows,
      configurations,
      cleared,
      executed,
      toggled,
      globalStates,
    });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    for (const [path, value] of previous) {
      if (value) require.cache[path] = value;
      else delete require.cache[path];
    }
    if (previousSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previousSecret;
  }
}

test("超管后台要求登录且只允许超级管理员", async () => {
  await withRouter(async ({ request }) => {
    assert.equal((await request("/admin/tasks", { headers: { Authorization: "" } })).status, 401);
    assert.equal(
      (await request("/admin/tasks", { headers: { Authorization: "Bearer admin" } })).status,
      403,
    );
    assert.equal((await request("/admin/tasks")).status, 200);
  });
});

test("任务列表只返回状态与字段元数据，不泄露凭据", async () => {
  await withRouter(async ({ request }) => {
    const response = await request("/admin/tasks");
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.ok(!text.includes("credentials"));
    const body = JSON.parse(text);
    const item = body.data.items[0];
    assert.equal(item.id, "workbuddy-cn");
    assert.equal(item.configured, true);
    assert.equal(item.ownerId, 1);
    assert.equal(item.todayCompleted, true);
    assert.equal(item.lastRun.id, 6);
    assert.equal(item.lastRun.success, false);
    assert.equal(item.lastRun.durationMs, 800);
    assert.equal(item.lastSuccessAt, "2026-11-03T01:00:00.000Z");
    assert.equal(item.lastFailureAt, "2026-11-08T01:00:00.000Z");
    assert.deepEqual(item.credentialFields, task.credentialFields);

    const unconfigured = body.data.items.find((row) => row.id === "juejin");
    assert.equal(unconfigured.configured, false);
    assert.equal(unconfigured.enabled, true);
  });
});

test("股票日报作为全局任务出现在每日任务列表和执行日志里", async () => {
  await withRouter(async ({ request, runRows }) => {
    runRows.unshift({
      id: 50,
      job: "daily:stock-digest",
      ownerId: null,
      success: true,
      durationMs: 1200,
      detail: "评估 7 批，发送 1 封",
      createdAt: "2026-11-08T02:30:00.000Z",
    });

    const body = await (await request("/admin/tasks")).json();
    const digest = body.data.items.find((item) => item.id === "stock-digest");
    assert.ok(digest, "全局任务必须出现在任务列表");
    assert.equal(digest.requiresCredentials, false);
    assert.equal(digest.executor, "global");
    assert.equal(digest.todayCompleted, true);
    assert.equal(digest.lastRun.detail, "评估 7 批，发送 1 封");

    const all = await (await request("/admin/logs")).json();
    assert.ok(all.data.items.some((row) => row.task === "stock-digest"));

    const filtered = await (await request("/admin/logs?task=stock-digest")).json();
    assert.equal(filtered.data.total, 1);
    assert.equal(filtered.data.items[0].detail, "评估 7 批，发送 1 封");
  });
});

test("全局任务的开关与立即执行走自己的分支，不经过凭据服务", async () => {
  await withRouter(async ({ request, globalStates, executed }) => {
    const put = await request("/admin/tasks/stock-digest/enabled", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(put.status, 200);
    const toggledBody = await put.json();
    assert.equal(toggledBody.data.enabled, false);
    assert.deepEqual(globalStates, [
      {
        id: "1:stock-digest",
        ownerId: 1,
        taskId: "stock-digest",
        credentials: "",
        enabled: false,
      },
    ]);
    assert.equal(executed.length, 0, "全局任务不该被当作凭据任务执行");

    const run = await request("/admin/tasks/stock-digest/run", {
      method: "POST",
    });
    assert.equal(run.status, 200);
    const runBody = await run.json();
    assert.equal(runBody.data.success, true);
    assert.equal(runBody.data.results[0].task, "stock-digest");
    assert.equal(runBody.data.results[0].status, "success");
    assert.equal(runBody.data.results[0].ownerId, null);
  });
});

test("任务开关只接受布尔值，并把状态交给签到服务", async () => {
  await withRouter(async ({ request, toggled }) => {
    const bad = await request("/admin/tasks/workbuddy-cn/enabled", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: "yes" }),
    });
    assert.equal(bad.status, 400);

    const ok = await request("/admin/tasks/workbuddy-cn/enabled", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(toggled, [
      { ownerId: 1, id: "workbuddy-cn", enabled: false },
    ]);
  });
});

test("超管保存凭据并写入审计，响应不回显密钥", async () => {
  await withRouter(async ({ request, configurations, runRows }) => {
    const value = { accessToken: "secret-access", refreshToken: "secret-refresh" };
    const response = await request("/admin/credentials/workbuddy-cn", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(value),
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.ok(!text.includes(value.accessToken) && !text.includes(value.refreshToken));
    assert.deepEqual(configurations, [
      { ownerId: 1, id: "workbuddy-cn", value },
    ]);
    const audit = runRows.find((row) => row.job === "daily-config:workbuddy-cn");
    assert.ok(audit);
    assert.equal(audit.detail, "admin#1 更新凭据");
  });
});

test("超管清除凭据并写入审计", async () => {
  await withRouter(async ({ request, cleared, runRows }) => {
    const response = await request("/admin/credentials/workbuddy-cn", { method: "DELETE" });
    assert.equal(response.status, 200);
    assert.deepEqual(cleared, [{ ownerId: 1, id: "workbuddy-cn" }]);
    const audit = runRows.find((row) => row.detail === "admin#1 清除凭据");
    assert.ok(audit);
    assert.equal(audit.job, "daily-config:workbuddy-cn");
  });
});

test("立即执行只跑指定任务，并原样返回失败原因", async () => {
  await withRouter(async ({ request, executed }) => {
    const response = await request("/admin/tasks/workbuddy-cn/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ force: true }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.success, true);
    assert.equal(body.data.success, false);
    assert.equal(body.data.results[0].status, "failed");
    assert.equal(body.data.results[0].summary, "上游超时");
    assert.deepEqual(executed, [
      { ownerId: 1, id: "workbuddy-cn", options: { force: true } },
    ]);
  });
});

test("执行日志按站点与结果过滤，并排除配置审计", async () => {
  await withRouter(async ({ request }) => {
    const filtered = await request("/admin/logs?task=workbuddy-cn&success=false&limit=1");
    assert.equal(filtered.status, 200);
    const body = await filtered.json();
    assert.equal(body.data.total, 2);
    assert.equal(body.data.items.length, 1);
    assert.equal(body.data.items[0].task, "workbuddy-cn");
    assert.equal(body.data.items[0].success, false);

    const all = await (await request("/admin/logs")).json();
    assert.equal(all.data.total, 4);
    assert.ok(all.data.items.every((item) => !item.task.includes("config")));
  });
});

test("操作记录只读取配置审计任务", async () => {
  await withRouter(async ({ request }) => {
    const response = await request("/admin/audits");
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.data.total, 2);
    assert.ok(body.data.items.every((item) => item.detail.startsWith("admin#1")));
  });
});

test("分页参数非法时返回 400", async () => {
  await withRouter(async ({ request }) => {
    assert.equal((await request("/admin/logs?limit=0")).status, 400);
    assert.equal((await request("/admin/logs?offset=-1")).status, 400);
    assert.equal((await request("/admin/logs?success=maybe")).status, 400);
    assert.equal((await request("/admin/logs?task=bad%20id")).status, 400);
  });
});
