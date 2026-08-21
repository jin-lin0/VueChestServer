const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const MarketAppVersion = sequelize.define(
  "MarketAppVersion",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    appId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    version: {
      type: DataTypes.STRING(20),
      allowNull: false,
    },
    fileKey: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    fileUrl: {
      type: DataTypes.STRING(500),
      allowNull: false,
    },
    size: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    releaseNotes: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    allowNetwork: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    publishedBy: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    status: {
      type: DataTypes.ENUM("active", "yanked"),
      allowNull: false,
      defaultValue: "active",
    },
  },
  {
    tableName: "market_app_versions",
    timestamps: true,
    indexes: [
      { unique: true, fields: ["appId", "version"] },
      { fields: ["appId", "status"] },
    ],
  },
);

module.exports = MarketAppVersion;
