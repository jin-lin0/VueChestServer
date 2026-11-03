const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

module.exports = sequelize.define(
  "CheckinState",
  {
    id: { type: DataTypes.STRING(40), primaryKey: true },
    credentials: { type: DataTypes.TEXT, allowNull: false },
    lastCompletedDate: { type: DataTypes.DATEONLY, allowNull: true },
    leaseToken: { type: DataTypes.UUID, allowNull: true },
    leaseUntil: { type: DataTypes.DATE, allowNull: true },
  },
  { tableName: "checkin_states", timestamps: true },
);
