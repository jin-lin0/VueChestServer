const { Op } = require("sequelize");
const Notification = require("../models/notification");
const { toBoundedInt, MAX_PAGE } = require("../utils/queryParams");

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

function serializeNotification(row) {
  const value = row.toJSON ? row.toJSON() : row;
  let meta = null;
  if (value.meta) {
    try {
      meta = JSON.parse(value.meta);
    } catch {
      meta = null;
    }
  }
  return {
    id: value.id,
    type: value.type,
    title: value.title,
    body: value.body || "",
    link: value.link || "",
    appId: value.appId ?? null,
    meta,
    read: Boolean(value.readAt),
    createdAt: value.createdAt ? new Date(value.createdAt).getTime() : Date.now(),
  };
}

// 通知列表复用有界分页参数。
const clampPage = (value) => toBoundedInt(value, { fallback: 1, max: MAX_PAGE });
const clampLimit = (value) =>
  toBoundedInt(value, { fallback: DEFAULT_PAGE_SIZE, max: MAX_PAGE_SIZE });

async function listNotifications(userId, options = {}) {
  const page = clampPage(options.page);
  const limit = clampLimit(options.limit);
  const where = { userId };
  if (options.unreadOnly) where.readAt = null;

  const { rows, count } = await Notification.findAndCountAll({
    where,
    order: [
      ["createdAt", "DESC"],
      ["id", "DESC"],
    ],
    limit,
    offset: (page - 1) * limit,
  });

  return {
    items: rows.map(serializeNotification),
    pagination: { page, limit, total: count, hasMore: page * limit < count },
  };
}

async function unreadCount(userId) {
  return Notification.count({ where: { userId, readAt: null } });
}

/** ids 为空数组时视为「不做任何事」，避免误把全部通知标记已读。 */
async function markRead(userId, ids) {
  const list = (Array.isArray(ids) ? ids : [])
    .map((id) => Number.parseInt(id, 10))
    .filter((id) => Number.isFinite(id) && id > 0);
  if (!list.length) return 0;

  const [updated] = await Notification.update(
    { readAt: new Date() },
    { where: { userId, id: { [Op.in]: list }, readAt: null } },
  );
  return updated;
}

async function markAllRead(userId) {
  const [updated] = await Notification.update(
    { readAt: new Date() },
    { where: { userId, readAt: null } },
  );
  return updated;
}

async function removeNotification(userId, id) {
  const deleted = await Notification.destroy({ where: { userId, id } });
  return deleted > 0;
}

/** 创建通知失败不影响主业务流程。 */
async function createNotification(input = {}) {
  // 允许传入 null（buildXxx 判定「不该发」时会返回 null），此时静默跳过
  const { userId, type, title } = input || {};
  if (!userId || !type || !title) return null;

  try {
    const notification = await Notification.create({
      userId,
      type: String(type).slice(0, 40),
      title: String(title).slice(0, 120),
      body: input.body ? String(input.body).slice(0, 500) : null,
      link: input.link ? String(input.link).slice(0, 200) : null,
      // 注意 Number(null) === 0，所以必须先排除 null/undefined，
      // 否则「应用已删除」时传进来的 appId: null 会被存成 0，前端会拿到一个假的应用 ID
      appId:
        input.appId == null || !Number.isFinite(Number(input.appId))
          ? null
          : Number(input.appId),
      meta: input.meta ? JSON.stringify(input.meta) : null,
    });
    return serializeNotification(notification);
  } catch (error) {
    console.warn("[notification] 创建通知失败：", error.message);
    return null;
  }
}

/** 捕获旁路通知失败，避免影响主业务。调用方式：await safeNotify(notifyXxx(...))。 */
function safeNotify(promise) {
  return Promise.resolve(promise).catch((error) => {
    console.warn("[notification] 通知流程异常：", error?.message || error);
    return null;
  });
}

module.exports = {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  serializeNotification,
  clampPage,
  clampLimit,
  safeNotify,
  listNotifications,
  unreadCount,
  markRead,
  markAllRead,
  removeNotification,
  createNotification,
};
