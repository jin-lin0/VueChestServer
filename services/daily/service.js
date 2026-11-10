const { Op } = require("sequelize");
const {
  TaskError,
  encryptCredentials,
  decryptCredentials,
} = require("../../utils/taskCredentials");
const { executionJob } = require("../../utils/cronJobs");
const { positiveInt } = require("../westock/limiter");
const { notifyTaskFailure } = require("./notify");
const {
  leaseDuration,
  claimLease,
  releaseLease,
  assertLeaseHeld,
} = require("./lease");
const { tasks: defaultRegistry } = require("./registry");

// 开启 Fluid Compute 后 Hobby 的默认与上限均为 300s（vercel.json maxDuration），
// 预算给冷启动、数据库连接和响应留出余量。预算只是上限，不预占时长。
const DEFAULT_BUDGET_MS = 240000;
const DEFAULT_TASK_MS = 60000;

// worker 任务只接受外部上报，服务器不直接执行，也不参与定时轮次。
const WORKER_STATUSES = new Set(["success", "already_done", "skipped", "failed"]);
// 服务器执行的适配器允许返回的终态（inactive = 上游活动未开放）。
const SERVER_STATUSES = ["success", "already_done", "inactive"];
const COMPLETED_STATUSES = ["success", "already_done"];

function dayKey(now, timeZone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(now));
}

function accountId(ownerId, taskId) {
  return `${ownerId}:${taskId}`;
}

/**
 * 非 TaskError 是程序或数据库异常：对外只给通用摘要，
 * 但必须把原始错误留在函数日志里，否则执行记录无法定位。
 */
function safeSummary(error) {
  if (error instanceof TaskError) return error.message;
  console.error("[daily] 任务执行异常:", error);
  return "任务执行失败，请检查数据库或上游服务后重试";
}

function enabledOwners(rows) {
  return rows.filter((row) => row.enabled !== false).map((row) => row.ownerId);
}

function requireOwnerId(ownerId) {
  const id = Number(ownerId);
  if (!Number.isInteger(id) || id < 1)
    throw new TaskError("缺少有效的任务归属用户", "DAILY_OWNER_REQUIRED", 400);
  return id;
}

/**
 * worker 只关心"该站点是谁的凭据"，不该在 CI 里硬编码超管 ID。
 * 只有一个超管配置了该站点时自动归属；多个时才要求显式指定，避免写错账号。
 */
async function resolveWorkerOwner(State, ownerId, taskId) {
  if (ownerId !== undefined && ownerId !== null && ownerId !== "")
    return requireOwnerId(ownerId);
  const rows = await State.findAll({
    where: { taskId },
    attributes: ["ownerId"],
    order: [["ownerId", "ASC"]],
  });
  if (rows.length === 0)
    throw new TaskError(
      "尚未录入该站点的凭据，请先在超管后台配置",
      "DAILY_UNCONFIGURED",
      404,
    );
  if (rows.length > 1)
    throw new TaskError(
      `有 ${rows.length} 个超管配置了该站点，请显式指定 ownerId`,
      "DAILY_OWNER_REQUIRED",
      400,
    );
  return rows[0].ownerId;
}

function createDailyTaskService({
  State,
  Run,
  registry = defaultRegistry,
  now = Date.now,
  budgetMs = positiveInt(process.env.DAILY_BUDGET_MS, DEFAULT_BUDGET_MS),
  taskMs = positiveInt(process.env.DAILY_TASK_TIMEOUT_MS, DEFAULT_TASK_MS),
  notify = notifyTaskFailure,
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
    // 单次执行的实际超时由「单任务上限」和「本轮剩余预算」共同决定；
    // 租约必须比它更长，否则任务还没结束就会被别的实例抢走。
    const runMs = Math.max(1, Math.min(taskMs, deadline - now()));
    const leaseToken = await claimLease(State, {
      id,
      day,
      leaseMs: leaseDuration(runMs),
      now: now(),
      force,
    });
    if (!leaseToken)
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
      const latest = await assertLeaseHeld(
        State,
        owned,
        now(),
        "任务锁已失效，已停止执行",
      );
      if (now() >= deadline)
        throw new TaskError("本轮时间已耗尽，请稍后重试", "DAILY_TIMEOUT");
      const credentials = decryptCredentials(
        latest.credentials,
        id,
        task.id,
      );
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new TaskError("任务执行超时，可稍后重试", "DAILY_TIMEOUT"));
        }, runMs);
      });
      const running = Promise.resolve().then(() =>
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
              throw new TaskError(
                "任务锁已失效，停止更新凭据",
                "DAILY_LEASE_LOST",
              );
            controller.signal.throwIfAborted();
          },
        }),
      );
      // 超时后适配器仍可能在跑，它的迟到失败属于已放弃的执行，不能再冒泡。
      running.catch(() => {});
      result = await Promise.race([running, timeout]);
      if (
        !SERVER_STATUSES.includes(result?.status) ||
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
    const completed = COMPLETED_STATUSES.includes(result.status);
    const released = await releaseLease(State, owned, { day, completed });
    if (!released)
      return {
        task: task.id,
        ownerId: owner,
        status: "failed",
        summary: "执行状态未能确认，稍后重试将回读上游状态",
      };
    let recorded = true;
    try {
      await Run.create({
        job: executionJob(task.id),
        ownerId: owner,
        success: result.status !== "failed",
        durationMs: now() - started,
        detail: `${result.status}: ${result.summary}`,
      });
    } catch {
      recorded = false;
    }
    if (result.status === "failed")
      await notify({ ownerId: owner, task, summary: result.summary });
    return { task: task.id, ownerId: owner, ...result, recorded };
  }

  function findTask(taskId) {
    const task = registry.find((item) => item.id === taskId);
    if (!task)
      throw new TaskError("未注册的每日任务", "UNKNOWN_DAILY_TASK", 400);
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
        throw new TaskError(
          "任务正在执行，请稍后更新凭据",
          "DAILY_BUSY",
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
    throw new TaskError("任务正在执行，请稍后清除凭据", "DAILY_BUSY", 409);
  }

  /**
   * 暂停/恢复只影响定时轮次和 worker 账号列表，不动凭据。
   * 手动执行仍然放行，方便排查「关了之后是不是站点本身的问题」。
   */
  async function setEnabled(ownerId, taskId, enabled) {
    const owner = requireOwnerId(ownerId);
    const task = findTask(taskId);
    if (task.requiresCredentials === false)
      throw new TaskError(
        "全局任务的开关键由每日任务路由维护",
        "DAILY_NOT_DAILY_TASK",
        400,
      );
    const id = accountId(owner, task.id);
    const row = await State.findByPk(id, { attributes: ["id"] });
    if (!row)
      throw new TaskError(
        "该任务尚未配置凭据，无法启用",
        "DAILY_UNCONFIGURED",
        400,
      );
    const on = enabled === true;
    await State.update({ enabled: on }, { where: { id } });
    return { task: task.id, ownerId: owner, enabled: on };
  }

  /**
   * 只对 worker 任务开放：worker 需要用同一份加密凭据执行浏览器流程。
   * 服务器自执行的任务（如 WorkBuddy 的 AT/RT）永远不能通过这里读出。
   */
  async function workerCredentials(ownerId, taskId) {
    const task = findTask(taskId);
    if (task.executor !== "worker")
      throw new TaskError(
        "该任务由服务器执行，不向 worker 提供凭据",
        "DAILY_NOT_WORKER_TASK",
        400,
      );
    const owner = await resolveWorkerOwner(State, ownerId, task.id);
    const row = await State.findByPk(accountId(owner, task.id));
    if (!row)
      throw new TaskError(
        "尚未录入该站点的凭据，请先在超管后台配置",
        "DAILY_UNCONFIGURED",
        404,
      );
    return {
      task: task.id,
      ownerId: owner,
      credentials: decryptCredentials(row.credentials, row.id, task.id),
    };
  }

  /**
   * 列出某个 worker 任务下所有已配置凭据的归属，让一次 worker 运行
   * 就能覆盖全部超管，新增超管时不用改 workflow。
   */
  async function workerAccounts(taskId) {
    const task = findTask(taskId);
    if (task.executor !== "worker")
      throw new TaskError(
        "该任务由服务器执行，没有 worker 账号列表",
        "DAILY_NOT_WORKER_TASK",
        400,
      );
    const rows = await State.findAll({
      where: { taskId: task.id },
      attributes: ["ownerId", "enabled"],
      order: [["ownerId", "ASC"]],
    });
    return {
      task: task.id,
      ownerIds: enabledOwners(rows),
    };
  }

  /**
   * 外部 worker 的结果上报：只落 cron_runs，成功时标记当日已完成，
   * 避免超管后台把它显示成"待执行"。
   */
  async function report(ownerId, taskId, { status, summary, durationMs } = {}) {
    const task = findTask(taskId);
    if (task.executor !== "worker")
      throw new TaskError(
        "该任务由服务器执行，不接受外部上报",
        "DAILY_NOT_WORKER_TASK",
        400,
      );
    const normalized = typeof status === "string" ? status.trim() : "";
    if (!WORKER_STATUSES.has(normalized))
      throw new TaskError(
        "上报状态不合法，只能是 success / already_done / skipped / failed",
        "INVALID_DAILY_STATUS",
        400,
      );
    const owner = await resolveWorkerOwner(State, ownerId, task.id);
    const text =
      typeof summary === "string" ? summary.trim().slice(0, 500) : "";
    const duration =
      Number.isInteger(durationMs) && durationMs >= 0
        ? Math.min(durationMs, 3600000)
        : null;
    const success = normalized !== "failed";
    if (success) {
      await State.update(
        { lastCompletedDate: dayKey(now(), task.timeZone) },
        { where: { id: accountId(owner, task.id) } },
      );
    }
    await Run.create({
      job: executionJob(task.id),
      ownerId: owner,
      success,
      // cron_runs.durationMs 非空；worker 没上报耗时就记 0
      durationMs: duration ?? 0,
      detail: `${normalized}: ${text || "无摘要"}`,
    });
    if (!success)
      await notify({ ownerId: owner, task, summary: text || normalized });
    return { task: task.id, ownerId: owner, status: normalized, recorded: true };
  }

  /**
   * 超管后台的「立即执行」：只跑一个任务，返回与 runAll 同形结果。
   * force=true 时忽略当日幂等，用于换号或联调后的主动复核。
   */
  async function runOne(ownerId, taskId, { force = false } = {}) {
    const owner = requireOwnerId(ownerId);
    const task = findTask(taskId);
    if (task.executor === "worker")
      throw new TaskError(
        "该任务由外部 worker 执行，服务器无法直接运行",
        "DAILY_REQUIRES_WORKER",
        400,
      );
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
      await notify({ ownerId: owner, task, summary: result.summary });
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
      if (task.executor === "worker") continue;
      const rows = await State.findAll({
        where: { taskId: task.id },
        attributes: ["ownerId", "enabled"],
        order: [["ownerId", "ASC"]],
      });
      if (rows.length === 0) slots.push({ task, ownerId: null });
      else
        for (const ownerId of enabledOwners(rows))
          slots.push({ task, ownerId });
    }
    const results = new Array(slots.length);
    let cursor = 0;
    // 并发 2 个账号：Vercel 函数内多个账号并行执行，同时给每个账号留出
    // 单任务超时预算；预算不足时后续账号以 deferred 结束、等手动补跑。
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
          await notify({
            ownerId: slot.ownerId,
            task: slot.task,
            summary: results[i].summary,
          });
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

  return {
    runAll,
    runOne,
    configure,
    clear,
    setEnabled,
    workerCredentials,
    workerAccounts,
    report,
  };
}

module.exports = {
  createDailyTaskService,
  dayKey,
  accountId,
};
