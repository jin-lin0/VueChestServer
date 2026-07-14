const express = require("express");
const router = express.Router();
const Message = require("../models/message");
const { authMiddleware } = require("../middleware/auth");
const { adminOnly } = require("../middleware/superAdmin");

// 创建消息
router.post("/", async (req, res) => {
  const { question, answer, model } = req.body;
  if (typeof question !== "string" || !question.trim() || question.length > 50_000) {
    return res.status(400).json({ error: "问题内容无效", code: "VALIDATION_ERROR" });
  }
  if (typeof answer !== "string" || !answer.trim() || answer.length > 200_000) {
    return res.status(400).json({ error: "回答内容无效", code: "VALIDATION_ERROR" });
  }
  if (typeof model !== "string" || !model.trim() || model.length > 100) {
    return res.status(400).json({ error: "模型名称无效", code: "VALIDATION_ERROR" });
  }
  const message = await Message.create({ question: question.trim(), answer, model: model.trim() });
  res.status(201).json(message);
});

// 获取所有消息
router.get("/", authMiddleware, adminOnly, async (req, res) => {
  const messages = await Message.findAll();
  res.json(messages);
});

// 获取单个消息
router.get("/:id", authMiddleware, adminOnly, async (req, res) => {
  const message = await Message.findByPk(req.params.id);
  if (!message) {
    return res.status(404).json({ error: "Message not found" });
  }
  res.json(message);
});

// 更新消息
router.put("/:id", authMiddleware, adminOnly, async (req, res) => {
  const [updated] = await Message.update(req.body, {
    where: { id: req.params.id },
  });
  if (!updated) {
    return res.status(404).json({ error: "Message not found" });
  }
  const updatedMessage = await Message.findByPk(req.params.id);
  res.json(updatedMessage);
});

// 删除消息
router.delete("/:id", authMiddleware, adminOnly, async (req, res) => {
  const deleted = await Message.destroy({
    where: { id: req.params.id },
  });
  if (!deleted) {
    return res.status(404).json({ error: "Message not found" });
  }
  res.json({ message: "Message deleted" });
});

module.exports = router;
