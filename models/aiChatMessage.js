const { DataTypes } = require("sequelize");

const sequelize = require("../config/database");

const AIChatMessage = sequelize.define(
  "AIChatMessage",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    conversationId: {
      type: DataTypes.STRING(64),
      allowNull: false,
    },
    role: {
      type: DataTypes.ENUM("user", "assistant", "system"),
      allowNull: false,
    },
    content: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    model: {
      type: DataTypes.STRING(100),
      allowNull: true,
    },
  },
  {
    tableName: "ai_chat_messages",
    timestamps: true,
  },
);

module.exports = AIChatMessage;
