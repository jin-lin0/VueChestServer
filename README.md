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
middleware/   认证 / 超级管理员 / 访问日志 / 响应压缩 / 请求限流
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
| `RESEND_KEY`           | Resend API Key（验证码 / 日报）  |                            |
| `RESEND_FROM`          | 发件人整串（优先于 DOMAIN）      | `VueChest <noreply@x.com>` |
| `RESEND_DOMAIN`        | 发件人域名（未配 FROM 时使用）   | `example.com`              |
| `CRON_SECRET`          | Vercel Cron 鉴权密钥             | 随机长串                   |
| `STOCK_DIGEST_TO`      | 策略日报收件人（逗号分隔）       | `a@x.com,b@y.com`          |
| `STOCK_DIGEST_STRATEGIES` | 可选，覆盖默认策略 id         | `macd_golden,ma_long`      |

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
| `/api/netease`              | `routes/netease.js`                                           | 网易云音乐 API（游客可用，按 IP 限流）     |
| `/api/bilibili`             | `routes/bilibili.js`                                          | B 站字幕提取（WBI 签名，服务端代理）       |
| `/api/music-favorites`      | `routes/musicFavorites.js`                                    | 音乐收藏分组（需登录）                     |
| `/api/uploads`              | `routes/uploads.js`                                           | R2 预签名直传（头像 / 应用包 / 截图）      |
| `/api/workspace-templates`  | `routes/workspaceTemplates.js`                                | 工作区模板                                 |
| `/api/research-stocks`      | `routes/stockResearch.js`                                     | 腾讯 A 股大盘、估值摘要与前复权 K 线（游客可用，按 IP 限流） |
| `/api/westock`              | `routes/westock.js`                                           | westock CLI 封装：K 线 / 行情 / 选股 / 策略 |
| `/api/stats`                | `routes/stats.js`                                             | 访问与业务统计（仪表盘）                   |
| `/health`                   | `index.js`                                                    | 健康检查（顺带归档访问日志）               |

股票数据接口只接受带市场前缀的标的身份（例如 `sh000001` 与 `sz000001`），不推断六位代码的市场，也不保留独立摘要接口。

- `GET /api/research-stocks/quotes?symbols=sh600000,sz000001`：最多 100 个标的，批量返回数字或 `null`；成交量为股，成交额和市值为元，保留腾讯行情时间。
- `GET /api/research-stocks/search?q=关键词`：返回沪深股票、指数与交易所基金，保留市场和类型，过滤债券等不支持的标的。
- `GET /api/research-stocks/:symbol/kline`：返回标的、周期、复权方式和必填的已确认收盘日期。股票、基金为 `qfq`，指数为 `none`；收盘时重新取数，上游尚未确认收盘时缩短缓存并保留此前确认日期，缺少或无效的上游行情时间会被拒绝。

腾讯专用复权接口的响应可使用 `qfqday/qfqweek/qfqmonth` 或 `day/week/month` 字段；解析优先使用复权字段，字段存在但损坏时不会改读另一组数据。K 线有效空数据返回 `404 / NO_DATA`，上游响应或格式异常返回 `502 / UPSTREAM_ERROR`，上游超时返回 `504 / UPSTREAM_TIMEOUT`。

## 滥用防护

计数存于进程内存；多实例各自计数，跨实例共享额度需另行实现。限流依据转发头最右一跳，部署时需要可信边缘覆盖该位置；可绕过边缘直连源站的环境不能依赖此规则识别客户端。

| 接口 | 策略 |
| --- | --- |
| `/api/auth/login` | 同账号失败 5 次后指数退避，最长 15 分钟，成功清零；单 IP 60 次/10 分钟 |
| `/api/auth/send-code`、`/api/auth/forgot-password` | 单 IP 5 次/小时，另有邮箱冷却 |
| `/api/netease`、`/api/research-stocks` | 单 IP 600 次/30 分钟，保留游客访问 |

音乐和行情代理缓存可复用的只读结果，并合并相同参数的并发请求。超出请求额度返回 `429` 和 `Retry-After`。

## 策略选股日报

`vercel.json` 配置了每工作日北京时间 08:30（`30 0 * * 1-5` UTC）触发的 Cron，
调用 `GET /api/stock-digest/run`，流程见 `services/stockDigest.js`：

1. **采集**：先用上证指数行情确定「最近收盘交易日」D，再用 `strategy <id> --date D`
   跑各策略（默认 7 个热门策略），结果按 `(strategyId, signalDate)` 幂等写入
   `stock_strategy_signals`。
2. **评估**：早盘行情 `asOf` 仍停在上一个收盘日，因此用一次批量行情即可回看
   历史信号的「次日涨跌」，统计正确率并标记 `evaluated`。节假日无新数据时保持待评估。
3. **推送**：邮件含「昨日 / 近3日 / 近7日 / 近15日 / 累计」正确率排名表，以及按累计
   正确率排序的今日候选股。

**鉴权**：Vercel 配置 `CRON_SECRET` 后会自动给 cron 请求带上
`Authorization: Bearer $CRON_SECRET`，接口用常量时间比较校验；未配置时一律 401。
手动补发：

```bash
curl -X POST https://<domain>/api/stock-digest/run -H "Authorization: Bearer $CRON_SECRET"
```

**可观测性**：每次执行（含邮件失败）写入 `cron_runs`，失败时向 `STOCK_DIGEST_TO`
发告警邮件。登录用户可读 `GET /api/stock-digest/history?days=30`（战绩数据），
管理员可读 `GET /api/stock-digest/runs`（最近执行记录）。

**超时保护**：生产区域访问国内上游明显慢于本地，因此设置了整体预算（默认 40s）：
预算耗尽会跳过剩余策略并照常发邮件，避免整单 504。当前 `maxDuration` 为 300s
（Fluid Compute），日报预算仍按实际耗时保守保留。
可用 `STOCK_DIGEST_BUDGET_MS`（整体）、`STOCK_DIGEST_EVAL_BUDGET_MS`（评估）、
`STOCK_DIGEST_STRATEGY_TIMEOUT_MS`（单个策略）调整。执行日志会打印各阶段耗时
（`[stock-digest] 采集完成 +10447ms`），可在 Vercel Functions → Logs 查看。

> 若线上仍偶尔超时，优先把 **Functions Region** 调到 `hkg1`（香港）：本项目大部分
> 上游（腾讯行情、westock、网易云、B 站）都在国内，从美东默认区域访问延迟很高。

> Hobby 计划的 cron 每天只触发一次，且实际时间在指定小时的窗口内浮动；
> 因此「盘中提醒」类需求不适用。日报在开盘前运行，正好对应前一交易日收盘数据。

> ⚠️ **Hobby 计划必须开启 Fluid Compute**（Settings → Functions → Fluid Compute），
> 否则函数最长只能运行 **10 秒**，`vercel.json` 的 `maxDuration: 300` 会被夹到 10s，
> 日报会在第 10 秒被 Vercel 杀掉并返回 504（`FUNCTION_INVOCATION_TIMEOUT`）。
> 开启后 Hobby 默认可运行 300s。

## 每日签到

定时触发与机器写入入口使用 Cron 密钥，与 VueChest 登录和管理员角色无关。所有 Cron 入口均验证 `Authorization: Bearer <CRON_SECRET>`；缺失或错误返回 401。超管后台入口使用独立的登录态与角色校验，见下一节。

| 接口 | 用途 |
| --- | --- |
| `GET /api/checkins/run` | Vercel 每日触发 |
| `POST /api/checkins/run` | 手动补跑 |
| `PUT /api/checkins/credentials/:task` | 机器写入凭据，只写不读；body 需带 `ownerId` |

部署前确保 `checkin_states` 和 `cron_runs` 已存在；表结构由模型定义，`pnpm schema:check` 可检查结构差异。Vercel 运行时不会自动建表。全新环境直接启动一次服务即可建表；本项目不保留旧结构兼容，旧库升级直接删除 `checkin_states` 重建并重新录入凭据。

复用 `CRON_SECRET`，另配置 `CHECKIN_ENCRYPTION_KEY`（32 字节密钥，编码为 64 个十六进制字符，无默认值）。所有站点凭据统一加密存库，不按站点新增环境变量。时间预算可用 `CHECKIN_BUDGET_MS`（整轮，默认 240000）和 `CHECKIN_TASK_TIMEOUT_MS`（单任务，默认 60000）覆盖。密钥生成命令：

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

通过 HTTPS 向 `PUT /api/checkins/credentials/workbuddy-cn` 提交凭据（`ownerId` 为归属超管）：

```json
{
  "ownerId": 1,
  "accessToken": "本人 Access Token",
  "refreshToken": "对应的 Refresh Token"
}
```

也可以在环境变量 `CHECKIN_OWNER_ID` 中指定默认归属，省去每次传 `ownerId`。录入不执行签到，也不返回凭据；录入后调用 POST 执行入口验证。刷新后的令牌自动加密写回，重新登录后仍通过同一 PUT 接口替换。任务执行中拒绝覆盖（409）。加密密钥丢失或更换后，需要迁移密文或重新录入凭据。

### 凭据从哪来

WorkBuddy 的 AT/RT 只能用短信验证码登录换取，因此登录流程也放在本仓库，不依赖外部项目：

```bash
cd VueChestServer
pnpm checkin                              # 方向键选站点，回车后走该站点登录
pnpm checkin workbuddy-cn                 # 直接指定站点
pnpm checkin workbuddy-cn --dry-run       # 只打印凭据，不改数据库
```

不写站点时进入交互式选择（↑/↓ 移动、回车确认），避免记站点 ID、也避免把凭据写到错误任务上。

选定站点后，脚本按该站点的登录方式取凭据：WorkBuddy 是发短信 → 输入验证码 → 换到 AT/RT，再调用一次续期接口验证可用性。**续期会轮换令牌**，所以脚本默认保存轮换后的新值，并直接走 `configure()` 加密入库，无需再手工调 PUT 接口。

参数分两层：通用入口只认 `--owner <超管ID>`（默认取唯一启用的 super_admin，多个时必须显式指定）和 `--dry-run`；`--phone` / `--code` / `--no-verify` 是 `workbuddy-cn` 自己的站点参数——各站点登录方式不同（短信、Cookie、账密……），所以由站点脚本解析。`pnpm checkin --help` 看站点清单，`pnpm checkin workbuddy-cn --help` 看该站点参数。新增站点时在 `scripts/checkin-credentials/` 下加一份登录脚本、注册进 `index.js` 的 `providers`，交互列表会自动带出该站点。

计划每天 UTC 01:17（北京时间 09:17）运行，Hobby 可能延迟。最多并发两个账号任务，总预算默认 240 秒、单任务 60 秒，可用 `CHECKIN_BUDGET_MS` 和 `CHECKIN_TASK_TIMEOUT_MS` 调整；两者都要小于部署后的函数时长。多超管各自配置后，预算要覆盖全部「超管 × 站点」账号，站点或超管增加时需同步评估。数据库租约协调跨实例并发，同一归属账号在业务日期完成后跳过，失败可补跑。

结果在 `results` 中，并带 `ownerId` 区分归属：`success` / `already_done` 表示上游确认已签；`unconfigured` 表示未录入；`inactive` 表示活动未开放；`failed` / `deferred` 表示失败或预算不足。部分失败时返回 502，其他任务继续执行；Vercel 不会自动重试失败的 Cron。脱敏执行摘要存入 `cron_runs`。

当前只接入 WorkBuddy 国内版签到，不包含活跃模拟、对话或其他成长任务。新增站点时实现凭据校验与签到适配器，并加入任务清单，无需用户管理模块。

### 超管后台

超级管理员可在 `/admin/checkins` 页面完成日常运维，不必再手动 `curl`：

- 查看每个签到站点的配置状态、今日完成情况、最近执行结果与失败摘要。
- 按适配器声明的 `credentialFields` 动态渲染凭据表单，保存后立即生效。
- 对单个任务立即执行；今日已完成时可显式忽略当日幂等重新复核上游，但租约仍然生效，不会与定时任务并发重复执行。
- 清除凭据等同于停用该任务，后续轮次以 `unconfigured` 跳过；任务执行中拒绝清除（409）。
- 查看执行日志与配置操作审计，支持按站点、结果和时间分页。
- 所有状态、日志和审计都按当前登录超管隔离，多个超管各自管理自己的凭据与执行结果。

| 接口 | 权限 | 用途 |
| --- | --- | --- |
| `GET /api/checkins/admin/tasks` | `super_admin` | 任务状态与凭据字段元数据 |
| `PUT /api/checkins/admin/credentials/:task` | `super_admin` | 保存或替换凭据 |
| `DELETE /api/checkins/admin/credentials/:task` | `super_admin` | 清除凭据（停用任务） |
| `POST /api/checkins/admin/tasks/:task/run` | `super_admin` | 单任务立即执行，body 可传 `{"force":true}` |
| `GET /api/checkins/admin/logs` | `super_admin` | 执行日志，支持 `task`、`success`、`limit`、`offset` |
| `GET /api/checkins/admin/audits` | `super_admin` | 配置操作审计，支持 `task`、`limit`、`offset` |

凭据始终只写不读：接口响应、日志和页面都不会回显 Access Token、Refresh Token 或 Cookie。数据库中也只保存 AES-256-GCM 密文，不提供明文录入或“是否加密”开关。若确实需要直接在数据库录入，必须自行按既有格式生成密文；否则请在后台页面或使用 `PUT /api/checkins/credentials/:task` 写入。

审计与执行记录复用 `cron_runs`，按 `job` 前缀区分：执行记录为 `checkin:<task>`，配置操作为 `checkin-config:<task>`，两种记录都带 `ownerId`。日志查询会同时按归属用户过滤并显式排除配置审计，避免跨超管读取或混入签到结果。

### 签到数据归属

`checkin_states` 以「超管 + 站点」为最小单位：

- `ownerId` 指向 `users.id`，`taskId` 是适配器标识；`id` 为 `${ownerId}:${taskId}`。
- 唯一索引为 `(ownerId, taskId)`，同一超管对同一站点只有一行，不同超管互不覆盖。
- 凭据密文使用 AES-256-GCM，AAD 绑定 `id + taskId`；不保留旧单租户密文兼容。

> ⚠️ 本项目不做向后兼容。表结构或密文格式变化时，直接清空 `checkin_states`
> 后由超管在后台重新录入凭据，不增加兼容分支。

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

<details>
<summary>第三方参考与许可</summary>

WorkBuddy 国内版签到适配参考了 [L0NE-6/WorkBuddy-Daily](https://github.com/L0NE-6/WorkBuddy-Daily) 的接口流程，使用 Node.js 重新实现。

MIT License

Copyright (c) 2026 L0NE-6

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

</details>
