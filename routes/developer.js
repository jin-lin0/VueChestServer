const express = require("express");
const { Op, fn, col } = require("sequelize");
const MarketApp = require("../models/marketApp");
const MarketAppVersion = require("../models/marketAppVersion");
const AppComment = require("../models/appComment");
const { authMiddleware } = require("../middleware/auth");

const router = express.Router();
router.use(authMiddleware);

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
  const versionsByApp = new Map();
  versions.forEach((version) => {
    const list = versionsByApp.get(version.appId) || [];
    list.push(version.toJSON());
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
  await version.update({ reviewStatus: "withdrawn" });
  if (app.status === "pending") await app.update({ status: "rejected" });
  res.json({ success: true, message: `v${version.version} 已撤回` });
});

module.exports = router;
