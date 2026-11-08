const test = require("node:test");
const assert = require("node:assert/strict");
const { encryptCredentials } = require("../utils/checkinCredentials");
const { createCheckinService, dayKey } = require("../services/checkins");
const juejin = require("../services/checkins/juejin");

const OWNER = 2;
const COOKIE = "sessionid=abc123; sid_tt=abc123";

function key(t) {
  const previous = process.env.CHECKIN_ENCRYPTION_KEY;
  process.env.CHECKIN_ENCRYPTION_KEY = "ab".repeat(32);
  t.after(() => {
    if (previous === undefined) delete process.env.CHECKIN_ENCRYPTION_KEY;
    else process.env.CHECKIN_ENCRYPTION_KEY = previous;
  });
}

function fixture(t, { serverRuns } = {}) {
  key(t);
  const registry = [
    {
      id: "server-task",
      timeZone: "Asia/Shanghai",
      run: async () => {
        if (serverRuns) serverRuns.count += 1;
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
  const State = {
    findByPk: async (id) => rows.find((row) => row.id === id) || null,
    findAll: async ({ where }) =>
      rows
        .filter((row) => row.taskId === where.taskId)
        .map((row) => ({ ownerId: row.ownerId })),
    update: async (values, { where }) => {
      const row = rows.find((item) => item.id === where.id);
      if (!row) return [0];
      Object.assign(row, values);
      return [1];
    },
  };
  const deps = {
    State,
    Run: {
      create: async (value) => {
        logs.push(value);
      },
    },
    registry,
  };
  return { rows, logs, deps, service: createCheckinService(deps) };
}

test("worker 任务可以读到自己的凭据，服务器任务被拒绝", async (t) => {
  const f = fixture(t);
  const data = await f.service.workerCredentials(OWNER, "juejin");
  assert.deepEqual(data.credentials, { cookie: COOKIE });

  await assert.rejects(
    () => f.service.workerCredentials(OWNER, "server-task"),
    (error) => error.code === "CHECKIN_NOT_WORKER_TASK",
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
    (error) => error.code === "CHECKIN_UNCONFIGURED" && error.status === 404,
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
    (error) => error.code === "CHECKIN_OWNER_REQUIRED",
  );

  const accounts = await f.service.workerAccounts("juejin");
  assert.deepEqual(accounts.ownerIds, [2, 3]);
});

test("服务器任务没有 worker 账号列表", async (t) => {
  const f = fixture(t);
  await assert.rejects(
    () => f.service.workerAccounts("server-task"),
    (error) => error.code === "CHECKIN_NOT_WORKER_TASK",
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
  assert.equal(f.logs[0].job, "checkin:juejin");
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
});

test("非法状态或给服务器任务上报都会被拒绝", async (t) => {
  const f = fixture(t);
  await assert.rejects(
    () => f.service.report(OWNER, "juejin", { status: "done", summary: "x" }),
    (error) => error.code === "INVALID_CHECKIN_STATUS",
  );
  await assert.rejects(
    () => f.service.report(OWNER, "server-task", { status: "success" }),
    (error) => error.code === "CHECKIN_NOT_WORKER_TASK",
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
    (error) => error.code === "CHECKIN_REQUIRES_WORKER",
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
