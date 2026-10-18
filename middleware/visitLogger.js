const VisitLog = require("../models/visitLog");

function getClientIP(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) return forwarded.split(",")[0].trim();
  return req.ip || req.socket?.remoteAddress || "127.0.0.1";
}

function isLocalIP(ip) {
  if (!ip) return true;
  return /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|::ffff:127\.|localhost$)/.test(
    ip,
  );
}

function getGeoFromFrontend(headers) {
  const clientGeo = headers["x-client-geo"];
  if (clientGeo) {
    const parts = clientGeo.split(",");
    if (parts[0]) return { country: parts[0], city: parts[1] || "" };
  }
  return null;
}

// 输入按模型列宽截断，避免单条超长字段导致批量归档失败。
const FIELD_LIMITS = { path: 200, country: 100, city: 100 };

// 缓冲区满时丢弃新维度，已有维度继续累加；归档时汇总丢弃数量。
const MAX_BUFFER_KEYS = 2000;

// 内存计数器：key = JSON 编码的 [date, path, country, city] → count
const buffer = new Map();
let lastFlushAt = 0;
let flushPromise = null;
let droppedCount = 0;
const FLUSH_INTERVAL_MS = 4 * 60 * 1000; // 超过 4 分钟自动 flush（防止 cron 没触发）

const ROLLED_BACK_CODES = new Set(["ER_LOCK_WAIT_TIMEOUT", "ER_LOCK_DEADLOCK"]);
const AMBIGUOUS_WRITE_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "PROTOCOL_CONNECTION_LOST", "EPIPE"]);

function hasCode(error, codes) {
  return [error, error?.parent, error?.original].some((item) => codes.has(item?.code));
}

// 失败回填也必须遵守上限：flush 期间新请求可能已经占满了缓冲区。
function requeue(key, count) {
  if (!buffer.has(key) && buffer.size >= MAX_BUFFER_KEYS) {
    droppedCount += count;
    return;
  }
  buffer.set(key, (buffer.get(key) || 0) + count);
}

function clampField(value, limit) {
  if (typeof value !== "string") return "";
  return value.length > limit ? value.slice(0, limit) : value;
}

// 用 JSON 数组编码维度，避免路径中的分隔符造成字段错位。
function encodeKey(date, path, country, city) {
  return JSON.stringify([date, path, country, city]);
}

function decodeKey(key) {
  const [date, path, country, city] = JSON.parse(key);
  return { date, path, country, city };
}

// 批量写入数据库
async function flushToDB() {
  if (flushPromise) return flushPromise;
  if (buffer.size === 0) return { flushed: 0, failed: 0 };

  flushPromise = flushEntries();
  try {
    return await flushPromise;
  } finally {
    flushPromise = null;
  }
}

/** 取出 buffer 全部内容并清空，顺便刷新自动 flush 的时间戳。 */
function drainBuffer() {
  const entries = Array.from(buffer.entries());
  buffer.clear();
  lastFlushAt = Date.now();

  return entries.map(([key, count]) => ({ key, count, ...decodeKey(key) }));
}

// 批量 upsert 的列顺序。必须与 models/visitLog.js 的字段名一致，
// 也必须与 buildUpsert 里 replacements 的展开顺序一致。
const UPSERT_COLUMNS = ["date", "path", "country", "city", "count"];

/**
 * 按唯一维度索引批量累加计数。
 * 使用 MySQL 行别名语法；不支持该语法时退回逐条写入。
 */
function buildUpsert(records) {
  const table = VisitLog.getTableName();
  const columns = UPSERT_COLUMNS.map((name) => `\`${name}\``).join(",");
  const placeholders = records.map(() => "(?,?,?,?,?)").join(",");

  return {
    sql:
      `INSERT INTO \`${table}\` (${columns}) VALUES ${placeholders} AS \`new\` ` +
      `ON DUPLICATE KEY UPDATE \`count\` = \`${table}\`.\`count\` + \`new\`.\`count\``,
    replacements: records.flatMap((record) =>
      UPSERT_COLUMNS.map((name) => record[name]),
    ),
  };
}

/**
 * 归档内存计数器。
 * @returns {Promise<{flushed: number, failed: number}>} 成功与失败的维度数
 */
async function flushEntries() {
  const records = drainBuffer();
  if (droppedCount > 0) {
    console.warn(
      `访问日志缓冲区已满（上限 ${MAX_BUFFER_KEYS} 个维度），本轮丢弃了 ${droppedCount} 次计数`,
    );
    droppedCount = 0;
  }
  if (records.length === 0) return { flushed: 0, failed: 0 };

  try {
    const { sql, replacements } = buildUpsert(records);
    // 走模型的 sequelize 而不是直接 require config/database：缓存器/模型的依赖
    // 都留在 VisitLog 这一个入口上，测试里替换模型就能拦住这条语句。
    await VisitLog.sequelize.query(sql, { replacements });
    return { flushed: records.length, failed: 0 };
  } catch (e) {
    // 连接在回包前断开时，服务端可能已经提交；不能把“没收到成功响应”当成“没有写入”。
    if (hasCode(e, AMBIGUOUS_WRITE_CODES)) {
      console.error(`访问日志归档结果无法确认（${records.length} 个维度），跳过重放以免重复计数：${e.message}`);
      return { flushed: 0, failed: records.length };
    }
    // 语法/字段/约束等明确失败时，退回逐条，保住不受坏行影响的维度。
    console.error(
      `访问日志批量归档失败，退回逐条重试（${records.length} 个维度）：${e.message}`,
    );
  }

  return flushOneByOne(records);
}

/** 批量明确失败后的逐条写入兜底。 */
async function flushOneByOne(records) {
  let flushed = 0;
  let failed = 0;

  // 限制每批并发数，避免兜底写入占满正常请求的连接队列。
  const CONCURRENCY = 16;
  for (let start = 0; start < records.length; start += CONCURRENCY) {
    const batch = records.slice(start, start + CONCURRENCY);
    await Promise.all(
      batch.map(async ({ key, count, date, path, country, city }) => {
        let record = null;
        let created = false;
        try {
          // upsert: 存在则累加，不存在则创建
          const result = await VisitLog.findOrCreate({
            where: { date, path, country, city },
            defaults: { count },
          });
          record = result[0];
          created = result[1];
        } catch (e) {
          // 连接异常可能发生在提交后；只有可确认失败的创建才能回填重试。
          if (!hasCode(e, AMBIGUOUS_WRITE_CODES)) requeue(key, count);
          failed += 1;
          return;
        }

        // 新建时 defaults.count 已经带上了计数，不用再加
        if (created) {
          flushed += 1;
          return;
        }

        try {
          await record.increment("count", { by: count });
          flushed += 1;
        } catch (e) {
          // 死锁/锁等待超时明确未提交本次增量，应该重试；连接断开等不确定结果不能重放。
          if (hasCode(e, ROLLED_BACK_CODES)) requeue(key, count);
          failed += 1;
        }
      }),
    );
  }

  return { flushed, failed };
}

// 中间件：只更新内存计数器，不阻塞请求
function visitLogger(req, res, next) {
  if (!req.path.startsWith("/api/") || req.path.startsWith("/api/stats"))
    return next();

  const ip = getClientIP(req);
  if (isLocalIP(ip)) return next();

  const geo = getGeoFromFrontend(req.headers);
  const today = new Date().toISOString().slice(0, 10);
  const key = encodeKey(
    today,
    clampField(req.path, FIELD_LIMITS.path),
    clampField(geo?.country, FIELD_LIMITS.country),
    clampField(geo?.city, FIELD_LIMITS.city),
  );

  if (!buffer.has(key) && buffer.size >= MAX_BUFFER_KEYS) {
    droppedCount += 1;
  } else {
    buffer.set(key, (buffer.get(key) || 0) + 1);
  }

  // 超过 4 分钟自动 flush（防止 cron 没触发的兜底）
  if (Date.now() - lastFlushAt > FLUSH_INTERVAL_MS) {
    flushToDB().catch(() => {});
  }

  next();
}

// 导出 flush 供 cron 调用
visitLogger.flushToDB = flushToDB;
visitLogger.getBufferSize = () => buffer.size;
// 只给测试用：核对这几个上限与 models/visitLog.js 的列宽没有漂移。
visitLogger.FIELD_LIMITS = FIELD_LIMITS;
visitLogger.MAX_BUFFER_KEYS = MAX_BUFFER_KEYS;

module.exports = visitLogger;
