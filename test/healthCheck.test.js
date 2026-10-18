const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");

const HEALTH_PATH = require.resolve("../routes/health");
const DB_PATH = require.resolve("../config/database");
const LOGGER_PATH = require.resolve("../middleware/visitLogger");

/**
 * 健康检查的契约测试。
 *
 * 这条端点的历史问题是「假绿灯」：它只调 visitLogger.flushToDB()，而那个函数在
 * buffer 为空时直接 return（不碰数据库），单条写失败又在内层被 catch 吞掉，
 * 所以数据库挂了它照样回 status:"ok" + 200。
 */
async function withHealth(stubs, run) {
  const previous = new Map();
  const targets = [DB_PATH, LOGGER_PATH];
  for (const path of targets) {
    previous.set(path, require.cache[path]);
  }
  require.cache[DB_PATH] = {
    id: DB_PATH,
    filename: DB_PATH,
    loaded: true,
    exports: { authenticate: stubs.authenticate },
  };
  require.cache[LOGGER_PATH] = {
    id: LOGGER_PATH,
    filename: LOGGER_PATH,
    loaded: true,
    exports: Object.assign(() => {}, {
      flushToDB: stubs.flushToDB,
      getBufferSize: stubs.getBufferSize || (() => 0),
    }),
  };

  const cachedHealth = require.cache[HEALTH_PATH];
  delete require.cache[HEALTH_PATH];

  const app = express();
  app.use("/health", require(HEALTH_PATH));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const realConsoleError = console.error;
  console.error = () => {};
  try {
    await run(base);
  } finally {
    console.error = realConsoleError;
    await new Promise((resolve) => server.close(resolve));
    if (cachedHealth) require.cache[HEALTH_PATH] = cachedHealth;
    else delete require.cache[HEALTH_PATH];
    for (const [path, cached] of previous) {
      if (cached) require.cache[path] = cached;
      else delete require.cache[path];
    }
  }
}

test("数据库正常时回 200 ok，并带 database 与归档计数", async () => {
  await withHealth(
    {
      authenticate: async () => {},
      flushToDB: async () => ({ flushed: 4, failed: 0 }),
      getBufferSize: () => 0,
    },
    async (base) => {
      const res = await fetch(`${base}/health`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.status, "ok");
      assert.equal(body.database, "ok");
      assert.equal(body.logsFlushed, 4);
      assert.equal(body.logsFailed, 0);
      assert.ok(body.timestamp);
    },
  );
});

test("数据库不可达时回 503 degraded，且不泄漏连接错误原文", async () => {
  await withHealth(
    {
      authenticate: async () => {
        const error = new Error("connect ECONNREFUSED 127.0.0.1:3306");
        error.name = "SequelizeConnectionRefusedError";
        throw error;
      },
      flushToDB: async () => ({ flushed: 0, failed: 0 }),
    },
    async (base) => {
      const res = await fetch(`${base}/health`);
      assert.equal(res.status, 503, "库挂了就不能再回 200");
      const raw = await res.text();
      const body = JSON.parse(raw);
      assert.equal(body.status, "degraded");
      assert.equal(body.database, "down");
      assert.ok(
        !/ECONNREFUSED|127\.0\.0\.1|Sequelize/i.test(raw),
        "免登录端点不能把连接错误原文回出去",
      );
    },
  );
});

test("即使 buffer 为空也会真的探数据库（这正是原来的假绿灯成因）", async () => {
  let probed = 0;
  await withHealth(
    {
      authenticate: async () => {
        probed += 1;
      },
      flushToDB: async () => ({ flushed: 0, failed: 0 }),
      getBufferSize: () => 0,
    },
    async (base) => {
      const res = await fetch(`${base}/health`);
      assert.equal(res.status, 200);
      assert.equal(probed, 1, "空 buffer 也必须探库，否则等于不检查");
    },
  );
});

test("库连得上但归档有条目写失败时算降级", async () => {
  await withHealth(
    {
      authenticate: async () => {},
      flushToDB: async () => ({ flushed: 3, failed: 2 }),
      getBufferSize: () => 2,
    },
    async (base) => {
      const res = await fetch(`${base}/health`);
      assert.equal(res.status, 503);
      const body = await res.json();
      assert.equal(body.status, "degraded");
      assert.equal(body.database, "ok", "库是好的，问题在归档");
      assert.equal(body.logsFailed, 2);
      assert.equal(body.bufferRemaining, 2);
    },
  );
});

test("flushToDB 自己抛错时不让健康检查崩，而是降级", async () => {
  await withHealth(
    {
      authenticate: async () => {},
      flushToDB: async () => {
        throw new Error("unexpected");
      },
    },
    async (base) => {
      const res = await fetch(`${base}/health`);
      assert.equal(res.status, 503);
      const body = await res.json();
      assert.equal(body.status, "degraded");
      assert.equal(body.database, "ok");
    },
  );
});
