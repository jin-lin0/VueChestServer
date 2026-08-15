const { DataTypes } = require("sequelize");

const sequelize = require("../config/database");

// AI 对话会话（conversationId 由前端生成的 uuid 决定，已绑定所属用户 userId）
const AIChatConversation = sequelize.define(
  "AIChatConversation",
  {
    id: {
      type: DataTypes.STRING(64),
      primaryKey: true,
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: "所属用户 id，用于会话归属校验",
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
    indexes: [{ fields: ["userId"] }],
  },
);

module.exports = AIChatConversation;
