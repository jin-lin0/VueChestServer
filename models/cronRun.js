const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

/**
 * 定时任务执行记录。
 *
 * Vercel 的 cron 失败是静默的（控制台不告警），日报断发可能几天后才被发现。
 * 每次执行无论成败都落一行，失败时由调用方顺带发告警邮件。
 * 不只服务股票日报：job 字段区分任务，后续其他 cron 复用同一张表。
 */
const CronRun = sequelize.define(
  "CronRun",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    job: {
      type: DataTypes.STRING(64),
      allowNull: false,
    },
    // 签到类任务按超级管理员隔离；其它定时任务（如股票日报）保持 null。
    ownerId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    success: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
    },
    durationMs: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    // 成功时放摘要（采集/评估数量等），失败时放错误信息；只存可读文本，不存大对象
    detail: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
  },
  {
    tableName: "cron_runs",
    timestamps: true,
    updatedAt: false,
    indexes: [
      { fields: ["job", "createdAt"] },
      { fields: ["ownerId", "job", "createdAt"] },
    ],
  },
);

module.exports = CronRun;
