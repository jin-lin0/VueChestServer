const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { errorHandler } = require("../middleware/errorHandler");
const { Op } = require("sequelize");

/**
 * 音乐收藏「读取全部收藏组」的查询次数收口。
 *
 * 背景：GET /api/music-favorites/groups 原来是
 *   1 次 findOrCreate(默认组) + 1 次 findAll(分组) + N 次 findAll(各分组的歌曲)，
 * 即「3 + N」次**串行**往返。数据库在远端（热态约 47ms/次，见 config/database.js），
 * 分 5 组就是 ≈280ms 的白等。
 *
 * 本文件钉住三件事：
 *  1. 查询数固定为 2（分组一次 + 歌曲一次），不随分组数增长；
 *  2. 歌曲是按 groupId 归桶的、顺序与「逐组查询」完全一致（id ASC）；
 *  3. 默认组的补建只在**真的没有默认组**时发生，不再每次请求都白跑一次 SELECT。
 *
 * 数据库与鉴权按项目既有做法换成 require.cache 桩：这里测的是查询形状，
 * 不是复测 Sequelize / JWT。
 */
async function withMusicFavoritesRouter(run, options = {}) {
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

  const calls = { groupFindAll: [], findOrCreate: [], songFindAll: [] };

  const groups = options.groups ?? [
    { id: 1, name: "我的喜欢", isDefault: true },
    { id: 2, name: "通勤", isDefault: false },
  ];
  // songRows 用「已经是 getter 输出」的形态：songData 是对象或 null（解析失败）。
  const songRows = options.songRows ?? [
    { groupId: 1, songData: { id: "a", name: "A" } },
    { groupId: 1, songData: { id: "b", name: "B" } },
    { groupId: 2, songData: { id: "c", name: "C" } },
  ];

  put(paths.auth, {
    authMiddleware: (req, res, next) => {
      req.user = { id: options.userId ?? 7, role: "user" };
      next();
    },
  });

  put(paths.group, {
    findAll: async (query) => {
      calls.groupFindAll.push(query);
      return options.groupFindAll ?? groups;
    },
    findOrCreate: async (query) => {
      calls.findOrCreate.push(query);
      const created = {
        id: options.createdDefaultId ?? 42,
        name: query.defaults.name,
        isDefault: true,
      };
      return [created, true];
    },
  });

  put(paths.song, {
    findAll: async (query) => {
      calls.songFindAll.push(query);
      return options.songFindAll ?? songRows;
    },
  });

  delete require.cache[paths.route];
  const router = require(paths.route);
  const app = express();
  app.use(express.json());
  app.use("/api/music-favorites", router);
  // 挂**生产用的**错误处理器：路由现在把未预期的异常交给 next(e) 统一分发，
  // 不挂就只能落到 Express 默认处理器（500 + HTML），钉不住「不回显驱动原文」这条契约。
  app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));

  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    await run({ base, calls });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    for (const [path, cached] of previous) {
      if (cached === undefined) delete require.cache[path];
      else require.cache[path] = cached;
    }
    // 路由模块本身必须清掉，否则后续用例会拿到这一轮的桩。
    delete require.cache[paths.route];
  }
}

async function getGroups(base) {
  const res = await fetch(`${base}/api/music-favorites/groups`);
  return { status: res.status, body: await res.json() };
}

test("读取收藏组：查询数固定为 2，不随分组数增长", async () => {
  const many = Array.from({ length: 6 }, (_, index) => ({
    id: index + 1,
    name: `分组 ${index + 1}`,
    isDefault: index === 0,
  }));
  await withMusicFavoritesRouter(
    async ({ base, calls }) => {
      const { status, body } = await getGroups(base);
      assert.equal(status, 200);
      assert.equal(body.data.length, 6);

      assert.equal(calls.groupFindAll.length, 1, "分组只应查一次");
      assert.equal(calls.songFindAll.length, 1, "歌曲只应查一次（原来每分组一次）");

      const where = calls.songFindAll[0].where;
      assert.deepEqual(
        where.groupId[Op.in],
        [1, 2, 3, 4, 5, 6],
        "一次查询必须覆盖全部分组 id",
      );
    },
    { groups: many, groupFindAll: many },
  );
});

test("读取收藏组：歌曲按 groupId 归桶，组内顺序与逐组查询一致（id ASC）", async () => {
  await withMusicFavoritesRouter(async ({ base }) => {
    const { body } = await getGroups(base);
    assert.deepEqual(
      body.data.map((group) => group.id),
      [1, 2],
      "默认组排最前（isDefault DESC, id ASC）",
    );
    assert.deepEqual(body.data[0].songs, [
      { id: "a", name: "A" },
      { id: "b", name: "B" },
    ]);
    assert.deepEqual(body.data[1].songs, [{ id: "c", name: "C" }]);
  });
});

test("读取收藏组：空分组返回 songs: []，不塌成 undefined", async () => {
  await withMusicFavoritesRouter(
    async ({ base }) => {
      const { body } = await getGroups(base);
      assert.deepEqual(body.data[0].songs, [{ id: "a", name: "A" }]);
      assert.deepEqual(body.data[1].songs, []);
    },
    {
      songRows: [{ groupId: 1, songData: { id: "a", name: "A" } }],
    },
  );
});

test("读取收藏组：songData 解析失败（getter 返回 null）的歌曲被丢弃", async () => {
  await withMusicFavoritesRouter(
    async ({ base }) => {
      const { body } = await getGroups(base);
      assert.deepEqual(body.data[0].songs, [{ id: "b", name: "B" }]);
    },
    {
      songRows: [
        { groupId: 1, songData: null },
        { groupId: 1, songData: { id: "b", name: "B" } },
      ],
    },
  );
});

test("读取收藏组：已有默认组时不再补建（省掉每次请求的重复 SELECT）", async () => {
  await withMusicFavoritesRouter(async ({ base, calls }) => {
    await getGroups(base);
    assert.equal(
      calls.findOrCreate.length,
      0,
      "默认组已存在就不应再 findOrCreate",
    );
  });
});

test("读取收藏组：确实没有默认组时才补建，且补建的默认组排在最前", async () => {
  const noDefault = [{ id: 5, name: "通勤", isDefault: false }];
  await withMusicFavoritesRouter(
    async ({ base, calls }) => {
      const { body } = await getGroups(base);
      assert.equal(calls.findOrCreate.length, 1, "缺默认组时必须补建一次");
      assert.deepEqual(
        calls.findOrCreate[0].where,
        { userId: 7, isDefault: true },
        "补建必须限定在同一个用户的默认组上",
      );
      assert.deepEqual(
        body.data.map((group) => group.id),
        [42, 5],
        "补建的默认组要排在最前",
      );
      assert.deepEqual(body.data[0].songs, [], "新组还没有歌");
    },
    { groups: noDefault, groupFindAll: noDefault },
  );
});

test("读取收藏组：一个分组都没有时补建默认组，并只发一次以它为范围的歌曲查询", async () => {
  await withMusicFavoritesRouter(
    async ({ base, calls }) => {
      const { body } = await getGroups(base);
      assert.equal(calls.songFindAll.length, 1);
      assert.deepEqual(calls.songFindAll[0].where.groupId[Op.in], [42]);
      assert.deepEqual(body.data, [
        { id: 42, name: "我的喜欢", isDefault: true, songs: [] },
      ]);
    },
    { groups: [], groupFindAll: [] },
  );
});

test("读取收藏组：查询必须限定在 userId 上（不能读到别人的收藏）", async () => {
  await withMusicFavoritesRouter(async ({ base, calls }) => {
    await getGroups(base);
    assert.deepEqual(calls.groupFindAll[0].where, { userId: 7 });
  });
});
