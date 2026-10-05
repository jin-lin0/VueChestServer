const express = require("express");
const { Op, fn, col } = require("sequelize");
const MarketApp = require("../models/marketApp");
const MarketAppVersion = require("../models/marketAppVersion");
const MarketAppVersionReview = require("../models/marketAppVersionReview");
const AppComment = require("../models/appComment");
const VisitLog = require("../models/visitLog");
const {
  buildDateRange,
  aggregateDownloads,
  countByDay,
  ratingDistribution,
  averageRating,
  averageReviewHours,
} = require("../services/developerAnalytics");
const { authMiddleware } = require("../middleware/auth");

const router = express.Router();
router.use(authMiddleware);

function compareVersions(left, right) {
  const parse = (value) => {
    const [main, prerelease = ""] = String(value || "0").replace(/^v/i, "").split("-", 2);
    return { parts: main.split(".").map((part) => parseInt(part, 10) || 0), prerelease };
  };
  const a = parse(left);
  const b = parse(right);
  const length = Math.max(a.parts.length, b.parts.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (a.parts[index] || 0) - (b.parts[index] || 0);
    if (diff) return diff > 0 ? 1 : -1;
  }
  if (!a.prerelease && b.prerelease) return 1;
  if (a.prerelease && !b.prerelease) return -1;
  return a.prerelease.localeCompare(b.prerelease, undefined, { numeric: true });
}

async function findOwnedApp(appId, userId) {
  const app = await MarketApp.findOne({ where: { id: appId, uploadedBy: userId } });
  if (!app) {
    const error = new Error("开发者应用不存在");
    error.status = 404;
    throw error;
  }
  return app;
}

router.get("/apps", async (req, res) => {
  const apps = await MarketApp.findAll({
    where: { uploadedBy: req.user.id },
    attributes: [
      "id",
      "name",
      "icon",
      "description",
      "version",
      "category",
      "downloads",
      "status",
      "isListed",
      "createdAt",
      "updatedAt",
    ],
    order: [["updatedAt", "DESC"]],
  });
  const appIds = apps.map((app) => app.id);
  const [versions, ratings] = await Promise.all([
    appIds.length
      ? MarketAppVersion.findAll({
          where: { appId: { [Op.in]: appIds } },
          attributes: [
            "id",
            "appId",
            "version",
            "size",
            "releaseNotes",
            "status",
            "reviewStatus",
            "reviewCategory",
            "reviewNote",
            "reviewedAt",
            "submissionCount",
            "createdAt",
            "updatedAt",
          ],
          order: [["createdAt", "DESC"]],
        })
      : [],
    appIds.length
      ? AppComment.findAll({
          where: { appId: { [Op.in]: appIds }, parentId: null, status: "visible" },
          attributes: [
            "appId",
            [fn("COUNT", col("id")), "commentCount"],
            [fn("AVG", col("rating")), "averageRating"],
          ],
          group: ["appId"],
          raw: true,
        })
      : [],
  ]);
  const reviews = versions.length
    ? await MarketAppVersionReview.findAll({
        where: { versionId: { [Op.in]: versions.map((version) => version.id) } },
        attributes: ["id", "versionId", "action", "category", "message", "createdAt"],
        order: [["createdAt", "DESC"]],
      })
    : [];
  const reviewsByVersion = new Map();
  reviews.forEach((review) => {
    const list = reviewsByVersion.get(review.versionId) || [];
    list.push(review.toJSON());
    reviewsByVersion.set(review.versionId, list);
  });
  const versionsByApp = new Map();
  versions.forEach((version) => {
    const list = versionsByApp.get(version.appId) || [];
    list.push({ ...version.toJSON(), reviews: reviewsByVersion.get(version.id) || [] });
    versionsByApp.set(version.appId, list);
  });
  const ratingMap = new Map(
    ratings.map((rating) => [
      Number(rating.appId),
      {
        commentCount: Number(rating.commentCount || 0),
        averageRating: rating.averageRating ? Number(rating.averageRating) : null,
      },
    ]),
  );
  res.json({
    success: true,
    data: apps.map((app) => ({
      ...app.toJSON(),
      versions: versionsByApp.get(app.id) || [],
      rating: ratingMap.get(app.id) || { commentCount: 0, averageRating: null },
    })),
  });
});

/**
 * 开发者数据看板：把「累计数字」升级为「按时间维度的趋势」。
 *
 * 数据来源：
 * - 下载趋势：visit_logs 里 `/api/market/apps/:id/download` 与
 *   `/api/market/apps/:id/versions/:vid/download` 两类路径的每日计数。
 *   （visitLogger 不记录内网 IP，因此本地调试流量不计入，属预期行为。）
 * - 评论趋势 / 评分分布：app_comments。
 * - 审核时效：market_app_versions 的 createdAt → reviewedAt。
 */
router.get("/analytics", async (req, res) => {
  const range = buildDateRange(req.query.days);
  const apps = await MarketApp.findAll({
    where: { uploadedBy: req.user.id },
    attributes: [
      "id",
      "name",
      "icon",
      "category",
      "status",
      "isListed",
      "downloads",
      "createdAt",
    ],
    order: [["downloads", "DESC"]],
  });
  const appIds = apps.map((app) => app.id);
  const base = {
    range: { days: range.days, from: range.from, to: range.to, dates: range.dates },
  };

  if (!appIds.length) {
    return res.json({
      success: true,
      data: {
        ...base,
        totals: {
          apps: 0,
          listed: 0,
          pendingVersions: 0,
          downloads: 0,
          windowDownloads: 0,
          comments: 0,
          averageRating: null,
        },
        series: { downloads: range.dates.map(() => 0), comments: range.dates.map(() => 0) },
        apps: [],
        ratings: ratingDistribution([]),
        review: { averageHours: null, approvedCount: 0, pendingCount: 0 },
      },
    });
  }

  const appIdFilter = { [Op.in]: appIds };
  const [downloadRows, windowComments, allComments, approvedVersions, pendingRows] =
    await Promise.all([
      VisitLog.findAll({
        where: {
          date: { [Op.between]: [range.from, range.to] },
          path: { [Op.like]: "/api/market/apps/%/download" },
        },
        attributes: ["date", "path", "count"],
        raw: true,
      }),
      AppComment.findAll({
        where: {
          appId: appIdFilter,
          parentId: null,
          status: "visible",
          createdAt: { [Op.gte]: `${range.from} 00:00:00` },
        },
        attributes: ["appId", "createdAt"],
        raw: true,
      }),
      AppComment.findAll({
        where: { appId: appIdFilter, parentId: null, status: "visible" },
        attributes: ["appId", "rating"],
        raw: true,
      }),
      MarketAppVersion.findAll({
        where: {
          appId: appIdFilter,
          reviewStatus: "approved",
          reviewedAt: { [Op.ne]: null },
        },
        attributes: ["createdAt", "reviewedAt"],
        raw: true,
      }),
      MarketAppVersion.findAll({
        where: { appId: appIdFilter, reviewStatus: "pending" },
        attributes: ["appId"],
        raw: true,
      }),
    ]);

  const downloads = aggregateDownloads(downloadRows, appIds, range);
  const comments = countByDay(windowComments, range);
  const pendingByApp = new Map();
  for (const row of pendingRows) {
    pendingByApp.set(row.appId, (pendingByApp.get(row.appId) || 0) + 1);
  }

  const ratingsByApp = new Map();
  for (const comment of allComments) {
    const list = ratingsByApp.get(comment.appId) || [];
    list.push(comment);
    ratingsByApp.set(comment.appId, list);
  }

  res.json({
    success: true,
    data: {
      ...base,
      totals: {
        apps: apps.length,
        listed: apps.filter((app) => app.status === "approved" && app.isListed).length,
        pendingVersions: pendingRows.length,
        // downloads 是模型里的累计计数，windowDownloads 是所选区间内的实际增量
        downloads: apps.reduce((total, app) => total + (app.downloads || 0), 0),
        windowDownloads: downloads.total,
        comments: comments.total,
        averageRating: averageRating(allComments),
      },
      series: {
        downloads: downloads.series,
        comments: comments.series,
      },
      apps: apps.map((app) => {
        const appComments = ratingsByApp.get(app.id) || [];
        return {
          id: app.id,
          name: app.name,
          icon: app.icon,
          category: app.category,
          status: app.status,
          isListed: app.isListed,
          downloads: app.downloads || 0,
          windowDownloads: (downloads.byApp.get(app.id) || []).reduce(
            (total, value) => total + value,
            0,
          ),
          comments: (comments.byApp.get(app.id) || []).reduce(
            (total, value) => total + value,
            0,
          ),
          averageRating: averageRating(appComments),
          pendingVersions: pendingByApp.get(app.id) || 0,
          downloadTrend: downloads.byApp.get(app.id) || range.dates.map(() => 0),
          commentTrend: comments.byApp.get(app.id) || range.dates.map(() => 0),
        };
      }),
      ratings: ratingDistribution(allComments),
      review: {
        averageHours: averageReviewHours(approvedVersions),
        approvedCount: approvedVersions.length,
        pendingCount: pendingRows.length,
      },
    },
  });
});

router.put("/apps/:id/listing", async (req, res) => {
  const app = await findOwnedApp(req.params.id, req.user.id);
  if (app.status !== "approved") {
    return res.status(400).json({ error: "只有审核通过的应用可以上架或下架" });
  }
  await app.update({ isListed: req.body?.isListed === true });
  res.json({ success: true, data: { id: app.id, isListed: app.isListed } });
});

router.post("/apps/:id/versions/:versionId/withdraw", async (req, res) => {
  const app = await findOwnedApp(req.params.id, req.user.id);
  const version = await MarketAppVersion.findOne({
    where: {
      id: req.params.versionId,
      appId: app.id,
      publishedBy: req.user.id,
      reviewStatus: "pending",
    },
  });
  if (!version) return res.status(404).json({ error: "待审核版本不存在" });
  await version.update({
    reviewStatus: "withdrawn",
    reviewedBy: req.user.id,
    reviewedAt: new Date(),
  });
  await MarketAppVersionReview.create({
    appId: app.id,
    versionId: version.id,
    actorId: req.user.id,
    action: "withdrawn",
  });
  if (app.status === "pending") await app.update({ status: "rejected" });
  res.json({ success: true, message: `v${version.version} 已撤回` });
});

router.post("/apps/:id/versions/:versionId/resubmit", async (req, res) => {
  const app = await findOwnedApp(req.params.id, req.user.id);
  const version = await MarketAppVersion.findOne({
    where: {
      id: req.params.versionId,
      appId: app.id,
      publishedBy: req.user.id,
      reviewStatus: { [Op.in]: ["rejected", "withdrawn"] },
    },
  });
  if (!version) return res.status(404).json({ error: "可重新提交的版本不存在" });
  if (app.status === "approved" && compareVersions(version.version, app.version) <= 0) {
    return res.status(409).json({ error: "线上版本已经更高，请发布新的版本号" });
  }
  await version.update({
    reviewStatus: "pending",
    reviewCategory: null,
    reviewNote: null,
    reviewedBy: null,
    reviewedAt: null,
    submissionCount: Number(version.submissionCount || 1) + 1,
  });
  if (app.status === "rejected") await app.update({ status: "pending" });
  await MarketAppVersionReview.create({
    appId: app.id,
    versionId: version.id,
    actorId: req.user.id,
    action: "resubmitted",
  });
  res.json({ success: true, message: `v${version.version} 已重新提交审核` });
});

module.exports = router;
