const PROVIDER_META = [
  {
    id: "openrouter",
    name: "OpenRouter",
    type: "openai",
    baseUrl: "https://openrouter.ai/api/v1/chat/completions",
    models: [{ id: "openrouter/free", name: "Free Models Router (免费)" }],
    defaultModel: "openrouter/free",
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

function getApiKey(providerId) {
  const envName = KEY_ENV[providerId];
  return envName ? process.env[envName] || "" : "";
}

function getProviderMeta(providerId) {
  return PROVIDER_META.find((p) => p.id === providerId);
}

function getProviderModels(providerId) {
  const meta = getProviderMeta(providerId);
  return meta ? meta.models : [];
}

// 可选列表与请求校验共用同一数据源，防止前端绕过下拉框指定付费模型。
function isModelAllowed(providerId, model) {
  return getProviderModels(providerId).some((item) => item.id === model);
}

async function getConfiguredProviders() {
  const providers = [];
  for (const meta of PROVIDER_META) {
    if (!getApiKey(meta.id)) continue;
    if (meta.models.length === 0) continue;
    providers.push({
      id: meta.id,
      name: meta.name,
      models: meta.models,
      defaultModel: meta.defaultModel,
    });
  }
  return providers;
}

function buildUpstreamRequest({
  providerId,
  model,
  messages,
  stream = true,
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
      stream,
      max_tokens: maxTokens,
      temperature,
    }),
  };
}

function parseUpstreamDelta(json) {
  return json?.choices?.[0]?.delta?.content ?? null;
}

module.exports = {
  PROVIDER_META,
  getApiKey,
  getProviderMeta,
  getConfiguredProviders,
  getProviderModels,
  isModelAllowed,
  buildUpstreamRequest,
  parseUpstreamDelta,
};
