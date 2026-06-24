const express = require("express");
const router = express.Router();
const Question = require("../models/question");
const Category = require("../models/category");
const { Op } = require("sequelize");
const sequelize = require("../config/database");
const { authMiddleware } = require("../middleware/auth");
const { asyncHandler } = require("../utils/async-handler");

const VALID_DIFFICULTIES = ["easy", "medium", "hard"];

// 获取所有分类
router.get(
  "/categories",
  asyncHandler(async (req, res) => {
    const categories = await Category.findAll({
      include: [{ model: Question, attributes: ["id"] }],
    });
    res.json(categories);
  })
);

// 创建分类
router.post(
  "/categories",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const { name, description } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: "分类名称不能为空" });
    }
    const category = await Category.create({ name: name.trim(), description });
    res.status(201).json(category);
  })
);

// 更新分类
router.put(
  "/categories/:id",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const category = await Category.findByPk(req.params.id);
    if (!category) {
      return res.status(404).json({ error: "分类不存在" });
    }
    if (req.body.name !== undefined && !req.body.name.trim()) {
      return res.status(400).json({ error: "分类名称不能为空" });
    }
    await category.update(req.body);
    res.json(category);
  })
);

// 删除分类
router.delete(
  "/categories/:id",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const category = await Category.findByPk(req.params.id);
    if (!category) {
      return res.status(404).json({ error: "分类不存在" });
    }
    const questionCount = await Question.count({
      where: { categoryId: req.params.id },
    });
    if (questionCount > 0) {
      return res.status(400).json({ error: "该分类下还有题目，无法删除" });
    }
    await category.destroy();
    res.json({ message: "删除成功" });
  })
);

// 获取题目列表（支持筛选和搜索）
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const { categoryId, difficulty, keyword, page = 1, limit = 10 } = req.query;
    const where = {};

    if (categoryId) where.categoryId = categoryId;
    if (difficulty) where.difficulty = difficulty;

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
      limit: Math.min(parseInt(limit), 100),
      offset: (parseInt(page) - 1) * parseInt(limit),
      order: [["createdAt", "DESC"]],
    });

    res.json({
      questions: questions.rows,
      total: questions.count,
      page: parseInt(page),
      totalPages: Math.ceil(questions.count / parseInt(limit)),
    });
  })
);

// 获取单个题目详情
router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const question = await Question.findByPk(req.params.id, {
      include: [{ model: Category, attributes: ["id", "name"] }],
    });
    if (!question) {
      return res.status(404).json({ error: "题目不存在" });
    }
    res.json(question);
  })
);

// 随机抽题
router.get(
  "/random/:count",
  asyncHandler(async (req, res) => {
    const count = Math.min(parseInt(req.params.count) || 1, 50);
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
  })
);

// 创建题目
router.post(
  "/",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const { title, answer, difficulty, categoryId } = req.body;

    if (!title || !title.trim()) {
      return res.status(400).json({ error: "题目标题不能为空" });
    }
    if (!answer || !answer.trim()) {
      return res.status(400).json({ error: "题目答案不能为空" });
    }
    if (difficulty && !VALID_DIFFICULTIES.includes(difficulty)) {
      return res.status(400).json({ error: "无效的难度等级" });
    }
    if (!categoryId) {
      return res.status(400).json({ error: "请选择分类" });
    }

    const question = await Question.create(req.body);
    res.status(201).json(question);
  })
);

// 更新题目
router.put(
  "/:id",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const question = await Question.findByPk(req.params.id);
    if (!question) {
      return res.status(404).json({ error: "题目不存在" });
    }
    if (req.body.title !== undefined && !req.body.title.trim()) {
      return res.status(400).json({ error: "题目标题不能为空" });
    }
    if (req.body.difficulty && !VALID_DIFFICULTIES.includes(req.body.difficulty)) {
      return res.status(400).json({ error: "无效的难度等级" });
    }
    await question.update(req.body);
    res.json(question);
  })
);

// 删除题目
router.delete(
  "/:id",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const question = await Question.findByPk(req.params.id);
    if (!question) {
      return res.status(404).json({ error: "题目不存在" });
    }
    await question.destroy();
    res.json({ message: "删除成功" });
  })
);

// 批量导入题目
router.post(
  "/import",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const { questions } = req.body;
    if (!Array.isArray(questions) || questions.length === 0) {
      return res.status(400).json({ error: "请提供有效的题目数组" });
    }
    const created = await Question.bulkCreate(questions);
    res.status(201).json({
      message: `成功导入 ${created.length} 道题目`,
      count: created.length,
    });
  })
);

module.exports = router;
