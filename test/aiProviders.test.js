const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeOpenRouterFreeModels,
  buildUpstreamRequest,
  OPENROUTER_MODELS_URL,
} = require("../config/aiProviders");

test("requests OpenRouter models ordered by intelligence index", () => {
  assert.match(OPENROUTER_MODELS_URL, /sort=intelligence-high-to-low/);
});

test("keeps concrete zero-price OpenRouter free variants in upstream order", () => {
  const rows = [
    {
      id: "vendor/first:free",
      name: "First Free",
      context_length: 131072,
      expiration_date: "2026-09-30",
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
    {
      id: "vendor/first:free",
      name: "First Free",
      contextLength: 131072,
      expirationDate: "2026-09-30",
    },
    {
      id: "vendor/second:free",
      name: "Second Free",
      contextLength: 65536,
      expirationDate: null,
    },
  ]);
});

test("builds an ordered OpenRouter fallback request after route-level validation", () => {
  const request = buildUpstreamRequest({
    providerId: "openrouter",
    model: "vendor/model:free",
    fallbackModels: ["vendor/backup-1:free", "vendor/backup-2:free"],
    messages: [{ role: "user", content: "hello" }],
    maxTokens: 1024,
    temperature: 0.7,
    apiKey: "secret",
  });

  assert.equal(request.url, "https://openrouter.ai/api/v1/chat/completions");
  assert.deepEqual(JSON.parse(request.body), {
    models: [
      "vendor/model:free",
      "vendor/backup-1:free",
      "vendor/backup-2:free",
    ],
    messages: [{ role: "user", content: "hello" }],
    stream: true,
    max_tokens: 1024,
    temperature: 0.7,
  });
});
