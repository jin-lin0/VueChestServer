const express = require("express");
const { Op } = require("sequelize");
const router = express.Router();
const AIChatConversation = require("../models/aiChatConversation");
const AIChatMessage = require("../models/aiChatMessage");
const { authMiddleware } = require("../middleware/auth");
const {
  getConfiguredProviders,
  parseUpstreamDelta,
} = require("../config/aiProviders");
const {
  createAIUpstreamRequest,
  recordModelResolution,
} = require("../services/aiService");

const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_TEMPERATURE = 0.7;

router.get("/providers", async (req, res) => {
  const providers = await getConfiguredProviders();
  res.json({ success: true, data: providers });
});

/**
 * 把一轮对话落库：upsert 会话（首次用首条用户消息生成标题），
 * 仅持久化「最新一条用户消息 + 助手回复」，避免与已存历史重复。
 */
async function persistTurn(
  userId,
  conversationId,
  provider,
  model,
  messages,
  assistantContent,
  options = {},
) {
  const userMessages = messages.filter((m) => m.role === "user");
  const lastUser = userMessages[userMessages.length - 1];
  if (!lastUser) return;

  return AIChatConversation.sequelize.transaction(async (transaction) => {
    const [conv] = await AIChatConversation.findOrCreate({
      where: { id: conversationId },
      defaults: { title: "新对话", provider, model, userId },
      transaction,
    });
    if (conv.userId != null && conv.userId !== userId) {
      const error = new Error("无权修改该会话");
      error.code = "FORBIDDEN";
      throw error;
    }

    if (options.replaceFromMessageId) {
      await AIChatMessage.destroy({
        where: {
          conversationId,
          id: { [Op.gte]: options.replaceFromMessageId },
        },
        transaction,
      });
    }

    if (conv.title === "新对话" || options.updateTitle) {
      const raw = lastUser.content || "";
      conv.title = raw.slice(0, 20) + (raw.length > 20 ? "..." : "");
    }
    conv.provider = provider;
    conv.model = model;
    // 每轮都刷新会话更新时间，服务端列表才能按最近对话正确排序。
    await conv.save({ transaction });

    let userRow = null;
    if (options.persistUser !== false) {
      userRow = await AIChatMessage.create(
        {
          conversationId,
          role: "user",
          content: lastUser.content,
          model,
        },
        { transaction },
      );
    }
    const assistantRow = assistantContent
      ? await AIChatMessage.create(
          {
            conversationId,
            role: "assistant",
            content: assistantContent,
            model,
          },
          { transaction },
        )
      : null;

    return {
      userMessageId: userRow?.id || null,
      assistantMessageId: assistantRow?.id || null,
      title: conv.title,
    };
  });
}

router.post("/chat", authMiddleware, async (req, res) => {
  const userId = req.user.id;
  const rawId = req.body?.conversationId;
  const conversationId = rawId != null ? String(rawId) : "";
  const { provider, model, messages } = req.body || {};
  const mode = ["normal", "edit", "regenerate"].includes(req.body?.mode)
    ? req.body.mode
    : "normal";
  const replaceFromMessageId = Number(req.body?.replaceFromMessageId);
  const requestedMaxTokens = Number(req.body?.maxTokens);
  const requestedTemperature = Number(req.body?.temperature);

  if (!conversationId) {
    return res.status(400).json({
      success: false,
      error: "缺少 conversationId",
      code: "VALIDATION",
    });
  }
  if (!provider || !model) {
    return res.status(400).json({
      success: false,
      error: "缺少 provider 或 model",
      code: "VALIDATION",
    });
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    return res
      .status(400)
      .json({ success: false, error: "messages 不能为空", code: "VALIDATION" });
  }

  // 会话归属校验：若会话已存在，必须是当前用户自己的
  const existing = await AIChatConversation.findByPk(conversationId);
  if (existing && existing.userId != null && existing.userId !== userId) {
    return res.status(403).json({
      success: false,
      error: "无权访问该会话",
      code: "FORBIDDEN",
    });
  }

  let replacementUpdatesTitle = false;
  if (mode !== "normal") {
    if (
      !existing ||
      !Number.isInteger(replaceFromMessageId) ||
      replaceFromMessageId <= 0
    ) {
      return res.status(400).json({
        success: false,
        error: "编辑或重新生成需要有效的原消息",
        code: "INVALID_REPLACEMENT",
      });
    }
    const replacementTarget = await AIChatMessage.findOne({
      where: { id: replaceFromMessageId, conversationId },
      attributes: ["id", "role"],
    });
    const expectedRole = mode === "edit" ? "user" : "assistant";
    if (!replacementTarget || replacementTarget.role !== expectedRole) {
      return res.status(400).json({
        success: false,
        error:
          mode === "edit" ? "找不到要编辑的用户消息" : "找不到要重新生成的回答",
        code: "INVALID_REPLACEMENT",
      });
    }
    if (mode === "edit") {
      const firstUserMessage = await AIChatMessage.findOne({
        where: { conversationId, role: "user" },
        attributes: ["id"],
        order: [["id", "ASC"]],
      });
      replacementUpdatesTitle = firstUserMessage?.id === replaceFromMessageId;
    }
  }

  let upstream;
  const upstreamController = new AbortController();
  req.once("aborted", () => upstreamController.abort());
  res.once("close", () => {
    if (!res.writableEnded) upstreamController.abort();
  });
  try {
    const result = await createAIUpstreamRequest({
      providerId: provider,
      model,
      messages,
      maxTokens: Number.isFinite(requestedMaxTokens)
        ? Math.min(8192, Math.max(64, requestedMaxTokens))
        : DEFAULT_MAX_TOKENS,
      temperature: Number.isFinite(requestedTemperature)
        ? Math.min(2, Math.max(0, requestedTemperature))
        : DEFAULT_TEMPERATURE,
      signal: upstreamController.signal,
    });
    upstream = result.response;
  } catch (e) {
    return res.status(e.status || 502).json({
      success: false,
      error: e.message || "AI 请求失败",
      code: e.code || "UPSTREAM_ERROR",
    });
  }

  // 设置 SSE 头，开始流式回传
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullAssistant = "";
  let resolvedModel = model;
  let announcedModel = "";
  let clientGone = false;

  const writePayload = (payload) => {
    try {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
      if (typeof res.flush === "function") res.flush();
    } catch {
      clientGone = true;
    }
  };

  const writeChunk = (delta) =>
    writePayload({ choices: [{ delta: { content: delta } }] });

  let streamFailure = null;
  try {
    while (!clientGone) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6);
        if (data === "[DONE]") break;

        try {
          const json = JSON.parse(data);
          const actualModel = typeof json?.model === "string" ? json.model : "";
          if (actualModel && actualModel !== announcedModel) {
            resolvedModel = actualModel;
            announcedModel = actualModel;
            writePayload({ model: actualModel });
          }
          const delta = parseUpstreamDelta(json);
          if (delta) {
            fullAssistant += delta;
            writeChunk(delta);
          }
        } catch {}
      }
    }
  } catch (error) {
    streamFailure = error;
  } finally {
    try {
      await reader.cancel();
    } catch {}
  }

  if (streamFailure && !clientGone) {
    writePayload({
      error: streamFailure?.message || "AI 响应流中断",
      code: streamFailure?.code || "STREAM_INTERRUPTED",
    });
  }

  let persisted = null;
  try {
    if (fullAssistant) {
      recordModelResolution(model, resolvedModel);
      persisted = await persistTurn(
        userId,
        conversationId,
        provider,
        resolvedModel,
        messages,
        fullAssistant,
        {
          replaceFromMessageId: mode === "normal" ? null : replaceFromMessageId,
          persistUser: mode !== "regenerate",
          updateTitle: replacementUpdatesTitle,
        },
      );
      if (!clientGone) writePayload({ persisted });
    } else if (!clientGone) {
      writePayload({ error: "模型没有返回内容", code: "EMPTY_RESPONSE" });
    }
  } catch (e) {
    console.error("AI 对话落库失败:", e.message);
    if (!clientGone) {
      writePayload({
        error: "回答已生成，但保存会话失败",
        code: "PERSISTENCE_FAILED",
      });
    }
  }

  if (!clientGone) {
    try {
      res.write("data: [DONE]\n\n");
      if (typeof res.flush === "function") res.flush();
      res.end();
    } catch {}
  }
});

// 会话列表以服务端为准，登录后可跨浏览器和设备恢复。
router.get("/conversations", authMiddleware, async (req, res) => {
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const limit = Math.min(
    100,
    Math.max(10, Number.parseInt(req.query.limit, 10) || 50),
  );
  const query = String(req.query.q || "")
    .trim()
    .slice(0, 60);
  const where = { userId: req.user.id };
  if (query) where.title = { [Op.like]: `%${query}%` };

  const { rows, count } = await AIChatConversation.findAndCountAll({
    where,
    attributes: ["id", "title", "provider", "model", "createdAt", "updatedAt"],
    order: [["updatedAt", "DESC"]],
    limit,
    offset: (page - 1) * limit,
  });

  res.json({
    success: true,
    data: rows.map((row) => ({
      id: row.id,
      title: row.title || "新对话",
      provider: row.provider || null,
      model: row.model || null,
      createdAt: row.createdAt ? new Date(row.createdAt).getTime() : Date.now(),
      updatedAt: row.updatedAt ? new Date(row.updatedAt).getTime() : Date.now(),
    })),
    pagination: {
      page,
      limit,
      total: count,
      hasMore: page * limit < count,
    },
  });
});

router.put("/conversations/:id", authMiddleware, async (req, res) => {
  const title = String(req.body?.title || "")
    .trim()
    .slice(0, 60);
  if (!title) {
    return res.status(400).json({
      success: false,
      error: "会话标题不能为空",
      code: "VALIDATION",
    });
  }
  const conversation = await AIChatConversation.findOne({
    where: { id: req.params.id, userId: req.user.id },
  });
  if (!conversation) {
    return res.status(404).json({
      success: false,
      error: "会话不存在",
      code: "NOT_FOUND",
    });
  }
  await conversation.update({ title });
  res.json({ success: true, data: { id: conversation.id, title } });
});

router.get("/conversations/:id/messages", authMiddleware, async (req, res) => {
  const conv = await AIChatConversation.findByPk(req.params.id);
  if (!conv || conv.userId !== req.user.id) {
    return res.status(404).json({
      success: false,
      error: "会话不存在",
      code: "NOT_FOUND",
    });
  }

  const rows = await AIChatMessage.findAll({
    where: { conversationId: req.params.id, role: { [Op.ne]: "system" } },
    order: [["id", "ASC"]],
  });
  const messages = rows.map((r) => ({
    id: r.id,
    role: r.role,
    content: r.content,
    timestamp: r.createdAt ? new Date(r.createdAt).getTime() : Date.now(),
  }));
  res.json({
    success: true,
    data: {
      messages,
      provider: conv?.provider || null,
      model: conv?.model || null,
      title: conv?.title || "新对话",
    },
  });
});

router.delete("/conversations/:id", authMiddleware, async (req, res) => {
  const conversation = await AIChatConversation.findOne({
    where: { id: req.params.id, userId: req.user.id },
    attributes: ["id"],
  });
  if (!conversation) {
    return res.status(404).json({
      success: false,
      error: "会话不存在",
      code: "NOT_FOUND",
    });
  }

  await AIChatConversation.sequelize.transaction(async (transaction) => {
    await AIChatMessage.destroy({
      where: { conversationId: conversation.id },
      transaction,
    });
    await AIChatConversation.destroy({
      where: { id: conversation.id, userId: req.user.id },
      transaction,
    });
  });

  res.json({ success: true, data: { id: conversation.id } });
});

module.exports = router;
