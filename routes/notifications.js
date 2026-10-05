const express = require("express");
const {
  listNotifications,
  unreadCount,
  markRead,
  markAllRead,
  removeNotification,
} = require("../services/notificationService");
const { authMiddleware } = require("../middleware/auth");

const router = express.Router();
router.use(authMiddleware);

router.get("/", async (req, res) => {
  const result = await listNotifications(req.user.id, {
    page: req.query.page,
    limit: req.query.limit,
    unreadOnly: req.query.unread === "true" || req.query.unreadOnly === "true",
  });
  res.json({ success: true, data: result.items, pagination: result.pagination });
});

// 顶栏角标只需要一个数字，单独给一个轻量端点，避免拉整页数据。
router.get("/unread-count", async (req, res) => {
  res.json({ success: true, data: { count: await unreadCount(req.user.id) } });
});

router.post("/read", async (req, res) => {
  const updated = await markRead(req.user.id, req.body?.ids);
  res.json({ success: true, data: { updated } });
});

router.post("/read-all", async (req, res) => {
  const updated = await markAllRead(req.user.id);
  res.json({ success: true, data: { updated } });
});

router.delete("/:id", async (req, res) => {
  const removed = await removeNotification(req.user.id, req.params.id);
  if (!removed) {
    return res.status(404).json({ success: false, error: "通知不存在" });
  }
  res.json({ success: true, data: { id: Number(req.params.id) } });
});

module.exports = router;
