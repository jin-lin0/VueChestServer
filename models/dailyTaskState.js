const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

module.exports = sequelize.define(
  "DailyTaskState",
  {
    // 每个超级管理员对每个任务各有一行状态（凭据 + 开关），id 为 `${ownerId}:${taskId}`。
    // 不依赖自增主键，便于在定时任务中按 owner 精确抢占租约。
    id: { type: DataTypes.STRING(80), primaryKey: true },
    ownerId: { type: DataTypes.INTEGER, allowNull: false },
    taskId: { type: DataTypes.STRING(40), allowNull: false },
    credentials: { type: DataTypes.TEXT, allowNull: false },
    // 关闭后定时轮次与 worker 账号列表都会跳过；手动执行不受影响。
    enabled: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
    lastCompletedDate: { type: DataTypes.DATEONLY, allowNull: true },
    leaseToken: { type: DataTypes.UUID, allowNull: true },
    leaseUntil: { type: DataTypes.DATE, allowNull: true },
  },
  {
    tableName: "daily_task_states",
    timestamps: true,
    indexes: [
      { unique: true, fields: ["ownerId", "taskId"] },
      { fields: ["taskId"] },
    ],
  },
);
