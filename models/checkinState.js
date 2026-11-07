const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

module.exports = sequelize.define(
  "CheckinState",
  {
    // 每个超级管理员对每个站点各有一行凭据，id 为 `${ownerId}:${taskId}`。
    // 不依赖自增主键，便于在定时任务中按 owner 精确抢占租约。
    id: { type: DataTypes.STRING(80), primaryKey: true },
    ownerId: { type: DataTypes.INTEGER, allowNull: false },
    taskId: { type: DataTypes.STRING(40), allowNull: false },
    credentials: { type: DataTypes.TEXT, allowNull: false },
    lastCompletedDate: { type: DataTypes.DATEONLY, allowNull: true },
    leaseToken: { type: DataTypes.UUID, allowNull: true },
    leaseUntil: { type: DataTypes.DATE, allowNull: true },
  },
  {
    tableName: "checkin_states",
    timestamps: true,
    indexes: [
      { unique: true, fields: ["ownerId", "taskId"] },
      { fields: ["taskId"] },
    ],
  },
);
