const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const AppComment = sequelize.define(
  "AppComment",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    appId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      comment: "关联 market_apps.id",
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      comment: "关联 users.id",
    },
    content: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    // 1-5 星评分，可空（纯文字评论不强制打分）
    rating: {
      type: DataTypes.TINYINT,
      allowNull: true,
    },
    // 楼中楼：指向被回复的【顶层】评论 id；顶层评论为 null
    parentId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    // 管理员可隐藏违规评论；删除走物理删
    status: {
      type: DataTypes.ENUM("visible", "hidden"),
      defaultValue: "visible",
    },
  },
  {
    tableName: "app_comments",
    timestamps: true,
    indexes: [
      { fields: ["appId"] },
      { fields: ["parentId"] },
      { fields: ["appId", "createdAt"] },
    ],
  }
);

const User = require("./user");
const MarketApp = require("./marketApp");
AppComment.belongsTo(User, { foreignKey: "userId", as: "author" });
AppComment.belongsTo(MarketApp, { foreignKey: "appId", as: "app" });

module.exports = AppComment;
