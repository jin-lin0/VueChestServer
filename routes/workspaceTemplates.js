const crypto = require("crypto");
const express = require("express");
const WorkspaceTemplate = require("../models/workspaceTemplate");
const { authMiddleware, optionalAuth } = require("../middleware/auth");
const { isAdmin } = require("../middleware/superAdmin");

const router = express.Router();
const APP_KEY_RE = /^(builtin|market):\d+$/;

function sanitizeTemplate(raw) {
  if (!raw || typeof raw !== "object") {
    const error = new Error("工作区模板格式错误");
    error.status = 400;
    throw error;
  }
  const name = String(raw.name || "").trim().slice(0, 40);
  if (!name) {
    const error = new Error("模板名称不能为空");
    error.status = 400;
    throw error;
  }
  const appKeys = [
    ...new Set(
      (Array.isArray(raw.appKeys) ? raw.appKeys : [])
        .map(String)
        .filter((key) => APP_KEY_RE.test(key)),
    ),
  ].slice(0, 100);
  return {
    version: 1,
    name,
    icon: String(raw.icon || "◫").slice(0, 8),
    description: String(raw.description || "").trim().slice(0, 255),
    appKeys,
  };
}

function publicData(row) {
  return {
    shareCode: row.shareCode,
    name: row.name,
    icon: row.icon,
    description: row.description || "",
    template: row.data,
    isOfficial: row.isOfficial,
    downloads: row.downloads,
    createdAt: row.createdAt,
  };
}

router.get("/official", async (req, res) => {
  const rows = await WorkspaceTemplate.findAll({
    where: { isOfficial: true },
    order: [["downloads", "DESC"]],
    limit: 30,
  });
  res.json({ success: true, data: rows.map(publicData) });
});

router.get("/:shareCode", optionalAuth, async (req, res) => {
  const row = await WorkspaceTemplate.findOne({ where: { shareCode: req.params.shareCode } });
  if (!row) return res.status(404).json({ error: "工作区模板不存在" });
  res.json({ success: true, data: publicData(row) });
});

router.post("/", authMiddleware, async (req, res) => {
  const template = sanitizeTemplate(req.body?.template);
  let shareCode;
  do {
    shareCode = crypto.randomBytes(6).toString("base64url");
  } while (await WorkspaceTemplate.count({ where: { shareCode } }));
  const row = await WorkspaceTemplate.create({
    shareCode,
    name: template.name,
    icon: template.icon,
    description: template.description,
    data: template,
    createdBy: req.user.id,
    isOfficial: isAdmin(req.user) && req.body?.isOfficial === true,
  });
  res.status(201).json({ success: true, data: publicData(row) });
});

router.post("/:shareCode/use", async (req, res) => {
  await WorkspaceTemplate.increment("downloads", { where: { shareCode: req.params.shareCode } });
  res.json({ success: true });
});

router.delete("/:shareCode", authMiddleware, async (req, res) => {
  const row = await WorkspaceTemplate.findOne({ where: { shareCode: req.params.shareCode } });
  if (!row) return res.status(404).json({ error: "工作区模板不存在" });
  if (row.createdBy !== req.user.id && !isAdmin(req.user)) {
    return res.status(403).json({ error: "无权删除该模板" });
  }
  await row.destroy();
  res.json({ success: true });
});

module.exports = router;
