const express = require("express");
const { Op, fn, col } = require("sequelize");
const MarketApp = require("../models/marketApp");
const MarketAppVersion = require("../models/marketAppVersion");
const MarketAppVersionReview = require("../models/marketAppVersionReview");
const AppComment = require("../models/appComment");
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
