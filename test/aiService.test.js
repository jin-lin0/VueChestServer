const test = require("node:test");
const assert = require("node:assert/strict");
const {
  classifyUpstreamError,
  estimateTokens,
  chunkText,
  consumeAIStream,
  parseJsonContent,
  resetModelHealth,
  recordModelFailure,
  recordModelResolution,
  rankModelsByHealth,
  modelHealthSnapshot,
} = require("../services/aiService");

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

test("consumes AI SSE chunks incrementally and resolves the actual model", async () => {
  const encoder = new TextEncoder();
  const deltas = [];
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'data: {"model":"resolved-model","choices":[{"delta":{"content":"第一段"}}]}\n\n',
          ),
        );
        controller.enqueue(
          encoder.encode(
            'data: {"choices":[{"delta":{"content":"第二段"}}]}\n\ndata: [DONE]\n\n',
          ),
        );
        controller.close();
      },
    }),
  );
  const result = await consumeAIStream(response, {
    requestedModel: "requested-model",
    onDelta: (delta) => deltas.push(delta),
  });
  assert.deepEqual(deltas, ["第一段", "第二段"]);
  assert.deepEqual(result, {
    content: "第一段第二段",
    model: "resolved-model",
  });
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

test("model health demotion expires after its TTL", () => {
  resetModelHealth();
  const models = [{ id: "first" }, { id: "second" }];
  recordModelFailure("first", "RATE_LIMIT", 1000);
  assert.deepEqual(
    rankModelsByHealth(models, 2000).map((item) => item.id),
    ["second", "first"],
  );
  // 超过降级窗口后自动恢复原有顺序，不需要额外清理。
  assert.deepEqual(
    rankModelsByHealth(models, 1000 + 60_000).map((item) => item.id),
    ["first", "second"],
  );
  assert.deepEqual(modelHealthSnapshot(1000 + 60_000), []);
  resetModelHealth();
});

test("model health ignores identical or missing model ids", () => {
  resetModelHealth();
  recordModelResolution("same", "same", 1000);
  recordModelResolution("", "other", 1000);
  recordModelResolution("requested", "", 1000);
  assert.deepEqual(modelHealthSnapshot(2000), []);
  resetModelHealth();
});

test("rejects an upstream stream that closes without DONE after partial output", async () => {
  const deltas = [];
  await assert.rejects(
    consumeAIStream(
      new Response('data:{"choices":[{"delta":{"content":"partial"}}]}\n\n'),
      { onDelta: (delta) => deltas.push(delta) },
    ),
    { code: "INCOMPLETE_STREAM" },
  );
  assert.deepEqual(deltas, ["partial"]);
});

test("surfaces an upstream error event instead of treating it as a completed answer", async () => {
  await assert.rejects(
    consumeAIStream(
      new Response(
        'data:{"error":{"code":429,"message":"rate limited"}}\n\ndata:[DONE]\n\n',
      ),
    ),
    { code: "RATE_LIMIT" },
  );
});

test("releases a stream at DONE even when the provider keeps its connection open", async () => {
  let cancelled = false;
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'data:{"choices":[{"delta":{"content":"OK"}}]}\r\n\r\ndata:[DONE]\r\n\r\n',
          ),
        );
      },
      cancel() {
        cancelled = true;
      },
    }),
  );
  assert.equal((await consumeAIStream(response)).content, "OK");
  assert.equal(cancelled, true);
  assert.equal(response.body.locked, false);
});
