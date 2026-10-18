const express = require("express");
const sequelize = require("../config/database");
const visitLogger = require("../middleware/visitLogger");

const router = express.Router();

/**
 * 健康检查（Vercel cron 每日保活也会打这里，见 vercel.json 的 crons）。
 *
 * 这个端点原来是个「假绿灯」，两处叠加导致它**永远**回 ok：
 *   1. 它只调 `visitLogger.flushToDB()`，而那个函数在 buffer 为空时直接 return，
 *      根本不碰数据库。本地/低流量时 buffer 常为空 → 数据库挂了照样 `status: "ok"`。
 *   2. 单条写入失败在 `flushEntries` 内部就被 catch 吞掉并放回 buffer，
 *      外层写在 index.js 里的 try/catch 几乎永远不会触发。
 * 于是探针永远绿 —— 而这个项目的数据库在远端（DB_HOST=mysql.sqlpub.com），
 * 断连不是理论问题（见「服务端失联诊断与重启恢复」那次事故）。
 *
 * 现在的语义：
 *   - 显式探一次数据库（`sequelize.authenticate()`），与 buffer 是否为空无关；
 *   - 数据库不可达 → **503 + status "degraded"**，让监控真能报警；
 *   - 归档有条目写不进去（表结构/权限变了）同样算降级，否则这种
 *     「连得上但写不进去」的问题会一直隐身；
 *   - 不回错误原文（本路由免登录），细节只进服务端日志。
 */
router.get("/", async (req, res) => {
  const timestamp = new Date().toISOString();
  const bufferRemaining = visitLogger.getBufferSize();

  let flush = { flushed: 0, failed: 0 };
  let flushThrew = false;
  try {
    flush = await visitLogger.flushToDB();
  } catch (error) {
    // flushToDB 内部逐条兜底，正常不会抛；这里只是不让它把健康检查带崩
    console.error("健康检查：访问日志归档抛出异常", error);
    flushThrew = true;
  }

  try {
    await sequelize.authenticate();
  } catch (error) {
    console.error("健康检查失败：数据库不可达", error);
    return res.status(503).json({
      status: "degraded",
      timestamp,
      database: "down",
      error: "数据库不可用",
      logsFlushed: flush.flushed,
      logsFailed: flush.failed,
      bufferRemaining,
    });
  }

  if (flushThrew || flush.failed > 0) {
    console.error(
      `健康检查降级：访问日志归档未完全成功（成功 ${flush.flushed}，失败 ${flush.failed}）`,
    );
    return res.status(503).json({
      status: "degraded",
      timestamp,
      database: "ok",
      error: "访问日志归档未完全成功",
      logsFlushed: flush.flushed,
      logsFailed: flush.failed,
      bufferRemaining,
    });
  }

  return res.json({
    status: "ok",
    timestamp,
    database: "ok",
    logsFlushed: flush.flushed,
    logsFailed: 0,
    bufferRemaining,
  });
});

module.exports = router;
