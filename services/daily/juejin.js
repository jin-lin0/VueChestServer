const { TaskError } = require("../../utils/taskCredentials");

const COOKIE_MAX_LENGTH = 4000;

/**
 * 掘金的 growth_api 要求浏览器生成的签名参数（a_bogus / msToken），
 * curl 直接请求只会拿到 HTTP 200 + 空 body。因此本任务标记为 worker 执行：
 * 服务器只负责配置凭据、接收上报，真正的签到/抽奖在带 Chromium 的 worker 里跑。
 */
function validateCredentials(input) {
  const raw = typeof input?.cookie === "string" ? input.cookie.trim() : "";
  if (!raw)
    throw new TaskError(
      "请填写掘金 Cookie（至少包含 sessionid）",
      "INVALID_DAILY_CREDENTIALS",
      400,
    );
  if (raw.length > COOKIE_MAX_LENGTH || /[\r\n]/.test(raw))
    throw new TaskError(
      "掘金 Cookie 格式不正确（过长或包含换行）",
      "INVALID_DAILY_CREDENTIALS",
      400,
    );
  // 允许只粘贴 sessionid 的裸值，这里补全成合法 Cookie
  const cookie = raw.includes("=") ? raw : `sessionid=${raw}`;
  if (!/(^|;\s*)sessionid=[^;\s]+/.test(cookie))
    throw new TaskError(
      "掘金 Cookie 里缺少 sessionid",
      "INVALID_DAILY_CREDENTIALS",
      400,
    );
  return { cookie };
}

async function run() {
  throw new TaskError(
    "掘金签到需要浏览器环境，请由外部 worker 执行并上报结果",
    "DAILY_REQUIRES_WORKER",
    400,
  );
}

module.exports = {
  id: "juejin",
  name: "掘金",
  description: "每日签到 + 免费抽奖（Chromium worker 执行）",
  timeZone: "Asia/Shanghai",
  executor: "worker",
  credentialFields: [
    {
      key: "cookie",
      label: "Cookie",
      type: "textarea",
      required: true,
      placeholder: "sessionid=...",
      help: "登录掘金后，从任意 api.juejin.cn 请求复制完整 Cookie；只填 sessionid 的值也可以",
    },
  ],
  validateCredentials,
  run,
};
