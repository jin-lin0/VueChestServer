const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { Op } = require("sequelize");
const { errorHandler } = require("../middleware/errorHandler");

// 批量元信息与目录列表使用不同的展示规则，但都要求审核通过。
const ROUTER_PATH = require.resolve("../routes/market");

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

function makeRow(id) {
  return { id, toJSON: () => ({ id, name: `应用${id}`, allowNetwork: true, permissions: [] }) };
}

/**
 * 起一个只挂 market 路由的临时服务。
 * @param {{ findAll?: Function, findAndCountAll?: Function }} query 模型查询桩
 * @param {(ctx: {base: string, calls: object[]}) => Promise<void>} run
 */
async function withMarketRouter(query, run) {
  const calls = [];
  const marketApp = {
    findAll: async (options) => {
      calls.push({ kind: "findAll", ...options });
      return query.findAll ? query.findAll(options) : [];
    },
    findAndCountAll: async (options) => {
      calls.push({ kind: "findAndCountAll", ...options });
      return query.findAndCountAll ? query.findAndCountAll(options) : { rows: [], count: 0 };
    },
  };

  const previous = stubModules({
    "../models/marketApp": marketApp,
    "../models/marketAppVersion": {},
    "../models/marketAppVersionReview": {},
    "../models/appReport": {},
    "../models/appComment": {},
    "../middleware/auth": {
      authMiddleware: (_req, _res, next) => next(),
      // 游客（非管理员）
      optionalAuth: (req, _res, next) => {
        req.user = undefined;
        next();
      },
    },
    "../middleware/superAdmin": { adminOnly: (_q, _s, n) => n(), isAdmin: () => false },
    "../utils/r2": { publicUrl: () => "", headObject: async () => null, deleteObject: async () => {} },
    "../utils/bundleIntegrity": { normalizeSha256: (v) => v, assertObjectIntegrity: () => {} },
    "../utils/permissions": { parsePermissions: () => [], serializePermissions: () => "" },
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
  });

  const cachedRouter = require.cache[ROUTER_PATH];
  delete require.cache[ROUTER_PATH];

  const app = express();
  app.use(express.json());
  app.use("/api/market", require(ROUTER_PATH));
  app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    await run({ base, calls });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (cachedRouter) require.cache[ROUTER_PATH] = cachedRouter;
    else delete require.cache[ROUTER_PATH];
    restoreModules(previous);
  }
}

test("?ids=1,2,3 用一次 findAll 查完，且不查 count", async () => {
  await withMarketRouter(
    { findAll: (options) => options.where.id[Op.in].map(makeRow) },
    async ({ base, calls }) => {
      const res = await fetch(`${base}/api/market/apps?ids=1,2,3`);
      assert.equal(res.status, 200);
      const body = await res.json();

      assert.equal(calls.length, 1, "批量分支只应该查一次");
      assert.equal(calls[0].kind, "findAll", "批量不该走 findAndCountAll（count 用不上）");
      assert.deepEqual(calls[0].where.id, { [Op.in]: [1, 2, 3] });
      assert.deepEqual(
        body.data.items.map((item) => item.id),
        [1, 2, 3],
      );
      assert.equal(body.data.total, 3);
      assert.deepEqual(body.data.items[0].permissions, []);
      assert.equal(body.data.items[0].allowNetwork, true);
    },
  );
});

test("批量更新元信息保留更新说明，不拉取完整 readme", async () => {
  const record = { id: 1, name: "示例应用", releaseNotes: "修复数据恢复", readme: "完整文档" };
  await withMarketRouter(
    {
      findAll: ({ attributes }) => [{
        toJSON: () => Object.fromEntries(
          attributes.filter((key) => key in record).map((key) => [key, record[key]]),
        ),
      }],
    },
    async ({ base }) => {
      const response = await fetch(`${base}/api/market/apps?ids=1`);
      const body = await response.json();
      assert.equal(body.data.items[0].releaseNotes, "修复数据恢复");
      assert.equal(body.data.items[0].readme, undefined);
    },
  );
});

test("ids 会去重、过滤非正整数（重复 id 不该重复查 / 重复回）", async () => {
  await withMarketRouter(
    { findAll: (options) => options.where.id[Op.in].map(makeRow) },
    async ({ base, calls }) => {
      const res = await fetch(`${base}/api/market/apps?ids=1,1,abc,-1,0,2`);
      assert.equal(res.status, 200);
      assert.deepEqual(calls[0].where.id, { [Op.in]: [1, 2] });
      const body = await res.json();
      assert.deepEqual(
        body.data.items.map((item) => item.id),
        [1, 2],
      );
    },
  );
});

test("ids 为空 / 全非法时不打数据库", async () => {
  for (const query of ["ids=", "ids=abc", "ids=-1,0", "ids=,"]) {
    await withMarketRouter({}, async ({ base, calls }) => {
      const res = await fetch(`${base}/api/market/apps?${query}`);
      assert.equal(res.status, 200, query);
      const body = await res.json();
      assert.deepEqual(body.data.items, [], query);
      assert.equal(calls.length, 0, `${query} 不该产生任何查询`);
    });
  }
});

test("批量查询保留隐藏但已审核的应用，排除未审核应用", async () => {
  const records = [
    { id: 1, status: "approved", isListed: false },
    { id: 2, status: "pending", isListed: true },
  ];
  await withMarketRouter(
    { findAll: ({ where }) => records.filter((row) =>
      row.status === where.status && (where.isListed === undefined || row.isListed === where.isListed)
    ).map((row) => ({ toJSON: () => row })) },
    async ({ base, calls }) => {
      const res = await fetch(`${base}/api/market/apps?ids=1,2`);
      assert.equal(res.status, 200);
      assert.equal(calls[0].where.status, "approved");
      const body = await res.json();
      assert.deepEqual(body.data.items.map((item) => item.id), [1]);
    },
  );
});

test("ids 数量截断到 100，挡住 ?ids=1,2,...（一万个）", async () => {
  const many = Array.from({ length: 500 }, (_, index) => index + 1).join(",");
  await withMarketRouter(
    { findAll: (options) => options.where.id[Op.in].map(makeRow) },
    async ({ base, calls }) => {
      const res = await fetch(`${base}/api/market/apps?ids=${many}`);
      assert.equal(res.status, 200);
      assert.equal(calls[0].where.id[Op.in].length, 100);
      const body = await res.json();
      assert.equal(body.data.items.length, 100);
    },
  );
});

test("不带 ids 时仍是原来的分页路径（批量没有把列表改坏）", async () => {
  await withMarketRouter(
    {
      findAndCountAll: (options) => ({
        rows: [makeRow(1)],
        count: 8,
        // 顺带把分页参数记下来，证明 limit/offset 仍然生效
        __options: options,
      }),
    },
    async ({ base, calls }) => {
      const res = await fetch(`${base}/api/market/apps?page=2&limit=5`);
      assert.equal(res.status, 200);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].kind, "findAndCountAll");
      assert.equal(calls[0].limit, 5);
      assert.equal(calls[0].offset, 5);
      assert.equal(calls[0].where.status, "approved");
      assert.equal(calls[0].where.isListed, true);
      const body = await res.json();
      assert.equal(body.data.total, 8);
      assert.equal(body.data.totalPages, 2);
      assert.equal(body.data.page, 2);
    },
  );
});
