const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { errorHandler } = require("../middleware/errorHandler");
const MusicFavoriteSong = require("../models/musicFavoriteSong");

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

  const calls = { groupFindOne: [], songFindOrCreate: [], bulkCreate: [], destroy: [] };
  // 分组实例：路由删分组时调的是 `group.destroy()`（实例方法），不是模型级的 destroy。
  const group =
    options.group === undefined
      ? {
          id: 7,
          userId: 7,
          destroy: async () => {
            calls.destroy.push({ model: "groupInstance", id: 7 });
          },
        }
      : options.group;

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
    findOrCreate: async ({ defaults }) => [{ id: 99, ...defaults }, false],
  });
  put(paths.song, {
    findAll: async () => options.existing ?? [],
    bulkCreate: async (rows) => {
      calls.bulkCreate.push(rows.map((row) => ({ ...row })));
      if (options.bulkCreateError) throw options.bulkCreateError;
      return rows;
    },
    findOrCreate: async ({ defaults }) => {
      calls.songFindOrCreate.push(defaults);
      if (options.findOrCreateError) throw options.findOrCreateError;
      return [{ id: 99, ...defaults }, true];
    },
    destroy: async (query) => {
      calls.destroy.push({ model: "song", ...query });
      return 1;
    },
  });

  delete require.cache[paths.route];
  const router = require(paths.route);
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use("/api/music-favorites", router);
  // 必须挂**生产用的**那个：路由改成 next(e) 之后，不挂就只会拿到 Express 默认的 500 HTML，
  // 那既钉不住状态码也钉不住「不回显原文」。
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

const post = (base, path, body) =>
  fetch(`${base}/api/music-favorites${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const del = (base, path) =>
  fetch(`${base}/api/music-favorites${path}`, { method: "DELETE" });

/** 造一个序列化后恰好 total 字节的 song（ASCII 填充，字符数 = 字节数）。 */
function songOfBytes(total) {
  const empty = JSON.stringify({ id: "x", pad: "" });
  return { id: "x", pad: "a".repeat(total - empty.length) };
}

/* ---------------------------- 路径参数判据 ---------------------------- */

test("删分组：非数字路径参数返回 404，不再把 NaN 塞进 WHERE 报 500", async () => {
  await withRouter(async (base, calls) => {
    const res = await del(base, "/groups/abc");
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.code, "NOT_FOUND");
    assert.ok(
      !JSON.stringify(body).includes("where clause"),
      "不能把 SQL 片段漏给客户端",
    );
    assert.equal(calls.groupFindOne.length, 0, "非法参数不该查库");
  });
});

test("删分组：`1.5` / `1e3` 这类 parseInt 会读成 1 的写法一律 404", async () => {
  await withRouter(async (base, calls) => {
    for (const raw of ["1.5", "1e3", "7abc", "+7", "-7", "0", " 7"]) {
      const res = await del(base, `/groups/${encodeURIComponent(raw)}`);
      assert.equal(res.status, 404, `/${raw} 应当 404`);
    }
    assert.equal(calls.groupFindOne.length, 0, "这些参数都不该落到查库");
  });
});

test("删分组：超出安全整数范围的 id 返回 404", async () => {
  await withRouter(async (base) => {
    const res = await del(base, "/groups/9007199254740993");
    assert.equal(res.status, 404);
  });
});

test("删分组：合法 id 仍然正常删除（先清歌曲再删分组）", async () => {
  await withRouter(async (base, calls) => {
    const res = await del(base, "/groups/7");
    assert.equal(res.status, 200);
    assert.deepEqual(calls.groupFindOne[0].where, { id: 7, userId: 7 });
    assert.deepEqual(calls.destroy, [
      { model: "song", where: { groupId: 7 } },
      { model: "groupInstance", id: 7 },
    ]);
  });
});

test("单条加歌：非法路径参数同样 404", async () => {
  await withRouter(async (base, calls) => {
    const res = await post(base, "/groups/abc/songs", { song: { id: "s1" } });
    assert.equal(res.status, 404);
    assert.equal(calls.songFindOrCreate.length, 0);
  });
});

test("批量加歌：非法路径参数同样 404", async () => {
  await withRouter(async (base, calls) => {
    const res = await post(base, "/groups/abc/songs/batch", {
      songs: [{ id: "s1" }],
    });
    assert.equal(res.status, 404);
    assert.equal(calls.bulkCreate.length, 0);
  });
});

/* ---------------------------- 异常分发 ---------------------------- */

/** 造一个真实形状的驱动错误：Sequelize 把 mysql2 的原始错误挂在 parent 上。 */
function driverError(code, sqlMessage) {
  const parent = new Error(sqlMessage);
  parent.code = code;
  parent.sqlMessage = sqlMessage;
  const error = new Error(sqlMessage);
  error.name = "SequelizeDatabaseError";
  error.parent = parent;
  error.original = parent;
  return error;
}

test("批量加歌撞上列宽上限：400 且不把驱动原文漏出去", async () => {
  const leaked = "Data too long for column 'songData' at row 1";
  await withRouter(
    async (base) => {
      const res = await post(base, "/groups/7/songs/batch", {
        songs: [{ id: "s1", name: "歌" }],
      });
      assert.equal(res.status, 400, "输入问题不该报 500");
      const body = await res.json();
      assert.equal(body.code, "VALIDATION_ERROR");
      const text = JSON.stringify(body);
      assert.ok(!text.includes("Data too long"), "不能回显驱动原文");
      assert.ok(!text.includes("at row 1"), "不能回显驱动定位信息");
      // 字段名是**有意**保留的：客户端得知道是哪个字段出的问题。
      // 面向调用方的措辞由前置的体积护栏给出（「歌曲数据过大」），不会走到这里。
      assert.match(body.error, /^提交的数据不符合要求/);
    },
    { bulkCreateError: driverError("ER_DATA_TOO_LONG", leaked) },
  );
});

test("批量加歌遇上真正的服务端故障：仍然 500，且文案不外发", async () => {
  await withRouter(
    async (base) => {
      const res = await post(base, "/groups/7/songs/batch", {
        songs: [{ id: "s1" }],
      });
      assert.equal(res.status, 500);
      const body = await res.json();
      assert.equal(body.code, "SERVER_ERROR");
      assert.equal(body.error, "服务器内部错误");
      assert.ok(!JSON.stringify(body).includes("default value"));
    },
    {
      bulkCreateError: driverError(
        "ER_NO_DEFAULT_FOR_FIELD",
        "Field 'songData' doesn't have a default value",
      ),
    },
  );
});

test("单条加歌撞上列宽上限：400 且不把驱动原文漏出去", async () => {
  await withRouter(
    async (base) => {
      const res = await post(base, "/groups/7/songs", {
        song: { id: "s1", name: "歌" },
      });
      assert.equal(res.status, 400);
      const body = await res.json();
      const text = JSON.stringify(body);
      assert.ok(!text.includes("Data too long"), "不能回显驱动原文");
      assert.ok(!text.includes("at row 1"));
      assert.match(body.error, /^提交的数据不符合要求/);
    },
    {
      findOrCreateError: driverError(
        "ER_DATA_TOO_LONG",
        "Data too long for column 'songData' at row 1",
      ),
    },
  );
});

test("单条加歌的唯一冲突仍视为成功（不被新的分发改掉）", async () => {
  const unique = new Error("Validation error");
  unique.name = "SequelizeUniqueConstraintError";
  await withRouter(
    async (base) => {
      const res = await post(base, "/groups/7/songs", { song: { id: "s1" } });
      assert.equal(res.status, 200);
      assert.deepEqual((await res.json()).data, { id: "s1" });
    },
    { findOrCreateError: unique },
  );
});

/* ---------------------------- 体积护栏 ---------------------------- */

test("体积护栏：边界值恰好通过，多 1 字节即 400", async () => {
  const LIMIT = 65535;
  // 先自证这个 helper 确实造出了指定字节数，免得测的是一个错误的边界
  assert.equal(Buffer.byteLength(JSON.stringify(songOfBytes(LIMIT))), LIMIT);
  assert.equal(Buffer.byteLength(JSON.stringify(songOfBytes(LIMIT + 1))), LIMIT + 1);

  await withRouter(async (base, calls) => {
    const ok = await post(base, "/groups/7/songs", { song: songOfBytes(LIMIT) });
    assert.equal(ok.status, 200, "正好等于上限应当通过");

    const tooBig = await post(base, "/groups/7/songs", {
      song: songOfBytes(LIMIT + 1),
    });
    assert.equal(tooBig.status, 400);
    assert.match((await tooBig.json()).error, /过大/);
    assert.equal(calls.songFindOrCreate.length, 1, "超限的那首不该再去写库");
  });
});

test("体积护栏：批量里有一首超限就整条 400，不落库", async () => {
  await withRouter(async (base, calls) => {
    const res = await post(base, "/groups/7/songs/batch", {
      songs: [{ id: "ok" }, songOfBytes(70000)],
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /过大/);
    assert.equal(calls.bulkCreate.length, 0, "不该发出一条注定失败的 INSERT");
  });
});

test("体积护栏按**字节**算，字符数没超但字节超了也要拦", async () => {
  const LIMIT = 65535;
  // 多字节文本字符数未超限但字节数超限，用于验证 TEXT 容量约束。
  const cjk = { id: "x", pad: "汉".repeat(22000) };
  const serialized = JSON.stringify(cjk);
  assert.ok(
    Buffer.byteLength(serialized) > LIMIT,
    `构造的数据应当超过上限，实际 ${Buffer.byteLength(serialized)} 字节`,
  );
  assert.ok(
    serialized.length < LIMIT,
    "字符数必须仍在上限内，否则这条用例证明不了什么",
  );

  await withRouter(async (base, calls) => {
    const res = await post(base, "/groups/7/songs", { song: cjk });
    assert.equal(res.status, 400, "按字节判断才拦得住");
    assert.equal(calls.songFindOrCreate.length, 0);
  });
});

test("体积上限必须与模型 songData 的列类型对得上（防漂移）", () => {
  // 常量写死在路由里，这里钉住它与模型是同一个量级：
  // 换成 MEDIUMTEXT / LONGTEXT 时这条会失败，提醒把 MAX_SONG_DATA_BYTES 一起改。
  const type = MusicFavoriteSong.rawAttributes.songData.type;
  assert.equal(type.key, "TEXT", "songData 不再是 TEXT 了");
  assert.equal(type.options.length, undefined, "TEXT 无长度参数，上限是 65535 字节");
});
