const test = require("node:test");
const assert = require("node:assert/strict");

const { detectDevice } = require("../services/authSessionService");
const { sanitizeWorkspaceConfig } = require("../utils/workspaceConfig");

test("auth session helper detects device, browser and forwarded IP", () => {
  assert.deepEqual(
    detectDevice({
      headers: {
        "user-agent": "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/140.0",
        "x-forwarded-for": "203.0.113.10, 10.0.0.2",
      },
      ip: "127.0.0.1",
    }),
    {
      deviceName: "Mac · Chrome",
      userAgent: "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/140.0",
      ip: "203.0.113.10",
    },
  );
});

test("workspace config keeps valid app keys and normalizes fields", () => {
  assert.deepEqual(
    sanitizeWorkspaceConfig({
      workspaces: [
        {
          id: "main",
          name: " 主工作区 ",
          icon: "工具箱图标很长",
          items: [
            { appKey: "builtin:1", extra: true },
            { appKey: "market:42" },
            { appKey: "invalid:1" },
          ],
        },
      ],
      updatedAt: "123",
    }),
    {
      version: 1,
      workspaces: [
        {
          id: "main",
          name: "主工作区",
          icon: "工具箱图标很长",
          items: [{ appKey: "builtin:1" }, { appKey: "market:42" }],
        },
      ],
      updatedAt: 123,
    },
  );
});

test("workspace config rejects invalid and oversized workspace collections", () => {
  assert.throws(
    () => sanitizeWorkspaceConfig({ workspaces: [] }),
    (error) => error.status === 400 && error.code === "VALIDATION_ERROR",
  );
  assert.throws(
    () =>
      sanitizeWorkspaceConfig({
        workspaces: [{ id: "main", name: "main", items: [] }],
        padding: "x".repeat(101 * 1024),
      }),
    (error) => error.status === 413 && error.code === "PAYLOAD_TOO_LARGE",
  );
});
