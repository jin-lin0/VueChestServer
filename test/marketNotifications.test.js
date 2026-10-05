const test = require("node:test");
const assert = require("node:assert/strict");
const {
  categoryLabel,
  buildReviewNotification,
  buildCommentNotification,
  buildReportNotification,
  buildReportResolvedNotification,
} = require("../services/marketNotifications");

const app = { id: 12, name: "AI 笔记", uploadedBy: 3 };

test("审核通过通知：文案、跳转与 meta 完整", () => {
  const payload = buildReviewNotification({
    app,
    version: { version: "1.2.0" },
    approved: true,
    actorId: 99,
  });
  assert.equal(payload.userId, 3);
  assert.equal(payload.type, "market.review.approved");
  assert.equal(payload.title, "AI 笔记 v1.2.0 已通过审核");
  assert.match(payload.body, /可以在应用市场搜索并安装/);
  assert.equal(payload.link, "/developer");
  assert.deepEqual(payload.meta, { approved: true, category: null, version: "1.2.0" });
});

test("审核拒绝通知：带上问题分类与审核意见", () => {
  const payload = buildReviewNotification({
    app,
    version: { version: "1.2.0" },
    approved: false,
    category: "security",
    note: "申请了不必要的剪贴板权限",
    actorId: 99,
  });
  assert.equal(payload.type, "market.review.rejected");
  assert.match(payload.body, /安全或权限问题/);
  assert.match(payload.body, /不必要的剪贴板权限/);
});

test("审核通知：管理员审核自己的应用时不下发", () => {
  assert.equal(
    buildReviewNotification({ app: { ...app, uploadedBy: 99 }, approved: true, actorId: 99 }),
    null,
  );
  assert.equal(buildReviewNotification({ app: null, approved: true, actorId: 1 }), null);
});

test("审核通知：缺少版本时标题不出现多余空格", () => {
  const payload = buildReviewNotification({ app, approved: true, actorId: 99 });
  assert.equal(payload.title, "AI 笔记 已通过审核");
});

test("审核通知：超长审核意见被截断", () => {
  const payload = buildReviewNotification({
    app,
    approved: false,
    category: "other",
    note: "字".repeat(400),
    actorId: 99,
  });
  assert.ok(payload.body.length < 200);
  assert.ok(payload.body.endsWith("…"));
});

test("顶层评论通知应用作者，楼中楼通知被回复者", () => {
  const top = buildCommentNotification({
    app,
    comment: { id: 1, content: "很好用", rating: 5 },
    parent: null,
    actor: { id: 7, username: "小明" },
  });
  assert.equal(top.userId, 3);
  assert.equal(top.type, "market.comment.created");
  assert.equal(top.title, "AI 笔记 收到新评论（5 星）");
  assert.match(top.body, /^小明：很好用$/);
  assert.equal(top.link, "/market/12");

  const reply = buildCommentNotification({
    app,
    comment: { id: 2, content: "同感" },
    parent: { id: 1, userId: 8 },
    actor: { id: 7, username: "小明" },
  });
  assert.equal(reply.userId, 8);
  assert.equal(reply.type, "market.comment.reply");
  assert.equal(reply.title, "小明 回复了你在「AI 笔记」的评论");
  assert.deepEqual(reply.meta, { commentId: 2, parentId: 1 });
});

test("评论通知：作者自评、自己回复自己都不发", () => {
  assert.equal(
    buildCommentNotification({
      app,
      comment: { id: 1, content: "自评" },
      parent: null,
      actor: { id: 3, username: "作者" },
    }),
    null,
  );
  assert.equal(
    buildCommentNotification({
      app,
      comment: { id: 2, content: "自己回自己" },
      parent: { id: 1, userId: 7 },
      actor: { id: 7, username: "小明" },
    }),
    null,
  );
  assert.equal(buildCommentNotification({ app: null, comment: { id: 1 } }), null);
});

test("举报通知：通知应用作者并带举报类型", () => {
  const payload = buildReportNotification({
    app,
    report: { id: 5, reason: "privacy", details: "疑似收集无关的个人信息" },
    actor: { id: 7 },
  });
  assert.equal(payload.userId, 3);
  assert.equal(payload.type, "market.report.created");
  assert.match(payload.title, /被举报：privacy/);
  assert.deepEqual(payload.meta, { reportId: 5, reason: "privacy" });
});

test("举报处理结果通知举报人，自己处理自己的举报不发", () => {
  const payload = buildReportResolvedNotification({
    app,
    report: { id: 5, reporterId: 7, resolutionNote: "已下架处理" },
    status: "resolved",
    actorId: 99,
  });
  assert.equal(payload.userId, 7);
  assert.equal(payload.title, "你对「AI 笔记」的举报已处理");
  assert.equal(payload.link, "/market/12");

  const dismissed = buildReportResolvedNotification({
    app,
    report: { id: 5, reporterId: 7, resolutionNote: "证据不足" },
    status: "dismissed",
    actorId: 99,
  });
  assert.match(dismissed.title, /已驳回/);

  assert.equal(
    buildReportResolvedNotification({
      app,
      report: { id: 5, reporterId: 99, resolutionNote: "x" },
      status: "resolved",
      actorId: 99,
    }),
    null,
  );
});

test("举报处理通知：应用已删除时回退到市场首页", () => {
  const payload = buildReportResolvedNotification({
    app: null,
    report: { id: 5, reporterId: 7, resolutionNote: "已处理" },
    status: "resolved",
    actorId: 99,
  });
  assert.equal(payload.link, "/market");
  assert.equal(payload.title, "你对「该应用」的举报已处理");
});

test("categoryLabel 对未知分类回退到通用文案", () => {
  assert.equal(categoryLabel("security"), "安全或权限问题");
  assert.equal(categoryLabel("unknown"), "审核意见");
  assert.equal(categoryLabel(undefined), "审核意见");
});
