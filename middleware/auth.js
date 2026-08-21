const jwt = require("jsonwebtoken");
const User = require("../models/user");
const UserSession = require("../models/userSession");

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
  if (!decoded.sessionId) {
    const e = new Error("登录会话已失效，请重新登录");
    e.code = "SESSION_REQUIRED";
    throw e;
  }
  const [user, session] = await Promise.all([
    User.findByPk(decoded.id, {
      attributes: ["id", "username", "role", "isActive"],
    }),
    UserSession.findOne({
      where: { id: decoded.sessionId, userId: decoded.id, revokedAt: null },
    }),
  ]);
  if (!user || !user.isActive) {
    const e = new Error("账号不存在或已被禁用");
    e.code = "ACCOUNT_DISABLED";
    throw e;
  }
  if (!session || session.expiresAt <= new Date()) {
    const e = new Error("登录会话已过期或被撤销");
    e.code = "SESSION_REVOKED";
    throw e;
  }
  if (Date.now() - new Date(session.lastActiveAt).getTime() > 5 * 60 * 1000) {
    session.update({ lastActiveAt: new Date() }).catch(() => {});
  }

  // 以数据库当前权限为准，避免角色变更后旧 Token 继续拥有管理员权限。
  return {
    ...decoded,
    id: user.id,
    username: user.username,
    role: user.role,
    sessionId: session.id,
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
