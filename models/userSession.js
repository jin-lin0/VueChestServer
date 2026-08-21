const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const UserSession = sequelize.define(
  "UserSession",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    deviceName: {
      type: DataTypes.STRING(120),
      allowNull: false,
    },
    userAgent: {
      type: DataTypes.STRING(500),
      allowNull: true,
    },
    ip: {
      type: DataTypes.STRING(64),
      allowNull: true,
    },
    lastActiveAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    expiresAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    revokedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    tableName: "user_sessions",
    timestamps: true,
    indexes: [
      { fields: ["userId", "revokedAt"] },
      { fields: ["expiresAt"] },
    ],
  },
);

module.exports = UserSession;
