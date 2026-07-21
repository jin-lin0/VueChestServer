const jwt = require("jsonwebtoken");
const User = require("../models/user");

function verifySecret() {
  if (!process.env.JWT_SECRET) {
    throw new Error("JWT_SECRET 未配置");
  }
}

async function verifyAndLoad(authHeader) {
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    const e = new Error("未授权，请先登录");
    e.code = "UNAUTHORIZED";
    throw e;
  }

  const token = authHeader.split(" ")[1];
  if (!token) {
    const e = new Error("无效的令牌");
    e.code = "INVALID_TOKEN";
    throw e;
  }

  verifySecret();
  const decoded = jwt.verify(token, process.env.JWT_SECRET);
  const user = await User.findByPk(decoded.id, {
    attributes: ["id", "username", "role", "isActive"],
  });
  if (!user || !user.isActive) {
    const e = new Error("账号不存在或已被禁用");
    e.code = "ACCOUNT_DISABLED";
    throw e;
  }

  // 以数据库当前权限为准，避免角色变更后旧 Token 继续拥有管理员权限。
  return {
    ...decoded,
    id: user.id,
    username: user.username,
    role: user.role,
  };
}

async function authMiddleware(req, res, next) {
  try {
    req.user = await verifyAndLoad(req.headers.authorization);
    next();
  } catch (error) {
    const code =
      error.code ||
      (error.name === "TokenExpiredError" ? "TOKEN_EXPIRED" : "INVALID_TOKEN");
    res.status(401).json({ error: error.message, code });
  }
}

async function optionalAuth(req, res, next) {
  try {
    req.user = await verifyAndLoad(req.headers.authorization);
  } catch {}
  next();
}

module.exports = { authMiddleware, optionalAuth };
