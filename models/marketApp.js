const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const MarketApp = sequelize.define(
  "MarketApp",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    name: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
    icon: {
      type: DataTypes.STRING(50),
      allowNull: false,
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    version: {
      type: DataTypes.STRING(20),
      allowNull: false,
      defaultValue: "1.0.0",
    },
    author: {
      type: DataTypes.STRING(100),
      allowNull: true,
    },
    category: {
      type: DataTypes.STRING(50),
      allowNull: true,
    },
    fileKey: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    fileUrl: {
      type: DataTypes.STRING(500),
      allowNull: true,
    },
    size: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    screenshots: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    readme: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    isOfficial: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    downloads: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    uploadedBy: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    status: {
      type: DataTypes.ENUM("pending", "approved", "rejected"),
      defaultValue: "pending",
    },
    // 允许访问的网络域名白名单（JSON 数组，如 ["api.example.com","*.example.com"]）。
    // 沙箱应用默认无法联网，仅在 allowNetwork 显式声明且经审核后，对应域名才会被放行。
    allowNetwork: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
  },
  {
    tableName: "market_apps",
    timestamps: true,
  },
);

module.exports = MarketApp;
