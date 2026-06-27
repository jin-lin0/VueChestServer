const { Resend } = require("resend");

// 延迟初始化，避免缺少 key 时模块加载就报错
let resendClient = null;

function getClient() {
  if (!process.env.RESEND_KEY) {
    throw new Error("未配置 RESEND_KEY 环境变量");
  }
  if (!resendClient) {
    resendClient = new Resend(process.env.RESEND_KEY);
  }
  return resendClient;
}

/**
 * 构造发件人地址
 * 优先使用 RESEND_FROM 整串，否则用 RESEND_DOMAIN 拼接
 */
function getFromAddress() {
  if (process.env.RESEND_FROM) {
    return process.env.RESEND_FROM;
  }
  if (!process.env.RESEND_DOMAIN) {
    throw new Error("未配置 RESEND_DOMAIN 环境变量");
  }
  return `VueChest <noreply@${process.env.RESEND_DOMAIN}>`;
}

/**
 * 发送注册验证码邮件
 * @param {string} to 收件人邮箱
 * @param {string} code 6 位验证码
 * @returns {Promise<{success: boolean, messageId?: string, error?: string}>}
 */
async function sendVerificationEmail(to, code) {
  try {
    const resend = getClient();
    const from = getFromAddress();

    const { data, error } = await resend.emails.send({
      from,
      to,
      subject: "【VueChest】注册验证码",
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 32px; background: #f8fafc; border-radius: 12px;">
          <div style="background: white; padding: 32px; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.06);">
            <h2 style="margin: 0 0 8px; color: #1f2937;">VueChest 注册验证码</h2>
            <p style="color: #6b7280; margin: 0 0 24px; font-size: 14px;">您正在注册 VueChest 账号，请使用以下验证码完成验证：</p>
            <div style="text-align: center; background: linear-gradient(135deg, #667eea, #764ba2); border-radius: 10px; padding: 20px; margin: 24px 0;">
              <span style="font-size: 32px; font-weight: 700; color: white; letter-spacing: 8px;">${code}</span>
            </div>
            <p style="color: #6b7280; font-size: 13px; margin: 0;">验证码 5 分钟内有效，请勿泄露给他人。如非本人操作，请忽略此邮件。</p>
          </div>
          <p style="text-align: center; color: #9ca3af; font-size: 12px; margin-top: 16px;">VueChest · 请勿直接回复此邮件</p>
        </div>
      `,
    });

    if (error) {
      console.error("Resend 发送失败:", error);
      return { success: false, error: error.message || "邮件发送失败" };
    }

    return { success: true, messageId: data?.id };
  } catch (err) {
    console.error("邮件服务异常:", err.message);
    return { success: false, error: err.message };
  }
}

module.exports = { sendVerificationEmail, getFromAddress };
