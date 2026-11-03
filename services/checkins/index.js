const { randomUUID } = require("node:crypto");
const { Op } = require("sequelize");
const {
  CheckinError,
  encryptCredentials,
  decryptCredentials,
} = require("../../utils/checkinCredentials");
const { positiveInt } = require("../westock/limiter");
const workbuddy = require("./workbuddy");

const tasks = [workbuddy];

// 开启 Fluid Compute 后 Hobby 的默认与上限均为 300s（vercel.json maxDuration），
// 预算给冷启动、数据库连接和响应留出余量。预算只是上限，不预占时长。
const DEFAULT_BUDGET_MS = 240000;
const DEFAULT_TASK_MS = 60000;

function dayKey(now, timeZone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(now));
}
function safeSummary(error) {
  return error instanceof CheckinError
    ? error.message
    : "签到执行失败，请检查数据库或上游服务后重试";
}

function createCheckinService({
  State,
  Run,
  registry = tasks,
  now = Date.now,
  budgetMs = positiveInt(process.env.CHECKIN_BUDGET_MS, DEFAULT_BUDGET_MS),
  taskMs = positiveInt(process.env.CHECKIN_TASK_TIMEOUT_MS, DEFAULT_TASK_MS),
}) {
  async function execute(task, deadline) {
    const configured = await State.findByPk(task.id, { attributes: ["id"] });
    if (!configured)
      return {
        task: task.id,
        status: "unconfigured",
        summary: "未录入凭据，跳过",
      };
    const day = dayKey(now(), task.timeZone);
    const leaseToken = randomUUID();
    const [claimed] = await State.update(
      { leaseToken, leaseUntil: new Date(now() + 90000) },
      {
        where: {
          id: task.id,
          [Op.and]: [
            {
              [Op.or]: [
                { leaseUntil: null },
                { leaseUntil: { [Op.lte]: new Date(now()) } },
              ],
            },
            {
              [Op.or]: [
                { lastCompletedDate: null },
                { lastCompletedDate: { [Op.ne]: day } },
              ],
            },
          ],
        },
      },
    );
    if (!claimed)
      return {
        task: task.id,
        status: "skipped",
        summary: "今日已完成或正在执行",
      };
    const owned = { id: task.id, leaseToken };
    const started = now();
    const controller = new AbortController();
    let timer, result;
    try {
      const latest = await State.findByPk(task.id);
      if (
        !latest ||
        latest.leaseToken !== leaseToken ||
        new Date(latest.leaseUntil).getTime() <= now()
      ) {
        throw new CheckinError(
          "签到任务锁已失效，已停止执行",
          "CHECKIN_LEASE_LOST",
        );
      }
      if (now() >= deadline)
        throw new CheckinError("本轮时间已耗尽，请稍后重试", "CHECKIN_TIMEOUT");
      const credentials = decryptCredentials(
        latest.credentials,
        task.id,
        task.id,
      );
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(
          () => {
            controller.abort();
            reject(
              new CheckinError("签到执行超时，可稍后重试", "CHECKIN_TIMEOUT"),
            );
          },
          Math.max(1, Math.min(taskMs, deadline - now())),
        );
      });
      result = await Promise.race([
        task.run({
          credentials,
          signal: controller.signal,
          saveCredentials: async (next) => {
            controller.signal.throwIfAborted();
            const encrypted = encryptCredentials(
              task.validateCredentials(next),
              task.id,
              task.id,
            );
            const [saved] = await State.update(
              { credentials: encrypted },
              { where: owned },
            );
            if (!saved)
              throw new CheckinError(
                "签到任务锁已失效，停止更新凭据",
                "CHECKIN_LEASE_LOST",
              );
            controller.signal.throwIfAborted();
          },
        }),
        timeout,
      ]);
      if (
        !["success", "already_done", "inactive"].includes(result?.status) ||
        typeof result.summary !== "string" ||
        result.summary.length > 500
      )
        throw new Error("Invalid task result");
      result = { status: result.status, summary: result.summary };
    } catch (error) {
      result = { status: "failed", summary: safeSummary(error) };
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
    const completed = ["success", "already_done"].includes(result.status);
    const [finished] = await State.update(
      {
        leaseToken: null,
        leaseUntil: null,
        ...(completed ? { lastCompletedDate: day } : {}),
      },
      { where: owned },
    );
    if (!finished)
      return {
        task: task.id,
        status: "failed",
        summary: "执行状态未能确认，稍后重试将回读上游状态",
      };
    let recorded = true;
    try {
      await Run.create({
        job: `checkin:${task.id}`,
        success: result.status !== "failed",
        durationMs: now() - started,
        detail: `${result.status}: ${result.summary}`,
      });
    } catch {
      recorded = false;
    }
    return { task: task.id, ...result, recorded };
  }

  async function configure(taskId, value) {
    const task = registry.find((item) => item.id === taskId);
    if (!task)
      throw new CheckinError("未注册的签到服务", "UNKNOWN_CHECKIN_TASK", 400);
    const credentials = encryptCredentials(
      task.validateCredentials(value),
      task.id,
      task.id,
    );
    const [, created] = await State.findOrCreate({
      where: { id: task.id },
      defaults: { credentials },
    });
    if (!created) {
      const [updated] = await State.update(
        {
          credentials,
          lastCompletedDate: null,
          leaseToken: null,
          leaseUntil: null,
        },
        {
          where: {
            id: task.id,
            [Op.or]: [
              { leaseUntil: null },
              { leaseUntil: { [Op.lte]: new Date(now()) } },
            ],
          },
        },
      );
      if (!updated)
        throw new CheckinError(
          "任务正在执行，请稍后更新凭据",
          "CHECKIN_BUSY",
          409,
        );
    }
    return { task: task.id, configured: true };
  }

  async function runAll() {
    const deadline = now() + budgetMs;
    const results = new Array(registry.length);
    let cursor = 0;
    async function worker() {
      while (cursor < registry.length) {
        const i = cursor++;
        if (deadline - now() < 5000) {
          results[i] = {
            task: registry[i].id,
            status: "deferred",
            summary: "本轮时间预算不足，请手动补跑",
          };
          continue;
        }
        try {
          results[i] = await execute(registry[i], deadline);
        } catch (error) {
          results[i] = {
            task: registry[i].id,
            status: "failed",
            summary: safeSummary(error),
          };
        }
      }
    }
    await Promise.all([worker(), worker()]);
    return {
      success: results.every(
        (r) =>
          !["failed", "deferred"].includes(r.status) && r.recorded !== false,
      ),
      results,
    };
  }
  return { runAll, configure };
}

module.exports = { tasks, dayKey, createCheckinService };
