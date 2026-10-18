const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { errorHandler } = require("../middleware/errorHandler");

const ROUTE_CACHE_KEYS = {
  bilibili: {
    mount: "/api/bilibili",
    auth: "../middleware/auth",
    route: "../routes/bilibili",
  },
  musicFavorites: {
    mount: "/api/music-favorites",
    auth: "../middleware/auth",
    group: "../models/musicFavoriteGroup",
    song: "../models/musicFavoriteSong",
    route: "../routes/musicFavorites",
  },
};

/** 客户端保留原始 fetch，避免测试请求进入上游替身。 */
let clientFetch = globalThis.fetch;

async function withServer(kind, run, stubs = {}) {
  clientFetch = globalThis.fetch;
  const spec = ROUTE_CACHE_KEYS[kind];
  const mount = spec.mount;
  const paths = Object.fromEntries(
    Object.entries(spec)
      .filter(([key]) => key !== "mount")
      .map(([key, rel]) => [key, require.resolve(rel)]),
  );
  const previous = new Map(
    Object.values(paths).map((path) => [path, require.cache[path]]),
  );
  const put = (path, exports) => {
    require.cache[path] = { id: path, filename: path, loaded: true, exports };
  };

  put(paths.auth, {
    authMiddleware: (req, res, next) => {
      if (!req.headers.authorization) {
        return res.status(401).json({ success: false, error: "未授权" });
      }
      req.user = { id: 1 };
      next();
    },
  });
  if (paths.group) {
    const created = [];
    put(paths.group, {
      findOrCreate: async ({ defaults }) => {
        created.push(defaults);
        return [{ id: 1, ...defaults }, true];
      },
      findAll: async () => created.map((item, index) => ({ id: index + 1, ...item })),
      create: async (values) => {
        created.push(values);
        return { id: created.length, ...values };
      },
      findByPk: async () => null,
    });
    put(paths.song, { findAll: async () => [] });
  }

  delete require.cache[paths.route];
  const router = require(paths.route);
  const app = express();
  app.use(express.json());
  // 按 index.js 的真实挂载点挂（router 内部只写 /info、/groups 这类相对路径）
  app.use(mount, router);
  // 直接挂**生产用的**那个错误处理中间件：这样「有没有退化成 500 / 原文外发」
  // 才和线上一致，而不是测一个只在测试里存在的实现。
  app.use(errorHandler);

  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  const realFetch = globalThis.fetch;
  const realError = console.error;
  if (stubs.fetch) globalThis.fetch = stubs.fetch;
  // 错误处理中间件会把真实错误打日志（这正是设计），这里静音以免污染测试输出
  console.error = () => {};
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    console.error = realError;
    globalThis.fetch = realFetch;
    await new Promise((resolve) => server.close(resolve));
    for (const [path, cached] of previous) {
      if (cached) require.cache[path] = cached;
      else delete require.cache[path];
    }
  }
}

function post(baseUrl, path, body, headers = {}) {
  return clientFetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

test("bilibili /info：url 传数字返回 400，而不是 500", async () => {
  let upstreamCalls = 0;
  await withServer(
    "bilibili",
    async (baseUrl) => {
      const res = await post(baseUrl, "/api/bilibili/info", { url: 12345 });
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), {
        error: "请输入有效的 B站视频链接（需包含 BV 号）",
      });
      assert.equal(upstreamCalls, 0, "非法链接不该打上游");
    },
    {
      fetch: async () => {
        upstreamCalls += 1;
        throw new Error("不该走到这里");
      },
    },
  );
});

test("bilibili /info：sessdata 传数字不会 500（按未填写处理）", async () => {
  const seen = [];
  await withServer(
    "bilibili",
    async (baseUrl) => {
      const res = await post(baseUrl, "/api/bilibili/info", {
        url: "https://www.bilibili.com/video/BV1xx411c7mD",
        sessdata: 12345,
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.success, true);
      assert.equal(body.data.bvid, "BV1xx411c7mD");
    },
    {
      fetch: async (url, options = {}) => {
        seen.push({ url: String(url), headers: options.headers || {} });
        return {
          text: async () =>
            JSON.stringify({
              code: 0,
              data: { title: "标题", pages: [{ cid: 1, page: 1 }] },
            }),
        };
      },
    },
  );
  assert.equal(seen.length, 1);
  assert.equal(seen[0].headers.Cookie, undefined, "非字符串 sessdata 不该被当凭证用");
});

test("bilibili /info：合法 sessdata 仍会带 Cookie（没有把功能改坏）", async () => {
  const seen = [];
  await withServer(
    "bilibili",
    async (baseUrl) => {
      const res = await post(baseUrl, "/api/bilibili/info", {
        url: "https://www.bilibili.com/video/BV1xx411c7mD",
        sessdata: "  abc123  ",
      });
      assert.equal(res.status, 200);
    },
    {
      fetch: async (url, options = {}) => {
        seen.push({ headers: options.headers || {} });
        return {
          text: async () =>
            JSON.stringify({
              code: 0,
              data: { title: "标题", pages: [{ cid: 1, page: 1 }] },
            }),
        };
      },
    },
  );
  assert.equal(seen[0].headers.Cookie, "SESSDATA=abc123", "应 trim 后使用");
});

test("bilibili /info：url 是合法链接但上游返回错误码时如实报错", async () => {
  await withServer(
    "bilibili",
    async (baseUrl) => {
      const res = await post(baseUrl, "/api/bilibili/info", {
        url: "https://www.bilibili.com/video/BV1xx411c7mD",
      });
      assert.equal(res.status, 500);
      const body = await res.json();
      assert.match(body.error, /稿件不可见|视频不存在/);
    },
    {
      fetch: async () => ({
        text: async () =>
          JSON.stringify({ code: -404, message: "稿件不可见" }),
      }),
    },
  );
});

test("music /groups：name 传数字返回 400，而不是 500", async () => {
  await withServer(
    "musicFavorites",
    async (baseUrl) => {
      const res = await post(
        baseUrl,
        "/api/music-favorites/groups",
        { name: 12345 },
        { Authorization: "Bearer t" },
      );
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), {
        success: false,
        error: "分组名不能为空",
        code: "VALIDATION",
      });
    },
  );
});

test("music /groups：合法分组名仍可创建（没有把功能改坏）", async () => {
  await withServer(
    "musicFavorites",
    async (baseUrl) => {
      const res = await post(
        baseUrl,
        "/api/music-favorites/groups",
        { name: "  通勤歌单  " },
        { Authorization: "Bearer t" },
      );
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.data.name, "通勤歌单");
    },
  );
});
