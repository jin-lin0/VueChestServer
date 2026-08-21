const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const WorkspaceTemplate = sequelize.define(
  "WorkspaceTemplate",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    shareCode: {
      type: DataTypes.STRING(16),
      allowNull: false,
      unique: true,
    },
    name: {
      type: DataTypes.STRING(40),
      allowNull: false,
    },
    icon: {
      type: DataTypes.STRING(16),
      allowNull: false,
    },
    description: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    data: {
      type: DataTypes.TEXT("long"),
      allowNull: false,
      get() {
        try {
          return JSON.parse(this.getDataValue("data") || "{}");
        } catch {
          return {};
        }
      },
      set(value) {
        this.setDataValue("data", JSON.stringify(value || {}));
      },
    },
    createdBy: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    isOfficial: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    downloads: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
  },
  {
    tableName: "workspace_templates",
    timestamps: true,
    indexes: [
      { unique: true, fields: ["shareCode"] },
      { fields: ["createdBy"] },
      { fields: ["isOfficial"] },
    ],
  },
);

module.exports = WorkspaceTemplate;
