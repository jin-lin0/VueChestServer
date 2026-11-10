const test = require("node:test");
const assert = require("node:assert/strict");
const { Op } = require("sequelize");
const {
  encryptCredentials,
  decryptCredentials,
  encryptionKey,
} = require("../utils/taskCredentials");
const { createDailyTaskService, dayKey } = require("../services/daily");
const workbuddy = require("../services/daily/workbuddy");

const token = (sub = "test-user", nonce = "a") =>
  `e30.${Buffer.from(JSON.stringify({ sub, nonce })).toString("base64url")}.signature`;
const credentials = {
  accessToken: token(),
  refreshToken: "test-refresh-token",
};
function key(t) {
  const previous = process.env.DAILY_ENCRYPTION_KEY;
  process.env.DAILY_ENCRYPTION_KEY = "ab".repeat(32);
  t.after(() => {
    if (previous === undefined) delete process.env.DAILY_ENCRYPTION_KEY;
    else process.env.DAILY_ENCRYPTION_KEY = previous;
  });
}
function reply(data, code = 0, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({ code, data }),
  };
}
async function runProvider(responses, saveCredentials = async () => {}) {
  const calls = [];
  const result = await workbuddy.run({
    credentials,
    signal: new AbortController().signal,
    saveCredentials,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      const next = responses.shift();
      assert.ok(next, `unexpected request ${url}`);
      return next;
    },
  });
  return { result, calls };
}

test("凭据加密具有随机性，并绑定账号和服务；错误密钥或篡改不能解密", (t) => {
  key(t);
  const a = encryptCredentials(credentials, "id", "provider");
  const b = encryptCredentials(credentials, "id", "provider");
  assert.notEqual(a, b);
  assert.ok(!a.includes(credentials.refreshToken));
  assert.deepEqual(decryptCredentials(a, "id", "provider"), credentials);
  assert.throws(() => decryptCredentials(a, "another", "provider"), /无法解密/);
  assert.throws(() => decryptCredentials(a, "id", "another"), /无法解密/);
  const parts = a.split(".");
  const data = Buffer.from(parts[3], "base64");
  data[0] ^= 1;
  parts[3] = data.toString("base64");
  assert.throws(
    () => decryptCredentials(parts.join("."), "id", "provider"),
    /无法解密/,
  );
  process.env.DAILY_ENCRYPTION_KEY = "cd".repeat(32);
  assert.throws(() => decryptCredentials(a, "id", "provider"), /无法解密/);
});

test("缺失和非法加密密钥拒绝保存，不回退为明文", (t) => {
  key(t);
  for (const value of [undefined, "", "short", "zz".repeat(32)]) {
    if (value === undefined) delete process.env.DAILY_ENCRYPTION_KEY;
    else process.env.DAILY_ENCRYPTION_KEY = value;
    assert.throws(encryptionKey, /密钥未配置或格式错误/);
  }
});

test("WorkBuddy 今日已签或活动未开放时，不发领取及活跃请求", async () => {
  for (const state of [
    { active: false },
    { active: true, today_checked_in: true },
  ]) {
    const { result, calls } = await runProvider([reply(state)]);
    assert.equal(calls.length, 1);
    assert.equal(result.status, state.active ? "already_done" : "inactive");
  }
});

test("WorkBuddy 使用真实状态回读确认，且只访问签到相关接口", async () => {
  const { result, calls } = await runProvider([
    reply({ active: true, today_checked_in: false }),
    reply({ credit: 10 }),
    reply({ active: true, today_checked_in: true }),
  ]);
  assert.equal(result.status, "success");
  assert.deepEqual(
    calls.map((c) => new URL(c.url).pathname),
    [
      "/v2/billing/meter/checkin-activity-status",
      "/v2/billing/meter/daily-checkin",
      "/v2/billing/meter/checkin-activity-status",
    ],
  );
  for (const { options } of calls) {
    assert.equal(
      options.headers.Authorization,
      `Bearer ${credentials.accessToken}`,
    );
    assert.equal(options.redirect, "error");
    assert.ok(options.signal instanceof AbortSignal);
  }
});

test("空 200 和未回读确认不能冒充签到成功", async () => {
  await assert.rejects(
    () =>
      runProvider([
        reply({ active: true, today_checked_in: false }),
        reply({}),
        reply({ active: true, today_checked_in: false }),
      ]),
    /尚未确认/,
  );
  await assert.rejects(() => runProvider([reply({})]), /字段不完整/);
});

test("401 续期后先保存新令牌，后续请求使用新 AT", async () => {
  const fresh = {
    accessToken: token("test-user", "new"),
    refreshToken: "rotated-refresh",
  };
  let saved = false;
  const responses = [
    reply({}, 401, 401),
    reply(fresh),
    reply({ active: true, today_checked_in: true }),
  ];
  const calls = [];
  const result = await workbuddy.run({
    credentials,
    signal: new AbortController().signal,
    saveCredentials: async (value) => {
      assert.deepEqual(value, fresh);
      saved = true;
    },
    fetchImpl: async (url, options) => {
      calls.push(url);
      if (calls.length === 3) {
        assert.equal(saved, true);
        assert.equal(
          options.headers.Authorization,
          `Bearer ${fresh.accessToken}`,
        );
      }
      return responses.shift();
    },
  });
  assert.equal(result.status, "already_done");
  assert.equal(
    calls[1],
    "https://copilot.tencent.com/v2/plugin/auth/token/refresh",
  );
});

test("轮换令牌持久化失败时停止，不继续发签到请求", async () => {
  let count = 0;
  await assert.rejects(
    () =>
      workbuddy.run({
        credentials,
        signal: new AbortController().signal,
        saveCredentials: async () => {
          throw new Error("write failed");
        },
        fetchImpl: async () =>
          ++count === 1
            ? reply({}, 401, 401)
            : reply({ accessToken: token(), refreshToken: "new" }),
      }),
    /write failed/,
  );
  assert.equal(count, 2);
});

test("账号受限不刷新、不重试，且错误不回显上游内容", async () => {
  let count = 0;
  await assert.rejects(
    () =>
      workbuddy.run({
        credentials,
        signal: new AbortController().signal,
        saveCredentials: async () => {},
        fetchImpl: async () => {
          count++;
          return reply({ secret: "do-not-log" }, 11140, 403);
        },
      }),
    (error) =>
      error.code === "WORKBUDDY_RESTRICTED" &&
      !error.message.includes("do-not-log"),
  );
  assert.equal(count, 1);
});

test("刷新到不同账号时拒绝保存", async () => {
  await assert.rejects(
    () =>
      runProvider(
        [
          reply({}, 401, 401),
          reply({ accessToken: token("another"), refreshToken: "new" }),
        ],
        () => assert.fail("must not save"),
      ),
    /不同账号/,
  );
});

function matches(row, where) {
  return Reflect.ownKeys(where).every((k) => {
    const value = where[k];
    if (k === Op.and) return value.every((item) => matches(row, item));
    if (k === Op.or) return value.some((item) => matches(row, item));
    if (value && typeof value === "object" && !(value instanceof Date)) {
      if (Op.ne in value) return row[k] !== value[Op.ne];
      if (Op.lte in value)
        return row[k] != null && new Date(row[k]) <= value[Op.lte];
    }
    return row[k] === value;
  });
}
function fixture(run, count = 1) {
  const ownerId = 1;
  const registry = Array.from({ length: count }, (_, i) => ({
    id: String(i),
    timeZone: "Asia/Shanghai",
    run,
    validateCredentials: (v) => v,
  }));
  const rows = Array.from({ length: count }, (_, i) => ({
    id: `${ownerId}:${i}`,
    ownerId,
    taskId: String(i),
    lastCompletedDate: null,
    leaseUntil: null,
    leaseToken: null,
    credentials: encryptCredentials(
      credentials,
      `${ownerId}:${i}`,
      String(i),
    ),
  }));
  const logs = [];
  const State = {
    findOrCreate: async ({ where, defaults }) => {
      const row = rows.find((r) => r.id === where.id);
      if (row) return [row, false];
      const created = {
        id: where.id,
        lastCompletedDate: null,
        leaseUntil: null,
        leaseToken: null,
        ...defaults,
      };
      rows.push(created);
      return [created, true];
    },
    findByPk: async (id) => {
      const row = rows.find((r) => r.id === id);
      return row ? { ...row } : null;
    },
    findAll: async ({ where }) =>
      rows
        .filter((row) => row.taskId === where.taskId)
        .map((row) => ({ ownerId: row.ownerId })),
    update: async (values, { where }) => {
      const matched = rows.filter((row) => matches(row, where));
      matched.forEach((row) => Object.assign(row, values));
      return [matched.length];
    },
    destroy: async ({ where }) => {
      const matched = rows.filter((row) => matches(row, where));
      for (const row of matched) rows.splice(rows.indexOf(row), 1);
      return [matched.length];
    },
  };
  const deps = {
    State,
    Run: {
      create: async (v) => {
        logs.push(v);
      },
    },
    registry,
    notify: async () => {},
  };
  return { rows, logs, deps, service: createDailyTaskService(deps) };
}

test("同日重复触发与并发实例只允许一次账号任务执行", async (t) => {
  key(t);
  let count = 0;
  const f = fixture(async () => {
    count++;
    await new Promise((r) => setTimeout(r, 10));
    return { status: "success", summary: "完成" };
  });
  await Promise.all([
    f.service.runAll(),
    createDailyTaskService(f.deps).runAll(),
  ]);
  await f.service.runAll();
  assert.equal(count, 1);
  assert.equal(f.logs.length, 1);
  assert.equal(f.rows[0].leaseToken, null);
  assert.ok(f.rows[0].lastCompletedDate);
});

test("失败账号不影响其他任务，错误摘要不包含凭据，失败允许重试", async (t) => {
  key(t);
  let count = 0;
  const f = fixture(async () => {
    if (++count === 1) throw new Error(credentials.refreshToken);
    return { status: "success", summary: "完成" };
  }, 2);
  const result = await f.service.runAll();
  assert.equal(result.success, false);
  assert.deepEqual(
    result.results.map((r) => r.status),
    ["failed", "success"],
  );
  assert.ok(!JSON.stringify(f.logs).includes(credentials.refreshToken));
  assert.equal((await f.service.runAll()).success, true);
  assert.equal(count, 3);
});

test("租约覆盖整段单任务超时，执行未结束前不会被并发实例抢占", async (t) => {
  key(t);
  let leaseUntil = 0;
  let holder;
  holder = fixture(async () => {
    leaseUntil = new Date(holder.rows[0].leaseUntil).getTime()
    return { status: "success", summary: "完成" }
  });
  await holder.service.runAll();
  // 默认单任务超时 60s；租约必须比它更长（含固定余量），否则任务没跑完就会过期
  assert.ok(
    leaseUntil - Date.now() > 60000,
    `租约只剩 ${leaseUntil - Date.now()}ms`,
  );
});

test("进程遗留租约到期后可恢复，未到期时不执行", async (t) => {
  key(t);
  let count = 0;
  const f = fixture(async () => {
    count++;
    return { status: "inactive", summary: "未开放" };
  });
  f.rows[0].leaseUntil = new Date(Date.now() + 90000);
  await f.service.runAll();
  assert.equal(count, 0);
  f.rows[0].leaseUntil = new Date(Date.now() - 1);
  await f.service.runAll();
  assert.equal(count, 1);
});

test("超时释放租约，迟到的凭据回写被拒绝", async (t) => {
  key(t);
  let save;
  const f = fixture(async (ctx) => {
    save = ctx.saveCredentials;
    return new Promise(() => {});
  });
  const before = f.rows[0].credentials;
  const result = await createDailyTaskService({ ...f.deps, taskMs: 15 }).runAll();
  assert.equal(result.results[0].status, "failed");
  assert.equal(f.rows[0].leaseToken, null);
  await assert.rejects(() =>
    save({ accessToken: "late", refreshToken: "late" }),
  );
  assert.equal(f.rows[0].credentials, before);
});

test("时间不足显式标记未执行任务，不能返回全部成功", async (t) => {
  key(t);
  const f = fixture(() => assert.fail("not enough time"));
  const result = await createDailyTaskService({
    ...f.deps,
    budgetMs: 100,
  }).runAll();
  assert.equal(result.success, false);
  assert.equal(result.results[0].status, "deferred");
});

test("环境变量可覆盖默认时间预算", async (t) => {
  key(t);
  const previous = process.env.DAILY_BUDGET_MS;
  process.env.DAILY_BUDGET_MS = "100";
  t.after(() => {
    if (previous === undefined) delete process.env.DAILY_BUDGET_MS;
    else process.env.DAILY_BUDGET_MS = previous;
  });
  const f = fixture(() => assert.fail("not enough time"));
  const result = await f.service.runAll();
  assert.equal(result.success, false);
  assert.equal(result.results[0].status, "deferred");
});

test("任务成功但执行记录保存失败时如实报告，不重复签到", async (t) => {
  key(t);
  let count = 0;
  const f = fixture(async () => {
    count++;
    return { status: "success", summary: "完成" };
  });
  f.deps.Run.create = async () => {
    throw new Error("database unavailable");
  };
  const result = await f.service.runAll();
  assert.equal(result.success, false);
  assert.equal(result.results[0].recorded, false);
  await f.service.runAll();
  assert.equal(count, 1);
});

test("完成日期按服务时区计算，而非服务器默认时区", () => {
  assert.equal(
    dayKey(Date.parse("2026-11-03T16:01:00Z"), "Asia/Shanghai"),
    "2026-11-04",
  );
});

test("租约归属改变后不能覆盖新执行者的凭据或释放其租约", async (t) => {
  key(t);
  let f;
  f = fixture(async ({ saveCredentials }) => {
    f.rows[0].leaseToken = "new-owner";
    await saveCredentials({ accessToken: "new", refreshToken: "new" });
    return { status: "success", summary: "完成" };
  });
  const before = f.rows[0].credentials;
  const result = await f.service.runAll();
  assert.equal(result.success, false);
  assert.equal(f.rows[0].leaseToken, "new-owner");
  assert.equal(f.rows[0].credentials, before);
  assert.equal(f.rows[0].lastCompletedDate, null);
});

test("领取时失效，续期后发现今日已签就不再次领取", async () => {
  const fresh = { accessToken: token("test-user", "new"), refreshToken: "new" };
  const { result, calls } = await runProvider([
    reply({ active: true, today_checked_in: false }),
    reply({}, 401, 401),
    reply(fresh),
    reply({ active: true, today_checked_in: true }),
    reply({ active: true, today_checked_in: true }),
  ]);
  assert.equal(result.status, "success");
  assert.equal(calls.filter((c) => c.url.endsWith("/daily-checkin")).length, 1);
});

test("第二天直接读取数据库中轮换后的令牌", async (t) => {
  key(t);
  const fresh = {
    accessToken: "rotated-access",
    refreshToken: "rotated-refresh",
  };
  const seen = [];
  const f = fixture(async ({ credentials: value, saveCredentials }) => {
    seen.push(value);
    await saveCredentials(fresh);
    return { status: "success", summary: "完成" };
  });
  let date = Date.parse("2026-11-03T01:00:00Z");
  const service = createDailyTaskService({ ...f.deps, now: () => date });
  await service.runAll();
  date += 86400000;
  await service.runAll();
  assert.deepEqual(seen, [credentials, fresh]);
});

test("重新录入凭据后，当日也可重新核对上游", async (t) => {
  key(t);
  const seen = [];
  const f = fixture(async ({ credentials: value }) => {
    seen.push(value);
    return { status: "success", summary: "完成" };
  });
  await f.service.runAll();
  const changed = {
    accessToken: "relogin-access",
    refreshToken: "relogin-refresh",
  };
  await f.service.configure(1, "0", changed);
  await f.service.runAll();
  assert.deepEqual(seen, [credentials, changed]);
});

test("未录入凭据的个人任务直接跳过，不要求加密密钥", async (t) => {
  key(t);
  const f = fixture(() => assert.fail("not configured"));
  delete process.env.DAILY_ENCRYPTION_KEY;
  f.rows.splice(0);
  f.deps.State.findOrCreate = () => assert.fail("must not access storage");
  const result = await f.service.runAll();
  assert.equal(result.success, true);
  assert.equal(result.results[0].status, "unconfigured");
});

test("首次录入按服务保存密文，响应只有状态；未知服务不能创建记录", async (t) => {
  key(t);
  const f = fixture(() => assert.fail("只录入，不执行"));
  f.rows.splice(0);
  assert.deepEqual(await f.service.configure(1, "0", credentials), {
    task: "0",
    ownerId: 1,
    configured: true,
  });
  assert.equal(f.rows.length, 1);
  assert.ok(!f.rows[0].credentials.includes(credentials.refreshToken));
  assert.deepEqual(
    decryptCredentials(f.rows[0].credentials, "1:0", "0"),
    credentials,
  );
  await assert.rejects(
    () => f.service.configure(1, "unknown", credentials),
    (e) => e.status === 400,
  );
  assert.equal(f.rows.length, 1);
});

test("录入凭据不覆盖运行中的任务；租约过期后重新录入使旧租约失效", async (t) => {
  key(t);
  const f = fixture(() => assert.fail("只录入，不执行"));
  const before = f.rows[0].credentials;
  f.rows[0].leaseToken = "old-owner";
  f.rows[0].leaseUntil = new Date(Date.now() + 90000);
  await assert.rejects(
    () => f.service.configure(1, "0", credentials),
    (e) => e.status === 409,
  );
  assert.equal(f.rows[0].credentials, before);
  f.rows[0].leaseUntil = new Date(Date.now() - 1);
  f.rows[0].lastCompletedDate = "2026-11-03";
  await f.service.configure(1, "0", credentials);
  assert.equal(f.rows[0].leaseToken, null);
  assert.equal(f.rows[0].leaseUntil, null);
  assert.equal(f.rows[0].lastCompletedDate, null);
});

test("加密密钥缺失时不写入凭据，不生成明文记录", async (t) => {
  key(t);
  const f = fixture(() => assert.fail());
  f.rows.splice(0);
  delete process.env.DAILY_ENCRYPTION_KEY;
  await assert.rejects(
    () => f.service.configure(1, "0", credentials),
    /密钥未配置/,
  );
  assert.equal(f.rows.length, 0);
});

test("适配器额外返回的凭据字段不进入执行响应", async (t) => {
  key(t);
  const f = fixture(async () => ({
    status: "success",
    summary: "完成",
    credentials,
  }));
  const result = await f.service.runAll();
  assert.equal(result.results[0].status, "success");
  assert.equal(result.results[0].credentials, undefined);
  assert.ok(!JSON.stringify(result).includes(credentials.refreshToken));
});

test("立即执行只跑指定任务；force 可忽略当日幂等但仍受租约保护", async (t) => {
  key(t);
  let count = 0;
  const f = fixture(async () => {
    count++;
    return { status: "success", summary: "完成" };
  }, 2);
  f.rows[0].lastCompletedDate = dayKey(Date.now(), "Asia/Shanghai");

  const skipped = await f.service.runOne(1, "0");
  assert.equal(skipped.results[0].status, "skipped");
  assert.equal(count, 0);

  const forced = await f.service.runOne(1, "0", { force: true });
  assert.equal(forced.success, true);
  assert.equal(forced.results[0].status, "success");
  assert.equal(count, 1);
  assert.equal(f.rows[1].lastCompletedDate, null);

  f.rows[0].leaseUntil = new Date(Date.now() + 90000);
  const busy = await f.service.runOne(1, "0", { force: true });
  assert.equal(busy.success, true);
  assert.equal(busy.results[0].status, "skipped");
  assert.equal(count, 1);
});

test("清除凭据删除配置记录；执行中拒绝清除；未知任务报 400", async (t) => {
  key(t);
  const f = fixture(() => assert.fail("只清除，不执行"));
  f.rows[0].leaseUntil = new Date(Date.now() + 90000);
  await assert.rejects(
    () => f.service.clear(1, "0"),
    (error) => error.status === 409 && error.code === "DAILY_BUSY",
  );
  assert.equal(f.rows.length, 1);

  f.rows[0].leaseUntil = new Date(Date.now() - 1);
  assert.deepEqual(await f.service.clear(1, "0"), {
    task: "0",
    ownerId: 1,
    configured: false,
  });
  assert.equal(f.rows.length, 0);
  assert.deepEqual(await f.service.clear(1, "0"), {
    task: "0",
    ownerId: 1,
    configured: false,
  });
  await assert.rejects(
    () => f.service.clear(1, "unknown"),
    (error) => error.status === 400,
  );
});

test("同一站点的多个超管凭据互相隔离，定时轮次逐个执行", async (t) => {
  key(t);
  const seen = [];
  const f = fixture(async ({ credentials: value }) => {
    seen.push(value.accessToken);
    return { status: "success", summary: "完成" };
  });
  const otherCredentials = {
    accessToken: token("second-owner", "b"),
    refreshToken: "second-refresh",
  };
  f.rows.push({
    id: "2:0",
    ownerId: 2,
    taskId: "0",
    lastCompletedDate: null,
    leaseUntil: null,
    leaseToken: null,
    credentials: encryptCredentials(otherCredentials, "2:0", "0"),
  });

  const result = await f.service.runAll();
  assert.equal(result.success, true);
  assert.deepEqual(
    result.results.map((item) => item.ownerId),
    [1, 2],
  );
  assert.deepEqual(seen.sort(), [
    credentials.accessToken,
    otherCredentials.accessToken,
  ].sort());

  const changed = {
    accessToken: token("second-owner", "c"),
    refreshToken: "rotated-second",
  };
  await f.service.configure(2, "0", changed);
  assert.deepEqual(
    decryptCredentials(f.rows[1].credentials, "2:0", "0"),
    changed,
  );
  assert.deepEqual(
    decryptCredentials(f.rows[0].credentials, "1:0", "0"),
    credentials,
  );

  await f.service.clear(1, "0");
  assert.equal(f.rows.length, 1);
  assert.equal(f.rows[0].ownerId, 2);
});
