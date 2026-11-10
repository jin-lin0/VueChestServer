const express = require("express");
const State = require("../models/dailyTaskState");
const Run = require("../models/cronRun");
const cronAuth = require("../middleware/cronAuth");
const { authMiddleware } = require("../middleware/auth");
const { superAdminOnly } = require("../middleware/superAdmin");
const { TaskError } = require("../utils/taskCredentials");
const {
  executionJob,
  configJob,
  taskIdFromJob,
  executionWhere,
  configWhere,
} = require("../utils/cronJobs");
const {
  tasks,
  globalTasks,
  dayKey,
  accountId,
  createDailyTaskService,
} = require("../services/daily");

const service = createDailyTaskService({ State, Run });
const router = express.Router();
const registry = [...tasks, ...globalTasks];
const globalTaskIds = globalTasks.map((task) => task.id);

function findTask(taskId) {
  const task = registry.find((item) => item.id === taskId);
  if (!task)
    throw new TaskError("未注册的每日任务", "UNKNOWN_DAILY_TASK", 400);
  return task;
}

async function run(req, res) {
  const result = await service.runAll();
  res.status(result.success ? 200 : 502).json(result);
}

// 个人运维入口：定时触发和手动补跑都只使用 Cron 密钥。
router.route("/run").get(cronAuth, run).post(cronAuth, run);

// 机器写入凭据；与定时入口使用同一运维密钥。读取只开放给 worker 任务，见下方 GET。
// 多超管模式下必须用 ownerId 指明凭据归属，
// 日常使用请优先走下面的超管后台接口。
router.put("/credentials/:task", cronAuth, async (req, res) => {
  const ownerId = req.body?.ownerId;
  const value = { ...(req.body || {}) };
  delete value.ownerId;
  const data = await service.configure(ownerId, req.params.task, value);
  res.json({ success: true, data });
});

// worker 专用：读取「worker 执行型」任务的凭据（目前只有需要浏览器签名的掘金）。
// 服务器自执行的任务永远不经过这个接口，避免一对 Cron 密钥就能拖走所有令牌。
router.get("/credentials/:task", cronAuth, async (req, res) => {
  const ownerId = req.query.ownerId;
  const data = await service.workerCredentials(ownerId, req.params.task);
  res.json({ success: true, data });
});

// 一次 worker 运行覆盖所有已配置的超管：先取账号列表，再逐个跑。
router.get("/workers/:task/owners", cronAuth, async (req, res) => {
  const data = await service.workerAccounts(req.params.task);
  res.json({ success: true, data });
});

// worker 结果上报：只写 cron_runs，成功时更新当日完成状态。
router.post("/report", cronAuth, async (req, res) => {
  const ownerId = req.body?.ownerId;
  const data = await service.report(ownerId, req.body?.task, {
    status: req.body?.status,
    summary: req.body?.summary,
    durationMs: req.body?.durationMs,
  });
  res.json({ success: true, data });
});

function serializeRun(row) {
  if (!row) return null;
  return {
    id: row.id,
    success: row.success,
    ownerId: row.ownerId ?? null,
    durationMs: row.durationMs,
    detail: row.detail,
    createdAt: row.createdAt,
  };
}

function taskMeta(task) {
  return {
    id: task.id,
    name: task.name,
    description: task.description || "",
    timeZone: task.timeZone,
    executor:
      task.executor === "worker"
        ? "worker"
        : task.executor === "global"
          ? "global"
          : "server",
    requiresCredentials: task.requiresCredentials !== false,
    credentialFields: Array.isArray(task.credentialFields)
      ? task.credentialFields.map((field) => ({ ...field }))
      : [],
  };
}

/** 配置变更审计：落库失败只记日志，不能让已经生效的配置请求失败。 */
async function audit(task, user, action) {
  try {
    await Run.create({
      job: configJob(task),
      ownerId: user.id,
      success: true,
      durationMs: 0,
      detail: `admin#${user.id} ${action}`,
    });
  } catch (error) {
    console.error("[daily] 操作审计落库失败:", error.message);
  }
}

function parseTaskParam(value) {
  if (value === undefined) return "";
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,40}$/.test(value))
    throw new TaskError("任务标识不合法", "INVALID_DAILY_TASK", 400);
  return value;
}

function parseSuccess(value) {
  if (value === undefined || value === "") return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new TaskError(
    "success 只能是 true 或 false",
    "INVALID_DAILY_FILTER",
    400,
  );
}

function parsePaging(query) {
  const rawLimit = query.limit === undefined ? 30 : Number(query.limit);
  const rawOffset = query.offset === undefined ? 0 : Number(query.offset);
  if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 100)
    throw new TaskError(
      "limit 必须是 1 到 100 之间的整数",
      "INVALID_DAILY_PAGING",
      400,
    );
  if (!Number.isInteger(rawOffset) || rawOffset < 0)
    throw new TaskError(
      "offset 必须是非负整数",
      "INVALID_DAILY_PAGING",
      400,
    );
  return { limit: rawLimit, offset: rawOffset };
}

/**
 * 全局任务没有 owner 凭据，启用状态用同一张表里 credentials 为空的行承载。
 * 关掉只影响「谁还收」和定时轮次，凭据型任务才走 service.setEnabled。
 */
async function setGlobalEnabled(taskId, ownerId, enabled) {
  const id = accountId(ownerId, taskId);
  const [, created] = await State.findOrCreate({
    where: { id },
    defaults: { ownerId, taskId, credentials: "", enabled },
  });
  if (!created) await State.update({ enabled }, { where: { id } });
  return { task: taskId, ownerId, enabled };
}

// ===== 超管后台 =====
// 与上面的 Cron 入口完全分离：这里使用 VueChest 登录态和超级管理员角色。

router.get("/admin/tasks", authMiddleware, superAdminOnly, async (req, res) => {
  const ownerId = req.user.id;
  const items = await Promise.all(
    registry.map(async (task) => {
      const job = executionJob(task.id);
      // 全局任务的结果没有归属超管（cron 触发时不存在 owner），只按 job 查。
      const global = task.requiresCredentials === false;
      const runWhere = global ? { job } : { job, ownerId };
      const [state, lastRun, lastSuccess, lastFailure] = await Promise.all([
        State.findByPk(accountId(ownerId, task.id), {
          attributes: ["id", "enabled", "lastCompletedDate", "leaseUntil"],
        }),
        Run.findOne({ where: runWhere, order: [["id", "DESC"]] }),
        Run.findOne({
          where: { ...runWhere, success: true },
          order: [["id", "DESC"]],
        }),
        Run.findOne({
          where: { ...runWhere, success: false },
          order: [["id", "DESC"]],
        }),
      ]);
      const today = dayKey(Date.now(), task.timeZone);
      // 全局任务没有 lastCompletedDate：以最近一次成功记录的业务日期判断今日是否已执行。
      const todayCompleted = global
        ? !!lastRun?.success && dayKey(lastRun.createdAt, task.timeZone) === today
        : !!state?.lastCompletedDate && state.lastCompletedDate === today;
      return {
        ...taskMeta(task),
        ownerId,
        // 全局任务没有凭据，恒为"可执行"；普通任务是否配置取决于有没有状态行。
        configured: global ? true : !!state,
        enabled: state?.enabled !== false,
        running: !!(
          state?.leaseUntil && new Date(state.leaseUntil).getTime() > Date.now()
        ),
        todayCompleted,
        lastCompletedDate: global
          ? todayCompleted
            ? today
            : null
          : state?.lastCompletedDate || null,
        lastRun: serializeRun(lastRun),
        lastSuccessAt: lastSuccess?.createdAt || null,
        lastFailureAt: lastFailure?.createdAt || null,
      };
    }),
  );
  res.json({ success: true, data: { items } });
});

router.put(
  "/admin/credentials/:task",
  authMiddleware,
  superAdminOnly,
  async (req, res) => {
    const data = await service.configure(
      req.user.id,
      req.params.task,
      req.body,
    );
    await audit(req.params.task, req.user, "更新凭据");
    res.json({ success: true, data });
  },
);

router.delete(
  "/admin/credentials/:task",
  authMiddleware,
  superAdminOnly,
  async (req, res) => {
    const data = await service.clear(req.user.id, req.params.task);
    await audit(req.params.task, req.user, "清除凭据");
    res.json({ success: true, data });
  },
);

router.put(
  "/admin/tasks/:task/enabled",
  authMiddleware,
  superAdminOnly,
  async (req, res) => {
    const taskId = parseTaskParam(req.params.task);
    if (typeof req.body?.enabled !== "boolean")
      throw new TaskError(
        "enabled 必须是布尔值",
        "INVALID_DAILY_ENABLED",
        400,
      );
    const enabled = req.body.enabled;
    const task = findTask(taskId);
    const data =
      task.requiresCredentials === false
        ? await setGlobalEnabled(task.id, req.user.id, enabled)
        : await service.setEnabled(req.user.id, task.id, enabled);
    await audit(task.id, req.user, enabled ? "恢复定时执行" : "暂停定时执行");
    res.json({ success: true, data });
  },
);

router.post(
  "/admin/tasks/:task/run",
  authMiddleware,
  superAdminOnly,
  async (req, res) => {
    const task = findTask(parseTaskParam(req.params.task));
    let data;
    if (task.requiresCredentials === false) {
      const result = await runGlobalTask(task);
      data = {
        success: result.status !== "failed" && result.recorded !== false,
        results: [result],
      };
    } else {
      data = await service.runOne(req.user.id, task.id, {
        force: req.body?.force === true,
      });
    }
    // 请求本身成功，单个任务的执行结果放在 data.success 中，避免前端
    // 统一请求层把失败结果整体丢掉、看不到具体原因。
    res.json({ success: true, data });
  },
);

/** 全局任务自己的 run() 已经把结果收敛成 {success,status,summary}。 */
async function runGlobalTask(task) {
  try {
    const outcome = await task.run();
    return {
      task: task.id,
      ownerId: null,
      status: outcome.status,
      summary: outcome.summary,
      recorded: true,
    };
  } catch (error) {
    return {
      task: task.id,
      ownerId: null,
      status: "failed",
      summary: error.message || "任务执行失败",
      recorded: false,
    };
  }
}

router.get(
  "/admin/logs",
  authMiddleware,
  superAdminOnly,
  async (req, res) => {
    const task = parseTaskParam(req.query.task);
    const success = parseSuccess(req.query.success);
    const { limit, offset } = parsePaging(req.query);
    const where = executionWhere({
      taskId: task,
      ownerId: req.user.id,
      globalTaskIds,
    });
    if (success !== undefined) where.success = success;
    const [rows, total] = await Promise.all([
      Run.findAll({ where, order: [["id", "DESC"]], limit, offset }),
      Run.count({ where }),
    ]);
    res.json({
      success: true,
      data: {
        items: rows.map((row) => ({
          ...serializeRun(row),
          task: taskIdFromJob(row.job),
        })),
        total,
        limit,
        offset,
      },
    });
  },
);

router.get(
  "/admin/audits",
  authMiddleware,
  superAdminOnly,
  async (req, res) => {
    const task = parseTaskParam(req.query.task);
    const { limit, offset } = parsePaging(req.query);
    const where = configWhere(task);
    where.ownerId = req.user.id;
    const [rows, total] = await Promise.all([
      Run.findAll({ where, order: [["id", "DESC"]], limit, offset }),
      Run.count({ where }),
    ]);
    res.json({
      success: true,
      data: {
        items: rows.map((row) => ({
          ...serializeRun(row),
          task: taskIdFromJob(row.job),
        })),
        total,
        limit,
        offset,
      },
    });
  },
);

module.exports = router;
