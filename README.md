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
config/       数据库配置
middleware/   认证中间件
models/       Sequelize 数据模型
routes/       API 路由
scripts/      工具脚本（数据迁移等）
utils/        工具函数
validators/   请求校验
index.js      入口文件
```

## 快速开始

### 1. 安装依赖

```bash
pnpm install
```

### 2. 配置环境变量

复制 `.env` 文件（已有默认值，部署时按需修改）：

| 变量                   | 说明                    | 示例                       |
| ---------------------- | ----------------------- | -------------------------- |
| `DB_HOST`              | 数据库地址              | `mysql.sqlpub.com`         |
| `DB_PORT`              | 数据库端口              | `3306`                     |
| `DB_NAME`              | 数据库名                | `aichatmsg`                |
| `DB_USER`              | 数据库用户              | `logyes`                   |
| `DB_PASSWORD`          | 数据库密码              |                            |
| `JWT_SECRET`           | JWT 签名密钥            |                            |
| `R2_ACCOUNT_ID`        | Cloudflare Account ID   |                            |
| `R2_ACCESS_KEY_ID`     | R2 API Token Access Key |                            |
| `R2_SECRET_ACCESS_KEY` | R2 API Token Secret     |                            |
| `R2_BUCKET_NAME`       | R2 存储桶名称           | `vuechest`                 |
| `R2_PUBLIC_URL`        | R2 自定义域             | `https://files.020201.xyz` |

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

## API 端点

| 前缀                   | 路由文件                                                      | 说明                                     |
| ---------------------- | ------------------------------------------------------------- | ---------------------------------------- |
| `/api/auth`            | `routes/auth.js`                                              | 登录、注册、用户信息、应用同步           |
| `/api/users`           | `routes/users.js`                                             | 用户管理（仅 super_admin）               |
| `/api/market`          | `routes/market.js`、`routes/comments.js`、`routes/reports.js` | 应用市场、评论评分、举报审核与版本完整性 |
| `/api/questions`       | `routes/questions.js`                                         | 面试题库                                 |
| `/api/messages`        | `routes/messages.js`                                          | 消息/AI 聊天                             |
| `/api/netease`         | `routes/netease.js`                                           | 网易云音乐 API                           |
| `/api/research-stocks` | `routes/stockResearch.js`                                     | A 股大盘、估值、财务与公司公告           |
| `/health`              | index.js                                                      | 健康检查                                 |

## 部署到 Vercel

项目已配置 `vercel.json`，直接关联 GitHub 仓库即可部署。

**注意事项：**

### 1. 环境变量

在 Vercel 项目设置中配置上述环境变量，**不要在代码中硬编码**。

### 2. 数据库表结构同步

Vercel 每次冷启动时会 **跳过** `sequelize.sync()`，以加速冷启动（约节省 3-5 秒）。

内测阶段以 Sequelize 模型为数据库结构真源。新环境使用空数据库在本地启动一次服务，由 `sequelize.sync()` 创建完整表结构：

```bash
pnpm start
```

现阶段模型发生不兼容变更时直接重建内测数据库，不维护旧结构兼容代码。正式上线前再引入版本化迁移体系。

### 3. 冷启动

Vercel Serverless 函数在闲置一段时间后会冷启动，首次请求可能需要 2-5 秒（主要是建立 MySQL 连接）。后续请求恢复正常速度。

## 本地开发

```bash
# 热重载
pnpm run dev
```

进程使用 `nodemon` 监听文件变更，修改代码后自动重启。
