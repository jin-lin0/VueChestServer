const express = require("express");
const sequelize = require("../config/database");
const visitLogger = require("../middleware/visitLogger");

const router = express.Router();

/**
 * 始终探测数据库，与日志缓冲区是否为空无关。
 * 数据库不可达或日志归档失败返回 503 degraded，错误原文仅记入服务端日志。
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
