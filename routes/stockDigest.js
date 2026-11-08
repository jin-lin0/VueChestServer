const express = require("express");
const cronAuth = require("../middleware/cronAuth");
const { digestHistory } = require("../services/stockDigest");
const { runStockDigest } = require("../services/stockDigestJob");
const { authMiddleware } = require("../middleware/auth");

const router = express.Router();

// Vercel cron 固定发 GET；保留 POST 便于手动 curl 触发补发
async function handle(req, res, next) {
  try {
    const outcome = await runStockDigest();
    if (!outcome.success)
      return res.status(502).json({
        success: false,
        error: outcome.error,
        ...(outcome.result || {}),
      });
    res.json({ success: true, ...outcome.result });
  } catch (error) {
    next(error);
  }
}

router.get("/run", cronAuth, handle);
router.post("/run", cronAuth, handle);

// 历史战绩（登录用户可读，前端「策略战绩」页数据源，与邮件同口径）
router.get("/history", authMiddleware, async (req, res, next) => {
  try {
    const data = await digestHistory({ days: req.query.days });
    res.json({ success: true, ...data });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
