/**
 * 全局每日任务：工作日生成策略日报并发送给每个启用日报的超管。
 * 与凭据型任务的区别：没有 owner 凭据、不参与租约抢占，开关只决定「谁还收」。
 */

/** 把日报任务的返回结构收敛成和签到任务一致的 {success,status,summary}。 */
function toResult(outcome) {
  if (!outcome.success)
    return {
      success: false,
      status: "failed",
      summary: String(outcome.error || "策略日报执行失败"),
    };
  if (outcome.result.skipped)
    return {
      success: true,
      status: "skipped",
      summary: "所有超管都已暂停策略日报，本次跳过",
    };
  return {
    success: true,
    status: "success",
    summary: `发送 ${outcome.result.mails.length} 封；采集 ${outcome.result.collected.length}/${outcome.result.requested} 个策略`,
  };
}

module.exports = {
  id: "stock-digest",
  name: "策略选股日报",
  description: "工作日生成策略报告并发送到每个超管邮箱",
  timeZone: "Asia/Shanghai",
  executor: "global",
  requiresCredentials: false,
  credentialFields: [],
  async run() {
    // 延迟加载：日报依赖邮件与行情模块，不该在签到服务初始化时一起载入。
    const { runStockDigest } = require("../stockDigestJob");
    return toResult(await runStockDigest());
  },
};
