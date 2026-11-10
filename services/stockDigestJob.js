const CronRun = require("../models/cronRun");
const State = require("../models/dailyTaskState");
const { runDailyDigest } = require("./stockDigest");
const { sendHtmlMail } = require("../utils/mail");
const { superAdminRecipients } = require("../utils/notificationRecipients");
const escapeHtml = require("../utils/escapeHtml");
const { executionJob } = require("../utils/cronJobs");

/** 执行记录落库失败不能影响主流程（邮件已发出就算交付成功）。 */
async function record(success, durationMs, detail) {
  try {
    await CronRun.create({
      job: executionJob("stock-digest"),
      success,
      durationMs,
      detail,
    });
  } catch (error) {
    console.error("[stock-digest] 执行记录落库失败:", error.message);
  }
}

/** 失败告警只发给仍启用日报的超管；告警本身失败只记日志，不递归。 */
async function alertFailure(message, recipients) {
  const safe = escapeHtml(String(message).slice(0, 2000));
  await Promise.all(
    recipients.map((recipient) =>
      sendHtmlMail({
        to: recipient.email,
        subject: "【VueChest】策略日报执行失败告警",
        html: `<p>今日策略选股日报执行失败，请检查 Vercel 日志。</p><pre style="background:#f1f5f9;padding:12px;border-radius:8px;white-space:pre-wrap">${safe}</pre>`,
      }).catch((error) =>
        console.error(
          `[stock-digest] 告警邮件发送至 ${recipient.email} 失败:`,
          error.message,
        ),
      ),
    ),
  );
}

/**
 * 定时入口和超管后台「立即执行」共用的日报任务：
 * 生成一次内容，按超管逐个投递，再统一记录执行结果。
 * 返回结构固定为 { success, result?, error? }，让调用方只负责 HTTP 语义。
 */
async function runStockDigest() {
  const startedAt = Date.now();
  // 开关只对「谁还收日报」生效：关掉的超管既不收日报，也不收日报的失败告警。
  let recipients, disabled;
  try {
    [recipients, disabled] = await Promise.all([
      superAdminRecipients(),
      State.findAll({
        where: { taskId: "stock-digest", enabled: false },
        attributes: ["ownerId"],
      }),
    ]);
  } catch (error) {
    await record(false, 0, error.message);
    return { success: false, error: error.message };
  }
  const off = new Set(disabled.map((row) => row.ownerId));
  const targets = recipients.filter((item) => !off.has(item.ownerId));
  if (!targets.length) {
    await record(true, 0, "所有超管都已暂停策略日报，跳过");
    return { success: true, result: { skipped: true, mails: [] } };
  }

  let result;
  try {
    result = await runDailyDigest({ recipients: targets });
  } catch (error) {
    const duration = Date.now() - startedAt;
    await record(false, duration, error.message);
    await alertFailure(error.stack || error.message, targets);
    return { success: false, error: error.message };
  }

  const duration = Date.now() - startedAt;
  const failed = result.mails.filter((mail) => !mail.success);
  if (failed.length) {
    const reason = `邮件发送失败: ${failed
      .map((mail) => `${mail.email}（${mail.error || "未知原因"}）`)
      .join("；")}`;
    await record(false, duration, reason);
    await alertFailure(reason, targets);
    return { success: false, error: reason, result };
  }
  await record(
    true,
    duration,
    `评估 ${result.evaluated.length} 批，采集 ${result.collected.length}/${result.requested} 个策略，发送 ${result.mails.length} 封，用时 ${duration}ms`,
  );
  return { success: true, result };
}

module.exports = { runStockDigest };
