const express = require("express");
const jwt = require("jsonwebtoken");
const User = require("../models/user");
const { authMiddleware } = require("../middleware/auth");
const { sendVerificationEmail } = require("../utils/mail");
const {
  createCode,
  verifyCode,
  CODE_TTL_MS,
  RESEND_COOLDOWN_MS,
} = require("../utils/verificationCode");

const router = express.Router();

// 简单邮箱格式校验
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// 发送注册验证码
router.post("/send-code", async (req, res) => {
  try {
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
  } catch (error) {
    console.error("发送验证码错误:", error);
    res.status(500).json({
      error: "服务器内部错误",
      code: "SERVER_ERROR",
    });
  }
});

// 注册（普通用户，需邮箱验证码）
router.post("/register", async (req, res) => {
  try {
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

    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "7d" },
    );

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
  } catch (error) {
    console.error("注册错误:", error);
    res.status(500).json({
      error: "服务器内部错误",
      code: "SERVER_ERROR",
    });
  }
});

// 统一登录（所有角色：user / admin / super_admin）
router.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({
        error: "用户名和密码不能为空",
        code: "VALIDATION_ERROR",
      });
    }

    const user = await User.findOne({ where: { username } });

    if (!user) {
      return res.status(401).json({
        error: "用户名或密码错误",
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
        error: "用户名或密码错误",
        code: "INVALID_CREDENTIALS",
      });
    }

    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "7d" },
    );

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
  } catch (error) {
    console.error("登录错误:", error);
    res.status(500).json({
      error: "服务器内部错误",
      code: "SERVER_ERROR",
    });
  }
});

// 获取当前登录用户信息
router.get("/me", authMiddleware, async (req, res) => {
  try {
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
  } catch (error) {
    console.error("获取用户信息错误:", error);
    res.status(500).json({
      error: "服务器内部错误",
      code: "SERVER_ERROR",
    });
  }
});

// 登出
router.post("/logout", authMiddleware, async (req, res) => {
  res.json({
    success: true,
    message: "登出成功",
  });
});

// 检查是否有用户存在（用于初始化）
router.get("/check-init", async (req, res) => {
  try {
    const count = await User.count();
    res.json({
      success: true,
      hasUser: count > 0,
    });
  } catch (error) {
    res.status(500).json({
      error: "服务器内部错误",
      code: "SERVER_ERROR",
    });
  }
});

// ─── 应用安装同步 ─────────────────────────────

// 获取已安装应用列表
router.get("/installed-apps", authMiddleware, async (req, res) => {
  try {
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
  } catch (error) {
    console.error("获取已安装应用错误:", error);
    res.status(500).json({ error: "服务器内部错误" });
  }
});

// 全量更新已安装应用列表（合并用）
router.put("/installed-apps", authMiddleware, async (req, res) => {
  try {
    const { installedApps } = req.body;

    if (!Array.isArray(installedApps)) {
      return res.status(400).json({ error: "installedApps 必须是数组" });
    }

    const user = await User.findByPk(req.user.id);
    if (!user) {
      return res.status(404).json({ error: "用户不存在" });
    }

    await user.update({ installedApps });

    res.json({
      success: true,
      data: installedApps,
    });
  } catch (error) {
    console.error("更新已安装应用错误:", error);
    res.status(500).json({ error: "服务器内部错误" });
  }
});

module.exports = router;
