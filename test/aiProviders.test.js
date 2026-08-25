const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeOpenRouterFreeModels,
  buildUpstreamRequest,
} = require("../config/aiProviders");

test("keeps concrete zero-price OpenRouter free variants in upstream order", () => {
  const rows = [
    {
      id: "vendor/first:free",
      name: "First Free",
      context_length: 131072,
      pricing: { prompt: "0", completion: "0" },
    },
    {
      id: "vendor/paid",
      name: "Paid",
      pricing: { prompt: "0.1", completion: "0.2" },
    },
    {
      id: "openrouter/free",
      name: "Random Free Router",
      pricing: { prompt: "0", completion: "0" },
    },
    {
      id: "vendor/second:free",
      name: "Second Free",
      context_length: "65536",
      pricing: { prompt: 0, completion: 0 },
    },
    {
      id: "vendor/not-actually-free:free",
      pricing: { prompt: "0", completion: "0.01" },
    },
    {
      id: "vendor/missing-price:free",
      pricing: { prompt: "0" },
    },
  ];

  assert.deepEqual(normalizeOpenRouterFreeModels(rows), [
    { id: "vendor/first:free", name: "First Free", contextLength: 131072 },
    { id: "vendor/second:free", name: "Second Free", contextLength: 65536 },
  ]);
});

test("builds an upstream request after route-level model validation", () => {
  const request = buildUpstreamRequest({
    providerId: "openrouter",
    model: "vendor/model:free",
    messages: [{ role: "user", content: "hello" }],
    maxTokens: 1024,
    temperature: 0.7,
    apiKey: "secret",
  });

  assert.equal(request.url, "https://openrouter.ai/api/v1/chat/completions");
  assert.deepEqual(JSON.parse(request.body), {
    model: "vendor/model:free",
    messages: [{ role: "user", content: "hello" }],
    stream: true,
    max_tokens: 1024,
    temperature: 0.7,
  });
});
