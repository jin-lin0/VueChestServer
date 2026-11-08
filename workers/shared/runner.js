const fs = require("node:fs");
const path = require("node:path");

/**
 * 所有站点共用的执行循环：
 * 取账号列表 → 每个超管独立 context → 站点流程跑一遍 → 上报结果。
 *
 * 站点只需要提供 flow：{ contextOptions, prepare, run }，
 * cookie、签名、页面操作这些站点私有细节都留在 flow 里。
 */
async function captureFailure(page, dir, task, ownerId) {
  if (!page) return;
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(dir, `${task}-${ownerId}-${stamp}.png`);
    await page.screenshot({ path: file, fullPage: true });
    console.error(`🖼 失败截图：${file}`);
  } catch {
    // 截图失败不影响上报
  }
}

async function runTask({
  task,
  flow,
  client,
  launcher,
  env = process.env,
  log = (...args) => console.log(...args),
  debugDir = env.WORKER_DEBUG_DIR || "debug",
}) {
  const only = env.CHECKIN_OWNER_ID ? Number(env.CHECKIN_OWNER_ID) : 0;
  const ownerIds = only ? [only] : await client.ownerIds(task);
  if (!ownerIds.length)
    throw new Error("没有超管配置该站点的凭据，请先在超管后台填写");

  const browser = await launcher.launch();
  let failed = 0;

  async function report(ownerId, result) {
    try {
      await client.report(task, ownerId, result);
      const summary = String(result.summary || "").trim();
      log(
        `📮 超管 ${ownerId} 上报成功：${result.status}${summary ? ` · ${summary}` : ""}`,
      );
      return true;
    } catch (error) {
      log(`❌ 超管 ${ownerId} 上报失败：${error.message}`);
      return false;
    }
  }

  try {
    for (const ownerId of ownerIds) {
      const since = Date.now();
      const context = await browser.newContext(flow.contextOptions(env));
      let page;
      try {
        const credentials = await client.credentials(task, ownerId);
        await flow.prepare(context, credentials, { env, log });
        page = await context.newPage();
        if (typeof page.setDefaultTimeout === "function")
          page.setDefaultTimeout(45000);

        const capture = () => captureFailure(page, debugDir, task, ownerId);
        const result = await flow.run(page, credentials, { env, log, capture });
        const ok = await report(ownerId, {
          status: result?.status || "success",
          summary: result?.summary || "",
          durationMs: Date.now() - since,
        });
        if (!ok) failed += 1;
      } catch (error) {
        log(`❌ 超管 ${ownerId}：${error.message}`);
        await captureFailure(page, debugDir, task, ownerId);
        const ok = await report(ownerId, {
          status: "failed",
          summary: error.message,
          durationMs: Date.now() - since,
        });
        failed += 1;
        if (!ok) log(`❌ 超管 ${ownerId} 的失败结果也没能上报`);
      } finally {
        await context.close().catch(() => {});
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  return { total: ownerIds.length, failed };
}

module.exports = { runTask };
