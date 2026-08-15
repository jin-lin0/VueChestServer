const express = require("express");
const { Op, fn, col } = require("sequelize");
const VisitLog = require("../models/visitLog");
const MarketApp = require("../models/marketApp");
const Question = require("../models/question");
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
  const todayQuestions = await todayCreatedCount(Question);

  const todayVisits = await VisitLog.sum("count", {
    where: { date: todayStart() },
  });
  const totalVisits = await VisitLog.sum("count");

  // 访问地域分布：按国家/城市聚合访问次数（visitLogger 已写入 country/city）
  const topCountries = await VisitLog.findAll({
    attributes: ["country", [fn("SUM", col("count")), "total"]],
    where: { country: { [Op.ne]: "" } },
    group: ["country"],
    order: [[fn("SUM", col("count")), "DESC"]],
    limit: 10,
  }).then((rows) =>
    rows.map((r) => ({ country: r.country, total: Number(r.get("total")) })),
  );

  const topCities = await VisitLog.findAll({
    attributes: ["city", [fn("SUM", col("count")), "total"]],
    where: { city: { [Op.ne]: "" } },
    group: ["city"],
    order: [[fn("SUM", col("count")), "DESC"]],
    limit: 10,
  }).then((rows) =>
    rows.map((r) => ({ city: r.city, total: Number(r.get("total")) })),
  );

  res.json({
    success: true,
    data: {
      todayNewApps: todayApps,
      todayNewQuestions: todayQuestions,
      todayVisits: todayVisits || 0,
      totalVisits: totalVisits || 0,
      totalApps: await totalCreatedCount(MarketApp),
      geo: {
        countries: topCountries,
        cities: topCities,
      },
    },
  });
});

module.exports = router;
