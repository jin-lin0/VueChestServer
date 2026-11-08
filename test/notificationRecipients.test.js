const test = require("node:test");
const assert = require("node:assert/strict");

// 用 require.cache 注入假的 User 模型，沿用 authLoginThrottle.test.js 的写法。
function load(t, userStub) {
  const userPath = require.resolve("../models/user");
  const modulePath = require.resolve("../utils/notificationRecipients");
  const previousUser = require.cache[userPath];
  const previousModule = require.cache[modulePath];
  require.cache[userPath] = {
    id: userPath,
    filename: userPath,
    loaded: true,
    exports: userStub,
  };
  delete require.cache[modulePath];
  t.after(() => {
    require.cache[userPath] = previousUser;
    if (previousModule) require.cache[modulePath] = previousModule;
    else delete require.cache[modulePath];
  });
  return require("../utils/notificationRecipients");
}

test("超管收件人只保留启用且填了邮箱的账号", async (t) => {
  const mod = load(t, {
    findAll: async () => [
      { id: 2, email: " a@x.com " },
      { id: 3, email: "" },
    ],
  });
  assert.deepEqual(await mod.superAdminRecipients(), [
    { ownerId: 2, email: "a@x.com" },
  ]);
});

test("没有可用超管邮箱时明确失败，不回退环境变量", async (t) => {
  const mod = load(t, { findAll: async () => [{ id: 2, email: null }] });
  await assert.rejects(() => mod.superAdminRecipients(), /没有已配置邮箱/);
});

test("单账号收件人校验账号存在、启用且邮箱有效", async (t) => {
  const users = new Map([
    [2, { id: 2, email: "b@y.com", isActive: true }],
    [3, { id: 3, email: "c@z.com", isActive: false }],
    [4, { id: 4, email: "", isActive: true }],
  ]);
  const mod = load(t, {
    findByPk: async (id) => users.get(id) || null,
  });

  assert.deepEqual(await mod.ownerRecipient(2), {
    ownerId: 2,
    email: "b@y.com",
  });
  await assert.rejects(() => mod.ownerRecipient(3), /未配置可用邮箱/);
  await assert.rejects(() => mod.ownerRecipient(4), /未配置可用邮箱/);
  await assert.rejects(() => mod.ownerRecipient(99), /未配置可用邮箱/);
});
