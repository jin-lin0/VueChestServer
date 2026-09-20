const test = require("node:test");
const assert = require("node:assert/strict");
const {
  getProviderModels,
  isModelAllowed,
  buildUpstreamRequest,
} = require("../config/aiProviders");

test("openrouter only exposes the official free router model", () => {
  assert.deepEqual(getProviderModels("openrouter"), [
    { id: "openrouter/free", name: "Free Models Router (免费)" },
  ]);
});

test("model allowlist rejects arbitrary or paid models", () => {
  assert.equal(isModelAllowed("openrouter", "openrouter/free"), true);
  assert.equal(isModelAllowed("openrouter", "vendor/paid-model"), false);
  assert.equal(isModelAllowed("openrouter", "openrouter/auto"), false);
  assert.equal(
    isModelAllowed("siliconflow", "deepseek-ai/DeepSeek-V3.2"),
    true,
  );
  assert.equal(isModelAllowed("siliconflow", "openrouter/free"), false);
});

test("builds a plain single-model upstream request without fallback routing", () => {
  const request = buildUpstreamRequest({
    providerId: "openrouter",
    model: "openrouter/free",
    messages: [{ role: "user", content: "hello" }],
    maxTokens: 1024,
    temperature: 0.7,
    apiKey: "secret",
  });

  assert.equal(request.url, "https://openrouter.ai/api/v1/chat/completions");
  assert.deepEqual(JSON.parse(request.body), {
    model: "openrouter/free",
    messages: [{ role: "user", content: "hello" }],
    stream: true,
    max_tokens: 1024,
    temperature: 0.7,
  });
});
