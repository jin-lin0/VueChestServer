const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const UserWorkspace = sequelize.define(
  "UserWorkspace",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      unique: true,
    },
    config: {
      type: DataTypes.TEXT("long"),
      allowNull: false,
      get() {
        const raw = this.getDataValue("config");
        try {
          return JSON.parse(raw || "{}");
        } catch {
          return {};
        }
      },
      set(value) {
        this.setDataValue("config", JSON.stringify(value || {}));
      },
    },
  },
  {
    tableName: "user_workspaces",
    timestamps: true,
    indexes: [{ unique: true, fields: ["userId"] }],
  },
);

module.exports = UserWorkspace;
