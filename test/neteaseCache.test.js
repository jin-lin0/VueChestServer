const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");

const { errorHandler } = require("../middleware/errorHandler");

/** routes/netease.js 里的单条上限，改它必须同时改这里（下面的用例会因此变红）。 */
const CACHE_MAX_VALUE_BYTES = 512 * 1024;

/** 静默失败路径上的服务端日志，避免正常跑测试时刷屏。 */
function silenceConsoleError() {
  const original = console.error;
  console.error = () => {};
  return () => {
    console.error = original;
  };
}

/** 把某个模块换成桩并强制重载，沿用 test/upstreamProxyRateLimit.test.js 的写法。 */
async function withStubs(modules, reload, run) {
  const previous = new Map();
  for (const key of [...Object.keys(modules), ...reload]) {
    const path = require.resolve(key);
    previous.set(path, require.cache[path]);
    delete require.cache[path];
  }
  for (const [key, exports] of Object.entries(modules)) {
    const path = require.resolve(key);
    require.cache[path] = { id: path, filename: path, loaded: true, exports };
  }

  const app = express();
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    await run(app, base);
  } finally {
    // 先断开悬挂请求，避免失败用例阻塞 server.close。
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    for (const [path, cached] of previous) {
      if (cached) require.cache[path] = cached;
      else delete require.cache[path];
    }
  }
}

/** 记录上游方法及参数；responder 返回 body 或 reject，也可异步挂起请求。 */
async function withNeteaseRouter(responder, run) {
  const calls = [];
  const upstream = new Proxy(
    {},
    {
      get(_target, name) {
        if (typeof name !== "string") return undefined;
        return async (params = {}) => {
          calls.push({ name, params });
          const outcome = await responder(name, params, calls.length);
          if (outcome && Object.hasOwn(outcome, "reject")) throw outcome.reject;
          return { status: 200, body: outcome?.body, cookie: [] };
        };
      },
    },
  );

  await withStubs({ NeteaseCloudMusicApi: upstream }, ["../routes/netease"], async (app, base) => {
    // 挂真实的全局错误处理，验证「上游失败 → 502 + 稳定文案」这条对外契约
    app.use("/api/netease", require("../routes/netease"));
    app.use(errorHandler);
    await run({
      base,
      calls,
      count: (name) => calls.filter((call) => call.name === name).length,
      names: () => calls.map((call) => call.name),
      last: () => calls[calls.length - 1],
    });
  });
}

const get = (base, path) => fetch(base + path);
const json = async (promise) => (await promise).json();

test("同一个可缓存接口连续请求两次：上游只被打一次，两次响应完全一致", async () => {
  await withNeteaseRouter(
    () => ({ body: { result: { playlists: [{ id: 1 }] } } }),
    async ({ base, count }) => {
      const first = await get(base, "/api/netease/personalized?limit=12");
      const second = await get(base, "/api/netease/personalized?limit=12");
      assert.equal(first.status, 200);
      assert.equal(second.status, 200);
      assert.deepEqual(await first.json(), { result: { playlists: [{ id: 1 }] } });
      assert.deepEqual(await second.json(), { result: { playlists: [{ id: 1 }] } });
      assert.equal(count("personalized"), 1, "第二次必须命中缓存");
    },
  );
});

test("不同参数算不同 key：limit 变了就要重新打上游，且不会串数据", async () => {
  await withNeteaseRouter(
    (_name, params) => ({ body: { limit: params.limit } }),
    async ({ base, count }) => {
      assert.deepEqual(await json(get(base, "/api/netease/personalized?limit=12")), { limit: 12 });
      assert.deepEqual(await json(get(base, "/api/netease/personalized?limit=18")), { limit: 18 });
      assert.equal(count("personalized"), 2, "参数不同不应共用缓存条目");
      // 再各来一次，确认两条各自命中
      await get(base, "/api/netease/personalized?limit=12");
      await get(base, "/api/netease/personalized?limit=18");
      assert.equal(count("personalized"), 2);
    },
  );
});

test("缓存 key 带上游方法名：两个都是「无参数」的接口不能互相返回对方的数据", async () => {
  // 这条防的是「key 只由 params 算」：toplist 与 search/hot 的 params 都是 {}，
  // 少了方法名前缀，第二个接口会直接命中第一个的缓存 —— 页面不报错，只是数据全错。
  await withNeteaseRouter(
    (name) => ({ body: { from: name } }),
    async ({ base, names }) => {
      assert.deepEqual(await json(get(base, "/api/netease/toplist")), { from: "toplist_detail" });
      assert.deepEqual(await json(get(base, "/api/netease/search/hot")), {
        from: "search_hot_detail",
      });
      assert.deepEqual(names(), ["toplist_detail", "search_hot_detail"]);
    },
  );
});

test("同 key 并发未命中只打一次上游，且所有调用方拿到同一份数据", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let held = false;
  await withNeteaseRouter(
    async () => {
      // 只把第一次调用挂住：如果并发没被合并，第 2、3 次会立刻返回，下面的断言就会看到 count=3
      if (!held) {
        held = true;
        await gate;
      }
      return { body: { index: 1 } };
    },
    async ({ base, count }) => {
      const requests = [
        get(base, "/api/netease/toplist"),
        get(base, "/api/netease/toplist"),
        get(base, "/api/netease/toplist"),
      ];
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(count("toplist_detail"), 1, "三次并发请求只应打一次上游");
      release();
      for (const response of await Promise.all(requests)) {
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { index: 1 });
      }
      assert.equal(count("toplist_detail"), 1);
    },
  );
});

test("签名/带时效的 song_url 绝不缓存", async () => {
  await withNeteaseRouter(
    (_name, params, nth) => ({ body: { url: `https://cdn/${params.id}?token=${nth}` } }),
    async ({ base, count }) => {
      assert.equal(
        (await json(get(base, "/api/netease/song/url?id=1&br=320000"))).url,
        "https://cdn/1?token=1",
      );
      assert.equal(
        (await json(get(base, "/api/netease/song/url?id=1&br=320000"))).url,
        "https://cdn/1?token=2",
        "第二次必须重新取，不能复用旧链接",
      );
      assert.equal(count("song_url"), 2);
    },
  );
});

test("search 与 search/suggest 不缓存（关键字基数无上限 / 随输入逐字变化）", async () => {
  await withNeteaseRouter(
    (name, params, nth) => ({ body: { name, keywords: params.keywords, nth } }),
    async ({ base, count }) => {
      await get(base, "/api/netease/search?keywords=abc");
      await get(base, "/api/netease/search?keywords=abc");
      await get(base, "/api/netease/search/suggest?keywords=abc");
      await get(base, "/api/netease/search/suggest?keywords=abc");
      assert.equal(count("cloudsearch"), 2);
      assert.equal(count("search_suggest"), 2);
    },
  );
});

test("上游失败回 502 + 稳定文案，不把上游状态码当成客户端错误", async () => {
  const restore = silenceConsoleError();
  try {
    await withNeteaseRouter(
      (name) =>
        name === "toplist_detail"
          ? { reject: { status: 400, body: { code: 400, msg: "内部错误" } } }
          : { body: { ok: true } },
      async ({ base }) => {
        const response = await get(base, "/api/netease/toplist");
        assert.equal(response.status, 502, "上游的毛病不能以 4xx 回给调用方");
        const body = await response.json();
        assert.equal(body.success, false);
        assert.equal(body.code, "UPSTREAM_ERROR");
        assert.equal(body.error, "音乐服务暂时不可用，请稍后重试");
        assert.ok(!JSON.stringify(body).includes("内部错误"), "上游原文不得外发");
      },
    );
  } finally {
    restore();
  }
});

test("上游超时用 504 + UPSTREAM_TIMEOUT，与普通失败区分开", async () => {
  const restore = silenceConsoleError();
  try {
    await withNeteaseRouter(
      () => ({ reject: { status: 504, body: { code: 504 } } }),
      async ({ base }) => {
        const response = await get(base, "/api/netease/playlist/catlist");
        assert.equal(response.status, 504);
        assert.equal((await response.json()).code, "UPSTREAM_TIMEOUT");
      },
    );
  } finally {
    restore();
  }
});

test("失败结果不进缓存：上游恢复后立刻能拿到数据", async () => {
  const restore = silenceConsoleError();
  try {
    let fail = true;
    await withNeteaseRouter(
      () => (fail ? { reject: { status: 502, body: { code: 502 } } } : { body: { ok: true } }),
      async ({ base, count }) => {
        assert.equal((await get(base, "/api/netease/toplist")).status, 502);
        fail = false;
        const good = await get(base, "/api/netease/toplist");
        assert.equal(good.status, 200);
        assert.deepEqual(await good.json(), { ok: true });
        assert.equal(count("toplist_detail"), 2, "第二次必须真的重试上游");
      },
    );
  } finally {
    restore();
  }
});

test("单个接口失败不影响其他接口的缓存", async () => {
  const restore = silenceConsoleError();
  try {
    await withNeteaseRouter(
      (name) => (name === "artists" ? { reject: { status: 500 } } : { body: { from: name } }),
      async ({ base }) => {
        await get(base, "/api/netease/artist?id=1");
        assert.deepEqual(await json(get(base, "/api/netease/personalized?limit=12")), {
          from: "personalized",
        });
      },
    );
  } finally {
    restore();
  }
});

test("超过上限的大响应不入缓存（仍然照常完整返回给调用方）", async () => {
  await withNeteaseRouter(
    (name, _params, nth) => ({
      body: { name, nth, blob: "x".repeat(CACHE_MAX_VALUE_BYTES + 1024) },
    }),
    async ({ base, count }) => {
      const first = await json(get(base, "/api/netease/top/song?type=0"));
      const second = await json(get(base, "/api/netease/top/song?type=0"));
      assert.equal(first.blob.length, CACHE_MAX_VALUE_BYTES + 1024, "超大响应必须完整返回");
      assert.equal(second.blob.length, CACHE_MAX_VALUE_BYTES + 1024);
      assert.notEqual(first.nth, second.nth, "第二次必须重新打上游（说明没进缓存）");
      assert.equal(count("top_song"), 2);
    },
  );
});

test("383KB 级的响应仍然缓存（新歌速递实测就是这么大，不能把它挡在缓存外）", async () => {
  // 使用较大的目录响应验证缓存容量边界。
  const REAL_TOP_SONG_BYTES = 383 * 1024;
  await withNeteaseRouter(
    (_name, _params, nth) => ({ body: { nth, blob: "x".repeat(REAL_TOP_SONG_BYTES - 200) } }),
    async ({ base, count }) => {
      const first = await json(get(base, "/api/netease/top/song?type=0"));
      const second = await json(get(base, "/api/netease/top/song?type=0"));
      assert.equal(second.nth, first.nth, "383KB 级的响应必须命中缓存");
      assert.equal(count("top_song"), 1);
    },
  );
});

test("缺必填参数直接 400，不打上游", async () => {
  await withNeteaseRouter(
    () => ({ body: {} }),
    async ({ base, calls }) => {
      assert.equal((await get(base, "/api/netease/song/url")).status, 400);
      assert.equal(calls.length, 0, "参数校验失败不应消耗上游请求");
    },
  );
});
