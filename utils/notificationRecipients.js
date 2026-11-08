const User = require("../models/user");

/**
 * 通知收件人只来自账号本身：每个超管用自己的邮箱接收自己账号的通知。
 * 没有邮箱就明确失败，不再提供环境变量兜底，避免「配置漂移」后
 * 邮件发到一个谁也不知道的地址。
 */
function normalize(email) {
  return String(email || "").trim();
}

function missingRecipient(message) {
  const error = new Error(message);
  error.status = 500;
  return error;
}

/** 所有启用且配置了邮箱的超管。股票日报这类全局内容按人各发一封。 */
async function superAdminRecipients() {
  const rows = await User.findAll({
    where: { role: "super_admin", isActive: true },
    attributes: ["id", "email"],
    order: [["id", "ASC"]],
  });
  const recipients = rows
    .map((user) => ({ ownerId: user.id, email: normalize(user.email) }))
    .filter((item) => item.email);
  if (!recipients.length)
    throw missingRecipient("没有已配置邮箱的超级管理员，无法发送邮件");
  return recipients;
}

/** 单个超管的收件地址，用于签到失败这类只属于该账号的告警。 */
async function ownerRecipient(ownerId) {
  const id = Number(ownerId);
  const user =
    Number.isInteger(id) && id > 0
      ? await User.findByPk(id, {
          attributes: ["id", "email", "isActive"],
        })
      : null;
  const email = normalize(user?.email);
  if (!user || !user.isActive || !email)
    throw missingRecipient(`超管 ${ownerId} 未配置可用邮箱，无法发送告警`);
  return { ownerId: id, email };
}

module.exports = { superAdminRecipients, ownerRecipient };
