const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

// 市场应用的「云端键值存储」。
// 按 userId + appId 双重隔离：同一应用不同用户的数据互不可见，
// 不同应用之间也无法互相读取。value 以 JSON 字符串存放。
const AppData = sequelize.define(
  "AppData",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    appId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    dataKey: {
      type: DataTypes.STRING(120),
      allowNull: false,
    },
    value: {
      type: DataTypes.TEXT("long"),
      allowNull: true,
    },
  },
  {
    tableName: "app_data",
    timestamps: true,
    indexes: [
      { unique: true, fields: ["userId", "appId", "dataKey"] },
      { fields: ["userId", "appId"] },
    ],
  },
);

module.exports = AppData;
