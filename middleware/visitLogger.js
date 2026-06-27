const VisitLog = require("../models/visitLog");

function getClientIP(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) return forwarded.split(",")[0].trim();
  return req.ip || req.socket?.remoteAddress || "127.0.0.1";
}

function isLocalIP(ip) {
  if (!ip) return true;
  return /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|::ffff:127\.|localhost$)/.test(ip);
}

function getGeoFromFrontend(headers) {
  const clientGeo = headers["x-client-geo"];
  if (clientGeo) {
    const parts = clientGeo.split(",");
    if (parts[0]) return { country: parts[0], city: parts[1] || "" };
  }
  return null;
}

// 内存计数器：key = "date|path|country|city" → count
const buffer = new Map();
let lastFlushAt = 0;
const FLUSH_INTERVAL_MS = 4 * 60 * 1000; // 超过 4 分钟自动 flush（防止 cron 没触发）

function makeKey(date, path, country, city) {
  return `${date}|${path}|${country || ""}|${city || ""}`;
}

// 批量写入数据库
async function flushToDB() {
  if (buffer.size === 0) return { flushed: 0 };

  const entries = Array.from(buffer.entries());
  buffer.clear();
  lastFlushAt = Date.now();

  const today = new Date().toISOString().slice(0, 10);

  for (const [key, count] of entries) {
    const [, path, country, city] = key.split("|");
    try {
      // upsert: 存在则累加，不存在则创建
      const [record, created] = await VisitLog.findOrCreate({
        where: { date: today, path, country: country || "", city: city || "" },
        defaults: { count },
      });
      if (!created) {
        await record.increment("count", { by: count });
      }
    } catch (e) {
      // 写入失败，放回 buffer 下次重试
      buffer.set(key, (buffer.get(key) || 0) + count);
    }
  }

  return { flushed: entries.length };
}

// 中间件：只更新内存计数器，不阻塞请求
function visitLogger(req, res, next) {
  if (!req.path.startsWith("/api/") || req.path.startsWith("/api/stats")) return next();

  const ip = getClientIP(req);
  if (isLocalIP(ip)) return next();

  const geo = getGeoFromFrontend(req.headers);
  const today = new Date().toISOString().slice(0, 10);
  const key = makeKey(today, req.path, geo?.country, geo?.city);

  buffer.set(key, (buffer.get(key) || 0) + 1);

  // 超过 4 分钟自动 flush（防止 cron 没触发的兜底）
  if (Date.now() - lastFlushAt > FLUSH_INTERVAL_MS) {
    flushToDB().catch(() => {});
  }

  next();
}

// 导出 flush 供 cron 调用
visitLogger.flushToDB = flushToDB;
visitLogger.getBufferSize = () => buffer.size;

module.exports = visitLogger;
