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

function accountId(ownerId, taskId) {
  return `${ownerId}:${taskId}`;
}

function requireOwnerId(ownerId) {
  const id = Number(ownerId);
  if (!Number.isInteger(id) || id < 1)
    throw new CheckinError(
      "缺少有效的签到归属用户",
      "CHECKIN_OWNER_REQUIRED",
      400,
    );
  return id;
}

function createCheckinService({
  State,
  Run,
  registry = tasks,
  now = Date.now,
  budgetMs = positiveInt(process.env.CHECKIN_BUDGET_MS, DEFAULT_BUDGET_MS),
  taskMs = positiveInt(process.env.CHECKIN_TASK_TIMEOUT_MS, DEFAULT_TASK_MS),
}) {
  async function execute(task, ownerId, deadline, { force = false } = {}) {
    const owner = requireOwnerId(ownerId);
    const id = accountId(owner, task.id);
    const configured = await State.findByPk(id, { attributes: ["id"] });
    if (!configured)
      return {
        task: task.id,
        ownerId: owner,
        status: "unconfigured",
        summary: "未录入凭据，跳过",
      };
    const day = dayKey(now(), task.timeZone);
    const leaseToken = randomUUID();
    const claimable = [
      {
        [Op.or]: [
          { leaseUntil: null },
          { leaseUntil: { [Op.lte]: new Date(now()) } },
        ],
      },
    ];
    // 超管手动执行时可显式忽略「当日已完成」，仅跳过幂等判断；
    // 租约仍然生效，避免与定时任务或其他实例并发重复领取。
    if (!force)
      claimable.push({
        [Op.or]: [
          { lastCompletedDate: null },
          { lastCompletedDate: { [Op.ne]: day } },
        ],
      });
    const [claimed] = await State.update(
      { leaseToken, leaseUntil: new Date(now() + 90000) },
      {
        where: {
          id,
          [Op.and]: claimable,
        },
      },
    );
    if (!claimed)
      return {
        task: task.id,
        ownerId: owner,
        status: "skipped",
        summary: "今日已完成或正在执行",
      };
    const owned = { id, leaseToken };
    const started = now();
    const controller = new AbortController();
    let timer, result;
    try {
      const latest = await State.findByPk(id);
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
        id,
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
              id,
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
        ownerId: owner,
        status: "failed",
        summary: "执行状态未能确认，稍后重试将回读上游状态",
      };
    let recorded = true;
    try {
      await Run.create({
        job: `checkin:${task.id}`,
        ownerId: owner,
        success: result.status !== "failed",
        durationMs: now() - started,
        detail: `${result.status}: ${result.summary}`,
      });
    } catch {
      recorded = false;
    }
    return { task: task.id, ownerId: owner, ...result, recorded };
  }

  function findTask(taskId) {
    const task = registry.find((item) => item.id === taskId);
    if (!task)
      throw new CheckinError("未注册的签到服务", "UNKNOWN_CHECKIN_TASK", 400);
    return task;
  }

  async function configure(ownerId, taskId, value) {
    const owner = requireOwnerId(ownerId);
    const task = findTask(taskId);
    const id = accountId(owner, task.id);
    const credentials = encryptCredentials(
      task.validateCredentials(value),
      id,
      task.id,
    );
    const [, created] = await State.findOrCreate({
      where: { id },
      defaults: { ownerId: owner, taskId: task.id, credentials },
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
            id,
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
    return { task: task.id, ownerId: owner, configured: true };
  }

  /**
   * 清除凭据等同于停用该任务：删除记录后定时轮次会以 unconfigured 跳过。
   * 执行中的任务拒绝清除，避免适配器写回凭据时把记录重新创建出来。
   */
  async function clear(ownerId, taskId) {
    const owner = requireOwnerId(ownerId);
    const task = findTask(taskId);
    const id = accountId(owner, task.id);
    const [removed] = await State.destroy({
      where: {
        id,
        [Op.or]: [
          { leaseUntil: null },
          { leaseUntil: { [Op.lte]: new Date(now()) } },
        ],
      },
    });
    if (removed) return { task: task.id, ownerId: owner, configured: false };
    const existing = await State.findByPk(id, { attributes: ["id"] });
    if (!existing)
      return { task: task.id, ownerId: owner, configured: false };
    throw new CheckinError("任务正在执行，请稍后清除凭据", "CHECKIN_BUSY", 409);
  }

  /**
   * 超管后台的「立即执行」：只跑一个任务，返回与 runAll 同形结果。
   * force=true 时忽略当日幂等，用于换号或联调后的主动复核。
   */
  async function runOne(ownerId, taskId, { force = false } = {}) {
    const owner = requireOwnerId(ownerId);
    const task = findTask(taskId);
    const deadline = now() + budgetMs;
    let result;
    try {
      result = await execute(task, owner, deadline, { force: force === true });
    } catch (error) {
      result = {
        task: task.id,
        ownerId: owner,
        status: "failed",
        summary: safeSummary(error),
        recorded: false,
      };
    }
    return {
      success:
        !["failed", "deferred"].includes(result.status) &&
        result.recorded !== false,
      results: [result],
    };
  }

  async function runAll() {
    const deadline = now() + budgetMs;
    // 定时入口要跑所有超管已配置的账号；某站点完全没有配置时仍给出一条
    // unconfigured 结果，便于从 cron_runs/响应中看出「没配」而非「漏跑」。
    const slots = [];
    for (const task of registry) {
      const rows = await State.findAll({
        where: { taskId: task.id },
        attributes: ["ownerId"],
        order: [["ownerId", "ASC"]],
      });
      if (rows.length === 0) slots.push({ task, ownerId: null });
      else
        for (const row of rows)
          slots.push({ task, ownerId: row.ownerId });
    }
    const results = new Array(slots.length);
    let cursor = 0;
    async function worker() {
      while (cursor < slots.length) {
        const i = cursor++;
        const slot = slots[i];
        if (slot.ownerId === null) {
          results[i] = {
            task: slot.task.id,
            status: "unconfigured",
            summary: "未录入凭据，跳过",
          };
          continue;
        }
        if (deadline - now() < 5000) {
          results[i] = {
            task: slot.task.id,
            ownerId: slot.ownerId,
            status: "deferred",
            summary: "本轮时间预算不足，请手动补跑",
          };
          continue;
        }
        try {
          results[i] = await execute(slot.task, slot.ownerId, deadline);
        } catch (error) {
          results[i] = {
            task: slot.task.id,
            ownerId: slot.ownerId,
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
  return { runAll, runOne, configure, clear };
}

module.exports = { tasks, dayKey, accountId, createCheckinService };
