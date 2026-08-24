const express = require("express");
const { Op } = require("sequelize");
const AppReport = require("../models/appReport");
const MarketApp = require("../models/marketApp");
const User = require("../models/user");
const { authMiddleware } = require("../middleware/auth");
const { adminOnly } = require("../middleware/superAdmin");

const router = express.Router();
const REPORT_REASONS = new Set([
  "malware",
  "privacy",
  "fraud",
  "offensive",
  "copyright",
  "other",
]);

router.post("/apps/:id/reports", authMiddleware, async (req, res) => {
  const appId = Number(req.params.id);
  const reason = String(req.body?.reason || "").trim();
  const details = String(req.body?.details || "").trim();
  if (!Number.isInteger(appId) || !REPORT_REASONS.has(reason)) {
    return res.status(400).json({ error: "举报类型或应用 ID 无效" });
  }
  if (details.length < 5 || details.length > 1000) {
    return res.status(400).json({ error: "举报说明需为 5-1000 个字符" });
  }
  const app = await MarketApp.findOne({
    where: { id: appId, status: "approved" },
  });
  if (!app) return res.status(404).json({ error: "应用不存在" });

  const existing = await AppReport.findOne({
    where: { appId, reporterId: req.user.id, status: "open" },
  });
  if (existing) {
    return res.status(409).json({ error: "你已提交过该应用的待处理举报" });
  }
  const report = await AppReport.create({
    appId,
    reporterId: req.user.id,
    reason,
    details,
  });
  res.status(201).json({
    success: true,
    data: { id: report.id, status: report.status, createdAt: report.createdAt },
  });
});

router.get("/admin/reports", authMiddleware, adminOnly, async (req, res) => {
  const status = String(req.query.status || "open");
  const where = ["open", "resolved", "dismissed"].includes(status)
    ? { status }
    : {};
  const reports = await AppReport.findAll({
    where,
    order: [["createdAt", "DESC"]],
    limit: 200,
  });
  const appIds = [...new Set(reports.map((report) => report.appId))];
  const userIds = [...new Set(reports.map((report) => report.reporterId))];
  const [apps, users] = await Promise.all([
    appIds.length
      ? MarketApp.findAll({
          where: { id: { [Op.in]: appIds } },
          attributes: ["id", "name", "icon", "version", "status"],
        })
      : [],
    userIds.length
      ? User.findAll({
          where: { id: { [Op.in]: userIds } },
          attributes: ["id", "username"],
        })
      : [],
  ]);
  const appMap = new Map(apps.map((app) => [app.id, app.toJSON()]));
  const userMap = new Map(users.map((user) => [user.id, user.toJSON()]));
  res.json({
    success: true,
    data: reports.map((report) => ({
      ...report.toJSON(),
      app: appMap.get(report.appId) || null,
      reporter: userMap.get(report.reporterId) || null,
    })),
  });
});

router.put(
  "/admin/reports/:id",
  authMiddleware,
  adminOnly,
  async (req, res) => {
    const status = String(req.body?.status || "");
    const resolutionNote = String(req.body?.resolutionNote || "").trim();
    if (!["resolved", "dismissed"].includes(status)) {
      return res.status(400).json({ error: "处理状态无效" });
    }
    if (resolutionNote.length < 2 || resolutionNote.length > 1000) {
      return res.status(400).json({ error: "处理说明需为 2-1000 个字符" });
    }
    const report = await AppReport.findByPk(req.params.id);
    if (!report) return res.status(404).json({ error: "举报不存在" });
    await report.update({
      status,
      resolutionNote,
      reviewedBy: req.user.id,
      reviewedAt: new Date(),
    });
    res.json({ success: true, data: report });
  },
);

module.exports = router;
