const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const {
  responseCompression,
  isStreamingRequest,
} = require("../middleware/responseCompression");

async function withAiRouter(overrides, run) {
  const paths = {
    conversation: require.resolve("../models/aiChatConversation"),
    message: require.resolve("../models/aiChatMessage"),
    auth: require.resolve("../middleware/auth"),
    service: require.resolve("../services/aiService"),
    route: require.resolve("../routes/aiChat"),
  };
  const previous = new Map(
    Object.values(paths).map((path) => [path, require.cache[path]]),
  );
  const put = (path, exports) => {
    require.cache[path] = { id: path, filename: path, loaded: true, exports };
  };

  const conversation = {
    findByPk: async () => null,
    findOrCreate: async () => [
      {
        id: "conversation",
        title: "新对话",
        provider: null,
        model: null,
        save: async () => {},
      },
    ],
    findAndCountAll: async () => ({ rows: [], count: 0 }),
    findOne: async () => null,
    destroy: async () => 1,
    sequelize: { transaction: async (callback) => callback({}) },
    ...overrides.conversation,
  };
  let nextMessageId = 1;
  const message = {
    findOne: async () => null,
    findAll: async () => [],
    create: async (value) => ({ ...value, id: nextMessageId++ }),
    destroy: async () => 0,
    ...overrides.message,
  };
  const service = {
    createAIUpstreamRequest: async () => ({
      response: new Response(
        'data: {"model":"backup/model:free"}\n\n' +
          'data: {"choices":[{"delta":{"content":"OK"}}]}\n\n' +
          "data: [DONE]\n\n",
        { status: 200 },
      ),
    }),
    recordModelResolution: () => {},
    ...overrides.service,
  };

  put(paths.conversation, conversation);
  put(paths.message, message);
  put(paths.auth, {
    authMiddleware: (req, _res, next) => {
      req.user = { id: 1 };
      next();
    },
  });
  put(paths.service, service);
  delete require.cache[paths.route];

  const app = express();
  app.use(responseCompression);
  app.use(express.json());
  app.use("/api/ai-chat", require(paths.route));
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`, { conversation, message });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    for (const [path, cached] of previous) {
      if (cached) require.cache[path] = cached;
      else delete require.cache[path];
    }
  }
}

test(
  "chat route rejects access to another user's conversation",
  { concurrency: false },
  async () => {
    await withAiRouter(
      { conversation: { findByPk: async () => ({ userId: 2 }) } },
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/ai-chat/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conversationId: "foreign",
            provider: "openrouter",
            model: "vendor/model:free",
            messages: [{ role: "user", content: "hello" }],
          }),
        });
        assert.equal(response.status, 403);
        assert.equal((await response.json()).code, "FORBIDDEN");
      },
    );
  },
);

test(
  "chat route streams resolved model and persisted message ids",
  { concurrency: false },
  async () => {
    const created = [];
    await withAiRouter(
      {
        message: {
          create: async (value) => {
            created.push(value);
            return { ...value, id: created.length };
          },
        },
      },
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/ai-chat/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conversationId: "new",
            provider: "openrouter",
            model: "primary/model:free",
            messages: [{ role: "user", content: "hello" }],
          }),
        });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("content-encoding"), null);
        assert.equal(response.headers.get("x-accel-buffering"), "no");
        assert.match(response.headers.get("cache-control"), /no-transform/);
        const text = await response.text();
        assert.match(text, /backup\/model:free/);
        assert.match(text, /assistantMessageId/);
        assert.equal(created[1].model, "backup/model:free");
      },
    );
  },
);

test("compression bypass recognizes the AI SSE route", () => {
  assert.equal(isStreamingRequest({ path: "/api/ai-chat/chat" }), true);
  assert.equal(
    isStreamingRequest({ path: "/api/bilibili/analyze/stream" }),
    true,
  );
  assert.equal(isStreamingRequest({ path: "/api/bilibili/ask/stream" }), true);
  assert.equal(isStreamingRequest({ path: "/api/ai-chat/providers" }), false);
});

test(
  "SSE chunks reach the client before the stream finishes",
  { concurrency: false },
  async () => {
    const encoder = new TextEncoder();
    await withAiRouter(
      {
        service: {
          createAIUpstreamRequest: async () => ({
            response: new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(
                    encoder.encode(
                      'data: {"model":"backup/model:free","choices":[{"delta":{"content":"A"}}]}\n\n',
                    ),
                  );
                  setTimeout(() => {
                    controller.enqueue(
                      encoder.encode(
                        'data: {"choices":[{"delta":{"content":"B"}}]}\n\n',
                      ),
                    );
                    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                    controller.close();
                  }, 180);
                },
              }),
              { status: 200 },
            ),
          }),
        },
      },
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/ai-chat/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conversationId: "stream",
            provider: "openrouter",
            model: "primary/model:free",
            messages: [{ role: "user", content: "hello" }],
          }),
        });
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let early = "";
        while (!early.includes('"content":"A"')) {
          const { done, value } = await reader.read();
          assert.equal(done, false);
          early += decoder.decode(value, { stream: true });
          assert.doesNotMatch(early, /"content":"B"/);
        }

        let rest = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          rest += decoder.decode(value, { stream: true });
        }
        assert.match(rest, /"content":"B"/);
        assert.match(rest, /\[DONE\]/);
      },
    );
  },
);

test(
  "delete route cannot remove a conversation owned by someone else",
  { concurrency: false },
  async () => {
    let destroyed = false;
    await withAiRouter(
      {
        conversation: { findOne: async () => null },
        message: { destroy: async () => (destroyed = true) },
      },
      async (baseUrl) => {
        const response = await fetch(
          `${baseUrl}/api/ai-chat/conversations/foreign`,
          {
            method: "DELETE",
          },
        );
        assert.equal(response.status, 404);
        assert.equal(destroyed, false);
      },
    );
  },
);
