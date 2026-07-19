const express = require("express");
const router = express.Router();
const AIChatConversation = require("../models/aiChatConversation");
const AIChatMessage = require("../models/aiChatMessage");
const {
  getConfiguredProviders,
  getProviderMeta,
  getApiKey,
  buildUpstreamRequest,
  parseUpstreamDelta,
} = require("../config/aiProviders");

const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_TEMPERATURE = 0.7;

router.get("/providers", (req, res) => {
  res.json({ success: true, data: getConfiguredProviders() });
});

/**
 * 把一轮对话落库：upsert 会话（首次用首条用户消息生成标题），
 * 仅持久化「最新一条用户消息 + 助手回复」，避免与已存历史重复。
 */
async function persistTurn(
  conversationId,
  provider,
  model,
  messages,
  assistantContent,
) {
  const userMessages = messages.filter((m) => m.role === "user");
  const lastUser = userMessages[userMessages.length - 1];
  if (!lastUser) return;

  const [conv] = await AIChatConversation.findOrCreate({
    where: { id: conversationId },
    defaults: { title: "新对话", provider, model },
  });

  if (conv.title === "新对话") {
    const raw = lastUser.content || "";
    conv.title = raw.slice(0, 20) + (raw.length > 20 ? "..." : "");
    conv.provider = provider;
    conv.model = model;
    await conv.save();
  }

  await AIChatMessage.create({
    conversationId,
    role: "user",
    content: lastUser.content,
    model,
  });
  if (assistantContent) {
    await AIChatMessage.create({
      conversationId,
      role: "assistant",
      content: assistantContent,
      model,
    });
  }
}

router.post("/chat", async (req, res) => {
  const rawId = req.body?.conversationId;
  const conversationId = rawId != null ? String(rawId) : "";
  const { provider, model, messages } = req.body || {};

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

  const meta = getProviderMeta(provider);
  if (!meta) {
    return res.status(400).json({
      success: false,
      error: `未知平台: ${provider}`,
      code: "VALIDATION",
    });
  }

  const apiKey = getApiKey(provider);
  if (!apiKey) {
    return res.status(400).json({
      success: false,
      error: `平台 ${meta.name} 未配置 API Key`,
      code: "NO_KEY",
    });
  }

  let upstream;
  try {
    const { url, headers, body } = buildUpstreamRequest({
      providerId: provider,
      model,
      messages,
      maxTokens: DEFAULT_MAX_TOKENS,
      temperature: DEFAULT_TEMPERATURE,
      apiKey,
    });
    upstream = await fetch(url, { method: "POST", headers, body });
  } catch (e) {
    return res.status(502).json({
      success: false,
      error: `上游请求失败: ${e.message}`,
      code: "UPSTREAM_ERROR",
    });
  }

  // 上游非 2xx：在设置 SSE 头之前返回 JSON 错误，前端可正常解析
  if (!upstream.ok) {
    const text = await upstream.text().catch(() => "");
    let msg = `上游返回 ${upstream.status}`;
    try {
      const j = JSON.parse(text);
      msg = j?.error?.message || j?.error || msg;
    } catch {}
    return res
      .status(upstream.status)
      .json({ success: false, error: msg, code: "UPSTREAM_ERROR" });
  }

  // 设置 SSE 头，开始流式回传
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullAssistant = "";
  let clientGone = false;

  const writeChunk = (delta) => {
    try {
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n\n`,
      );
    } catch {
      clientGone = true;
    }
  };

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
          const delta = parseUpstreamDelta(json);
          if (delta) {
            fullAssistant += delta;
            writeChunk(delta);
          }
        } catch {}
      }
    }
  } catch {
    // 上游流异常，尽力返回已累积内容
  } finally {
    try {
      res.write("data: [DONE]\n\n");
      res.end();
    } catch {}
  }

  // 落库（无论客户端是否中途断开，都尽量保存这一轮）
  try {
    await persistTurn(conversationId, provider, model, messages, fullAssistant);
  } catch (e) {
    console.error("AI 对话落库失败:", e.message);
  }
});

router.get("/conversations/:id/messages", async (req, res) => {
  const { Op } = require("sequelize");
  const conv = await AIChatConversation.findByPk(req.params.id);
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

module.exports = router;
