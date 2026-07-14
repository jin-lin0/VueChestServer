const express = require("express");
const { Op } = require("sequelize");
const VisitLog = require("../models/visitLog");
const MarketApp = require("../models/marketApp");
const { authMiddleware } = require("../middleware/auth");
const { adminOnly } = require("../middleware/superAdmin");

const router = express.Router();

const todayStart = () => new Date().toISOString().slice(0, 10);

async function todayCreatedCount(model) {
  return model.count({
    where: {
      createdAt: { [Op.gte]: todayStart() },
    },
  });
}

async function totalCreatedCount(model) {
  return model.count();
}

router.get("/dashboard", authMiddleware, adminOnly, async (req, res) => {
  const todayApps = await todayCreatedCount(MarketApp);

  let todayQuestions = 0;
  try {
    const Question = require("../models/question");
    todayQuestions = await todayCreatedCount(Question);
  } catch {}

  const todayVisits = await VisitLog.sum("count", {
    where: { date: todayStart() },
  });
  const totalVisits = await VisitLog.sum("count");

  res.json({
    success: true,
    data: {
      todayNewApps: todayApps,
      todayNewQuestions: todayQuestions,
      todayVisits: todayVisits || 0,
      totalVisits: totalVisits || 0,
      totalApps: await totalCreatedCount(MarketApp),
    },
  });
});

// 调试：查看请求来源信息
router.get("/whoami", authMiddleware, adminOnly, (req, res) => {
  const ip =
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.ip ||
    req.socket?.remoteAddress;
  res.json({
    ip,
    vercel: {
      country: req.headers["x-vercel-ip-country"] || null,
      city: req.headers["x-vercel-ip-city"] || null,
      latitude: req.headers["x-vercel-ip-latitude"] || null,
      longitude: req.headers["x-vercel-ip-longitude"] || null,
    },
    headers: {
      "x-forwarded-for": req.headers["x-forwarded-for"] || null,
    },
  });
});

module.exports = router;
