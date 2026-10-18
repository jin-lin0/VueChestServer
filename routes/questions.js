const express = require("express");
const router = express.Router();
const Question = require("../models/question");
const Category = require("../models/category");
const { Op } = require("sequelize");
const sequelize = require("../config/database");
const { authMiddleware } = require("../middleware/auth");
const { adminOnly } = require("../middleware/superAdmin");
const { toBoundedInt, MAX_PAGE, parseIdList } = require("../utils/queryParams");

const VALID_DIFFICULTIES = ["easy", "medium", "hard"];

// 可写字段白名单：req.body 直通 Sequelize 会连 id / createdAt 一起写进去，
// 例如 PUT 里带上 id 能把主键改掉（等于换掉一行），create 时带 id 能抢占自增号段。
const QUESTION_FIELDS = [
  "title",
  "options",
  "answer",
  "analysis",
  "difficulty",
  "categoryId",
  "tags",
];
const CATEGORY_FIELDS = ["name", "description"];

const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 100;

/** 只取白名单里的字段（未传的保持 undefined，交给 Sequelize 用默认值/不更新）。 */
function pickFields(body, allowed) {
  const source = body && typeof body === "object" ? body : {};
  const picked = {};
  for (const key of allowed) {
    if (source[key] !== undefined) picked[key] = source[key];
  }
  return picked;
}

/**
 * 文本必填项校验：非字符串一律算不合法。
 * 原来的 `!req.body.name.trim()` 在 name 是数字/对象时会抛 TypeError，
 * 被全局错误处理兜成 500 并把原始报错文本回给客户端。
 */
function isBlankText(value) {
  return typeof value !== "string" || !value.trim();
}

/** 分类必须真实存在，避免建出查不到分类的孤儿题目（categoryId 在模型里是 NOT NULL）。 */
async function categoryExists(categoryId) {
  const found = await Category.findByPk(categoryId);
  return Boolean(found);
}

// 获取所有分类
router.get("/categories", async (req, res) => {
  const categories = await Category.findAll({
    include: [{ model: Question, attributes: ["id"] }],
  });
  res.json(categories);
});

// 创建分类
router.post("/categories", authMiddleware, adminOnly, async (req, res) => {
  const data = pickFields(req.body, CATEGORY_FIELDS);
  if (isBlankText(data.name)) {
    return res.status(400).json({ error: "分类名称不能为空" });
  }
  const category = await Category.create({
    ...data,
    name: data.name.trim(),
  });
  res.status(201).json(category);
});

// 更新分类
router.put("/categories/:id", authMiddleware, adminOnly, async (req, res) => {
  const category = await Category.findByPk(req.params.id);
  if (!category) {
    return res.status(404).json({ error: "分类不存在" });
  }
  const data = pickFields(req.body, CATEGORY_FIELDS);
  if (data.name !== undefined) {
    if (isBlankText(data.name)) {
      return res.status(400).json({ error: "分类名称不能为空" });
    }
    data.name = data.name.trim();
  }
  await category.update(data);
  res.json(category);
});

// 删除分类
router.delete(
  "/categories/:id",
  authMiddleware,
  adminOnly,
  async (req, res) => {
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
  },
);

// 获取题目列表（支持筛选和搜索）
// 分页参数一律先收口再进 SQL：这两个接口**无需登录**，直接 `parseInt` 会拼出
// `LIMIT -1` / `OFFSET NaN` 这类语法错误，变成 500 并把原始 MySQL 报错回给客户端
// （实测 `?limit=-1`、`?page=-1`、`?page=abc&limit=abc`、`?page=9.9e19` 都会 500）。
router.get("/", async (req, res) => {
  const { categoryId, difficulty, keyword } = req.query;
  const page = toBoundedInt(req.query.page, { fallback: 1, max: MAX_PAGE });
  const limit = toBoundedInt(req.query.limit, {
    fallback: DEFAULT_PAGE_SIZE,
    max: MAX_PAGE_SIZE,
  });
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
    limit,
    offset: (page - 1) * limit,
    order: [["createdAt", "DESC"]],
  });

  res.json({
    questions: questions.rows,
    total: questions.count,
    page,
    // limit 保证 ≥1，所以这里不可能是 Infinity / null
    totalPages: Math.ceil(questions.count / limit),
  });
});

// 获取单个题目详情
router.get("/:id", async (req, res) => {
  const question = await Question.findByPk(req.params.id, {
    include: [{ model: Category, attributes: ["id", "name"] }],
  });
  if (!question) {
    return res.status(404).json({ error: "题目不存在" });
  }
  res.json(question);
});

// 随机抽题
router.get("/random/:count", async (req, res) => {
  // 同上：`/random/-3` 会拼出 LIMIT -3（实测 500），负数按 1 处理
  const count = toBoundedInt(req.params.count, { fallback: 1, max: 50 });
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
});

// 创建题目
router.post("/", authMiddleware, adminOnly, async (req, res) => {
  const data = pickFields(req.body, QUESTION_FIELDS);

  if (isBlankText(data.title)) {
    return res.status(400).json({ error: "题目标题不能为空" });
  }
  if (isBlankText(data.answer)) {
    return res.status(400).json({ error: "题目答案不能为空" });
  }
  if (data.difficulty && !VALID_DIFFICULTIES.includes(data.difficulty)) {
    return res.status(400).json({ error: "无效的难度等级" });
  }
  if (data.categoryId === undefined || data.categoryId === null) {
    return res.status(400).json({ error: "请选择分类" });
  }
  if (!(await categoryExists(data.categoryId))) {
    return res.status(400).json({ error: "分类不存在" });
  }

  const question = await Question.create(data);
  res.status(201).json(question);
});

// 更新题目
router.put("/:id", authMiddleware, adminOnly, async (req, res) => {
  const question = await Question.findByPk(req.params.id);
  if (!question) {
    return res.status(404).json({ error: "题目不存在" });
  }
  const data = pickFields(req.body, QUESTION_FIELDS);
  if (data.title !== undefined && isBlankText(data.title)) {
    return res.status(400).json({ error: "题目标题不能为空" });
  }
  if (data.answer !== undefined && isBlankText(data.answer)) {
    return res.status(400).json({ error: "题目答案不能为空" });
  }
  if (data.difficulty && !VALID_DIFFICULTIES.includes(data.difficulty)) {
    return res.status(400).json({ error: "无效的难度等级" });
  }
  if (data.categoryId !== undefined) {
    if (data.categoryId === null || !(await categoryExists(data.categoryId))) {
      return res.status(400).json({ error: "分类不存在" });
    }
  }
  await question.update(data);
  res.json(question);
});

// 批量删除题目。
//
// 前端原来是「勾中 N 道就发 N 个 DELETE /api/questions/:id」（Promise.all）。
// 除了 N 个 HTTP + N 条 SQL，那里还有个更难看的正确性问题：Promise.all 只要有一个
// reject 就整体提示「批量删除失败」，可**前面已经删掉的那些是真删了** —— 管理员看到
// 「失败」去重试，实际上列表已经少了几行，而且那次失败路径不会刷新列表。
// 这里合成一次请求，返回真实删掉的行数，由前端如实汇报。
//
// 用 POST 而不是带 body 的 DELETE：DELETE + body 在部分代理/网关下会被丢掉，
// 而 body 一旦丢了，`ids` 变成 undefined，语义就从「删这几道」滑向「删空集」。
router.post("/batch-delete", authMiddleware, adminOnly, async (req, res) => {
  const ids = parseIdList(req.body && req.body.ids);
  if (ids.length === 0) {
    return res.status(400).json({ error: "请选择要删除的题目" });
  }

  const deleted = await Question.destroy({ where: { id: { [Op.in]: ids } } });

  res.json({
    message: deleted === ids.length ? "删除成功" : `已删除 ${deleted} 道题目`,
    data: { requested: ids.length, deleted },
  });
});

// 删除题目
router.delete("/:id", authMiddleware, adminOnly, async (req, res) => {
  const question = await Question.findByPk(req.params.id);
  if (!question) {
    return res.status(404).json({ error: "题目不存在" });
  }
  await question.destroy();
  res.json({ message: "删除成功" });
});

module.exports = router;
