const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

/**
 * 站内通知。
 *
 * 只记录「哪个事件通知了谁」这一条事实，展示文案在服务端生成并落库，
 * 避免前端为每种事件维护一份文案映射（新增事件类型时前端零改动）。
 * `link` 存站内路由，点击后直接跳转。
 */
const Notification = sequelize.define(
  "Notification",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    // 收件人
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    // 事件类型，如 market.version.approved / market.comment.created
    type: {
      type: DataTypes.STRING(40),
      allowNull: false,
    },
    title: {
      type: DataTypes.STRING(120),
      allowNull: false,
    },
    body: {
      type: DataTypes.STRING(500),
      allowNull: true,
    },
    link: {
      type: DataTypes.STRING(200),
      allowNull: true,
    },
    appId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    // 事件附加信息（JSON 字符串），如审核意见分类
    meta: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    readAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    tableName: "notifications",
    timestamps: true,
    indexes: [
      { fields: ["userId", "readAt"] },
      { fields: ["userId", "createdAt"] },
    ],
  },
);

module.exports = Notification;
