const { readSseData } = require("../utils/sse");
const {
  getApiKey,
  getProviderMeta,
  getProviderModels,
  buildUpstreamRequest,
  parseUpstreamDelta,
} = require("../config/aiProviders");

const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_TIMEOUT_MS = 60_000;
const BODY_READ_TIMEOUT_MS = 300_000;

class AIServiceError extends Error {
  constructor(message, code, status = 502, details = null) {
    super(message);
    this.name = "AIServiceError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function classifyUpstreamError(status, message = "") {
  const text = String(message).toLowerCase();
  if (status === 429) return { code: "RATE_LIMIT", status: 429 };
  if (status === 401 || status === 403)
    return { code: "UPSTREAM_AUTH", status: 502 };
  if (status === 402 || /credit|quota|余额|额度/.test(text)) {
    return { code: "QUOTA_EXHAUSTED", status: 429 };
  }
  if (/context|token limit|maximum context/.test(text)) {
    return { code: "CONTEXT_TOO_LONG", status: 400 };
  }
  if (/moderation|content policy|unsafe/.test(text)) {
    return { code: "CONTENT_REJECTED", status: 400 };
  }
  if (status >= 500) return { code: "UPSTREAM_UNAVAILABLE", status: 503 };
  if (status === 400 || status === 404)
    return { code: "UPSTREAM_VALIDATION", status: 400 };
  return {
    code: "UPSTREAM_ERROR",
    status: status >= 400 && status < 500 ? status : 502,
  };
}

function extractUpstreamMessage(payload, fallback) {
  if (!payload) return fallback;
  if (typeof payload === "string") return payload || fallback;
  return (
    payload?.error?.message || payload?.error || payload?.message || fallback
  );
}

/**
 * 非流式响应的读体超时兜底：建连超时不再覆盖 body 读取，
 * 用整体读体上限防止慢滴流式服务器把请求无限挂起。
 */
function withReadTimeout(promise) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () =>
          reject(new AIServiceError("AI 响应读取超时", "AI_TIMEOUT", 504)),
        BODY_READ_TIMEOUT_MS,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

function estimateTokens(text) {
  const value = String(text || "");
  const cjk = (value.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length;
  const rest = value.length - cjk;
  return Math.max(1, Math.ceil(cjk * 1.1 + rest / 4));
}

function splitLongPart(text, maxChars) {
  const parts = [];
  let rest = text;
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf("。", maxChars);
    if (cut < maxChars * 0.5) cut = rest.lastIndexOf("\n", maxChars);
    if (cut < maxChars * 0.5) cut = maxChars;
    parts.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

function chunkText(text, options = {}) {
  const maxTokens = Math.max(500, Number(options.maxTokens) || 6000);
  const maxChars = Math.max(2000, Math.floor(maxTokens * 3));
  const paragraphs = String(text || "")
    .split(/\n{2,}/)
    .flatMap((part) => splitLongPart(part.trim(), maxChars))
    .filter(Boolean);
  if (paragraphs.length === 0) return [];

  const chunks = [];
  let current = "";
  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (current && estimateTokens(candidate) > maxTokens) {
      chunks.push(current);
      current = paragraph;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function parseJsonContent(content) {
  const text = String(content || "").trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  const candidate = fenced ? fenced[1] : text;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start)
      return JSON.parse(candidate.slice(start, end + 1));
    throw new AIServiceError("模型没有返回有效 JSON", "INVALID_AI_JSON", 502);
  }
}

async function resolveRouting(providerId, requestedModel) {
  const meta = getProviderMeta(providerId);
  if (!meta)
    throw new AIServiceError(
      `未知平台: ${providerId}`,
      "UNKNOWN_PROVIDER",
      400,
    );
  const apiKey = getApiKey(providerId);
  if (!apiKey) {
    throw new AIServiceError(`平台 ${meta.name} 未配置 API Key`, "NO_KEY", 400);
  }

  const models = await getProviderModels(providerId);
  if (!models.some((item) => item.id === requestedModel)) {
    throw new AIServiceError(
      `模型 ${requestedModel} 不属于平台 ${meta.name} 支持列表`,
      "MODEL_NOT_ALLOWED",
      400,
    );
  }

  return { meta, apiKey, models };
}

async function createAIUpstreamRequest(options) {
  const {
    providerId,
    model,
    messages,
    stream = true,
    maxTokens = DEFAULT_MAX_TOKENS,
    temperature = DEFAULT_TEMPERATURE,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal,
  } = options;
  const routing = await resolveRouting(providerId, model);
  // 超时只约束「发起请求 → 拿到响应头」这一段，拿到响应头后立即清除计时器。
  // 免费模型出词慢，若用整流硬超时会把正常的流式长回答拦腰截断；
  // 挂死的流由 undici 默认的 bodyTimeout（300s 无数据）兜底。
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), timeoutMs);
  const signals = [timeoutController.signal];
  if (signal) signals.push(signal);

  const request = buildUpstreamRequest({
    providerId,
    model,
    messages,
    stream,
    maxTokens,
    temperature,
    apiKey: routing.apiKey,
  });

  let response;
  try {
    response = await fetch(request.url, {
      method: "POST",
      headers: request.headers,
      body: request.body,
      signal: AbortSignal.any(signals),
    });
  } catch (error) {
    if (error?.name === "AbortError" || error?.name === "TimeoutError") {
      throw new AIServiceError("AI 请求已取消或超时", "AI_TIMEOUT", 504);
    }
    throw new AIServiceError(
      `上游请求失败: ${error.message}`,
      "UPSTREAM_NETWORK",
      502,
    );
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const raw = await response.text().catch(() => "");
    let payload = raw;
    try {
      payload = JSON.parse(raw);
    } catch {}
    const message = extractUpstreamMessage(
      payload,
      `上游返回 ${response.status}`,
    );
    const classified = classifyUpstreamError(response.status, message);
    throw new AIServiceError(message, classified.code, classified.status, {
      upstreamStatus: response.status,
    });
  }

  return {
    response,
    requestedModel: model,
  };
}

async function completeAI(options) {
  const upstream = await createAIUpstreamRequest({ ...options, stream: false });
  let payload;
  try {
    payload = await withReadTimeout(upstream.response.json());
  } catch (error) {
    if (error instanceof AIServiceError) throw error;
    throw new AIServiceError("AI 响应格式错误", "INVALID_AI_RESPONSE", 502);
  }
  const actualModel = payload?.model || upstream.requestedModel;
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new AIServiceError("模型没有返回内容", "EMPTY_RESPONSE", 502);
  }
  return {
    content,
    model: actualModel,
    usage: payload?.usage || null,
  };
}

async function consumeAIStream(response, options = {}) {
  if (!response.body)
    throw new AIServiceError("无法读取 AI 响应流", "INVALID_AI_STREAM", 502);
  let content = "";
  let model = options.requestedModel || "";
  let reachedDone = false;
  for await (const data of readSseData(response.body, options.signal)) {
    if (data === "[DONE]") {
      reachedDone = true;
      break;
    }
    let json;
    try {
      json = JSON.parse(data);
    } catch {
      continue;
    }
    if (json?.error) {
      const message =
        typeof json.error === "string"
          ? json.error
          : json.error.message || "AI 响应流中断";
      const classified = classifyUpstreamError(
        Number(json.error?.code) || 502,
        message,
      );
      throw new AIServiceError(message, classified.code, classified.status);
    }
    if (typeof json?.model === "string" && json.model) {
      model = json.model;
      options.onModelResolved?.(model);
    }
    const delta = parseUpstreamDelta(json);
    if (delta) {
      content += delta;
      options.onDelta?.(delta);
    }
  }
  if (!reachedDone)
    throw new AIServiceError("AI 响应未正常完成", "INCOMPLETE_STREAM", 502);
  if (!content.trim())
    throw new AIServiceError("模型没有返回内容", "EMPTY_RESPONSE", 502);
  return { content, model: model || options.requestedModel || "" };
}

async function streamAI(options) {
  const upstream = await createAIUpstreamRequest({ ...options, stream: true });
  return consumeAIStream(upstream.response, {
    requestedModel: upstream.requestedModel,
    signal: options.signal,
    onDelta: options.onDelta,
    onModelResolved: options.onModelResolved,
  });
}

module.exports = {
  AIServiceError,
  classifyUpstreamError,
  extractUpstreamMessage,
  estimateTokens,
  chunkText,
  parseJsonContent,
  resolveRouting,
  createAIUpstreamRequest,
  completeAI,
  consumeAIStream,
  streamAI,
};
