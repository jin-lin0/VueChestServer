const express = require("express");
const { Op, fn, col } = require("sequelize");
const AppComment = require("../models/appComment");
const MarketApp = require("../models/marketApp");
const User = require("../models/user");
const { authMiddleware, optionalAuth } = require("../middleware/auth");
const { isAdmin } = require("../middleware/superAdmin");

const router = express.Router();

// 评论列表 + 评分摘要
// 测试期数据量小，直接返回该 app 全部可见评论（上限 500），楼中楼由前端按 parentId 组装；
// 后续若评论增长，可在此加分页（仅顶层分页并强制携带其楼中楼）。
router.get("/apps/:id/comments", optionalAuth, async (req, res) => {
  const appId = Number(req.params.id);
  if (!Number.isInteger(appId)) {
    return res.status(400).json({ error: "无效的应用 ID" });
  }

  const app = await MarketApp.findByPk(appId, { attributes: ["id", "status"] });
  if (!app || app.status !== "approved") {
    return res.status(404).json({ error: "应用不存在" });
  }

  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || 200));
  const rows = await AppComment.findAll({
    where: { appId, status: "visible" },
    order: [["createdAt", "DESC"]],
    limit,
    include: [
      { model: User, as: "author", attributes: ["id", "username", "avatar"] },
    ],
  });

  // 评分摘要：仅统计带 rating 的可见评论
  const ratingRows = await AppComment.findAll({
    where: { appId, status: "visible", rating: { [Op.ne]: null } },
    attributes: [[fn("AVG", col("rating")), "avg"], [fn("COUNT", col("rating")), "cnt"]],
    raw: true,
  });
  const r = ratingRows[0] || {};
  const ratingSummary = {
    average: r.avg != null ? Number(Number(r.avg).toFixed(1)) : null,
    count: Number(r.cnt) || 0,
  };

  res.json({
    success: true,
    data: {
      items: rows.map((row) => {
        const d = row.toJSON();
        d.canDelete = !!(
          req.user &&
          (req.user.id === d.userId || isAdmin(req.user))
        );
        return d;
      }),
      ratingSummary,
    },
  });
});

// 发布评论（仅登录用户）
router.post("/apps/:id/comments", authMiddleware, async (req, res) => {
  const appId = Number(req.params.id);
  if (!Number.isInteger(appId)) {
    return res.status(400).json({ error: "无效的应用 ID" });
  }
  const { content, rating, parentId } = req.body;

  const text = typeof content === "string" ? content.trim() : "";
  if (!text) return res.status(400).json({ error: "评论内容不能为空" });
  if (text.length > 1000)
    return res.status(400).json({ error: "评论过长（≤1000字）" });
  if (rating != null && (Number(rating) < 1 || Number(rating) > 5)) {
    return res.status(400).json({ error: "评分需在 1-5 之间" });
  }

  const app = await MarketApp.findByPk(appId, { attributes: ["id", "status"] });
  if (!app || app.status !== "approved") {
    return res.status(404).json({ error: "应用不存在" });
  }

  // 楼中楼：parentId 必须属于同一 app 且可见；若指向的是某个楼中楼，则归并到其顶层父级，避免无限嵌套
  const parent = parentId
    ? await AppComment.findOne({
        where: { id: Number(parentId), appId, status: "visible" },
      })
    : null;
  if (parentId && !parent) {
    return res.status(400).json({ error: "回复的评论不存在" });
  }
  const effectiveParentId = parent ? parent.parentId || parent.id : null;

  const comment = await AppComment.create({
    appId,
    userId: req.user.id,
    content: text,
    rating: rating == null ? null : Number(rating),
    parentId: effectiveParentId,
  });

  const withAuthor = await AppComment.findByPk(comment.id, {
    include: [
      { model: User, as: "author", attributes: ["id", "username", "avatar"] },
    ],
  });
  const out = withAuthor.toJSON();
  out.canDelete = true; // 刚创建的评论作者本人必可删

  res.status(201).json({ success: true, data: out });
});

// 删除评论（作者本人或管理员）。删除顶层评论时一并清除其楼中楼。
router.delete("/comments/:commentId", authMiddleware, async (req, res) => {
  const commentId = Number(req.params.commentId);
  if (!Number.isInteger(commentId)) {
    return res.status(400).json({ error: "无效的评论 ID" });
  }
  const comment = await AppComment.findByPk(commentId);
  if (!comment) return res.status(404).json({ error: "评论不存在" });
  if (comment.userId !== req.user.id && !isAdmin(req.user)) {
    return res.status(403).json({ error: "无权删除该评论" });
  }

  if (!comment.parentId) {
    await AppComment.destroy({ where: { parentId: comment.id } });
  }
  await comment.destroy();

  res.json({ success: true, message: "删除成功" });
});

module.exports = router;
