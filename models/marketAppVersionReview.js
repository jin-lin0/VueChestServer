const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const MarketAppVersionReview = sequelize.define(
  "MarketAppVersionReview",
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
    versionId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    actorId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    action: {
      type: DataTypes.ENUM("submitted", "approved", "rejected", "withdrawn", "resubmitted"),
      allowNull: false,
    },
    category: {
      type: DataTypes.STRING(50),
      allowNull: true,
    },
    message: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
  },
  {
    tableName: "market_app_version_reviews",
    timestamps: true,
    indexes: [
      { fields: ["versionId", "createdAt"] },
      { fields: ["appId", "createdAt"] },
    ],
  },
);

module.exports = MarketAppVersionReview;
