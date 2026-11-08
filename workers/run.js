#!/usr/bin/env node
/**
 * worker 统一入口：node run.js <task>
 *
 * 站点私有逻辑在 workers/<task>/flow.js，共享调度在 workers/shared/。
 * 新增一个需要浏览器的站点 = 服务端加 worker 适配器 + 这里加一个 flow.js。
 */
const { chromium } = require("playwright");
const { createClient } = require("./shared/api");
const { runTask } = require("./shared/runner");

function fail(message) {
  console.error(`❌ ${message}`);
  process.exit(1);
}

const task = process.argv[2];
if (!task) fail("用法: node run.js <task>，例如 node run.js juejin");

let flow;
const flowPath = `./${task}/flow`;
try {
  // 只允许加载本目录下的流程，避免路径穿越
  if (!/^[a-z0-9-]{1,40}$/.test(task)) fail(`任务名不合法：${task}`);
  flow = require(flowPath);
} catch (error) {
  // 只把"没这个文件"翻译成友好提示，flow 自身的语法/依赖错误要原样暴露
  const missingFlow =
    error.code === "MODULE_NOT_FOUND" &&
    String(error.message).includes(`${task}/flow`);
  if (!missingFlow) throw error;
  fail(`没有找到 workers/${task}/flow.js`);
}
if (flow.id !== task) fail(`workers/${task}/flow.js 的 id 与任务名不一致`);

const server = (process.env.CHECKIN_SERVER || "").replace(/\/+$/, "");
const secret = process.env.CRON_SECRET || "";
if (!server || !secret)
  fail("缺少环境变量：CHECKIN_SERVER、CRON_SECRET");

runTask({
  task,
  flow,
  client: createClient({ server, secret }),
  launcher: chromium,
})
  .then((result) => {
    if (result.failed) {
      console.error(`❌ ${result.failed}/${result.total} 个账号执行失败`);
      process.exitCode = 1;
    }
  })
  .catch((error) => {
    console.error(`❌ ${error.message}`);
    process.exitCode = 1;
  });
