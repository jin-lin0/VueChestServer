const express = require("express");
const { Op, fn, col } = require("sequelize");
const MarketApp = require("../models/marketApp");
const User = require("../models/user");
const { authMiddleware, optionalAuth } = require("../middleware/auth");
const { adminOnly } = require("../middleware/superAdmin");

const router = express.Router();

MarketApp.belongsTo(User, { foreignKey: "uploadedBy", as: "uploader" });

// 获取分类列表（只统计已通过的应用，单次 GROUP BY 查询，避免 N+1）
router.get("/categories", async (req, res) => {
  const rows = await MarketApp.findAll({
    attributes: ["category", [fn("COUNT", col("id")), "count"]],
    where: { status: "approved" },
    group: ["category"],
    raw: true,
  });
  const data = rows
    .filter((r) => r.category)
    .map((r) => ({ name: r.category, count: Number(r.count) }));
  res.json({ success: true, data });
});

// 获取应用列表（公开市场只返回已通过的应用）
router.get("/apps", optionalAuth, async (req, res) => {
  const { category, keyword, page = "1", limit = "20" } = req.query;
  const pageNum = Math.max(1, parseInt(page));
  const limitNum = Math.min(50, Math.max(1, parseInt(limit)));
  const offset = (pageNum - 1) * limitNum;

  const where = {};
  // 非管理员只看到已通过的应用
  const isAdmin = req.user && (req.user.role === "admin" || req.user.role === "super_admin");
  if (!isAdmin) {
    where.status = "approved";
  }
  if (category) {
    where.category = category;
  }
  if (keyword) {
    where[Op.or] = [
      { name: { [Op.like]: `%${keyword}%` } },
      { description: { [Op.like]: `%${keyword}%` } },
    ];
  }

  const attributes = [
    "id",
    "name",
    "icon",
    "description",
    "version",
    "author",
    "category",
    "size",
    "isOfficial",
    "downloads",
    "status",
    "createdAt",
    "updatedAt",
  ];

  const { rows, count } = await MarketApp.findAndCountAll({
    where,
    attributes,
    order: [["createdAt", "DESC"]],
    offset,
    limit: limitNum,
  });

  res.json({
    success: true,
    data: {
      items: rows,
      total: count,
      page: pageNum,
      limit: limitNum,
      totalPages: Math.ceil(count / limitNum),
    },
  });
});

// 获取应用详情
router.get("/apps/:id", optionalAuth, async (req, res) => {
  const app = await MarketApp.findByPk(req.params.id, {
    attributes: [
      "id",
      "name",
      "icon",
      "description",
      "version",
      "author",
      "category",
      "size",
      "screenshots",
      "readme",
      "isOfficial",
      "downloads",
      "status",
      "uploadedBy",
      "createdAt",
      "updatedAt",
    ],
  });

  if (!app) {
    return res.status(404).json({ error: "应用不存在" });
  }

  // 非管理员且非上传者只能查看已通过的应用
  const isAdmin = req.user && (req.user.role === "admin" || req.user.role === "super_admin");
  const isOwner = req.user && req.user.id === app.uploadedBy;
  if (app.status !== "approved" && !isAdmin && !isOwner) {
    return res.status(404).json({ error: "应用不存在" });
  }

  const data = app.toJSON();
  if (data.screenshots) {
    try {
      data.screenshots = JSON.parse(data.screenshots);
    } catch {
      data.screenshots = [];
    }
  }

  res.json({ success: true, data });
});

// 下载应用 JS 包（只允许下载已通过的应用）
router.get("/apps/:id/download", async (req, res) => {
  const app = await MarketApp.findByPk(req.params.id, {
    attributes: ["fileContent", "name", "version", "status"],
  });

  if (!app) {
    return res.status(404).json({ error: "应用不存在" });
  }

  if (app.status !== "approved") {
    return res.status(403).json({ error: "应用尚未通过审核" });
  }

  // 增加下载计数（异步，不阻塞）
  MarketApp.increment("downloads", { by: 1, where: { id: req.params.id } }).catch(() => {});

  res.json({
    success: true,
    data: {
      name: app.name,
      version: app.version,
      fileContent: app.fileContent,
    },
  });
});

// 上传应用（任何登录用户都可以上传，状态为 pending）
router.post("/apps", authMiddleware, async (req, res) => {
  const { name, icon, description, version, category, fileContent, screenshots, readme } =
    req.body;

  if (!name || !icon || !fileContent) {
    return res.status(400).json({ error: "名称、图标和文件内容不能为空" });
  }

  const app = await MarketApp.create({
    name,
    icon,
    description: description || "",
    version: version || "1.0.0",
    author: req.user.username,
    category: category || "",
    fileContent,
    size: Buffer.byteLength(fileContent, "utf8"),
    screenshots: screenshots ? JSON.stringify(screenshots) : null,
    readme: readme || "",
    uploadedBy: req.user.id,
    status: "pending",
  });

  res.status(201).json({
    success: true,
    message: "上传成功，等待管理员审核",
    data: { id: app.id, name: app.name, version: app.version, status: app.status },
  });
});

// 审核通过应用
router.post("/apps/:id/approve", authMiddleware, adminOnly, async (req, res) => {
  const app = await MarketApp.findByPk(req.params.id);
  if (!app) {
    return res.status(404).json({ error: "应用不存在" });
  }
  if (app.status === "approved") {
    return res.status(400).json({ error: "应用已通过审核" });
  }

  await app.update({ status: "approved" });

  res.json({
    success: true,
    message: "应用已通过审核",
  });
});

// 审核拒绝应用
router.post("/apps/:id/reject", authMiddleware, adminOnly, async (req, res) => {
  const app = await MarketApp.findByPk(req.params.id);
  if (!app) {
    return res.status(404).json({ error: "应用不存在" });
  }
  if (app.status === "rejected") {
    return res.status(400).json({ error: "应用已被拒绝" });
  }

  await app.update({ status: "rejected" });

  res.json({
    success: true,
    message: "应用已拒绝",
  });
});

// 更新应用
router.put("/apps/:id", authMiddleware, adminOnly, async (req, res) => {
  const app = await MarketApp.findByPk(req.params.id);

  if (!app) {
    return res.status(404).json({ error: "应用不存在" });
  }

  const { name, icon, description, version, category, fileContent, screenshots, readme, status } =
    req.body;

  const updateData = {};
  if (name !== undefined) updateData.name = name;
  if (icon !== undefined) updateData.icon = icon;
  if (description !== undefined) updateData.description = description;
  if (version !== undefined) updateData.version = version;
  if (category !== undefined) updateData.category = category;
  if (screenshots !== undefined) updateData.screenshots = JSON.stringify(screenshots);
  if (readme !== undefined) updateData.readme = readme;
  if (status !== undefined) updateData.status = status;

  if (fileContent !== undefined) {
    updateData.fileContent = fileContent;
    updateData.size = Buffer.byteLength(fileContent, "utf8");
  }

  await app.update(updateData);

  res.json({
    success: true,
    message: "更新成功",
  });
});

// 删除应用
router.delete("/apps/:id", authMiddleware, adminOnly, async (req, res) => {
  const app = await MarketApp.findByPk(req.params.id);

  if (!app) {
    return res.status(404).json({ error: "应用不存在" });
  }

  await app.destroy();

  res.json({
    success: true,
    message: "删除成功",
  });
});

module.exports = router;
