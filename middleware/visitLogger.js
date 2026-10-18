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

// 与 models/visitLog.js 的列宽一致（path STRING(200)、country/city STRING(100)）。
//
// 为什么要在写库前截断：这三个值全是**不可信输入** —— path 来自 URL，country/city
// 来自客户端可以随意伪造的 `X-Client-Geo` 头。而 MySQL 严格模式下超长写入会让
// **整条 INSERT 失败**（批量归档见 flushEntries）。实测：一个 252 字符的 path 就能让
// 整批归档失败、并且这个维度一直留在 buffer 里重试，`/health` 从此永久回 503
// （routes/health.js 把归档失败算作降级）。截断把这个问题挡在写入之前。
//
// 这几个数字由 test/visitLogger.test.js 的一条用例对着真实模型核对，改列宽忘改这里会变红。
const FIELD_LIMITS = { path: 200, country: 100, city: 100 };

// 一个 flush 窗口内最多记住多少个「日期/路径/地区」维度。真实用量远低于此
// （4 分钟窗口内的路由数 × 地区数）。这是个防无界增长的闸门：path 完全由请求方决定，
// 没有闸门时一串不重复的 URL 就能同时顶穿内存和落库规模。满了之后**新维度直接丢弃**
// （已经在计数里的维度继续累加），丢弃次数每轮 flush 汇总成一条 warn。
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

// key 用 JSON 数组编码，而不是 `|` 拼接。
//
// 为什么：path 里可以带 `|`（实测 `GET /api/__pipe|probe` 会被 Node 原样收下并进到
// req.path），拼字符串再 split 会让字段整体错位 —— 实测那一行写出来是
// path=/api/__pipe、country=probe、city=CN，真实的 CN/Beijing 被挤掉了，
// 等于让请求方往 country 列里写任意内容。JSON 没有这个歧义。
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
 * 把整批计数拼成**一条** upsert 语句。
 *
 * 为什么值得拼：每个「日期|路径|地区」维度原来都要一次 `findOrCreate`
 * （= SELECT 一次，命中时再 UPDATE 累加一次），而 MySQL 在远端
 * （热态单次往返 41~47ms，见 config/database.js 的注释）。39 个维度的实测：
 * `/health` 里那次 flush 花了 **8.01 秒**（同期空 buffer 的 /health 是 46ms）。
 * 而 `/health` 是**会 await 这次 flush** 的（routes/health.js），
 * 监控探针与 Vercel 的每日保活都挂在它上面 —— 落库慢会直接把探针拖到超时。
 *
 * 唯一索引 (date,path,country,city) 已在 models/visitLog.js 声明，
 * 所以这些维度天然可以走 `ON DUPLICATE KEY UPDATE count = count + ...`。
 *
 * 用 `AS new` 别名而不是 `VALUES()`：MySQL 8.0.20 起 VALUES() 已废弃，
 * 实测会带上 warning 1287，而别名写法零 warning（本机 8.0.41 验证）。
 * 代价是 MariaDB 不认这个语法 —— 那条路径会落到 flushOneByOne，
 * 慢但结果一样，不会写错数据。
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
 * 把内存计数器落库。
 * @returns {Promise<{flushed: number, failed: number}>} 以「日期|路径|地区」维度计数：
 *   flushed = 真正写成功的维度数，failed = 没写成功的维度数。
 *   以前只回 `flushed: entries.length`（尝试数），写失败也报成功，
 *   健康检查因此永远是绿灯 —— 见 routes/health.js 的注释。
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

/**
 * 逐条落库（批量语句失败时的兜底，语义与历史实现一致）。
 */
async function flushOneByOne(records) {
  let flushed = 0;
  let failed = 0;

  // 分批并发，不再串行：每个维度最多两条语句（建行 + 累加），串行 N 个维度就是
  // 2N 次串行往返（实测 39 个维度 8 秒）。但也不能一次全发 —— 兜底路径的规模
  // 由 MAX_BUFFER_KEYS 决定，2000 个维度一次全发会往连接池里排 4000 个查询，
  // 把正常请求一起堵在队列后面。每批 16 个，配合连接池（max: 5）刚好不空转。
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
