const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");
const Category = require("./category");

const Question = sequelize.define(
  "Question",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    title: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    options: {
      type: DataTypes.JSON,
      allowNull: true,
    },
    answer: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    analysis: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    difficulty: {
      type: DataTypes.ENUM("easy", "medium", "hard"),
      defaultValue: "medium",
    },
    categoryId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    tags: {
      type: DataTypes.JSON,
      allowNull: true,
    },
  },
  {
    tableName: "questions",
    timestamps: true,
    updatedAt: false,
  }
);

// 建立关联关系
Question.belongsTo(Category, { foreignKey: "categoryId" });
Category.hasMany(Question, { foreignKey: "categoryId" });

module.exports = Question;