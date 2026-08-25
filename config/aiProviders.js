const OPENROUTER_MODELS_URL =
  "https://openrouter.ai/api/v1/models?output_modalities=text&sort=most-popular";
const OPENROUTER_CACHE_TTL_MS = 15 * 60 * 1000;
const OPENROUTER_STALE_TTL_MS = 24 * 60 * 60 * 1000;

const PROVIDER_META = [
  {
    id: "openrouter",
    name: "OpenRouter",
    type: "openai",
    baseUrl: "https://openrouter.ai/api/v1/chat/completions",
    models: [],
    defaultModel: "",
  },
  {
    id: "siliconflow",
    name: "硅基流动 (DeepSeek)",
    type: "openai",
    baseUrl: "https://api.siliconflow.cn/v1/chat/completions",
    models: [
      { id: "deepseek-ai/DeepSeek-V3.2", name: "DeepSeek V3.2" },
      { id: "deepseek-ai/DeepSeek-R1", name: "DeepSeek R1" },
    ],
    defaultModel: "deepseek-ai/DeepSeek-V3.2",
  },
];

const KEY_ENV = {
  siliconflow: "SILICONFLOW_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

let openRouterCache = {
  models: [],
  fetchedAt: 0,
};
let openRouterRequest = null;

function getApiKey(providerId) {
  const envName = KEY_ENV[providerId];
  return envName ? process.env[envName] || "" : "";
}

function getProviderMeta(providerId) {
  return PROVIDER_META.find((p) => p.id === providerId);
}

function isZeroPrice(value) {
  if (value == null || value === "") return false;
  const number = Number(value);
  return Number.isFinite(number) && number === 0;
}

/**
 * 只接收 OpenRouter 明确标记为 :free 且文本输入/输出均为零价格的具体模型。
 * openrouter/free 是随机路由，不进入用户可选列表。
 */
function normalizeOpenRouterFreeModels(rows) {
  if (!Array.isArray(rows)) return [];

  const seen = new Set();
  const models = [];
  for (const row of rows) {
    const id = typeof row?.id === "string" ? row.id.trim() : "";
    if (!id.endsWith(":free") || id === "openrouter/free" || seen.has(id)) {
      continue;
    }
    if (!isZeroPrice(row?.pricing?.prompt) || !isZeroPrice(row?.pricing?.completion)) {
      continue;
    }

    seen.add(id);
    models.push({
      id,
      name: typeof row.name === "string" && row.name.trim() ? row.name.trim() : id,
      contextLength: Number.isFinite(Number(row.context_length))
        ? Number(row.context_length)
        : null,
    });
  }
  return models;
}

async function requestOpenRouterFreeModels() {
  const apiKey = getApiKey("openrouter");
  if (!apiKey) return [];

  const response = await fetch(OPENROUTER_MODELS_URL, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`OpenRouter 模型列表请求失败 (${response.status})`);
  }

  const payload = await response.json();
  const models = normalizeOpenRouterFreeModels(payload?.data);
  if (models.length === 0) {
    throw new Error("OpenRouter 当前没有可用的具体免费模型");
  }
  return models;
}

async function getOpenRouterFreeModels() {
  const now = Date.now();
  if (
    openRouterCache.models.length > 0 &&
    now - openRouterCache.fetchedAt < OPENROUTER_CACHE_TTL_MS
  ) {
    return openRouterCache.models;
  }
  if (openRouterRequest) return openRouterRequest;

  openRouterRequest = requestOpenRouterFreeModels()
    .then((models) => {
      openRouterCache = { models, fetchedAt: Date.now() };
      return models;
    })
    .catch((error) => {
      if (
        openRouterCache.models.length > 0 &&
        now - openRouterCache.fetchedAt < OPENROUTER_STALE_TTL_MS
      ) {
        console.warn(`OpenRouter 模型刷新失败，继续使用缓存: ${error.message}`);
        return openRouterCache.models;
      }
      throw error;
    })
    .finally(() => {
      openRouterRequest = null;
    });

  return openRouterRequest;
}

async function getProviderModels(providerId) {
  const meta = getProviderMeta(providerId);
  if (!meta) return [];
  if (providerId === "openrouter") return getOpenRouterFreeModels();
  return meta.models;
}

// 动态列表与请求校验共用同一数据源，防止前端绕过下拉框指定付费模型。
async function isModelAllowed(providerId, model) {
  const models = await getProviderModels(providerId);
  return models.some((item) => item.id === model);
}

async function getConfiguredProviders() {
  const providers = [];
  for (const meta of PROVIDER_META) {
    if (!getApiKey(meta.id)) continue;
    try {
      const models = await getProviderModels(meta.id);
      if (models.length === 0) continue;
      providers.push({
        id: meta.id,
        name: meta.name,
        models,
        // OpenRouter 以当前免费列表第一项为默认值，不再使用随机路由。
        defaultModel: meta.id === "openrouter" ? models[0].id : meta.defaultModel,
      });
    } catch (error) {
      console.error(`${meta.name} 模型列表加载失败:`, error.message);
    }
  }
  return providers;
}

function buildUpstreamRequest({
  providerId,
  model,
  messages,
  maxTokens,
  temperature,
  apiKey,
}) {
  const meta = getProviderMeta(providerId);
  if (!meta) throw new Error(`未知平台: ${providerId}`);

  return {
    url: meta.baseUrl,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      max_tokens: maxTokens,
      temperature,
    }),
  };
}

function parseUpstreamDelta(json) {
  return json?.choices?.[0]?.delta?.content ?? null;
}

function resetOpenRouterModelCache() {
  openRouterCache = { models: [], fetchedAt: 0 };
  openRouterRequest = null;
}

module.exports = {
  PROVIDER_META,
  getApiKey,
  getProviderMeta,
  getConfiguredProviders,
  getProviderModels,
  isModelAllowed,
  normalizeOpenRouterFreeModels,
  resetOpenRouterModelCache,
  buildUpstreamRequest,
  parseUpstreamDelta,
};
