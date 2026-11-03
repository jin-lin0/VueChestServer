const { randomUUID } = require("node:crypto");
const { CheckinError } = require("../../utils/checkinCredentials");

const BASE = "https://www.workbuddy.cn";
const REFRESH = "https://copilot.tencent.com/v2/plugin/auth/token/refresh";
const STATUS = `${BASE}/v2/billing/meter/checkin-activity-status`;
const CLAIM = `${BASE}/v2/billing/meter/daily-checkin`;
const ok = (code) => [0, 200, "0", "200"].includes(code);

function subject(token) {
  try {
    const sub = JSON.parse(
      Buffer.from(token.split(".")[1], "base64url").toString("utf8"),
    ).sub;
    return typeof sub === "string" && sub.length <= 200 && !/[\r\n]/.test(sub)
      ? sub
      : "";
  } catch {
    return "";
  }
}

function validateCredentials(input) {
  const accessToken =
    typeof input?.accessToken === "string" ? input.accessToken.trim() : "";
  const refreshToken =
    typeof input?.refreshToken === "string" ? input.refreshToken.trim() : "";
  if (
    !accessToken ||
    !refreshToken ||
    accessToken.length > 20000 ||
    refreshToken.length > 20000 ||
    /\s/.test(accessToken + refreshToken) ||
    !subject(accessToken)
  ) {
    throw new CheckinError(
      "请提供国内版有效格式的 Access Token 和 Refresh Token",
      "INVALID_CHECKIN_CREDENTIALS",
      400,
    );
  }
  return { accessToken, refreshToken };
}

async function run({
  credentials,
  saveCredentials,
  signal,
  fetchImpl = fetch,
}) {
  let current = validateCredentials(credentials);
  let refreshed = false;

  async function request(url, refreshing = false) {
    signal.throwIfAborted();
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${current.accessToken}`,
      "X-User-Id": subject(current.accessToken),
      Origin: BASE,
      Referer: `${BASE}/profile/growth-center`,
    };
    if (refreshing)
      Object.assign(headers, {
        "X-Refresh-Token": current.refreshToken,
        "X-Auth-Refresh-Source": "plugin",
        "X-Domain": "www.workbuddy.cn",
        "X-Request-ID": randomUUID(),
      });
    let response, payload;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers,
        body: "{}",
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
      });
      payload = await response.json();
    } catch {
      throw new CheckinError(
        "WorkBuddy 请求超时或响应不可用，请稍后重试",
        "WORKBUDDY_NETWORK_ERROR",
      );
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new CheckinError(
        "WorkBuddy 响应格式异常",
        "WORKBUDDY_INVALID_RESPONSE",
      );
    }
    if ([11140, "11140"].includes(payload.code)) {
      throw new CheckinError(
        "WorkBuddy 账号受限，请在官方客户端确认状态",
        "WORKBUDDY_RESTRICTED",
      );
    }
    return { response, payload };
  }

  async function refresh() {
    if (refreshed)
      throw new CheckinError(
        "WorkBuddy 登录已失效，请重新录入凭据",
        "WORKBUDDY_AUTH_EXPIRED",
      );
    refreshed = true;
    const { response, payload } = await request(REFRESH, true);
    if (!response.ok || !ok(payload.code) || !payload.data?.accessToken) {
      throw new CheckinError(
        "WorkBuddy 令牌续期失败，请重新登录",
        "WORKBUDDY_REFRESH_FAILED",
      );
    }
    const next = validateCredentials({
      accessToken: payload.data.accessToken,
      refreshToken: payload.data.refreshToken || current.refreshToken,
    });
    if (subject(next.accessToken) !== subject(current.accessToken)) {
      throw new CheckinError(
        "WorkBuddy 续期返回了不同账号，已停止",
        "WORKBUDDY_IDENTITY_CHANGED",
      );
    }
    // 先持久化轮换令牌，再继续签到，避免下次冷启动使用旧令牌。
    await saveCredentials(next);
    signal.throwIfAborted();
    current = next;
  }

  async function status() {
    let result = await request(STATUS);
    if (result.response.status === 401 && !refreshed) {
      await refresh();
      result = await request(STATUS);
    }
    const { response, payload } = result;
    if (!response.ok || !ok(payload.code)) {
      throw new CheckinError(
        "WorkBuddy 签到状态查询失败，请确认账号权限和登录状态",
        "WORKBUDDY_STATUS_FAILED",
      );
    }
    const data = payload.data;
    if (!data || typeof data.active !== "boolean") {
      throw new CheckinError(
        "WorkBuddy 签到状态字段不完整",
        "WORKBUDDY_INVALID_STATE",
      );
    }
    return data;
  }

  let state = await status();
  if (!state.active)
    return { status: "inactive", summary: "签到活动未开放，本次跳过" };
  if ([true, 1].includes(state.today_checked_in)) {
    return { status: "already_done", summary: "上游确认今日已经签到" };
  }
  if (![false, 0].includes(state.today_checked_in)) {
    throw new CheckinError("无法确认今日是否已签到", "WORKBUDDY_INVALID_STATE");
  }
  const claim = await request(CLAIM);
  if (claim.response.status === 401 && !refreshed) {
    await refresh();
    state = await status();
    if (!state.active)
      return { status: "inactive", summary: "签到活动未开放，本次跳过" };
    if (![true, 1, false, 0].includes(state.today_checked_in)) {
      throw new CheckinError(
        "无法确认今日是否已签到",
        "WORKBUDDY_INVALID_STATE",
      );
    }
    if ([false, 0].includes(state.today_checked_in)) await request(CLAIM);
  }
  state = await status();
  if (![true, 1].includes(state.today_checked_in)) {
    throw new CheckinError(
      "WorkBuddy 尚未确认签到成功，可稍后手动重试",
      "WORKBUDDY_UNCONFIRMED",
    );
  }
  return { status: "success", summary: "上游回读确认今日签到成功" };
}

module.exports = {
  id: "workbuddy-cn",
  name: "WorkBuddy 国内版",
  timeZone: "Asia/Shanghai",
  validateCredentials,
  run,
};
