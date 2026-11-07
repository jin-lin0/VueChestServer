const express = require("express");
const { Op } = require("sequelize");
const State = require("../models/checkinState");
const Run = require("../models/cronRun");
const cronAuth = require("../middleware/cronAuth");
const { authMiddleware } = require("../middleware/auth");
const { superAdminOnly } = require("../middleware/superAdmin");
const { CheckinError } = require("../utils/checkinCredentials");
const {
  tasks,
  dayKey,
  accountId,
  createCheckinService,
} = require("../services/checkins");

const service = createCheckinService({ State, Run });
const router = express.Router();

async function run(req, res) {
  const result = await service.runAll();
  res.status(result.success ? 200 : 502).json(result);
}

// 个人运维入口：定时触发和手动补跑都只使用 Cron 密钥。
router.route("/run").get(cronAuth, run).post(cronAuth, run);

// 仅写入，不提供凭据读取接口；与定时入口使用同一运维密钥。
// 多超管模式下必须用 ownerId（body 或 CHECKIN_OWNER_ID）指明凭据归属，
// 日常使用请优先走下面的超管后台接口。
router.put("/credentials/:task", cronAuth, async (req, res) => {
  const ownerId = req.body?.ownerId ?? process.env.CHECKIN_OWNER_ID;
  const value = { ...(req.body || {}) };
  delete value.ownerId;
  const data = await service.configure(ownerId, req.params.task, value);
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
    credentialFields: Array.isArray(task.credentialFields)
      ? task.credentialFields.map((field) => ({ ...field }))
      : [],
  };
}

/** 配置变更审计：落库失败只记日志，不能让已经生效的配置请求失败。 */
async function audit(task, user, action) {
  try {
    await Run.create({
      job: `checkin-config:${task}`,
      ownerId: user.id,
      success: true,
      durationMs: 0,
      detail: `admin#${user.id} ${action}`,
    });
  } catch (error) {
    console.error("[checkins] 操作审计落库失败:", error.message);
  }
}

function parseTaskParam(value) {
  if (value === undefined) return "";
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,40}$/.test(value))
    throw new CheckinError("签到任务标识不合法", "INVALID_CHECKIN_TASK", 400);
  return value;
}

function parseSuccess(value) {
  if (value === undefined || value === "") return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new CheckinError(
    "success 只能是 true 或 false",
    "INVALID_CHECKIN_FILTER",
    400,
  );
}

function parsePaging(query) {
  const rawLimit = query.limit === undefined ? 30 : Number(query.limit);
  const rawOffset = query.offset === undefined ? 0 : Number(query.offset);
  if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 100)
    throw new CheckinError(
      "limit 必须是 1 到 100 之间的整数",
      "INVALID_CHECKIN_PAGING",
      400,
    );
  if (!Number.isInteger(rawOffset) || rawOffset < 0)
    throw new CheckinError(
      "offset 必须是非负整数",
      "INVALID_CHECKIN_PAGING",
      400,
    );
  return { limit: rawLimit, offset: rawOffset };
}

function executionJobWhere(task) {
  if (task) return { job: `checkin:${task}` };
  // checkin-config: 也以 checkin: 开头，必须显式排除。
  return {
    [Op.and]: [
      { job: { [Op.like]: "checkin:%" } },
      { job: { [Op.notLike]: "checkin-config:%" } },
    ],
  };
}

function auditJobWhere(task) {
  return {
    job: task ? `checkin-config:${task}` : { [Op.like]: "checkin-config:%" },
  };
}

// ===== 超管后台 =====
// 与上面的 Cron 入口完全分离：这里使用 VueChest 登录态和超级管理员角色。

router.get("/admin/tasks", authMiddleware, superAdminOnly, async (req, res) => {
  const items = await Promise.all(
    tasks.map(async (task) => {
      const job = `checkin:${task.id}`;
      const ownerId = req.user.id;
      const [state, lastRun, lastSuccess, lastFailure] = await Promise.all([
        State.findByPk(accountId(ownerId, task.id), {
          attributes: ["id", "lastCompletedDate", "leaseUntil"],
        }),
        Run.findOne({
          where: { job, ownerId },
          order: [["id", "DESC"]],
        }),
        Run.findOne({
          where: { job, ownerId, success: true },
          order: [["id", "DESC"]],
        }),
        Run.findOne({
          where: { job, ownerId, success: false },
          order: [["id", "DESC"]],
        }),
      ]);
      return {
        ...taskMeta(task),
        ownerId,
        configured: !!state,
        running: !!(
          state?.leaseUntil && new Date(state.leaseUntil).getTime() > Date.now()
        ),
        todayCompleted:
          !!state?.lastCompletedDate &&
          state.lastCompletedDate === dayKey(Date.now(), task.timeZone),
        lastCompletedDate: state?.lastCompletedDate || null,
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

router.post(
  "/admin/tasks/:task/run",
  authMiddleware,
  superAdminOnly,
  async (req, res) => {
    const data = await service.runOne(req.user.id, req.params.task, {
      force: req.body?.force === true,
    });
    // 请求本身成功，单个任务的执行结果放在 data.success 中，避免前端
    // 统一请求层把失败结果整体丢掉、看不到具体原因。
    res.json({ success: true, data });
  },
);

router.get(
  "/admin/logs",
  authMiddleware,
  superAdminOnly,
  async (req, res) => {
    const task = parseTaskParam(req.query.task);
    const success = parseSuccess(req.query.success);
    const { limit, offset } = parsePaging(req.query);
    const where = executionJobWhere(task);
    where.ownerId = req.user.id;
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
          task: String(row.job || "").replace(/^checkin:/, ""),
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
    const where = auditJobWhere(task);
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
          task: String(row.job || "").replace(/^checkin-config:/, ""),
        })),
        total,
        limit,
        offset,
      },
    });
  },
);

module.exports = router;
