const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { errorHandler } = require("../middleware/errorHandler");

/**
 * 分页参数口径的**接线**测试。
 *
 * 单测 utils/queryParams.js 只能证明那个函数是对的；这里证明「路由真的用了它」——
 * 之前的 bug 正是 `Math.max(1, parseInt(page))` 写死在路由里，
 * `?page=abc` → NaN → `OFFSET NaN` → 500。
 */

/** 用桩替换一批模块，返回可还原的现场。 */
function stubModules(map) {
  const previous = new Map();
  for (const [key, exports] of Object.entries(map)) {
    const path = require.resolve(key);
    previous.set(path, require.cache[path]);
    require.cache[path] = { id: path, filename: path, loaded: true, exports };
  }
  return previous;
}

function restoreModules(previous) {
  for (const [path, cached] of previous) {
    if (cached) require.cache[path] = cached;
    else delete require.cache[path];
  }
}

/** 起一个只挂指定路由的临时服务，跑 run(baseUrl)，结束后彻底还原模块缓存。 */
async function withRouter({ stubs, reload, mount, routerPath }, run) {
  const previous = stubModules(stubs);
  const routerResolved = require.resolve(routerPath);
  const routerCached = require.cache[routerResolved];
  delete require.cache[routerResolved];

  const app = express();
  app.use(express.json());
  app.use(mount, require(routerPath));
  app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    await run(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (routerCached) require.cache[routerResolved] = routerCached;
    else delete require.cache[routerResolved];
    restoreModules(previous);
    for (const key of reload) delete require.cache[require.resolve(key)];
  }
}

function makeAppRow(id) {
  return { toJSON: () => ({ id, name: `应用${id}`, allowNetwork: true, permissions: [] }) };
}

async function withMarketRouter(run) {
  const calls = [];
  const marketApp = {
    findAndCountAll: async (query) => {
      calls.push({ limit: query.limit, offset: query.offset });
      return { rows: [makeAppRow(1)], count: 8 };
    },
  };
  await withRouter(
    {
      stubs: {
        "../models/marketApp": marketApp,
        "../models/marketAppVersion": {},
        "../models/marketAppVersionReview": {},
        "../models/appReport": {},
        "../models/appComment": {},
        "../middleware/auth": {
          authMiddleware: (req, _res, next) => next(),
          // 游客：isAdmin 会看到 undefined
          optionalAuth: (req, _res, next) => {
            req.user = undefined;
            next();
          },
        },
        "../middleware/superAdmin": { adminOnly: (_q, _s, n) => n(), isAdmin: () => false },
        "../utils/r2": { publicUrl: () => "", headObject: async () => null, deleteObject: async () => {} },
        "../utils/bundleIntegrity": { normalizeSha256: (v) => v, assertObjectIntegrity: () => {} },
        "../utils/permissions": {
          parsePermissions: () => [],
          serializePermissions: () => "",
        },
        "../services/marketVersionService": {
          VERSION_RE: /^$/,
          approveVersion: async () => {},
          canViewApp: () => true,
          compareVersions: () => 0,
          createPendingVersion: async () => {},
          parseAllowNetwork: (v) => Boolean(v),
          recordReview: async () => {},
          recordVersion: async () => {},
          reviewFeedback: () => "",
        },
        "../services/notificationService": { safeNotify: async () => {} },
        "../services/marketNotifications": { notifyReviewResult: async () => {} },
      },
      reload: [],
      mount: "/api/market",
      routerPath: "../routes/market",
    },
    (base) => run({ base, calls }),
  );
}

async function withUsersRouter(run) {
  const calls = [];
  const user = {
    findAndCountAll: async (query) => {
      calls.push({ limit: query.limit, offset: query.offset });
      return { rows: [], count: 0 };
    },
  };
  await withRouter(
    {
      stubs: {
        "../models/user": user,
        "../middleware/auth": { authMiddleware: (req, _res, next) => next() },
        "../middleware/superAdmin": { superAdminOnly: (_q, _s, n) => n() },
      },
      reload: [],
      mount: "/api/users",
      routerPath: "../routes/users",
    },
    (base) => run({ base, calls }),
  );
}

// [query, 期望 limit, 期望 offset] —— 与 test/questionRoutes.test.js 同一口径
const CASES = [
  ["", 20, 0],
  ["?page=2&limit=5", 5, 5],
  ["?page=abc", 20, 0],
  ["?limit=abc", 20, 0],
  ["?page=abc&limit=abc", 20, 0],
  ["?page=-1&limit=-1", 20, 0],
  ["?page=0&limit=0", 20, 0],
  ["?limit=99999", 50, 0],
  ["?page=99999999999999999999", 20, 1999980],
];

test("GET /api/market/apps：坏分页参数不再 500，且落到合理默认值", async () => {
  for (const [query, limit, offset] of CASES) {
    await withMarketRouter(async ({ base, calls }) => {
      const res = await fetch(`${base}/api/market/apps${query}`);
      assert.equal(res.status, 200, `${query} 应 200，实际 ${res.status}`);
      const body = await res.json();
      assert.equal(body.success, true);
      assert.deepEqual(
        { limit: calls.at(-1).limit, offset: calls.at(-1).offset },
        { limit, offset },
        `${query} 的 limit/offset`,
      );
      // 返回体里的分页描述也要和后端实际使用的值一致
      assert.equal(body.data.limit, limit, `${query} 的 body.data.limit`);
      assert.equal(body.data.page, offset / limit + 1, `${query} 的 body.data.page`);
    });
  }
});

test("GET /api/market/apps：仍在正常分页（没有把功能改坏）", async () => {
  await withMarketRouter(async ({ base, calls }) => {
    const res = await fetch(`${base}/api/market/apps?page=2&limit=5`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.deepEqual(calls.at(-1), { limit: 5, offset: 5 });
    assert.equal(body.data.totalPages, 2, "8 条 / 每页 5 → 2 页");
  });
});

test("GET /api/users：同一类坏分页参数同样收口", async () => {
  for (const [query, limit, offset] of CASES) {
    await withUsersRouter(async ({ base, calls }) => {
      const res = await fetch(`${base}/api/users${query}`);
      assert.equal(res.status, 200, `${query} 应 200，实际 ${res.status}`);
      assert.deepEqual(
        { limit: calls.at(-1).limit, offset: calls.at(-1).offset },
        { limit, offset },
        `${query} 的 limit/offset`,
      );
    });
  }
});
