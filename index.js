const express = require("express");
const cors = require("cors");
const { responseCompression } = require("./middleware/responseCompression");
require("dotenv").config();
const sequelize = require("./config/database");

const app = express();
const PORT = process.env.PORT || 3000;

// CORS 必须先于数据库初始化门禁注册。前端的 X-Client-Geo 会触发 OPTIONS 预检，
// 即使冷启动迁移失败或超时，也应先返回正确跨域头，让浏览器展示真实服务端错误。
app.use(cors());
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
});
// SSE 必须边生成边送达；AI 对话流在 responseCompression 中显式跳过压缩，
// 其余 JSON / 静态响应仍保留 gzip。
app.use(responseCompression);
app.use(express.json({ limit: "2mb" }));

// 访问统计（记录所有 API 请求）
const visitLogger = require("./middleware/visitLogger");
app.use(visitLogger);

// 测试路由
app.get("/", (req, res) => {
  res.send("AI Chat Server is running");
});

// 健康检查 + 日志归档（cron 保活用）
app.get("/health", async (req, res) => {
  try {
    const result = await visitLogger.flushToDB();
    res.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      logsFlushed: result.flushed,
      bufferRemaining: visitLogger.getBufferSize(),
    });
  } catch (e) {
    res.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      error: e.message,
    });
  }
});

// 管理员认证路由
const authRouter = require("./routes/auth");
app.use("/api/auth", authRouter);

// 网易云音乐 API 路由
const neteaseRouter = require("./routes/netease");
app.use("/api/netease", neteaseRouter);

// B站字幕提取路由
const bilibiliRouter = require("./routes/bilibili");
app.use("/api/bilibili", bilibiliRouter);

// 面试题库路由 - 管理操作需要认证
const questionsRouter = require("./routes/questions");
app.use("/api/questions", questionsRouter);

// 应用市场路由
const marketRouter = require("./routes/market");
app.use("/api/market", marketRouter);

// 应用评论路由（挂在 /api/market 下，强绑定 app）
const commentsRouter = require("./routes/comments");
app.use("/api/market", commentsRouter);

const reportsRouter = require("./routes/reports");
app.use("/api/market", reportsRouter);

// 用户管理路由
const usersRouter = require("./routes/users");
app.use("/api/users", usersRouter);

// 统计路由
const statsRouter = require("./routes/stats");
app.use("/api/stats", statsRouter);

const uploadsRouter = require("./routes/uploads");
app.use("/api/uploads", uploadsRouter);

// AI 对话路由
const aiChatRouter = require("./routes/aiChat");
app.use("/api/ai-chat", aiChatRouter);

// 市场应用云端键值存储（需登录，按 userId + appId 隔离）
const appDataRouter = require("./routes/appData");
app.use("/api/app-data", appDataRouter);

// 市场应用受控 AI 代理（需登录，要求应用已声明 ai 能力权限）
const appAiRouter = require("./routes/appAi");
app.use("/api/app-ai", appAiRouter);

// 音乐收藏分组路由（需登录）
const musicFavoritesRouter = require("./routes/musicFavorites");
app.use("/api/music-favorites", musicFavoritesRouter);

const workspaceTemplatesRouter = require("./routes/workspaceTemplates");
app.use("/api/workspace-templates", workspaceTemplatesRouter);

const developerRouter = require("./routes/developer");
app.use("/api/developer", developerRouter);

// 站内通知（需登录，只能读写自己的通知；不涉及浏览器推送）
const notificationsRouter = require("./routes/notifications");
app.use("/api/notifications", notificationsRouter);

// A 股研究数据：免密上游聚合（大盘、估值、财务与公告）
const stockResearchRouter = require("./routes/stockResearch");
app.use("/api/research-stocks", stockResearchRouter);

// westock 能力封装：spawn 官方 CLI（含混淆签名），将 K线/行情/选股/策略等封装为接口
const westockRouter = require("./routes/westock");
app.use("/api/westock", westockRouter);

// 同步数据库模型（Vercel 环境跳过 sync 以加速冷启动）
if (!process.env.VERCEL) {
  sequelize
    .sync()
    .then(() => {
      app.listen(PORT, () => {
        console.log(`Server is running on port ${PORT}`);
      });
      console.log("Database synced successfully");
    })
    .catch((err) => {
      console.error("Unable to sync database:", err);
    });
} else {
  // Vercel 请求链路禁止执行 schema sync/alter。数据库迁移必须在部署前独立完成，
  // 避免多实例冷启动同时占用连接并阻塞全部业务请求。
  console.log("Vercel runtime: schema migration skipped");
}

// 全局错误处理中间件（兜底所有未捕获的异常，统一错误响应格式）
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error("未捕获错误:", err);
  // 统一按响应契约返回 { success:false, error }，避免裸奔 500 / 原始报错文本
  res.status(err.status || 500).json({
    success: false,
    error: err.message || "服务器内部错误",
    code: err.code || "SERVER_ERROR",
  });
});

module.exports = app;
