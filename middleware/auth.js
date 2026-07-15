const jwt = require("jsonwebtoken");
const User = require("../models/user");

function verifySecret() {
  if (!process.env.JWT_SECRET) {
    throw new Error("JWT_SECRET 未配置");
  }
}

async function authMiddleware(req, res, next) {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        error: "未授权，请先登录",
        code: "UNAUTHORIZED",
      });
    }

    const token = authHeader.split(" ")[1];

    if (!token) {
      return res.status(401).json({
        error: "无效的令牌",
        code: "INVALID_TOKEN",
      });
    }

    verifySecret();
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findByPk(decoded.id, {
      attributes: ["id", "username", "role", "isActive"],
    });
    if (!user || !user.isActive) {
      return res
        .status(401)
        .json({ error: "账号不存在或已被禁用", code: "ACCOUNT_DISABLED" });
    }

    // 以数据库当前权限为准，避免角色变更后旧 Token 继续拥有管理员权限。
    req.user = {
      ...decoded,
      id: user.id,
      username: user.username,
      role: user.role,
    };
    next();
  } catch (error) {
    if (error.name === "TokenExpiredError") {
      return res.status(401).json({
        error: "令牌已过期，请重新登录",
        code: "TOKEN_EXPIRED",
      });
    }

    return res.status(401).json({
      error: "无效的令牌",
      code: "INVALID_TOKEN",
    });
  }
}

async function optionalAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;

    if (authHeader && authHeader.startsWith("Bearer ")) {
      const token = authHeader.split(" ")[1];
      if (token) {
        verifySecret();
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const user = await User.findByPk(decoded.id, {
          attributes: ["id", "username", "role", "isActive"],
        });
        if (user?.isActive) {
          req.user = {
            ...decoded,
            id: user.id,
            username: user.username,
            role: user.role,
          };
        }
      }
    }
  } catch (error) {
    // ignore
  }

  next();
}

module.exports = { authMiddleware, optionalAuth };
