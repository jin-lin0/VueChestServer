const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";
const MAX_DRAWS = 5;

/** Cookie 字符串 → Playwright cookie 对象；只保留 name=value 对。 */
function cookiePairs(raw) {
  return String(raw || "")
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const index = item.indexOf("=");
      if (index <= 0) return null;
      return {
        name: item.slice(0, index),
        value: item.slice(index + 1),
        domain: ".juejin.cn",
        path: "/",
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
      };
    })
    .filter(Boolean);
}

/** 等页面自己发出的掘金接口，顺带把 JSON 解析出来。 */
function waitForApi(page, pathname, method = "GET", timeout = 45000) {
  return page
    .waitForResponse(
      (response) => {
        try {
          const url = new URL(response.url());
          return (
            url.hostname === "api.juejin.cn" &&
            url.pathname === pathname &&
            response.request().method() === method
          );
        } catch {
          return false;
        }
      },
      { timeout },
    )
    .then(async (response) => {
      const payload = await response.json().catch(() => null);
      if (!payload) throw new Error(`${pathname} 返回了非 JSON 响应，可能被风控`);
      return payload;
    });
}

function jjError(payload, action) {
  return new Error(
    `${action}失败：${payload?.err_msg || `err_no=${payload?.err_no}`}`,
  );
}

/** v2 状态接口可能返回布尔值或 { check_in_done } 对象。 */
function alreadyCheckedIn(data) {
  if (typeof data === "boolean") return data;
  if (data && typeof data === "object") return data.check_in_done === true;
  return false;
}

async function assertPageHealthy(page) {
  const body = await page.evaluate(() => document.body?.innerText || "");
  if (/访问异常|前往申诉|请稍后再试/.test(body))
    throw new Error(
      `掘金拦截了本次访问：${body.replace(/\s+/g, " ").slice(0, 80)}`,
    );
}

async function signIn(page) {
  const statusPromise = waitForApi(
    page,
    "/growth_api/v2/get_today_status",
  ).catch(() => null);
  await page.goto("https://juejin.cn/user/center/signin", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
  await assertPageHealthy(page);

  const status = await statusPromise;
  const button = page
    .getByRole("button", { name: /立即签到|今日已签到/ })
    .first();
  await button.waitFor({ state: "visible", timeout: 30000 });
  const label = ((await button.textContent()) || "").trim();
  if (alreadyCheckedIn(status?.data) || label.includes("今日已签到"))
    return { status: "already_done", summary: "今天已经签到过了" };

  const checkInPromise = waitForApi(page, "/growth_api/v1/check_in", "POST");
  await button.click();
  const payload = await checkInPromise;
  if (payload.err_no === 15001)
    return {
      status: "already_done",
      summary: payload.err_msg || "今天已经签到过了",
    };
  if (payload.err_no !== 0) throw jjError(payload, "签到");
  const incr = payload.data?.incr_point;
  return {
    status: "success",
    summary: incr == null ? "签到成功" : `签到成功，+${incr} 矿石`,
  };
}

async function drawFreeLottery(page) {
  const configPromise = waitForApi(page, "/growth_api/v1/lottery_config/get");
  await page.goto("https://juejin.cn/user/center/lottery", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
  await assertPageHealthy(page);

  const config = await configPromise;
  if (config.err_no !== 0) throw jjError(config, "查询抽奖次数");
  let freeCount = Number(config.data?.free_count ?? 0);
  if (freeCount <= 0) return { summary: "没有免费抽奖次数，已跳过" };

  const prizes = [];
  while (freeCount > 0 && prizes.length < MAX_DRAWS) {
    const drawPromise = waitForApi(page, "/growth_api/v1/lottery/draw", "POST");
    const clicked = await page.evaluate(() => {
      const target = document.querySelector(".turntable-item.lottery");
      if (!target) return false;
      target.click();
      return true;
    });
    if (!clicked) throw new Error("找不到抽奖转盘按钮，页面结构可能变了");

    const payload = await drawPromise;
    if (payload.err_no !== 0) {
      // 免费次数用完属于正常终止；其他错误抛给调用方记录
      const message = payload.err_msg || "";
      if (/次数|免费|不足/.test(message)) break;
      throw jjError(payload, "抽奖");
    }
    freeCount -= 1;
    prizes.push(payload.data?.lottery_name || "未知奖品");
    await page.waitForTimeout(1200);
  }
  if (!prizes.length) return { summary: "没有抽到奖品（免费次数已用尽）" };
  return { summary: `免费抽奖 ${prizes.length} 次：${prizes.join("、")}` };
}

module.exports = {
  id: "juejin",
  contextOptions(env) {
    return {
      locale: "zh-CN",
      timezoneId: "Asia/Shanghai",
      userAgent: env.JUEJIN_USER_AGENT || DEFAULT_USER_AGENT,
      viewport: { width: 1440, height: 960 },
    };
  },
  async prepare(context, credentials) {
    if (!credentials?.cookie) throw new Error("服务端没有返回掘金 Cookie");
    await context.addCookies(cookiePairs(credentials.cookie));
  },
  async run(page, credentials, { capture } = {}) {
    const checkin = await signIn(page);
    let lottery = null;
    let lotteryError = "";
    try {
      lottery = await drawFreeLottery(page);
    } catch (error) {
      lotteryError = error.message;
      if (capture) await capture();
    }
    const summary = [
      checkin.summary,
      lottery?.summary,
      lotteryError && `抽奖失败：${lotteryError}`,
    ]
      .filter(Boolean)
      .join("；");
    return { status: checkin.status, summary };
  },
};
