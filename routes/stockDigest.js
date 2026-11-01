const express = require("express");
const crypto = require("node:crypto");
const { runDailyDigest, digestHistory } = require("../services/stockDigest");
const CronRun = require("../models/cronRun");
const { sendHtmlMail } = require("../utils/mail");
const { authMiddleware } = require("../middleware/auth");
const { adminOnly } = require("../middleware/superAdmin");

const router = express.Router();

/**
 * 只允许 Vercel Cron（或知道密钥的运维）触发。
 * Vercel 在项目配置了 CRON_SECRET 环境变量后，会自动给 cron 请求带上
 * `Authorization: Bearer ${CRON_SECRET}`；这里做常量时间比较。
 * 未配置 CRON_SECRET 时一律拒绝——这个接口会发邮件、写库，不能裸奔。
 */
function cronAuth(req, res, next) {
  const secret = process.env.CRON_SECRET || "";
  const header = req.headers.authorization || "";
  const expected = `Bearer ${secret}`;
  const ok =
    secret &&
    header.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
  if (!ok) {
    return res.status(401).json({ success: false, error: "未授权" });
  }
  next();
}

/** 执行记录落库失败不能影响主流程（日报已发出就算成功）。 */
async function recordRun(success, durationMs, detail) {
  try {
    await CronRun.create({ job: "stock-digest", success, durationMs, detail });
  } catch (error) {
    console.error("[stock-digest] 执行记录落库失败:", error.message);
  }
}

/** 失败告警：复用日报收件人；告警本身失败只记日志，不再递归告警。 */
async function alertFailure(message) {
  const to = (process.env.STOCK_DIGEST_TO || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!to.length) return;
  // 错误栈里常有 <anonymous> 之类字符，不转义会被当成 HTML 标签吞掉
  const safe = String(message)
    .slice(0, 2000)
    .replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
  await sendHtmlMail({
    to,
    subject: "【VueChest】策略日报执行失败告警",
    html: `<p>今日策略选股日报执行失败，请检查 Vercel 日志。</p><pre style="background:#f1f5f9;padding:12px;border-radius:8px;white-space:pre-wrap">${safe}</pre>`,
  }).catch((err) => console.error("[stock-digest] 告警邮件发送失败:", err.message));
}

// Vercel cron 固定发 GET；保留 POST 便于手动 curl 触发补发
async function handle(req, res, next) {
  const startedAt = Date.now();
  try {
    const result = await runDailyDigest();
    const duration = Date.now() - startedAt;
    // 邮件发送失败同样算失败：日报的交付物就是那封邮件
    if (!result.mail?.success) {
      const reason = `邮件发送失败: ${result.mail?.error || "未知原因"}`;
      await recordRun(false, duration, reason);
      await alertFailure(reason);
      return res.status(502).json({ success: false, error: reason, ...result });
    }
    await recordRun(
      true,
      duration,
      `评估 ${result.evaluated.length} 批，采集 ${result.collected.length}/${result.requested} 个策略，用时 ${duration}ms`,
    );
    res.json({ success: true, ...result });
  } catch (error) {
    const duration = Date.now() - startedAt;
    await recordRun(false, duration, error.message);
    await alertFailure(error.stack || error.message);
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

// 最近执行记录（仅管理员：detail 里可能含内部错误信息）
router.get("/runs", authMiddleware, adminOnly, async (req, res, next) => {
  try {
    const rows = await CronRun.findAll({
      where: { job: "stock-digest" },
      order: [["id", "DESC"]],
      limit: 30,
    });
    res.json({ success: true, data: rows });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
