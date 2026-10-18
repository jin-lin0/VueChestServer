const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { errorHandler } = require("../middleware/errorHandler");

// 本装置的响应标识；失败信息里用它区分「响应来自本装置」与「落到了别的服务器」。
const HARNESS_MARK = "app-data-harness";
// 当前正在用的端口（测试在文件内是顺序执行的，用它给失败信息定位）。
let currentPort = 0;

async function withRouter(run, options = {}) {
  const paths = {
    auth: require.resolve("../middleware/auth"),
    model: require.resolve("../models/appData"),
    user: require.resolve("../models/user"),
    route: require.resolve("../routes/appData"),
  };
  const previous = new Map(
    Object.values(paths).map((path) => [path, require.cache[path]]),
  );
  const put = (path, exports) => {
    require.cache[path] = { id: path, filename: path, loaded: true, exports };
  };

  const calls = { count: [], findAll: [], findOne: [], create: [], update: [], destroy: [], locks: [] };
  const rows = new Map();
  let transactionQueue = Promise.resolve();
  const makeRow = (where, value) => ({
    dataKey: where.dataKey,
    value,
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    update: async (values, query) => {
      calls.update.push(values);
      assert.ok(query.transaction, "覆盖也必须留在同一事务内");
      if (options.stateful) rows.set(where.dataKey, values.value);
    },
  });
  put(paths.user, {
    findByPk: async (id, query) => {
      calls.locks.push({ id, ...query });
      assert.equal(query.lock, query.transaction.LOCK.UPDATE);
      return { id };
    },
  });

  put(paths.auth, {
    authMiddleware: (req, res, next) => {
      req.user = { id: options.userId ?? 7, role: "user" };
      next();
    },
  });
  put(paths.model, {
    sequelize: {
      transaction: (run) => {
        const task = transactionQueue.then(() => run({ LOCK: { UPDATE: "UPDATE" } }));
        transactionQueue = task.catch(() => {});
        return task;
      },
    },
    count: async (query) => {
      calls.count.push(query);
      if (options.countError) throw options.countError;
      return (options.keysBeforeCreate ?? 0) + (options.stateful ? rows.size : 0);
    },
    findAll: async (query) => {
      calls.findAll.push(query);
      return options.rows ?? [];
    },
    findOne: async (query) => {
      calls.findOne.push(query);
      if (!query.transaction) return options.row ?? null;
      if (options.created === false || rows.has(query.where.dataKey)) {
        return makeRow(query.where, rows.get(query.where.dataKey));
      }
      return null;
    },
    create: async (data, query) => {
      calls.create.push(data);
      assert.ok(query.transaction, "新增必须留在同一事务内");
      if (options.stateful) rows.set(data.dataKey, data.value);
      return makeRow(data, data.value);
    },
    destroy: async (query) => {
      calls.destroy.push(query);
      return 1;
    },
  });

  delete require.cache[paths.route];
  const router = require(paths.route);
  const app = express();
  // 打上本进程的标识：偶发失败时用它区分「响应确实来自本装置」还是「落到了别的服务器」。
  app.use((req, res, next) => {
    res.setHeader("x-harness", HARNESS_MARK);
    next();
  });
  app.use(express.json({ limit: "2mb" }));
  app.use("/api/app-data", router);
  app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1");

  // 监听完成后再读取端口，并确保失败路径关闭服务器。
  try {
    await new Promise((resolve) => server.once("listening", resolve));
    currentPort = server.address().port;
    const base = `http://127.0.0.1:${currentPort}/api/app-data`;
    await run(base, calls);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    for (const [path, cached] of previous) {
      if (cached === undefined) delete require.cache[path];
      else require.cache[path] = cached;
    }
    delete require.cache[paths.route];
  }
}

/** 断言失败时同时报告响应体和测试服务标识，帮助定位响应来源。 */
async function expectStatus(res, want, message) {
  const body = await res.text();
  const who = res.headers.get("x-harness");
  const origin = who === HARNESS_MARK ? "本装置" : `⚠ 非本装置（x-harness=${who}）`;
  assert.equal(
    res.status,
    want,
    `${message ? message + "；" : ""}期望 ${want}，实际 ${res.status}；` +
      `端口=${currentPort} 来源=${origin}；响应体=${body.slice(0, 200)}`,
  );
  return body;
}

const getJson = (base, path) => fetch(base + path);
const putJson = (base, path, value) =>
  fetch(base + path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value }),
  });

/* --------------------------- 应用 id 判据 --------------------------- */

test("应用 id：小数 / 科学计数 / 带后缀一律 400，不再被 parseInt 截成另一个应用", async () => {
  // 这三种在原实现里分别被读成 1、1、1，然后安安静静地去读写 app 1 的数据。
  for (const bad of ["1.5", "1e3", "1abc", "12px"]) {
    await withRouter(async (base, calls) => {
      const res = await getJson(base, `/${bad}`);
      await expectStatus(res, 400, `${bad} 应当 400，实际 ${res.status}`);
      // 关键：压根不能碰数据库
      assert.deepEqual(calls.findAll, [], `${bad} 不该查库`);
      assert.deepEqual(calls.count, [], `${bad} 不该查配额`);
    });
  }
});

test("应用 id：0 / 负数 / 空 / 超出安全整数一律 400", async () => {
  for (const bad of ["0", "-1", "007", "9007199254740993", "1".repeat(30)]) {
    await withRouter(async (base, calls) => {
      const res = await getJson(base, `/${bad}`);
      await expectStatus(res, 400, `${bad} 应当 400，实际 ${res.status}`);
      assert.deepEqual(calls.findAll, []);
    });
  }
});

test("应用 id：合法值原样进 WHERE，且是数字不是字符串", async () => {
  await withRouter(async (base, calls) => {
    const res = await getJson(base, "/12");
    await expectStatus(res, 200);
    assert.equal(calls.findAll.length, 1);
    assert.deepEqual(calls.findAll[0].where, { userId: 7, appId: 12 });
    assert.equal(typeof calls.findAll[0].where.appId, "number");
  });
});

test("收口覆盖全部四个 handler：GET 单体 / PUT / DELETE 也走同一判据", async () => {
  await withRouter(async (base, calls) => {
    const get = await getJson(base, "/1.5/k");
    await expectStatus(get, 400);
    assert.deepEqual(calls.findOne, []);

    const put = await putJson(base, "/1.5/k", 1);
    await expectStatus(put, 400);
    assert.deepEqual(calls.create, []);

    const del = await fetch(base + "/1.5/k", { method: "DELETE" });
    await expectStatus(del, 400);
    assert.deepEqual(calls.destroy, []);

    // 同一个坏 appId 下，key 合法也没用
    const badKey = await putJson(base, "/1.5/" + "k".repeat(121), 1);
    await expectStatus(badKey, 400);
  });
});

test("键名本身的上限仍然生效（120 字符）", async () => {
  await withRouter(async (base, calls) => {
    const res = await putJson(base, "/12/" + "k".repeat(121), 1);
    await expectStatus(res, 400);
    assert.deepEqual(calls.create, []);
  });
});

/* ----------------------------- 键数量配额 ----------------------------- */

test("新增键刚好到上限（第 200 个）仍然放行", async () => {
  await withRouter(
    async (base, calls) => {
      const res = await putJson(base, "/12/progress", 42);
      await expectStatus(res, 200);
      assert.deepEqual(calls.destroy, [], "不该回滚");
    },
    { created: true, keysBeforeCreate: 199 },
  );
});

test("新增键超出上限：409 + 稳定 code，不创建临时记录", async () => {
  await withRouter(
    async (base, calls) => {
      const res = await putJson(base, "/12/overflow", 1);
      const body = JSON.parse(await expectStatus(res, 409));
      assert.equal(body.code, "APP_DATA_QUOTA_EXCEEDED");
      assert.match(body.error, /200/);
      // 不能既报错又把行留在库里
      assert.deepEqual(calls.destroy, [], "超额时不能靠删除一条已经可见的记录补救");
      assert.deepEqual(calls.create, [], "配额判定应在新增之前");
      // 也不该顺手去写值
      assert.deepEqual(calls.update, []);
    },
    { created: true, keysBeforeCreate: 200 },
  );
});

test("覆盖已有的键不占额度：满额时仍能更新，且不去数一遍", async () => {
  await withRouter(
    async (base, calls) => {
      const res = await putJson(base, "/12/progress", 99);
      await expectStatus(res, 200);
      assert.deepEqual(calls.update, [{ value: "99" }]);
      // 覆盖路径不该付一次额外的 count 往返
      assert.deepEqual(calls.count, [], "覆盖已有键时不应查配额");
      assert.deepEqual(calls.destroy, []);
    },
    { created: false, keysBeforeCreate: 999 },
  );
});

test("配额是按 (用户, 应用) 计的，查询条件必须带上 userId", async () => {
  await withRouter(
    async (base, calls) => {
      await putJson(base, "/12/k", 1);
      assert.deepEqual(calls.count[0].where, { userId: 7, appId: 12 });
    },
    { created: true, keysBeforeCreate: 0 },
  );
});

test("单条过大仍是 413（与配额的 409 区分开，调用方才知道该改什么）", async () => {
  await withRouter(async (base, calls) => {
    const res = await putJson(base, "/12/big", "a".repeat(200001));
    await expectStatus(res, 413);
    assert.deepEqual(calls.create, [], "超限的数据不该先落库再拒绝");
  });
});

test("单条数据边界：恰好 200000 字符放行", async () => {
  await withRouter(async (base, calls) => {
    // JSON.stringify("a".repeat(n)) 的长度是 n + 2（两端的引号）
    const res = await putJson(base, "/12/edge", "a".repeat(199998));
    await expectStatus(res, 200);
    assert.equal(calls.create.length, 1);
  });
});

test("只剩一个名额时并发新增不会超额，且不会删掉成功的键", async () => {
  await withRouter(async (base, calls) => {
    const responses = await Promise.all([
      putJson(base, "/12/first", 1),
      putJson(base, "/12/second", 2),
    ]);
    assert.deepEqual(responses.map((res) => res.status).sort(), [200, 409]);
    assert.equal(calls.create.length, 1);
    assert.deepEqual(calls.destroy, []);
    assert.equal(calls.locks.length, 2);
    assert.equal(calls.locks[0].id, 7);
    assert.equal(calls.findOne[0].transaction, calls.locks[0].transaction);
    assert.equal(calls.count[0].transaction, calls.locks[0].transaction);
  }, { stateful: true, keysBeforeCreate: 199 });
});

test("满额时并发写同一个新键都应拒绝，不能先报成功再被另一请求删掉", async () => {
  await withRouter(async (base, calls) => {
    const responses = await Promise.all([putJson(base, "/12/new", 1), putJson(base, "/12/new", 2)]);
    assert.deepEqual(responses.map((res) => res.status), [409, 409]);
    assert.deepEqual(calls.create, []);
    assert.deepEqual(calls.destroy, []);
  }, { stateful: true, keysBeforeCreate: 200 });
});

test("配额查询失败不能留下先创建的半截数据", async () => {
  await withRouter(async (base, calls) => {
    const response = await putJson(base, "/12/new", 1);
    assert.equal(response.status, 500);
    assert.deepEqual(calls.create, []);
  }, { countError: new Error("计数暂时失败") });
});
