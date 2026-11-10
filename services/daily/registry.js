const workbuddy = require("./workbuddy");
const juejin = require("./juejin");
const stockDigest = require("./stockDigest");

/**
 * 每天执行的任务清单。
 * - server：服务器直接执行（凭据 + 租约 + 幂等）
 * - worker：需要浏览器，由外部 worker 执行后上报结果
 * - global：全局任务，没有账号凭据，有自己的执行入口（如 Vercel cron）
 */
const tasks = [workbuddy, juejin];
const globalTasks = [stockDigest];

module.exports = { tasks, globalTasks };
