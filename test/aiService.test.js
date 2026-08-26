const test = require("node:test");
const assert = require("node:assert/strict");
const {
  classifyUpstreamError,
  estimateTokens,
  chunkText,
  parseJsonContent,
} = require("../services/aiService");
const {
  recordModelFailure,
  recordModelResolution,
  rankModelsByHealth,
  resetModelHealth,
} = require("../utils/aiModelHealth");

test("classifies actionable upstream errors", () => {
  assert.deepEqual(classifyUpstreamError(429, "rate limited"), {
    code: "RATE_LIMIT",
    status: 429,
  });
  assert.deepEqual(
    classifyUpstreamError(400, "maximum context length exceeded"),
    {
      code: "CONTEXT_TOO_LONG",
      status: 400,
    },
  );
  assert.deepEqual(classifyUpstreamError(503, "unavailable"), {
    code: "UPSTREAM_UNAVAILABLE",
    status: 503,
  });
});

test("estimates tokens and chunks long transcript text", () => {
  assert.ok(estimateTokens("这是一段中文内容") >= 8);
  const text = Array.from(
    { length: 20 },
    (_, index) => `第${index}段。${"内容".repeat(300)}`,
  ).join("\n\n");
  const chunks = chunkText(text, { maxTokens: 700 });
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => estimateTokens(chunk) <= 900));
  assert.equal(chunks.join("\n\n").replace(/\s/g, ""), text.replace(/\s/g, ""));
});

test("parses plain and fenced JSON model output", () => {
  assert.deepEqual(parseJsonContent('{"ok":true}'), { ok: true });
  assert.deepEqual(parseJsonContent('```json\n{"items":[1]}\n```'), {
    items: [1],
  });
  assert.throws(() => parseJsonContent("not json"), /有效 JSON/);
});

test("temporarily demotes models that recently failed or fell back", () => {
  resetModelHealth();
  const models = [{ id: "first" }, { id: "second" }, { id: "third" }];
  recordModelFailure("first", "RATE_LIMIT", 1000);
  assert.deepEqual(
    rankModelsByHealth(models, 2000).map((item) => item.id),
    ["second", "third", "first"],
  );
  recordModelResolution("second", "third", 3000);
  assert.deepEqual(
    rankModelsByHealth(models, 4000).map((item) => item.id),
    ["third", "first", "second"],
  );
  resetModelHealth();
});
