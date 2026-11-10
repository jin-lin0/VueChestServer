const { sendHtmlMail } = require("../../utils/mail");
const { ownerRecipient } = require("../../utils/notificationRecipients");
const safe = require("../../utils/escapeHtml");

/**
 * 任务失败只通知凭据归属人，告警本身失败也不能影响主流程，
 * 否则一次 SMTP 故障会把已经跑完的任务判成失败。
 */
async function notifyTaskFailure({ ownerId, task, summary }) {
  try {
    const { email } = await ownerRecipient(ownerId);
    await sendHtmlMail({
      to: email,
      subject: `【VueChest】${task.name} 执行失败`,
      html: `
        <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;padding:24px;">
          <h2 style="margin:0 0 8px;color:#1f2937;">${safe(task.name)} 执行失败</h2>
          <p style="color:#6b7280;margin:0 0 16px;font-size:14px;">站点：${safe(task.id)} · 账号：${safe(ownerId)}</p>
          <pre style="background:#fef2f2;color:#991b1b;padding:12px;border-radius:8px;white-space:pre-wrap;">${safe(summary)}</pre>
          <p style="color:#6b7280;font-size:13px;margin:16px 0 0;">请到超管后台的「每日任务」查看执行日志并修正凭据。</p>
        </div>
      `,
    });
    return true;
  } catch (error) {
    console.error("[daily] 失败告警发送失败:", error.message);
    return false;
  }
}

module.exports = { notifyTaskFailure };
