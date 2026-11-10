const { tasks, globalTasks } = require("./registry");
const { createDailyTaskService, dayKey, accountId } = require("./service");

module.exports = {
  tasks,
  globalTasks,
  createDailyTaskService,
  dayKey,
  accountId,
};
