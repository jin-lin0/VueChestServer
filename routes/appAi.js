const express = require("express");
const MarketApp = require("../models/marketApp");
const { authMiddleware } = require("../middleware/auth");
const { getConfiguredProviders } = require("../config/aiProviders");
const { completeAI } = require("../services/aiService");
const { parsePermissions } = require("../utils/permissions");

/**
 * 面向市场应用的受控 AI 代理（需登录）。
 *
 * 与 /api/ai-chat 的区别：这里不落库、不暴露平台密钥、单轮非流式，
 * 且要求目标应用已上架并显式声明 `ai` 能力权限，防止任意应用白嫖模型额度。
 */
const router = express.Router();
router.use(authMiddleware);

const MAX_MESSAGES = 20;
const MAX_CHARS_PER_MESSAGE = 8000;
const MAX_TOKENS = 2048;
const ALLOWED_ROLES = new Set(["system", "user", "assistant"]);

router.post("/chat", async (req, res) => {
  const appId = Number.parseInt(req.body?.appId, 10);
  if (!Number.isInteger(appId) || appId <= 0) {
    return res.status(400).json({ error: "缺少有效的 appId", code: "VALIDATION" });
  }

  const app = await MarketApp.findByPk(appId, {
    attributes: ["id", "status", "permissions"],
  });
  if (!app || app.status !== "approved") {
    return res.status(404).json({ error: "应用不存在或未上架", code: "NOT_FOUND" });
  }
  if (!parsePermissions(app.permissions).includes("ai")) {
    return res.status(403).json({ error: "该应用未声明 AI 能力权限", code: "FORBIDDEN" });
  }

  const raw = Array.isArray(req.body?.messages) ? req.body.messages : [];
  const messages = raw
    .slice(-MAX_MESSAGES)
    .map((item) => ({
      role: ALLOWED_ROLES.has(item?.role) ? item.role : "user",
      content: String(item?.content ?? "").slice(0, MAX_CHARS_PER_MESSAGE),
    }))
    .filter((item) => item.content.trim());
  if (messages.length === 0) {
    return res.status(400).json({ error: "messages 不能为空", code: "VALIDATION" });
  }

  const providers = await getConfiguredProviders();
  if (providers.length === 0) {
    return res.status(503).json({ error: "服务端未配置 AI 平台", code: "NO_PROVIDER" });
  }
  const provider = providers[0];
  const requestedModel = String(req.body?.model || "");
  const model = provider.models.some((item) => item.id === requestedModel)
    ? requestedModel
    : provider.defaultModel;

  try {
    const result = await completeAI({
      providerId: provider.id,
      model,
      messages,
      maxTokens: MAX_TOKENS,
      temperature: 0.7,
    });
    res.json({
      success: true,
      data: { content: result.content, model: result.model },
    });
  } catch (error) {
    res.status(error.status || 502).json({
      error: error.message || "AI 请求失败",
      code: error.code || "UPSTREAM_ERROR",
    });
  }
});

module.exports = router;
