const { DataTypes } = require("sequelize");

const sequelize = require("../config/database");

// AI 对话会话（conversationId 由前端生成的 uuid 决定，免登录）
const AIChatConversation = sequelize.define(
  "AIChatConversation",
  {
    id: {
      type: DataTypes.STRING(64),
      primaryKey: true,
    },
    title: {
      type: DataTypes.STRING(255),
      allowNull: false,
      defaultValue: "新对话",
    },
    provider: {
      type: DataTypes.STRING(50),
      allowNull: true,
    },
    model: {
      type: DataTypes.STRING(100),
      allowNull: true,
    },
  },
  {
    tableName: "ai_chat_conversations",
    timestamps: true,
  },
);

module.exports = AIChatConversation;
