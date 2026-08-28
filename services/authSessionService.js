const jwt = require("jsonwebtoken");
const UserSession = require("../models/userSession");

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function detectDevice(req) {
  const userAgent = String(req.headers["user-agent"] || "未知设备").slice(0, 500);
  let name = "浏览器设备";
  if (/iPhone/i.test(userAgent)) name = "iPhone";
  else if (/iPad/i.test(userAgent)) name = "iPad";
  else if (/Android/i.test(userAgent)) name = "Android 设备";
  else if (/Macintosh|Mac OS/i.test(userAgent)) name = "Mac";
  else if (/Windows/i.test(userAgent)) name = "Windows 设备";
  else if (/Linux/i.test(userAgent)) name = "Linux 设备";

  const browser = /Edg\//.test(userAgent)
    ? "Edge"
    : /Chrome\//.test(userAgent)
      ? "Chrome"
      : /Firefox\//.test(userAgent)
        ? "Firefox"
        : /Safari\//.test(userAgent)
          ? "Safari"
          : "浏览器";
  return {
    deviceName: `${name} · ${browser}`,
    userAgent,
    ip: String(req.headers["x-forwarded-for"] || req.ip || "")
      .split(",")[0]
      .trim()
      .slice(0, 64),
  };
}

async function createLoginSession(user, req) {
  const now = new Date();
  const session = await UserSession.create({
    userId: user.id,
    ...detectDevice(req),
    lastActiveAt: now,
    expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
  });
  const token = jwt.sign(
    {
      id: user.id,
      username: user.username,
      role: user.role,
      sessionId: session.id,
    },
    process.env.JWT_SECRET,
    { expiresIn: "7d" },
  );
  return { token, session };
}

module.exports = { SESSION_TTL_MS, createLoginSession, detectDevice };
