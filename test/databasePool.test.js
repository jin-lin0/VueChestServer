const test = require("node:test");
const assert = require("node:assert/strict");

const DB_PATH = require.resolve("../config/database");

/**
 * 连接池参数的回归门禁。
 *
 * 为什么需要它：`pool.min` 从 0 改成 1 的效果是「第一个请求快 160ms」，
 * 属于**改错了也不会让任何测试变红**的那类配置 —— 只有真去远端量才能发现。
 * 实测数据（mysql.sqlpub.com，与本项目同款配置）：
 *   min:0 → 热 47.4ms，静置 14s 后首次 205.9ms（+158ms 全花在重建连接）
 *   min:1 → 热 41.1ms，静置 14s 后首次  43.2ms
 * 这条用例把这两个分支钉住，避免以后有人「顺手清理」掉 min。
 */

/** 在指定环境变量下重新加载 config/database，拿到真正被使用的配置。 */
function loadPool(env) {
  const previousEnv = { VERCEL: process.env.VERCEL };
  const cachedDb = require.cache[DB_PATH];

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  // dotenv 默认不覆盖已存在的变量（override:false），所以上面设的 VERCEL 一定是最终生效值。
  delete require.cache[DB_PATH];

  let pool;
  try {
    pool = require("../config/database").options.pool;
  } finally {
    if (cachedDb) require.cache[DB_PATH] = cachedDb;
    else delete require.cache[DB_PATH];
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  return pool;
}

test("长驻进程留 1 条常驻连接，避免每次空闲后重付远端握手", () => {
  const pool = loadPool({ VERCEL: undefined });
  assert.equal(pool.min, 1, "min 掉回 0 会让空闲后的首个请求多花约 160ms");
  assert.equal(pool.max, 5);
  assert.equal(pool.idle, 10000);
  assert.equal(pool.acquire, 30000);
});

test("Vercel 上不留常驻连接（实例会被冻结，留着白占 MySQL 连接额度）", () => {
  const pool = loadPool({ VERCEL: "1" });
  assert.equal(pool.min, 0);
  assert.equal(pool.max, 1, "serverless 每个实例只能有 1 个连接");
  assert.equal(pool.acquire, 8000);
});

test("两个分支共用同一个 idle，且 idle 明显小于服务端 wait_timeout", () => {
  // 服务端 wait_timeout = 28800s。idle 必须远小于它，否则常驻连接会先被服务端回收，
  // min>0 就失去意义（虽然会退化成 min:0 的行为，不会更差，但白留了个连接）。
  const WAIT_TIMEOUT_MS = 28800 * 1000;
  for (const pool of [loadPool({ VERCEL: undefined }), loadPool({ VERCEL: "1" })]) {
    assert.ok(
      pool.idle > 0 && pool.idle < WAIT_TIMEOUT_MS / 10,
      `idle=${pool.idle} 应远小于服务端 wait_timeout`,
    );
  }
});
