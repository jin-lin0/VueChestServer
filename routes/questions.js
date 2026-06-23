const express = require("express");
const router = express.Router();
const Question = require("../models/question");
const Category = require("../models/category");
const { Op } = require("sequelize");
const sequelize = require("../config/database");
const { authMiddleware } = require("../middleware/auth");

// 获取所有分类
router.get("/categories", async (req, res) => {
  try {
    const categories = await Category.findAll({
      include: [{ model: Question, attributes: ["id"] }],
    });
    res.json(categories);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 创建分类
router.post("/categories", authMiddleware, async (req, res) => {
  try {
    const { name, description } = req.body;
    const category = await Category.create({ name, description });
    res.status(201).json(category);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 更新分类
router.put("/categories/:id", authMiddleware, async (req, res) => {
  try {
    const category = await Category.findByPk(req.params.id);
    if (!category) {
      return res.status(404).json({ error: "分类不存在" });
    }
    await category.update(req.body);
    res.json(category);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 删除分类
router.delete("/categories/:id", authMiddleware, async (req, res) => {
  try {
    const category = await Category.findByPk(req.params.id);
    if (!category) {
      return res.status(404).json({ error: "分类不存在" });
    }
    // 检查分类下是否有题目
    const questionCount = await Question.count({
      where: { categoryId: req.params.id },
    });
    if (questionCount > 0) {
      return res.status(400).json({ error: "该分类下还有题目，无法删除" });
    }
    await category.destroy();
    res.json({ message: "删除成功" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 获取题目列表（支持筛选和搜索）
router.get("/", async (req, res) => {
  try {
    const { categoryId, difficulty, keyword, page = 1, limit = 10 } = req.query;
    const where = {};

    if (categoryId) where.categoryId = categoryId;
    if (difficulty) where.difficulty = difficulty;

    // 关键词搜索
    if (keyword) {
      where[Op.or] = [
        { title: { [Op.like]: `%${keyword}%` } },
        { answer: { [Op.like]: `%${keyword}%` } },
        { tags: { [Op.like]: `%${keyword}%` } },
      ];
    }

    const questions = await Question.findAndCountAll({
      where,
      include: [{ model: Category, attributes: ["id", "name"] }],
      limit: parseInt(limit),
      offset: (parseInt(page) - 1) * parseInt(limit),
      order: [["createdAt", "DESC"]],
    });

    res.json({
      questions: questions.rows,
      total: questions.count,
      page: parseInt(page),
      totalPages: Math.ceil(questions.count / parseInt(limit)),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 获取单个题目详情
router.get("/:id", async (req, res) => {
  try {
    const question = await Question.findByPk(req.params.id, {
      include: [{ model: Category, attributes: ["id", "name"] }],
    });
    if (!question) {
      return res.status(404).json({ error: "题目不存在" });
    }
    res.json(question);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 随机抽题
router.get("/random/:count", async (req, res) => {
  try {
    const count = parseInt(req.params.count) || 1;
    const { categoryId, difficulty } = req.query;
    const where = {};

    if (categoryId) where.categoryId = categoryId;
    if (difficulty) where.difficulty = difficulty;

    const questions = await Question.findAll({
      where,
      include: [{ model: Category, attributes: ["id", "name"] }],
      order: sequelize.random(),
      limit: count,
    });

    res.json(questions);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 创建题目
router.post("/", authMiddleware, async (req, res) => {
  try {
    const {
      title,
      options,
      answer,
      analysis,
      difficulty,
      categoryId,
      tags,
    } = req.body;
    const question = await Question.create({
      title,
      options,
      answer,
      analysis,
      difficulty,
      categoryId,
      tags,
    });
    res.status(201).json(question);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 更新题目
router.put("/:id", authMiddleware, async (req, res) => {
  try {
    const question = await Question.findByPk(req.params.id);
    if (!question) {
      return res.status(404).json({ error: "题目不存在" });
    }
    await question.update(req.body);
    res.json(question);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 删除题目
router.delete("/:id", authMiddleware, async (req, res) => {
  try {
    const question = await Question.findByPk(req.params.id);
    if (!question) {
      return res.status(404).json({ error: "题目不存在" });
    }
    await question.destroy();
    res.json({ message: "删除成功" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 批量导入题目
router.post("/import", authMiddleware, async (req, res) => {
  try {
    const { questions } = req.body;
    if (!Array.isArray(questions) || questions.length === 0) {
      return res.status(400).json({ error: "请提供有效的题目数组" });
    }
    const created = await Question.bulkCreate(questions);
    res.status(201).json({
      message: `成功导入 ${created.length} 道题目`,
      count: created.length,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
