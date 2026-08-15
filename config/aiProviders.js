const PROVIDER_META = [
  {
    id: "openrouter",
    name: "OpenRouter",
    type: "openai",
    baseUrl: "https://openrouter.ai/api/v1/chat/completions",
    models: [{ id: "openrouter/free", name: "Free Models" }],
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

// 校验 model 是否属于该平台声明的白名单，防止被指定任意/高价模型耗尽额度
function isModelAllowed(providerId, model) {
  const meta = getProviderMeta(providerId);
  if (!meta) return false;
  return meta.models.some((m) => m.id === model);
}

function getConfiguredProviders() {
  return PROVIDER_META.filter((p) => !!getApiKey(p.id)).map((p) => ({
    id: p.id,
    name: p.name,
    models: p.models,
    defaultModel: p.defaultModel,
  }));
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
  if (!isModelAllowed(providerId, model)) {
    throw new Error(`模型 ${model} 不属于平台 ${meta.name} 白名单`);
  }

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

module.exports = {
  PROVIDER_META,
  getApiKey,
  getProviderMeta,
  getConfiguredProviders,
  isModelAllowed,
  buildUpstreamRequest,
  parseUpstreamDelta,
};
