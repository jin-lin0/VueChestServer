const test = require("node:test");
const assert = require("node:assert/strict");
const { Op } = require("sequelize");
const {
  executionJob,
  configJob,
  taskIdFromJob,
  executionWhere,
  configWhere,
} = require("../utils/cronJobs");

test("执行与配置记录使用不同前缀，且能互相还原任务标识", () => {
  assert.equal(executionJob("workbuddy-cn"), "daily:workbuddy-cn");
  assert.equal(configJob("workbuddy-cn"), "daily-config:workbuddy-cn");
  assert.equal(taskIdFromJob("daily:workbuddy-cn"), "workbuddy-cn");
  assert.equal(taskIdFromJob("daily-config:workbuddy-cn"), "workbuddy-cn");
  assert.equal(taskIdFromJob("unknown"), "unknown");
  assert.equal(taskIdFromJob(null), "");
});

test("执行记录查询按任务与归属过滤，全局任务不受超管限制", () => {
  assert.deepEqual(
    executionWhere({ taskId: "juejin", ownerId: 2, globalTaskIds: ["stock-digest"] }),
    { job: "daily:juejin", ownerId: 2 },
  );
  assert.deepEqual(
    executionWhere({
      taskId: "stock-digest",
      ownerId: 2,
      globalTaskIds: ["stock-digest"],
    }),
    { job: "daily:stock-digest" },
  );

  const all = executionWhere({ ownerId: 2, globalTaskIds: ["stock-digest"] });
  assert.equal(all[Op.or].length, 2);
  assert.deepEqual(all[Op.or][1], { job: "daily:stock-digest" });
  const first = all[Op.or][0][Op.and];
  assert.deepEqual(first[0], { ownerId: 2 });
  assert.equal(first[1].job[Op.like], "daily:%");
});

test("配置审计按 daily-config 前缀查询，不混入执行记录", () => {
  assert.deepEqual(configWhere("juejin"), { job: "daily-config:juejin" });
  assert.equal(configWhere()[ "job"][Op.like], "daily-config:%");
});
