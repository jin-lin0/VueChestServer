const express = require("express");
const router = express.Router();
const Message = require("../models/message");

// 创建消息
router.post("/", async (req, res) => {
  const message = await Message.create(req.body);
  res.status(201).json(message);
});

// 获取所有消息
router.get("/", async (req, res) => {
  const messages = await Message.findAll();
  res.json(messages);
});

// 获取单个消息
router.get("/:id", async (req, res) => {
  const message = await Message.findByPk(req.params.id);
  if (!message) {
    return res.status(404).json({ error: "Message not found" });
  }
  res.json(message);
});

// 更新消息
router.put("/:id", async (req, res) => {
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
router.delete("/:id", async (req, res) => {
  const deleted = await Message.destroy({
    where: { id: req.params.id },
  });
  if (!deleted) {
    return res.status(404).json({ error: "Message not found" });
  }
  res.json({ message: "Message deleted" });
});

module.exports = router;
