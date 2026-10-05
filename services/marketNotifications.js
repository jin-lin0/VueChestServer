const { createNotification } = require("./notificationService");

/**
 * 市场事件的「通知文案」集中在这一层。
 *
 * 结构：`buildXxx()` 是纯函数，只负责把事件转成通知载荷（含收件人与文案），
 * `notifyXxx()` 再把它落库。拆开的原因是纯函数可以脱离数据库被测试——
 * 文案、收件人判定（不给自己发通知）这类规则最需要回归保护。
 */

const REVIEW_CATEGORY_LABEL = {
  functionality: "功能问题",
  security: "安全或权限问题",
  metadata: "描述或素材问题",
  compatibility: "兼容性问题",
  other: "其他问题",
};

function categoryLabel(category) {
  return REVIEW_CATEGORY_LABEL[category] || "审核意见";
}

function truncate(value, max = 120) {
  const text = String(value ?? "").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

/** 应用/版本审核结果 → 通知应用作者。 */
function buildReviewNotification({
  app,
  version,
  approved,
  category,
  note,
  actorId,
}) {
  if (!app?.uploadedBy || app.uploadedBy === actorId) return null;

  const versionLabel = version?.version ? ` v${version.version}` : "";
  const title = approved
    ? `${app.name}${versionLabel} 已通过审核`
    : `${app.name}${versionLabel} 未通过审核`;

  const parts = [];
  if (!approved && category) parts.push(categoryLabel(category));
  if (note) parts.push(truncate(note, 160));
  if (approved) parts.push("用户现在可以在应用市场搜索并安装它。");

  return {
    userId: app.uploadedBy,
    type: approved ? "market.review.approved" : "market.review.rejected",
    title: truncate(title, 120),
    body: parts.join(" · "),
    link: "/developer",
    appId: app.id,
    meta: {
      approved,
      category: category || null,
      version: version?.version || null,
    },
  };
}

/**
 * 新评论 → 楼中楼通知被回复者，顶层评论通知应用作者。
 * 自己回复自己、或作者给自己应用评论时不产生通知。
 */
function buildCommentNotification({ app, comment, parent, actor }) {
  if (!app || !comment) return null;
  const actorName = actor?.username || "某位用户";

  if (parent) {
    if (!parent.userId || parent.userId === actor?.id) return null;
    return {
      userId: parent.userId,
      type: "market.comment.reply",
      title: `${actorName} 回复了你在「${app.name}」的评论`,
      body: truncate(comment.content, 160),
      link: `/market/${app.id}`,
      appId: app.id,
      meta: { commentId: comment.id, parentId: parent.id },
    };
  }

  if (!app.uploadedBy || app.uploadedBy === actor?.id) return null;
  return {
    userId: app.uploadedBy,
    type: "market.comment.created",
    title: `${app.name} 收到新评论${comment.rating ? `（${comment.rating} 星）` : ""}`,
    body: `${actorName}：${truncate(comment.content, 160)}`,
    link: `/market/${app.id}`,
    appId: app.id,
    meta: { commentId: comment.id, rating: comment.rating ?? null },
  };
}

/** 应用被举报 → 通知应用作者。 */
function buildReportNotification({ app, report, actor }) {
  if (!app?.uploadedBy || app.uploadedBy === actor?.id) return null;
  return {
    userId: app.uploadedBy,
    type: "market.report.created",
    title: `「${app.name}」被举报：${report.reason}`,
    body: truncate(report.details, 160),
    link: `/market/${app.id}`,
    appId: app.id,
    meta: { reportId: report.id, reason: report.reason },
  };
}

/** 举报处理结果 → 通知举报人。 */
function buildReportResolvedNotification({ app, report, status, actorId }) {
  if (!report?.reporterId || report.reporterId === actorId) return null;
  const name = app?.name || "该应用";
  return {
    userId: report.reporterId,
    type: "market.report.resolved",
    title:
      status === "resolved"
        ? `你对「${name}」的举报已处理`
        : `你对「${name}」的举报已驳回`,
    body: truncate(report.resolutionNote, 160),
    link: app ? `/market/${app.id}` : "/market",
    appId: app?.id ?? null,
    meta: { reportId: report.id, status },
  };
}

function notifyReviewResult(input) {
  return createNotification(buildReviewNotification(input));
}

function notifyNewComment(input) {
  return createNotification(buildCommentNotification(input));
}

function notifyNewReport(input) {
  return createNotification(buildReportNotification(input));
}

function notifyReportResolved(input) {
  return createNotification(buildReportResolvedNotification(input));
}

module.exports = {
  REVIEW_CATEGORY_LABEL,
  categoryLabel,
  buildReviewNotification,
  buildCommentNotification,
  buildReportNotification,
  buildReportResolvedNotification,
  notifyReviewResult,
  notifyNewComment,
  notifyNewReport,
  notifyReportResolved,
};
