const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const AppReport = sequelize.define(
  "AppReport",
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
    reporterId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    reason: {
      type: DataTypes.STRING(30),
      allowNull: false,
    },
    details: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    status: {
      type: DataTypes.ENUM("open", "resolved", "dismissed"),
      allowNull: false,
      defaultValue: "open",
    },
    resolutionNote: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    reviewedBy: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    reviewedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    tableName: "app_reports",
    timestamps: true,
    indexes: [
      { fields: ["appId", "status"] },
      { fields: ["reporterId", "status"] },
      { fields: ["status", "createdAt"] },
    ],
  },
);

module.exports = AppReport;
