const test = require("node:test");
const assert = require("node:assert/strict");
const { encryptCredentials } = require("../utils/taskCredentials");
const { createDailyTaskService, dayKey } = require("../services/daily");
const juejin = require("../services/daily/juejin");

const OWNER = 2;
const COOKIE = "sessionid=abc123; sid_tt=abc123";

function key(t) {
  const previous = process.env.DAILY_ENCRYPTION_KEY;
  process.env.DAILY_ENCRYPTION_KEY = "ab".repeat(32);
  t.after(() => {
    if (previous === undefined) delete process.env.DAILY_ENCRYPTION_KEY;
    else process.env.DAILY_ENCRYPTION_KEY = previous;
  });
}

function fixture(t, { serverRuns, serverFails } = {}) {
  key(t);
  const registry = [
    {
      id: "server-task",
      timeZone: "Asia/Shanghai",
      name: "服务器任务",
      run: async () => {
        if (serverRuns) serverRuns.count += 1;
        if (serverFails) throw new Error("token 已过期");
        return { status: "success", summary: "完成" };
      },
      validateCredentials: (value) => value,
    },
    juejin,
  ];
  const rows = [
    {
      id: `${OWNER}:server-task`,
      ownerId: OWNER,
      taskId: "server-task",
      credentials: encryptCredentials(
        { token: "x" },
        `${OWNER}:server-task`,
        "server-task",
      ),
      lastCompletedDate: null,
      leaseToken: null,
      leaseUntil: null,
    },
    {
      id: `${OWNER}:juejin`,
      ownerId: OWNER,
      taskId: "juejin",
      credentials: encryptCredentials(
        { cookie: COOKIE },
        `${OWNER}:juejin`,
        "juejin",
      ),
      lastCompletedDate: null,
      leaseToken: null,
      leaseUntil: null,
    },
  ];
  const logs = [];
  const alerts = [];
  const State = {
    findByPk: async (id) => rows.find((row) => row.id === id) || null,
    findAll: async ({ where }) =>
      rows
        .filter((row) => row.taskId === where.taskId)
        .map((row) => ({ ownerId: row.ownerId, enabled: row.enabled })),
    update: async (values, { where }) => {
      const row = rows.find((item) => item.id === where.id);
      if (!row) return [0];
      Object.assign(row, values);
      return [1];
    },
  };
  const deps = {
    State,
    notify: async (payload) => {
      alerts.push(payload);
    },
    Run: {
      create: async (value) => {
        logs.push(value);
      },
    },
    registry,
  };
  return { rows, logs, alerts, deps, service: createDailyTaskService(deps) };
}

test("worker 任务可以读到自己的凭据，服务器任务被拒绝", async (t) => {
  const f = fixture(t);
  const data = await f.service.workerCredentials(OWNER, "juejin");
  assert.deepEqual(data.credentials, { cookie: COOKIE });

  await assert.rejects(
    () => f.service.workerCredentials(OWNER, "server-task"),
    (error) => error.code === "DAILY_NOT_WORKER_TASK",
  );
});

test("未配置凭据时 worker 拿到明确的 404 语义", async (t) => {
  const f = fixture(t);
  f.rows.splice(
    f.rows.findIndex((row) => row.taskId === "juejin"),
    1,
  );
  await assert.rejects(
    () => f.service.workerCredentials(OWNER, "juejin"),
    (error) => error.code === "DAILY_UNCONFIGURED" && error.status === 404,
  );
});

test("只有一个超管配置掘金时，worker 无需传 ownerId", async (t) => {
  const f = fixture(t);
  const data = await f.service.workerCredentials("", "juejin");
  assert.equal(data.ownerId, OWNER);
  assert.deepEqual(data.credentials, { cookie: COOKIE });

  await f.service.report(undefined, "juejin", { status: "success", summary: "签到成功" });
  assert.equal(f.logs[0].ownerId, OWNER);
});

test("多个超管都配置了掘金时要求显式指定 ownerId", async (t) => {
  const f = fixture(t);
  f.rows.push({
    id: "3:juejin",
    ownerId: 3,
    taskId: "juejin",
    credentials: encryptCredentials({ cookie: COOKIE }, "3:juejin", "juejin"),
    lastCompletedDate: null,
    leaseToken: null,
    leaseUntil: null,
  });
  await assert.rejects(
    () => f.service.report(undefined, "juejin", { status: "success" }),
    (error) => error.code === "DAILY_OWNER_REQUIRED",
  );

  const accounts = await f.service.workerAccounts("juejin");
  assert.deepEqual(accounts.ownerIds, [2, 3]);
});

test("服务器任务没有 worker 账号列表", async (t) => {
  const f = fixture(t);
  await assert.rejects(
    () => f.service.workerAccounts("server-task"),
    (error) => error.code === "DAILY_NOT_WORKER_TASK",
  );
});

test("成功上报写入执行日志并标记当日完成，失败只记日志", async (t) => {
  const f = fixture(t);
  const today = dayKey(Date.now(), "Asia/Shanghai");

  await f.service.report(OWNER, "juejin", {
    status: "success",
    summary: "签到成功，+5 矿石",
    durationMs: 12345,
  });
  assert.equal(f.logs.length, 1);
  assert.equal(f.logs[0].job, "daily:juejin");
  assert.equal(f.logs[0].ownerId, OWNER);
  assert.equal(f.logs[0].success, true);
  assert.equal(f.logs[0].durationMs, 12345);
  assert.match(f.logs[0].detail, /^success: /);
  assert.equal(
    f.rows.find((row) => row.taskId === "juejin").lastCompletedDate,
    today,
  );

  await f.service.report(OWNER, "juejin", {
    status: "failed",
    summary: "Cookie 已失效",
  });
  assert.equal(f.logs[1].success, false);
  assert.equal(f.logs[1].durationMs, 0);
  assert.match(f.logs[1].detail, /Cookie 已失效/);
  assert.equal(f.alerts.length, 1);
  assert.equal(f.alerts[0].ownerId, OWNER);
  assert.match(f.alerts[0].summary, /Cookie 已失效/);
});

test("服务器任务失败时只告警一次，成功不告警", async (t) => {
  const ok = fixture(t);
  await ok.service.runOne(OWNER, "server-task");
  assert.equal(ok.alerts.length, 0);

  const bad = fixture(t, { serverFails: true });
  const result = await bad.service.runOne(OWNER, "server-task");
  assert.equal(result.success, false);
  assert.equal(bad.alerts.length, 1);
  assert.equal(bad.alerts[0].task.id, "server-task");
  // 对外只发安全摘要，不把上游原始错误（可能含地址/令牌）写进邮件
  assert.match(bad.alerts[0].summary, /任务执行失败/);
});

test("非法状态或给服务器任务上报都会被拒绝", async (t) => {
  const f = fixture(t);
  await assert.rejects(
    () => f.service.report(OWNER, "juejin", { status: "done", summary: "x" }),
    (error) => error.code === "INVALID_DAILY_STATUS",
  );
  await assert.rejects(
    () => f.service.report(OWNER, "server-task", { status: "success" }),
    (error) => error.code === "DAILY_NOT_WORKER_TASK",
  );
});

test("定时轮次跳过 worker 任务，也不会把它们当成本地配置执行", async (t) => {
  const serverRuns = { count: 0 };
  const f = fixture(t, { serverRuns });
  const result = await f.service.runAll();
  assert.equal(serverRuns.count, 1);
  assert.deepEqual(
    result.results.map((item) => item.task),
    ["server-task"],
  );
});

test("管理员不能直接运行 worker 任务", async (t) => {
  const f = fixture(t);
  await assert.rejects(
    () => f.service.runOne(OWNER, "juejin"),
    (error) => error.code === "DAILY_REQUIRES_WORKER",
  );
});

test("暂停后定时轮次和 worker 账号列表都跳过，手动执行仍然放行", async (t) => {
  const serverRuns = { count: 0 };
  const f = fixture(t, { serverRuns });

  await f.service.setEnabled(OWNER, "server-task", false);
  assert.equal(f.rows.find((row) => row.taskId === "server-task").enabled, false);
  assert.deepEqual(await f.service.runAll().then((r) => r.results), []);
  assert.equal(serverRuns.count, 0);

  const manual = await f.service.runOne(OWNER, "server-task");
  assert.equal(manual.success, true);
  assert.equal(serverRuns.count, 1);

  await f.service.setEnabled(OWNER, "juejin", false);
  assert.deepEqual(await f.service.workerAccounts("juejin"), {
    task: "juejin",
    ownerIds: [],
  });

  await f.service.setEnabled(OWNER, "server-task", true);
  assert.deepEqual(
    await f.service.runAll().then((r) => r.results.map((item) => item.task)),
    ["server-task"],
  );
});

test("未配置凭据的任务不能直接开启开关", async (t) => {
  const f = fixture(t);
  f.rows.splice(
    f.rows.findIndex((row) => row.taskId === "juejin"),
    1,
  );
  await assert.rejects(
    () => f.service.setEnabled(OWNER, "juejin", true),
    (error) => error.code === "DAILY_UNCONFIGURED",
  );
});

test("掘金凭据允许只粘 sessionid 裸值，并拒绝换行注入", () => {
  assert.deepEqual(juejin.validateCredentials({ cookie: "abc123" }), {
    cookie: "sessionid=abc123",
  });
  assert.deepEqual(juejin.validateCredentials({ cookie: " a=1; sessionid=abc " }), {
    cookie: "a=1; sessionid=abc",
  });
  assert.throws(
    () => juejin.validateCredentials({ cookie: "uid=1" }),
    /缺少 sessionid/,
  );
  assert.throws(
    () => juejin.validateCredentials({ cookie: "sessionid=abc\nX-Evil: 1" }),
    /格式不正确/,
  );
});
