const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { Op } = require("sequelize");

/**
 * 题目 / 分类路由的写入收口。
 *
 * 本文件验证三件事（都是「接口参数最小化」的直接要求）：
 *  1. req.body 不再直通 Sequelize —— id / createdAt 这类非白名单字段进不去；
 *  2. 文本字段传非字符串时返回 400，而不是 `xxx.trim is not a function` 的 500（还会把原始报错回给客户端）；
 *  3. 分类必须真实存在，不建孤儿题目。
 *
 * 数据库与鉴权按项目既有测试做法换成桩：这里测的是路由的参数收口，
 * 不是复测 Sequelize 或 JWT 解析本身。
 */
async function withQuestionRouter(run, options = {}) {
  const paths = {
    auth: require.resolve("../middleware/auth"),
    superAdmin: require.resolve("../middleware/superAdmin"),
    question: require.resolve("../models/question"),
    category: require.resolve("../models/category"),
    database: require.resolve("../config/database"),
    route: require.resolve("../routes/questions"),
  };
  const previous = new Map(
    Object.values(paths).map((path) => [path, require.cache[path]]),
  );
  const put = (path, exports) => {
    require.cache[path] = { id: path, filename: path, loaded: true, exports };
  };

  const calls = { create: [], update: [], findPk: [], list: [], random: [], destroy: [] };
  const categories = options.categories ?? [{ id: 1, name: "前端" }];

  put(paths.auth, {
    authMiddleware: (req, res, next) => {
      if (!req.headers.authorization) {
        return res.status(401).json({ error: "未授权" });
      }
      req.user = { id: 1, role: "admin" };
      next();
    },
  });
  put(paths.superAdmin, {
    adminOnly: (req, res, next) => next(),
    superAdminOnly: (req, res, next) => next(),
  });
  put(paths.database, { random: () => "RAND()" });

  const makeRow = (values) => ({
    ...values,
    update: async function (patch) {
      calls.update.push({ id: this.id, patch: { ...patch } });
      Object.assign(this, patch);
      return this;
    },
    toJSON() {
      return { ...this };
    },
  });

  put(paths.category, {
    findAll: async () => categories,
    findByPk: async (id) => {
      calls.findPk.push({ model: "Category", id });
      const found = categories.find((item) => String(item.id) === String(id));
      return found ? makeRow(found) : null;
    },
    create: async (values) => {
      calls.create.push({ model: "Category", values: { ...values } });
      if (
        categories.some((item) => item.name === values.name) ||
        options.duplicateCategoryName
      ) {
        const error = new Error("Validation error");
        error.name = "SequelizeUniqueConstraintError";
        throw error;
      }
      return makeRow({ id: 99, ...values });
    },
  });

  const questions = options.questions ?? [{ id: 7, title: "旧标题", categoryId: 1 }];
  put(paths.question, {
    findByPk: async (id) => {
      calls.findPk.push({ model: "Question", id });
      const found = questions.find((item) => String(item.id) === String(id));
      return found ? makeRow(found) : null;
    },
    create: async (values) => {
      calls.create.push({ model: "Question", values: { ...values } });
      return makeRow({ id: 100, ...values });
    },
    count: async () => 0,
    findAndCountAll: async (query) => {
      calls.list.push({ limit: query.limit, offset: query.offset });
      return { rows: [], count: options.total ?? 1 };
    },
    findAll: async (query) => {
      calls.random.push({ limit: query.limit });
      return [];
    },
    // Question.destroy 在 Sequelize 里返回「真实删掉的行数」，
    // 批量删除接口正是靠它如实汇报部分成功，所以桩要能模拟少于请求数的情况。
    destroy: async (query) => {
      calls.destroy.push(query);
      const wanted = query.where.id[Op.in];
      const existing = questions.filter((item) => wanted.includes(item.id)).length;
      return options.destroyed ?? existing;
    },
  });

  delete require.cache[paths.route];
  const router = require(paths.route);
  const app = express();
  app.use(express.json());
  app.use("/api/questions", router);
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message });
  });

  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`, calls);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    for (const [path, cached] of previous) {
      if (cached) require.cache[path] = cached;
      else delete require.cache[path];
    }
  }
}

function send(baseUrl, path, method, body) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer test",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("创建题目时只写入白名单字段，id/createdAt 进不去", async () => {
  await withQuestionRouter(async (baseUrl, calls) => {
    const res = await send(baseUrl, "/api/questions", "POST", {
      id: 1,
      createdAt: "1999-01-01T00:00:00.000Z",
      title: "两数之和",
      answer: "哈希表",
      difficulty: "easy",
      categoryId: 1,
      options: ["A", "B"],
      tags: ["数组"],
      updatedAt: "2020-01-01",
    });
    assert.equal(res.status, 201);

    const values = calls.create.find((call) => call.model === "Question").values;
    assert.equal(values.id, undefined, "id 不应被写入");
    assert.equal(values.createdAt, undefined, "createdAt 不应被写入");
    assert.equal(values.updatedAt, undefined, "updatedAt 不应被写入");
    // 白名单内的字段要原样保留（含选项与标签）
    assert.deepEqual(values, {
      title: "两数之和",
      answer: "哈希表",
      difficulty: "easy",
      categoryId: 1,
      options: ["A", "B"],
      tags: ["数组"],
    });
  });
});

test("更新题目时 id 不会跟着进 update（否则等于换行）", async () => {
  await withQuestionRouter(async (baseUrl, calls) => {
    const res = await send(baseUrl, "/api/questions/7", "PUT", {
      id: 42,
      title: "新标题",
      createdAt: "1999-01-01T00:00:00.000Z",
    });
    assert.equal(res.status, 200);

    assert.equal(calls.update.length, 1);
    assert.deepEqual(calls.update[0].patch, { title: "新标题" });
  });
});

test("文本字段传非字符串时返回 400 而不是 500", async () => {
  await withQuestionRouter(async (baseUrl) => {
    const badTitle = await send(baseUrl, "/api/questions", "POST", {
      title: { a: 1 },
      answer: "答案",
      categoryId: 1,
    });
    assert.equal(badTitle.status, 400);
    assert.deepEqual(await badTitle.json(), { error: "题目标题不能为空" });

    const badName = await send(baseUrl, "/api/questions/categories", "POST", {
      name: 123,
    });
    assert.equal(badName.status, 400);
    assert.deepEqual(await badName.json(), { error: "分类名称不能为空" });

    const badUpdateTitle = await send(baseUrl, "/api/questions/7", "PUT", {
      title: ["x"],
    });
    assert.equal(badUpdateTitle.status, 400);
  });
});

test("更新题目时答案不能被清空", async () => {
  await withQuestionRouter(async (baseUrl, calls) => {
    const res = await send(baseUrl, "/api/questions/7", "PUT", {
      answer: "   ",
    });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "题目答案不能为空" });
    assert.equal(calls.update.length, 0, "校验失败不应落库");
  });
});

test("分类必须真实存在：不存在的 categoryId 返回 400", async () => {
  await withQuestionRouter(async (baseUrl, calls) => {
    const res = await send(baseUrl, "/api/questions", "POST", {
      title: "题",
      answer: "答",
      categoryId: 404,
    });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "分类不存在" });
    assert.equal(calls.create.length, 0, "分类不存在时不应建题");
  });
});

test("分类存在时正常创建，且分类名会去掉首尾空白", async () => {
  await withQuestionRouter(async (baseUrl, calls) => {
    const ok = await send(baseUrl, "/api/questions", "POST", {
      title: "题",
      answer: "答",
      categoryId: 1,
    });
    assert.equal(ok.status, 201);

    const category = await send(baseUrl, "/api/questions/categories", "POST", {
      name: "  后端  ",
      description: "服务端",
      id: 77,
    });
    assert.equal(category.status, 201);
    const values = calls.create.find((call) => call.model === "Category").values;
    assert.equal(values.name, "后端");
    assert.equal(values.id, undefined, "分类的 id 也不应被写入");
  });
});

test("未登录时写入接口仍然拒绝", async () => {
  await withQuestionRouter(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/questions/categories`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    });
    assert.equal(res.status, 401);
  });
});

test("分页参数收口：负数 / 非数字 / 超大值都不会拼出非法 SQL", async () => {
  const cases = [
    // [query, 期望的 limit, 期望的 offset]
    ["", 10, 0],
    ["?limit=5&page=3", 5, 10],
    ["?limit=-1", 10, 0],
    ["?page=-1", 10, 0],
    ["?page=abc&limit=abc", 10, 0],
    ["?limit=0", 10, 0],
    ["?limit=99999", 100, 0],
    ["?page=1000&limit=10", 10, 9990],
    ["?page=99999999999999999999", 10, 999990],
  ];
  for (const [query, limit, offset] of cases) {
    await withQuestionRouter(async (baseUrl, calls) => {
      const res = await fetch(`${baseUrl}/api/questions${query}`);
      assert.equal(res.status, 200, `${query} 应返回 200`);
      const body = await res.json();
      assert.deepEqual(calls.list.at(-1), { limit, offset }, `${query} 的 limit/offset`);
      assert.equal(typeof body.totalPages, "number", `${query} 的 totalPages 应为数字`);
    });
  }
});

test("总分页数按收口后的 limit 计算，不会出现 Infinity/null", async () => {
  await withQuestionRouter(
    async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/questions?limit=0`);
      const body = await res.json();
      assert.equal(body.totalPages, 1, "total=1、limit 收口成 10 → 1 页");
    },
    { total: 1 },
  );
});

test("随机抽题数量同样收口：负数与非数字都按 1 处理", async () => {
  for (const [raw, expected] of [
    ["3", 3],
    ["0", 1],
    ["-3", 1],
    ["abc", 1],
    ["999", 50],
  ]) {
    await withQuestionRouter(async (baseUrl, calls) => {
      const res = await fetch(`${baseUrl}/api/questions/random/${raw}`);
      assert.equal(res.status, 200);
      assert.equal(calls.random.at(-1).limit, expected, `/random/${raw}`);
    });
  }
});

/**
 * 批量删除的 N+1 与「如实汇报」门禁。
 *
 * 前端原来勾中 N 道就发 N 个 DELETE /api/questions/:id（Promise.all）。除了 N 个
 * HTTP + N 条 SQL，那里还有个更难看的正确性问题：只要有一个 reject 就整体提示
 * 「批量删除失败」，可前面已经删掉的那些是真删了 —— 管理员重试一次，列表又少几行。
 * 这里把「一次请求 + 返回真实删除数」钉住。
 */
test("批量删除只发一次 destroy，不按 id 逐个删", async (t) => {
  await withQuestionRouter(
    async (baseUrl, calls) => {
      const res = await send(baseUrl, "/api/questions/batch-delete", "POST", {
        ids: [7, 8, 9],
      });
      assert.equal(res.status, 200);
      const body = await res.json();

      assert.equal(calls.destroy.length, 1, "应该只查一次（N+1 门禁）");
      assert.deepEqual(calls.destroy[0].where.id, { [Op.in]: [7, 8, 9] });
      assert.deepEqual(body.data, { requested: 3, deleted: 3 });
      assert.equal(body.message, "删除成功");
    },
    { questions: [{ id: 7 }, { id: 8 }, { id: 9 }] },
  );
});

test("批量删除的 ids 会去重并过滤非法值", async () => {
  await withQuestionRouter(
    async (baseUrl, calls) => {
      const res = await send(baseUrl, "/api/questions/batch-delete", "POST", {
        ids: [7, 7, "abc", -1, 0, 8],
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.deepEqual(calls.destroy[0].where.id, { [Op.in]: [7, 8] });
      assert.equal(body.data.requested, 2);
    },
    { questions: [{ id: 7 }, { id: 8 }] },
  );
});

test("空 ids 返回 400 且不打数据库", async () => {
  for (const ids of [[], ["abc"], [-1], undefined, "1;2;3"]) {
    await withQuestionRouter(async (baseUrl, calls) => {
      const res = await send(baseUrl, "/api/questions/batch-delete", "POST", { ids });
      assert.equal(res.status, 400, `ids=${JSON.stringify(ids)}`);
      assert.equal(calls.destroy.length, 0, `ids=${JSON.stringify(ids)} 不该查库`);
    });
  }
});

test("部分 id 不存在时如实汇报真实删除行数，而不是谎报全成功", async () => {
  await withQuestionRouter(
    async (baseUrl) => {
      const res = await send(baseUrl, "/api/questions/batch-delete", "POST", {
        ids: [7, 8, 9],
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      // 只删掉 1 行 —— 必须让客户端看出「请求 3、实删 1」
      assert.deepEqual(body.data, { requested: 3, deleted: 1 });
      assert.equal(body.message, "已删除 1 道题目");
    },
    { questions: [{ id: 7 }, { id: 8 }, { id: 9 }], destroyed: 1 },
  );
});

test("批量删除仍然要求管理员身份", async () => {
  await withQuestionRouter(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/questions/batch-delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [7] }),
    });
    assert.equal(res.status, 401);
  });
});
