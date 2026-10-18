const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { errorHandler } = require("../middleware/errorHandler");
const { Op } = require("sequelize");

async function withRouter(run, options = {}) {
  const paths = {
    auth: require.resolve("../middleware/auth"),
    group: require.resolve("../models/musicFavoriteGroup"),
    song: require.resolve("../models/musicFavoriteSong"),
    route: require.resolve("../routes/musicFavorites"),
  };
  const previous = new Map(
    Object.values(paths).map((path) => [path, require.cache[path]]),
  );
  const put = (path, exports) => {
    require.cache[path] = { id: path, filename: path, loaded: true, exports };
  };

  const calls = { groupFindOne: [], songFindAll: [], bulkCreate: [] };
  const group = options.group === undefined ? { id: 3, userId: 7 } : options.group;

  put(paths.auth, {
    authMiddleware: (req, res, next) => {
      req.user = { id: options.userId ?? 7, role: "user" };
      next();
    },
  });
  put(paths.group, {
    findOne: async (query) => {
      calls.groupFindOne.push(query);
      return group;
    },
    findAll: async () => [],
    findOrCreate: async ({ defaults }) => [{ id: 99, ...defaults }, true],
  });
  put(paths.song, {
    findAll: async (query) => {
      calls.songFindAll.push(query);
      return options.existing ?? [];
    },
    bulkCreate: async (rows) => {
      calls.bulkCreate.push(rows.map((row) => ({ ...row })));
      if (options.bulkCreateError) throw options.bulkCreateError;
      return rows;
    },
    findOrCreate: async () => [null, false],
  });

  delete require.cache[paths.route];
  const router = require(paths.route);
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use("/api/music-favorites", router);
  // 使用真实错误中间件验证状态码及脱敏响应。
  app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));

  try {
    const base = `http://127.0.0.1:${server.address().port}`;
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

function postBatch(base, body, groupId = 3) {
  return fetch(`${base}/api/music-favorites/groups/${groupId}/songs/batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const song = (id) => ({ id, name: `歌 ${id}`, artists: "某人" });

test("批量加歌：N 首只发 3 次查询，且一次 IN 覆盖全部 songId", async () => {
  const songs = Array.from({ length: 40 }, (_, index) => song(`s${index + 1}`));
  await withRouter(async (base, calls) => {
    const res = await postBatch(base, { songs });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.data, { requested: 40, added: 40, skipped: 0 });

    assert.equal(calls.groupFindOne.length, 1, "分组归属只查一次");
    assert.equal(calls.songFindAll.length, 1, "已存在探测只查一次（原来每首 2 次往返）");
    assert.equal(calls.bulkCreate.length, 1, "只发一条 INSERT");
    assert.deepEqual(
      calls.songFindAll[0].where.songId[Op.in].length,
      40,
      "一次 IN 必须覆盖全部 songId",
    );
    // 探测必须限定在本分组内：否则「别的分组里已有这首」会被当成「这个分组里已有」，
    // 于是少插一条 —— 收藏静默丢失，结果还全是 200。
    assert.equal(
      calls.songFindAll[0].where.groupId,
      3,
      "已存在探测必须带 groupId",
    );
    assert.equal(calls.bulkCreate[0].length, 40);
    assert.equal(
      calls.songFindAll[0].attributes.includes("songId"),
      true,
      "探测只取 songId，不要把 songData 整列拉回来",
    );
  });
});

test("批量加歌：只插缺少的那几首，已存在的算 skipped", async () => {
  await withRouter(
    async (base, calls) => {
      const res = await postBatch(base, { songs: [song("a"), song("b"), song("c")] });
      const body = await res.json();
      assert.deepEqual(body.data, { requested: 3, added: 1, skipped: 2 });
      assert.deepEqual(
        calls.bulkCreate[0].map((row) => row.songId),
        ["c"],
      );
    },
    { existing: [{ songId: "a" }, { songId: "b" }] },
  );
});

test("批量加歌：全部已存在时不发 INSERT", async () => {
  await withRouter(
    async (base, calls) => {
      const res = await postBatch(base, { songs: [song("a")] });
      const body = await res.json();
      assert.deepEqual(body.data, { requested: 1, added: 0, skipped: 1 });
      assert.equal(calls.bulkCreate.length, 0, "没有新增就不该发 INSERT");
    },
    { existing: [{ songId: "a" }] },
  );
});

test("批量加歌：同一次请求里重复的 songId 去重，只写一行", async () => {
  await withRouter(async (base, calls) => {
    const res = await postBatch(base, { songs: [song("a"), song("a"), song("b")] });
    const body = await res.json();
    assert.deepEqual(body.data, { requested: 2, added: 2, skipped: 0 });
    assert.deepEqual(
      calls.bulkCreate[0].map((row) => row.songId),
      ["a", "b"],
    );
  });
});

test("批量加歌：脏项被逐项丢掉，不会带着 null songId 进 SQL", async () => {
  await withRouter(async (base, calls) => {
    const res = await postBatch(base, {
      songs: [
        song("ok"),
        null,
        undefined,
        "不是对象",
        42,
        [song("数组")],
        { name: "没有 id" },
        { id: null },
        { id: "" },
        { id: "   " },
        { id: "x".repeat(65) },
      ],
    });
    const body = await res.json();
    assert.deepEqual(body.data, { requested: 1, added: 1, skipped: 0 });
    assert.deepEqual(
      calls.bulkCreate[0].map((row) => row.songId),
      ["ok"],
      "只有合法项能落库",
    );
  });
});

test("批量加歌：songId 正好 64 位仍然收（边界不误伤）", async () => {
  await withRouter(async (base, calls) => {
    const id = "x".repeat(64);
    const res = await postBatch(base, { songs: [{ id }] });
    const body = await res.json();
    assert.deepEqual(body.data, { requested: 1, added: 1, skipped: 0 });
    assert.equal(calls.bulkCreate[0][0].songId, id);
  });
});

test("批量加歌：超过 MAX_BATCH_SONGS 的部分被截断，避免超大请求写进库", async () => {
  const songs = Array.from({ length: 260 }, (_, index) => song(`s${index}`));
  await withRouter(async (base, calls) => {
    const res = await postBatch(base, { songs });
    const body = await res.json();
    assert.equal(body.data.requested, 200, "单次上限 200");
    assert.equal(calls.bulkCreate[0].length, 200);
  });
});

test("批量加歌：songs 不是数组返回 400，而不是 500", async () => {
  for (const bad of [{}, "abc", 42, null, undefined, [1, 2][0]]) {
    await withRouter(async (base, calls) => {
      const res = await postBatch(base, { songs: bad });
      assert.equal(res.status, 400, `songs=${JSON.stringify(bad)} 必须 400`);
      const body = await res.json();
      assert.equal(body.code, "VALIDATION");
      assert.equal(calls.bulkCreate.length, 0);
      assert.equal(calls.songFindAll.length, 0);
    });
  }
});

test("批量加歌：数组里全是不合法项返回 400，不空跑一条 INSERT", async () => {
  await withRouter(async (base, calls) => {
    const res = await postBatch(base, { songs: [null, {}, { id: "" }] });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, "VALIDATION");
    assert.equal(calls.bulkCreate.length, 0);
  });
});

test("批量加歌：分组不属于当前用户返回 404，且不写库", async () => {
  await withRouter(
    async (base, calls) => {
      const res = await postBatch(base, { songs: [song("a")] });
      assert.equal(res.status, 404);
      assert.equal((await res.json()).code, "NOT_FOUND");
      assert.deepEqual(calls.groupFindOne[0].where, { id: 3, userId: 7 });
      assert.equal(calls.songFindAll.length, 0);
      assert.equal(calls.bulkCreate.length, 0);
    },
    { group: null },
  );
});

test("批量加歌：分组 id 不是正整数返回 404，而不是把 NaN 塞进 SQL 变成 500", async () => {
  for (const bad of ["abc", "0", "-1", "1.5", "1e3"]) {
    await withRouter(async (base, calls) => {
      const res = await postBatch(base, { songs: [song("a")] }, bad);
      assert.equal(res.status, 404, `群组 id=${bad} 必须 404`);
      assert.equal(calls.groupFindOne.length, 0, "非法 id 不该到达查询");
      assert.equal(calls.bulkCreate.length, 0);
    });
  }
});

test("批量加歌：并发撞唯一索引时如实报 added=0（整条 INSERT 被回滚）", async () => {
  const error = new Error("Duplicate entry");
  error.name = "SequelizeUniqueConstraintError";
  await withRouter(
    async (base, calls) => {
      const res = await postBatch(base, { songs: [song("a"), song("b")] });
      assert.equal(res.status, 200, "并发冲突不该把迁移整体打成 500");
      assert.deepEqual(await res.json(), {
        success: true,
        data: { requested: 2, added: 0, skipped: 2 },
      });
      assert.equal(calls.bulkCreate.length, 1, "不应重试出第二条 INSERT");
    },
    { bulkCreateError: error },
  );
});

test("批量加歌：真正的数据库错误仍然 500，不被当成并发冲突吞掉", async () => {
  const error = new Error("Field 'songData' doesn't have a default value");
  error.name = "SequelizeDatabaseError";
  await withRouter(
    async (base) => {
      const res = await postBatch(base, { songs: [song("a")] });
      assert.equal(res.status, 500);
      assert.equal((await res.json()).code, "SERVER_ERROR");
    },
    { bulkCreateError: error },
  );
});

test("批量加歌：插入的行都带上 groupId / userId / songData（不漏字段）", async () => {
  await withRouter(async (base, calls) => {
    await postBatch(base, { songs: [song("a")] });
    const row = calls.bulkCreate[0][0];
    assert.equal(row.groupId, 3);
    assert.equal(row.userId, 7);
    assert.equal(row.songId, "a");
    assert.deepEqual(row.songData, song("a"));
  });
});

test("批量加歌：songData 直接存对象（模型的 setter 负责序列化，路由不要自己 JSON.stringify）", async () => {
  await withRouter(async (base, calls) => {
    await postBatch(base, { songs: [song("a")] });
    assert.equal(typeof calls.bulkCreate[0][0].songData, "object");
  });
});
