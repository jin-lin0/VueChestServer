const { timingSafeEqual } = require("node:crypto");

module.exports = function cronAuth(req, res, next) {
  const secret = process.env.CRON_SECRET;
  const actual = Buffer.from(req.headers.authorization || "");
  const expected = Buffer.from(`Bearer ${secret || ""}`);
  if (
    !secret ||
    actual.length !== expected.length ||
    !timingSafeEqual(actual, expected)
  ) {
    return res.status(401).json({ success: false, error: "未授权" });
  }
  next();
};
