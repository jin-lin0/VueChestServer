const test = require("node:test");
const assert = require("node:assert/strict");
const {
  splitCloudEnvelope,
  createCloudEnvelope,
  sanitizeSelectiveSyncConfig,
} = require("../utils/cloudSync");

test("旧版工作区配置可透明升级为云端信封", () => {
  const workspace = {
    version: 1,
    workspaces: [{ id: "one", name: "工作区", icon: "◫", items: [] }],
    updatedAt: 10,
  };

  assert.deepEqual(splitCloudEnvelope(workspace), {
    workspace,
    selectiveSync: null,
  });
});

test("工作区和选择性同步数据可以共存", () => {
  const workspace = { version: 1, workspaces: [], updatedAt: 1 };
  const selectiveSync = {
    version: 1,
    selection: ["toolbox"],
    categories: {},
    updatedAt: 2,
  };

  const envelope = createCloudEnvelope(workspace, selectiveSync);
  assert.deepEqual(splitCloudEnvelope(envelope), { workspace, selectiveSync });
});

test("选择性同步只接受白名单类别并限制数据形状", () => {
  const result = sanitizeSelectiveSyncConfig({
    selection: ["workspace", "toolbox", "unknown", "toolbox"],
    categories: {
      toolbox: { updatedAt: 20, data: { localStorage: { preset: "[]" } } },
      workspace: { updatedAt: 20, data: { ignored: true } },
      unknown: { updatedAt: 20, data: { ignored: true } },
    },
    updatedAt: 30,
  });

  assert.deepEqual(result.selection, ["workspace", "toolbox"]);
  assert.deepEqual(Object.keys(result.categories), ["toolbox"]);
  assert.equal(result.categories.toolbox.updatedAt, 20);
});

test("单个类别超过大小限制时拒绝保存", () => {
  assert.throws(
    () =>
      sanitizeSelectiveSyncConfig({
        selection: ["toolbox"],
        categories: {
          toolbox: { data: { value: "x".repeat(330 * 1024) } },
        },
      }),
    (error) => error.code === "PAYLOAD_TOO_LARGE" && error.status === 413,
  );
});
