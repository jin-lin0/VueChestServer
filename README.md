# VueChest Server

Express + Sequelize + MySQL 后端服务，为 VueChest 提供 API 支持。

## 技术栈

- **Runtime**: Node.js
- **框架**: Express
- **ORM**: Sequelize (MySQL2)
- **数据库**: MySQL
- **认证**: JWT (jsonwebtoken) + bcryptjs

## 目录结构

```
config/       数据库与 AI 平台配置
middleware/   认证 / 超级管理员 / 访问日志 / 响应压缩
models/       Sequelize 数据模型
routes/       API 路由
services/     业务服务（AI 中转、B 站解析、市场版本等）
scripts/      工具脚本（初始化管理员、结构漂移检查、重置市场数据等）
utils/        工具函数（R2、邮件、SSE、校验等）
test/         测试
index.js      入口文件
```

## 快速开始

### 1. 安装依赖

```bash
pnpm install
```

### 2. 配置环境变量

复制 `.env` 文件（已有默认值，部署时按需修改）：

| 变量                   | 说明                             | 示例                       |
| ---------------------- | -------------------------------- | -------------------------- |
| `DB_HOST`              | 数据库地址                       | `mysql.sqlpub.com`         |
| `DB_PORT`              | 数据库端口                       | `3306`                     |
| `DB_NAME`              | 数据库名                         | `aichatmsg`                |
| `DB_USER`              | 数据库用户                       | `logyes`                   |
| `DB_PASSWORD`          | 数据库密码                       |                            |
| `JWT_SECRET`           | JWT 签名密钥                     |                            |
| `R2_ACCOUNT_ID`        | Cloudflare Account ID            |                            |
| `R2_ACCESS_KEY_ID`     | R2 API Token Access Key          |                            |
| `R2_SECRET_ACCESS_KEY` | R2 API Token Secret              |                            |
| `R2_BUCKET_NAME`       | R2 存储桶名称                    | `vuechest`                 |
| `R2_PUBLIC_URL`        | R2 自定义域                      | `https://files.020201.xyz` |

### 3. 启动服务

```bash
# 开发（热重载）
pnpm run dev

# 生产
pnpm start
```

默认监听 `http://localhost:3000`。

验证码当前使用进程内存储，不需要 Redis，适合单实例部署。多实例或 Serverless 部署时，验证码可能跨实例失效，后续再考虑改为 Redis 或数据库存储。

### R2 文件存储

头像和应用包通过预签名 URL 直传 Cloudflare R2，数据库只保存对象 Key 和 URL。R2 桶需要允许 `https://app.020201.xyz` 的 `PUT`、`GET`、`HEAD` 请求，并允许 `Content-Type` 与 `x-amz-meta-sha256` 请求头。应用包直传时会把 SHA-256 写入对象元数据；创建版本和浏览器安装都会核对该值。预签名上传地址使用 S3 Endpoint，文件读取使用 `https://files.020201.xyz`。

## 站内通知

### 事件来源

站内通知由业务动作触发，全部经 `services/notificationService.js#createNotification` 落库：

| 事件                | type                        | 收件人                 | 点击跳转      |
| ------------------- | --------------------------- | ---------------------- | ------------- |
| 应用 / 版本审核通过 | `market.review.approved`    | 应用作者               | `/developer`  |
| 应用 / 版本被驳回   | `market.review.rejected`    | 应用作者               | `/developer`  |
| 评论被回复          | `market.comment.reply`      | 被回复的评论作者       | `/market/:id` |
| 应用收到新评论      | `market.comment.created`    | 应用作者               | `/market/:id` |
| 应用被举报          | `market.report.created`     | 应用作者               | `/market/:id` |
| 举报处理完成 / 驳回 | `market.report.resolved`    | 举报人                 | `/market/:id` |

两条硬规则：

1. **自己触发的事件不发给自己**（作者给自己应用评论、管理员举报自己的应用都不会产生通知）。
2. **通知是旁路逻辑**。所有调用点都写成 `await safeNotify(notifyXxx(...))`，
   通知写库失败只会打一条 warn 日志，绝不会让审核 / 评论 / 举报这些主流程失败。

文案与收件人判定被抽成纯函数（`services/marketNotifications.js` 的 `buildXxx`），
因此「发给谁、发什么」可以脱离数据库直接单测。

> 通知只做**站内投递**，不涉及浏览器系统级推送：这需要注册 Service Worker，
> 而本站不使用 Service Worker（前端 `main.ts` 启动时反而会注销所有历史注册）。
> 未读数靠前端 60 秒轮询 `GET /api/notifications/unread-count` 获取。

### 数据看板

`GET /api/developer/analytics?days=90` 汇总开发者本人应用的数据。
下载量直接复用 `visit_logs` 里 `/api/market/apps/:id/download` 的路径分桶，
**不额外建表**，因此历史数据开箱即用。

聚合逻辑（日期轴生成、路径解析、评分分布、平均审核耗时）都在
`services/developerAnalytics.js` 里以纯函数实现，路由只做取数与拼装。

## API 端点

| 前缀                        | 路由文件                                                      | 说明                                       |
| --------------------------- | ------------------------------------------------------------- | ------------------------------------------ |
| `/api/auth`                 | `routes/auth.js`                                              | 登录、注册、用户信息、应用与选择性数据同步 |
| `/api/users`                | `routes/users.js`                                             | 用户管理（仅 super_admin）                 |
| `/api/market`               | `routes/market.js`、`routes/comments.js`、`routes/reports.js` | 应用市场、评论评分、举报审核与版本完整性   |
| `/api/developer`            | `routes/developer.js`                                         | 开发者中心（本人应用与版本管理、数据看板） |
| `/api/notifications`        | `routes/notifications.js`                                     | 站内通知中心（无推送订阅）                 |
| `/api/questions`            | `routes/questions.js`                                         | 面试题库                                   |
| `/api/ai-chat`              | `routes/aiChat.js`                                            | AI 对话（SSE 流式）与会话管理              |
| `/api/app-data`             | `routes/appData.js`                                           | 市场应用云端 KV（按 userId + appId 隔离）  |
| `/api/app-ai`               | `routes/appAi.js`                                             | 市场应用受控 AI 代理（需应用声明 ai 权限） |
| `/api/netease`              | `routes/netease.js`                                           | 网易云音乐 API                             |
| `/api/bilibili`             | `routes/bilibili.js`                                          | B 站字幕提取（WBI 签名，服务端代理）       |
| `/api/music-favorites`      | `routes/musicFavorites.js`                                    | 音乐收藏分组（需登录）                     |
| `/api/uploads`              | `routes/uploads.js`                                           | R2 预签名直传（头像 / 应用包 / 截图）      |
| `/api/workspace-templates`  | `routes/workspaceTemplates.js`                                | 工作区模板                                 |
| `/api/research-stocks`      | `routes/stockResearch.js`                                     | A 股大盘、估值、财务与公司公告             |
| `/api/westock`              | `routes/westock.js`                                           | westock CLI 封装：K 线 / 行情 / 选股 / 策略 |
| `/api/stats`                | `routes/stats.js`                                             | 访问与业务统计（仪表盘）                   |
| `/health`                   | `index.js`                                                    | 健康检查（顺带归档访问日志）               |

## 部署到 Vercel

项目已配置 `vercel.json`，直接关联 GitHub 仓库即可部署。

**注意事项：**

### 1. 环境变量

在 Vercel 项目设置中配置上述环境变量，**不要在代码中硬编码**。

### 2. 数据库表结构

数据库结构由 `sequelize.sync()` 在启动时维护：它按模型定义执行
`CREATE TABLE IF NOT EXISTS`，让模型里声明过的表存在（含模型 `indexes` 里声明的索引）。
新环境用空数据库启动一次服务即可，一步建齐。

> ⚠️ **`sync()` 从不 ALTER 已存在的表。** 给已有模型新增字段后它什么都不会做，
> 生产库上会以 `Unknown column 'xxx'` 报 500。这类变更必须手动执行一次 DDL。

**不用靠记忆判断该改什么**，跑一次结构漂移检查即可：

```bash
pnpm schema:check   # 只读，列出「模型有、库里没有」的列和索引，并生成 ALTER 语句
```

它会打印可直接复制执行的 SQL，例如：

```sql
ALTER TABLE `market_apps` ADD COLUMN `permissions` TEXT NULL;
ALTER TABLE `market_app_versions` ADD COLUMN `permissions` TEXT NULL;
```

无漂移时退出码为 0，有漂移为 1，因此也可以接进 CI 当护栏（需要 CI 能连上目标库）。

**Vercel 部署注意**：请求链路里不执行 schema sync（`if (!process.env.VERCEL)`），
多实例冷启动同时抢连接会阻塞全部业务请求。因此线上库的结构变更要在部署前手动完成。

### 3. 冷启动

Vercel Serverless 函数在闲置一段时间后会冷启动，首次请求可能需要 2-5 秒（主要是建立 MySQL 连接）。后续请求恢复正常速度。

## 本地开发

```bash
# 热重载
pnpm run dev
```

进程使用 `nodemon` 监听文件变更，修改代码后自动重启。
