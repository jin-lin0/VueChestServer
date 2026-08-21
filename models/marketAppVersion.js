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
    metadata: {
      type: DataTypes.TEXT("long"),
      allowNull: true,
      get() {
        try {
          return JSON.parse(this.getDataValue("metadata") || "{}");
        } catch {
          return {};
        }
      },
      set(value) {
        this.setDataValue("metadata", JSON.stringify(value || {}));
      },
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
    reviewStatus: {
      type: DataTypes.ENUM("pending", "approved", "rejected", "withdrawn"),
      allowNull: false,
      defaultValue: "approved",
    },
  },
  {
    tableName: "market_app_versions",
    timestamps: true,
    indexes: [
      { unique: true, fields: ["appId", "version"] },
      { fields: ["appId", "status"] },
      { fields: ["reviewStatus", "createdAt"] },
    ],
  },
);

module.exports = MarketAppVersion;
