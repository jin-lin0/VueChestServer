const express = require("express");
const cors = require("cors");
const compression = require("compression");
const { DataTypes, Op } = require("sequelize");
require("dotenv").config();
const sequelize = require("./config/database");
const MarketApp = require("./models/marketApp");
const MarketAppVersion = require("./models/marketAppVersion");
const AppComment = require("./models/appComment");
const UserWorkspace = require("./models/userWorkspace");
const WorkspaceTemplate = require("./models/workspaceTemplate");
const UserSession = require("./models/userSession");

const app = express();
const PORT = process.env.PORT || 3000;

async function ensureMarketReleaseNotesColumn() {
  const queryInterface = sequelize.getQueryInterface();
  const columns = await queryInterface.describeTable("market_apps");
  if (!columns.releaseNotes) {
    await queryInterface.addColumn("market_apps", "releaseNotes", {
      type: DataTypes.TEXT,
      allowNull: true,
    });
  }
}

async function ensureMarketVersions() {
  await MarketAppVersion.sync();
  const queryInterface = sequelize.getQueryInterface();
  const versionColumns = await queryInterface.describeTable("market_app_versions");
  if (!versionColumns.allowNetwork) {
    await queryInterface.addColumn("market_app_versions", "allowNetwork", {
      type: DataTypes.TEXT,
      allowNull: true,
    });
  }
  const apps = await MarketApp.findAll({ where: { fileKey: { [Op.ne]: null } } });
  for (const app of apps) {
    await MarketAppVersion.findOrCreate({
      where: { appId: app.id, version: app.version },
      defaults: {
        appId: app.id,
        version: app.version,
        fileKey: app.fileKey,
        fileUrl: app.fileUrl || `${process.env.R2_PUBLIC_URL || "https://files.020201.xyz"}/${app.fileKey}`,
        size: app.size,
        releaseNotes: app.releaseNotes || "",
        allowNetwork: app.allowNetwork || "[]",
        publishedBy: app.uploadedBy,
        status: "active",
      },
    });
  }
}

async function ensureIncrementalSchema() {
  await ensureMarketReleaseNotesColumn();
  await Promise.all([
    AppComment.sync({ alter: true }),
    UserWorkspace.sync(),
    WorkspaceTemplate.sync(),
    UserSession.sync(),
    MarketAppVersion.sync(),
  ]);
  await ensureMarketVersions();
}

let schemaReady = Promise.resolve();
if (process.env.VERCEL) schemaReady = ensureIncrementalSchema();

app.use(async (req, res, next) => {
  try {
    await schemaReady;
    next();
  } catch (error) {
    next(error);
  }
});

app.use(cors());
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
});
app.use(compression());
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

// 音乐收藏分组路由（需登录）
const musicFavoritesRouter = require("./routes/musicFavorites");
app.use("/api/music-favorites", musicFavoritesRouter);

const workspaceTemplatesRouter = require("./routes/workspaceTemplates");
app.use("/api/workspace-templates", workspaceTemplatesRouter);

// 同步数据库模型（Vercel 环境跳过 sync 以加速冷启动）
if (!process.env.VERCEL) {
  sequelize
    .sync()
    .then(() =>
      ensureMarketReleaseNotesColumn().catch((err) =>
        console.warn("MarketApp releaseNotes 列同步跳过:", err.message),
      ),
    )
    .then(() => ensureMarketVersions())
    .then(() => WorkspaceTemplate.sync())
    .then(() => UserSession.sync())
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
  // Vercel：跳过整体 sync 以加速冷启动，但显式确保新增的 app_comments 表存在
  // （向前兼容，非迁移脚本；本地非 VERCEL 环境由上面的 sequelize.sync() 统一建表）
  schemaReady
    .then(() => console.log("增量数据表已就绪"))
    .catch((err) => console.warn("增量数据表同步跳过:", err.message));
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
