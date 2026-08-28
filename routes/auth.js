const express = require("express");
const { Op } = require("sequelize");
const User = require("../models/user");
const UserWorkspace = require("../models/userWorkspace");
const UserSession = require("../models/userSession");
const MarketApp = require("../models/marketApp");
const { authMiddleware } = require("../middleware/auth");
const { sendVerificationEmail, sendResetCodeEmail } = require("../utils/mail");
const {
  createCode,
  verifyCode,
  CODE_TTL_MS,
  RESEND_COOLDOWN_MS,
} = require("../utils/verificationCode");
const {
  normalizeInstalledAppIds,
  selectExistingAppIds,
} = require("../utils/installedApps");
const {
  splitCloudEnvelope,
  createCloudEnvelope,
  sanitizeSelectiveSyncConfig,
} = require("../utils/cloudSync");
const { createLoginSession } = require("../services/authSessionService");
const { sanitizeWorkspaceConfig } = require("../utils/workspaceConfig");

const router = express.Router();

// 简单邮箱格式校验
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// 发送注册验证码
router.post("/send-code", async (req, res) => {
  const { email } = req.body;

  if (!email || !EMAIL_RE.test(email)) {
    return res.status(400).json({
      error: "请输入有效的邮箱地址",
      code: "VALIDATION_ERROR",
    });
  }

  // 检查邮箱是否已被注册
  const used = await User.findOne({ where: { email } });
  if (used) {
    return res.status(409).json({
      error: "该邮箱已被注册",
      code: "EMAIL_USED",
    });
  }

  const { code, cooldown } = createCode(email);
  if (cooldown > 0) {
    return res.status(429).json({
      error: `验证码已发送，请 ${Math.ceil(cooldown / 1000)} 秒后再试`,
      code: "RATE_LIMITED",
      retryAfter: Math.ceil(cooldown / 1000),
    });
  }

  const result = await sendVerificationEmail(email, code);
  if (!result.success) {
    return res.status(502).json({
      error: `验证码发送失败：${result.error}`,
      code: "MAIL_SEND_FAILED",
    });
  }

  res.json({
    success: true,
    message: "验证码已发送，请查收邮箱",
    data: {
      expiresIn: Math.floor(CODE_TTL_MS / 1000),
      cooldown: Math.floor(RESEND_COOLDOWN_MS / 1000),
    },
  });
});

// 注册（普通用户，需邮箱验证码）
router.post("/register", async (req, res) => {
  const { username, password, email, code } = req.body;

  if (!username || !password) {
    return res.status(400).json({
      error: "用户名和密码不能为空",
      code: "VALIDATION_ERROR",
    });
  }

  if (username.length < 3) {
    return res.status(400).json({
      error: "用户名至少需要3个字符",
      code: "VALIDATION_ERROR",
    });
  }

  // 用户名禁止邮箱格式：登录时靠「是否像邮箱」分流查 email/username，
  // 若用户名也是邮箱格式会造成歧义，故注册即禁止。
  if (EMAIL_RE.test(username)) {
    return res.status(400).json({
      error: "用户名不能是邮箱格式，请使用普通用户名",
      code: "VALIDATION_ERROR",
    });
  }

  if (password.length < 6) {
    return res.status(400).json({
      error: "密码至少需要6个字符",
      code: "VALIDATION_ERROR",
    });
  }

  // 邮箱为必填，并需校验验证码
  if (!email || !EMAIL_RE.test(email)) {
    return res.status(400).json({
      error: "请输入有效的邮箱地址",
      code: "VALIDATION_ERROR",
    });
  }

  if (!code) {
    return res.status(400).json({
      error: "请输入邮箱验证码",
      code: "VALIDATION_ERROR",
    });
  }

  // 先查重，避免验证码被白白消耗（验证码校验是一次性的）
  const existing = await User.findOne({ where: { username } });
  if (existing) {
    return res.status(409).json({
      error: "用户名已存在",
      code: "CONFLICT",
    });
  }

  const emailUsed = await User.findOne({ where: { email } });
  if (emailUsed) {
    return res.status(409).json({
      error: "该邮箱已被注册",
      code: "EMAIL_USED",
    });
  }

  // 查重通过后再校验验证码（校验成功即清除，一次性）
  const verify = verifyCode(email, code);
  if (!verify.valid) {
    return res.status(400).json({
      error: verify.reason,
      code: "CODE_INVALID",
    });
  }

  const user = await User.create({
    username,
    password,
    email,
    role: "user",
    isActive: true,
    installedApps: [],
  });

  const { token } = await createLoginSession(user, req);

  await user.update({ lastLoginAt: new Date() });

  res.status(201).json({
    success: true,
    message: "注册成功",
    data: {
      token,
      user: user.toJSON(),
      expiresIn: 7 * 24 * 60 * 60,
    },
  });
});

// 发送重置密码验证码
router.post("/forgot-password", async (req, res) => {
  const { email } = req.body;

  if (!email || !EMAIL_RE.test(email)) {
    return res.status(400).json({
      error: "请输入有效的邮箱地址",
      code: "VALIDATION_ERROR",
    });
  }

  const user = await User.findOne({ where: { email } });
  if (!user) {
    return res.status(404).json({
      error: "该邮箱未注册",
      code: "EMAIL_NOT_FOUND",
    });
  }

  const { code, cooldown } = createCode(email, "reset");
  if (cooldown > 0) {
    return res.status(429).json({
      error: `验证码已发送，请 ${Math.ceil(cooldown / 1000)} 秒后再试`,
      code: "RATE_LIMITED",
      retryAfter: Math.ceil(cooldown / 1000),
    });
  }

  const result = await sendResetCodeEmail(email, code);
  if (!result.success) {
    return res.status(502).json({
      error: `验证码发送失败：${result.error}`,
      code: "MAIL_SEND_FAILED",
    });
  }

  res.json({
    success: true,
    message: "重置验证码已发送，请查收邮箱",
    data: {
      expiresIn: Math.floor(CODE_TTL_MS / 1000),
      cooldown: Math.floor(RESEND_COOLDOWN_MS / 1000),
    },
  });
});

// 重置密码（凭邮箱验证码）
router.post("/reset-password", async (req, res) => {
  const { email, code, newPassword } = req.body;

  if (!email || !EMAIL_RE.test(email)) {
    return res.status(400).json({
      error: "请输入有效的邮箱地址",
      code: "VALIDATION_ERROR",
    });
  }

  if (!code) {
    return res.status(400).json({
      error: "请输入验证码",
      code: "VALIDATION_ERROR",
    });
  }

  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({
      error: "新密码至少需要6个字符",
      code: "VALIDATION_ERROR",
    });
  }

  const user = await User.findOne({ where: { email } });
  if (!user) {
    return res.status(404).json({
      error: "该邮箱未注册",
      code: "EMAIL_NOT_FOUND",
    });
  }

  const verify = verifyCode(email, code, "reset");
  if (!verify.valid) {
    return res.status(400).json({
      error: verify.reason,
      code: "CODE_INVALID",
    });
  }

  // beforeUpdate 钩子会自动对明文密码做 bcrypt 哈希
  user.password = newPassword;
  await user.save();
  await UserSession.update(
    { revokedAt: new Date() },
    { where: { userId: user.id, revokedAt: null } },
  );

  res.json({
    success: true,
    message: "密码重置成功，请使用新密码登录",
  });
});

// 统一登录（所有角色：user / admin / super_admin）
// 支持「用户名 + 密码」或「邮箱 + 密码」登录：自动识别 identifier 是否为邮箱格式
router.post("/login", async (req, res) => {
  const { username, email, password } = req.body;
  const identifier = (username || email || "").toString().trim();

  if (!identifier || !password) {
    return res.status(400).json({
      error: "用户名/邮箱和密码不能为空",
      code: "VALIDATION_ERROR",
    });
  }

  // 识别为邮箱则按 email 查，否则按 username 查
  const query = EMAIL_RE.test(identifier)
    ? { email: identifier }
    : { username: identifier };

  const user = await User.findOne({ where: query });

  if (!user) {
    return res.status(401).json({
      error: "用户名/邮箱或密码错误",
      code: "INVALID_CREDENTIALS",
    });
  }

  if (!user.isActive) {
    return res.status(403).json({
      error: "账号已被禁用，请联系管理员",
      code: "ACCOUNT_DISABLED",
    });
  }

  const isValidPassword = await user.validatePassword(password);

  if (!isValidPassword) {
    return res.status(401).json({
      error: "用户名/邮箱或密码错误",
      code: "INVALID_CREDENTIALS",
    });
  }

  const { token } = await createLoginSession(user, req);

  await user.update({ lastLoginAt: new Date() });

  res.json({
    success: true,
    message: "登录成功",
    data: {
      token,
      user: user.toJSON(),
      expiresIn: 7 * 24 * 60 * 60,
    },
  });
});

// 获取当前登录用户信息
router.get("/me", authMiddleware, async (req, res) => {
  const user = await User.findByPk(req.user.id);

  if (!user) {
    return res.status(404).json({
      error: "用户不存在",
      code: "NOT_FOUND",
    });
  }

  res.json({
    success: true,
    data: user.toJSON(),
  });
});

router.post("/logout", authMiddleware, async (req, res) => {
  await UserSession.update(
    { revokedAt: new Date() },
    { where: { id: req.user.sessionId, userId: req.user.id } },
  );
  res.json({ success: true });
});

router.get("/sessions", authMiddleware, async (req, res) => {
  const sessions = await UserSession.findAll({
    where: {
      userId: req.user.id,
      revokedAt: null,
      expiresAt: { [Op.gt]: new Date() },
    },
    attributes: [
      "id",
      "deviceName",
      "ip",
      "lastActiveAt",
      "expiresAt",
      "createdAt",
    ],
    order: [["lastActiveAt", "DESC"]],
  });
  res.json({
    success: true,
    data: sessions.map((session) => ({
      ...session.toJSON(),
      isCurrent: session.id === req.user.sessionId,
    })),
  });
});

router.delete("/sessions/others", authMiddleware, async (req, res) => {
  await UserSession.update(
    { revokedAt: new Date() },
    {
      where: {
        userId: req.user.id,
        id: { [Op.ne]: req.user.sessionId },
        revokedAt: null,
      },
    },
  );
  res.json({ success: true });
});

router.delete("/sessions/:id", authMiddleware, async (req, res) => {
  const session = await UserSession.findOne({
    where: { id: req.params.id, userId: req.user.id, revokedAt: null },
  });
  if (!session) return res.status(404).json({ error: "设备会话不存在" });
  await session.update({ revokedAt: new Date() });
  res.json({
    success: true,
    data: { revokedCurrent: session.id === req.user.sessionId },
  });
});

// 修改个人资料（当前支持修改登录用户名/昵称）
router.put("/me", authMiddleware, async (req, res) => {
  const { username } = req.body || {};

  if (typeof username !== "string" || !username.trim()) {
    return res.status(400).json({
      error: "昵称不能为空",
      code: "VALIDATION_ERROR",
    });
  }

  const trimmed = username.trim();

  if (trimmed.length < 3) {
    return res.status(400).json({
      error: "昵称至少需要 3 个字符",
      code: "VALIDATION_ERROR",
    });
  }

  // 与注册保持一致：用户名禁止邮箱格式，避免登录分流歧义
  if (EMAIL_RE.test(trimmed)) {
    return res.status(400).json({
      error: "昵称不能是邮箱格式，请使用普通昵称",
      code: "VALIDATION_ERROR",
    });
  }

  // 唯一性校验，排除当前用户本人
  const conflict = await User.findOne({ where: { username: trimmed } });
  if (conflict && conflict.id !== req.user.id) {
    return res.status(409).json({
      error: "该昵称已被占用",
      code: "CONFLICT",
    });
  }

  // 昵称未变化时 conflict 即当前用户本人，直接复用，避免重复查库
  const user = conflict || (await User.findByPk(req.user.id));
  if (!user) {
    return res.status(404).json({ error: "用户不存在" });
  }

  await user.update({ username: trimmed });

  res.json({
    success: true,
    data: user.toJSON(),
  });
});

// ─── 应用安装同步 ─────────────────────────────

// 获取已安装应用列表
router.get("/installed-apps", authMiddleware, async (req, res) => {
  const user = await User.findByPk(req.user.id, {
    attributes: ["id", "installedApps"],
  });

  if (!user) {
    return res.status(404).json({ error: "用户不存在" });
  }

  res.json({
    success: true,
    data: user.installedApps,
  });
});

// 全量更新已安装应用列表（合并用）
router.put("/installed-apps", authMiddleware, async (req, res) => {
  let requestedIds;
  try {
    requestedIds = normalizeInstalledAppIds(req.body.installedApps);
  } catch (error) {
    return res.status(error.status || 400).json({ error: error.message });
  }

  const user = await User.findByPk(req.user.id);
  if (!user) {
    return res.status(404).json({ error: "用户不存在" });
  }

  const rows = requestedIds.length
    ? await MarketApp.findAll({
        where: { id: { [Op.in]: requestedIds }, status: "approved" },
        attributes: ["id"],
      })
    : [];
  const installedApps = selectExistingAppIds(requestedIds, rows);
  const ignoredIds = requestedIds.filter((id) => !installedApps.includes(id));

  await user.update({ installedApps });

  res.json({
    success: true,
    data: installedApps,
    ignoredIds,
  });
});

// ─── 个人工作台云同步 ─────────────────────────

router.get("/workspace", authMiddleware, async (req, res) => {
  const workspace = await UserWorkspace.findOne({
    where: { userId: req.user.id },
  });
  const config = workspace
    ? splitCloudEnvelope(workspace.config).workspace
    : null;
  res.json({
    success: true,
    data:
      workspace && config
        ? {
            config,
            updatedAt: workspace.updatedAt.toISOString(),
          }
        : null,
  });
});

router.put("/workspace", authMiddleware, async (req, res) => {
  const config = sanitizeWorkspaceConfig(req.body?.config);
  let workspace = await UserWorkspace.findOne({
    where: { userId: req.user.id },
  });
  const previous = splitCloudEnvelope(workspace?.config);
  const envelope = createCloudEnvelope(config, previous.selectiveSync);

  if (workspace) {
    await workspace.update({ config: envelope });
  } else {
    workspace = await UserWorkspace.create({
      userId: req.user.id,
      config: envelope,
    });
  }

  res.json({
    success: true,
    data: {
      config,
      updatedAt: workspace.updatedAt.toISOString(),
    },
  });
});

router.delete("/workspace", authMiddleware, async (req, res) => {
  const workspace = await UserWorkspace.findOne({
    where: { userId: req.user.id },
  });
  if (workspace) {
    const previous = splitCloudEnvelope(workspace.config);
    if (previous.selectiveSync) {
      await workspace.update({
        config: createCloudEnvelope(null, previous.selectiveSync),
      });
    } else {
      await workspace.destroy();
    }
  }
  res.json({ success: true });
});

// ─── 选择性云同步 ───────────────────────────

router.get("/sync", authMiddleware, async (req, res) => {
  const workspace = await UserWorkspace.findOne({
    where: { userId: req.user.id },
  });
  const config = workspace
    ? splitCloudEnvelope(workspace.config).selectiveSync
    : null;
  res.json({
    success: true,
    data:
      workspace && config
        ? {
            config,
            updatedAt: workspace.updatedAt.toISOString(),
          }
        : null,
  });
});

router.put("/sync", authMiddleware, async (req, res) => {
  const config = sanitizeSelectiveSyncConfig(req.body?.config);
  let workspace = await UserWorkspace.findOne({
    where: { userId: req.user.id },
  });
  const previous = splitCloudEnvelope(workspace?.config);
  const envelope = createCloudEnvelope(previous.workspace, config);

  if (workspace) {
    await workspace.update({ config: envelope });
  } else {
    workspace = await UserWorkspace.create({
      userId: req.user.id,
      config: envelope,
    });
  }

  res.json({
    success: true,
    data: {
      config,
      updatedAt: workspace.updatedAt.toISOString(),
    },
  });
});

router.delete("/sync", authMiddleware, async (req, res) => {
  const workspace = await UserWorkspace.findOne({
    where: { userId: req.user.id },
  });
  if (workspace) {
    const previous = splitCloudEnvelope(workspace.config);
    if (previous.workspace) {
      await workspace.update({
        config: createCloudEnvelope(previous.workspace, null),
      });
    } else {
      await workspace.destroy();
    }
  }
  res.json({ success: true });
});

module.exports = router;
