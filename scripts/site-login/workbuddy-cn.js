const BASE = "https://www.workbuddy.cn";
const SEND_SMS_URL = `${BASE}/v2/plugin/login/send-sms`;
const LOGIN_URL = `${BASE}/v2/plugin/login/token`;
const REFRESH_URL = "https://copilot.tencent.com/v2/plugin/auth/token/refresh";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.7204.251 Safari/537.36";
const TIMEOUT_MS = 15000;

function headers(extra) {
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    Origin: BASE,
    Referer: `${BASE}/`,
    "User-Agent": UA,
    ...extra,
  };
}

async function postJson(fetchImpl, url, body, extra) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: headers(extra),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(`请求 ${url} 失败：${error.message}`);
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`响应不是合法 JSON（HTTP ${response.status}）`);
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    throw new Error("响应格式异常");
  return payload;
}

/** 只要验证码登录或续期任一步返回非 0，都视为本次流程失败。 */
function ensureOk(payload, action) {
  if (payload.code === 0) return payload.data || {};
  throw new Error(`${action}失败：${payload.msg || payload.message || `code=${payload.code}`}`);
}

function tokenClaims(token) {
  try {
    return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
  } catch {
    return {};
  }
}

function pickCredentials(data) {
  const accessToken = data.accessToken || data.access_token || "";
  const refreshToken = data.refreshToken || data.refresh_token || "";
  if (!accessToken || !refreshToken)
    throw new Error("登录响应缺少 accessToken / refreshToken");
  return { accessToken, refreshToken };
}

async function sendSms(fetchImpl, phone) {
  const data = ensureOk(
    await postJson(fetchImpl, SEND_SMS_URL, { phone }),
    "发送验证码",
  );
  return Number(data.expires_in) || 300;
}

async function login(fetchImpl, phone, smsCode) {
  const data = ensureOk(
    await postJson(fetchImpl, LOGIN_URL, {
      login_method: "phone",
      phone,
      sms_code: smsCode,
    }),
    "登录",
  );
  return pickCredentials(data);
}

async function refresh(fetchImpl, credentials) {
  const payload = await postJson(
    fetchImpl,
    REFRESH_URL,
    {},
    {
      "X-Refresh-Token": credentials.refreshToken,
      "X-Auth-Refresh-Source": "plugin",
      "X-Domain": "www.workbuddy.cn",
    },
  );
  const data = ensureOk(payload, "验证 Refresh Token ");
  return pickCredentials(data);
}

/**
 * 交互式取一份可用凭据。
 * 默认先刷新一次：既验证 RT 可用，又能拿到轮换后的新令牌，避免入库即失效。
 */
async function obtain({
  phone = "",
  code = "",
  ask,
  log = () => {},
  fetchImpl = fetch,
  verify = true,
}) {
  const target = (phone || (await ask("📱 手机号: "))).trim();
  if (!/^\d{6,15}$/.test(target)) throw new Error("手机号格式不正确");

  let smsCode = code.trim();
  if (smsCode) {
    log("✅ 使用命令行提供的验证码");
  } else {
    const expires = await sendSms(fetchImpl, target);
    log(`✅ 验证码已发送（有效期 ${expires} 秒）`);
    smsCode = (await ask("📱 收到的验证码: ")).trim();
    if (!smsCode) throw new Error("验证码不能为空");
  }

  let credentials = await login(fetchImpl, target, smsCode);
  const claims = tokenClaims(credentials.accessToken);
  const account = claims.preferred_username || target;
  const exp = claims.exp
    ? new Date(claims.exp * 1000).toLocaleString("zh-CN", { hour12: false })
    : "未知";
  log(`✅ 登录成功：${account}（AT 过期：${exp}）`);

  if (verify) {
    credentials = await refresh(fetchImpl, credentials);
    log("✅ Refresh Token 验证通过，已换取轮换后的新令牌");
  }

  return { credentials, account };
}

const USAGE = "workbuddy-cn [--phone <手机号>] [--code <验证码>] [--no-verify]";
const DESCRIPTION = `短信验证码登录，换取 AT/RT 并直接入库。
  --phone <手机号>   缺省时交互输入
  --code <验证码>    缺省时先发送短信再交互输入
  --no-verify       跳过 Refresh Token 校验（不推荐）`;

/** 站点私有参数只在这里解析，通用入口不识别短信、手机号这类业务概念。 */
function parseOptions(argv) {
  const options = { phone: "", code: "", verify: true };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === "--phone") options.phone = argv[++i] ?? "";
    else if (item === "--code") options.code = argv[++i] ?? "";
    else if (item === "--no-verify") options.verify = false;
    else throw new Error(`workbuddy-cn 不支持参数：${item}`);
  }
  return options;
}

async function run(argv, { ask, log = () => {}, fetchImpl = fetch } = {}) {
  return obtain({ ...parseOptions(argv), ask, log, fetchImpl });
}

module.exports = {
  id: "workbuddy-cn",
  label: "WorkBuddy 国内版",
  summary: "短信验证码登录换取 AT/RT",
  usage: USAGE,
  description: DESCRIPTION,
  run,
  parseOptions,
  obtain,
};
