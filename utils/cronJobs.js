const { Op } = require("sequelize");

// cron_runs.job 的命名约定集中在这里：写入方和分析查询都走同一套构造/解析，
// 避免各处自己拼字符串、再用 LIKE 和 substring 反解析。
const EXECUTION_PREFIX = "daily:";
const CONFIG_PREFIX = "daily-config:";

function executionJob(taskId) {
  return `${EXECUTION_PREFIX}${taskId}`;
}

function configJob(taskId) {
  return `${CONFIG_PREFIX}${taskId}`;
}

/** 从 job 还原任务标识；不认识的 job 原样返回。 */
function taskIdFromJob(job) {
  const text = String(job || "");
  if (text.startsWith(CONFIG_PREFIX)) return text.slice(CONFIG_PREFIX.length);
  if (text.startsWith(EXECUTION_PREFIX))
    return text.slice(EXECUTION_PREFIX.length);
  return text;
}

/**
 * 执行记录的查询条件。
 * - 指定任务：全局任务不按超管过滤，普通任务只看当前超管自己的记录。
 * - 不指定任务：当前超管的任务记录 + 所有全局任务记录（日报这类结果对所有超管可见）。
 * `daily:` 带冒号，天然不会匹配 `daily-config:`，无需再排除配置审计。
 */
function executionWhere({ taskId = "", ownerId, globalTaskIds = [] } = {}) {
  if (taskId) {
    if (globalTaskIds.includes(taskId))
      return { job: executionJob(taskId) };
    const where = { job: executionJob(taskId) };
    if (ownerId !== undefined) where.ownerId = ownerId;
    return where;
  }
  return {
    [Op.or]: [
      {
        [Op.and]: [
          { ownerId },
          { job: { [Op.like]: `${EXECUTION_PREFIX}%` } },
        ],
      },
      ...globalTaskIds.map((id) => ({ job: executionJob(id) })),
    ],
  };
}

function configWhere(taskId = "") {
  return taskId
    ? { job: configJob(taskId) }
    : { job: { [Op.like]: `${CONFIG_PREFIX}%` } };
}

module.exports = {
  executionJob,
  configJob,
  taskIdFromJob,
  executionWhere,
  configWhere,
};
