const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  serializeNotification,
  clampPage,
  clampLimit,
} = require("../services/notificationService");

test("serializeNotification 解析 meta 并归一化字段", () => {
  const createdAt = new Date("2026-10-04T12:00:00Z");
  const result = serializeNotification({
    id: 7,
    type: "market.comment.created",
    title: "收到新评论",
    body: null,
    link: null,
    appId: 12,
    meta: JSON.stringify({ commentId: 33, rating: 5 }),
    readAt: null,
    createdAt,
  });

  assert.deepEqual(result, {
    id: 7,
    type: "market.comment.created",
    title: "收到新评论",
    body: "",
    link: "",
    appId: 12,
    meta: { commentId: 33, rating: 5 },
    read: false,
    createdAt: createdAt.getTime(),
  });
});

test("serializeNotification 对损坏的 meta 与未读状态做兜底", () => {
  const result = serializeNotification({
    id: 1,
    type: "t",
    title: "标题",
    meta: "{不是 JSON",
    readAt: new Date("2026-10-04T12:00:00Z"),
  });
  assert.equal(result.meta, null);
  assert.equal(result.read, true);
  assert.equal(result.appId, null);
});

test("serializeNotification 支持 Sequelize 实例形态（有 toJSON）", () => {
  const row = {
    toJSON: () => ({ id: 2, type: "t", title: "标题", readAt: null }),
  };
  const result = serializeNotification(row);
  assert.equal(result.id, 2);
  assert.equal(result.read, false);
  assert.ok(typeof result.createdAt === "number");
});

test("clampPage / clampLimit 夹住越界分页参数", () => {
  assert.equal(clampPage(undefined), 1);
  assert.equal(clampPage("3"), 3);
  assert.equal(clampPage(0), 1);
  assert.equal(clampPage(-9), 1);
  assert.equal(clampPage("abc"), 1);

  assert.equal(clampLimit(undefined), DEFAULT_PAGE_SIZE);
  assert.equal(clampLimit(5), 5);
  assert.equal(clampLimit(9999), MAX_PAGE_SIZE);
  assert.equal(clampLimit(0), DEFAULT_PAGE_SIZE);
});
