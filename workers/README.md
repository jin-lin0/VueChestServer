# 签到 worker

有些站点的接口要求浏览器签名参数（掘金的 `a_bogus` / `msToken`），服务端 `fetch` 只会
拿到 HTTP 200 + 空 body。这类任务标记为 `executor: "worker"`，由这里的 Playwright
进程执行，服务器只负责凭据与记录。

## 结构

```
workers/
  run.js              # 统一入口：node run.js <task>
  shared/
    api.js            # 取账号列表 / 取凭据 / 上报结果（CRON_SECRET 鉴权）
    runner.js         # 通用循环：按超管逐个执行、失败截图、上报、退出码
  juejin/
    flow.js           # 站点私有：Cookie 注入 + 签到 + 免费抽奖
```

**分工原则**：所有"怎么登录、点哪个按钮、读哪个字段"都在 `flow.js`；
`shared/` 里不允许出现任何站点名、域名或选择器。

## 本地运行

```bash
cd VueChestServer/workers
npm install
npx playwright install chromium

DAILY_SERVER=http://localhost:3000 CRON_SECRET=你的密钥 npm start
# 等价于 node run.js juejin
```

凭据不放在这里：worker 会用 `CRON_SECRET` 取「已配置该站点的超管列表」，再逐个取
加密库里的 Cookie。所以先在超管后台 `/admin/daily` 填好即可。

## 环境变量

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `DAILY_SERVER` | ✅ | 服务器地址，如 `https://xxx.vercel.app` |
| `CRON_SECRET` | ✅ | 与服务器一致的机器密钥 |
| `DAILY_OWNER_ID` | | 只跑单个超管时用；不填则跑全部已配置的超管 |
| `WORKER_DEBUG_DIR` | | 失败截图目录，默认 `debug` |
| `JUEJIN_USER_AGENT` | | 掘金专用，风控严格时替换 UA |

## 新增一个 worker 任务

以假想的 `example` 为例，三处改动：

1. **服务端适配器** `services/daily/example.js`

   ```js
   module.exports = {
     id: "example",
     name: "示例站点",
     description: "需要浏览器执行",
     timeZone: "Asia/Shanghai",
     executor: "worker",              // 关键：标记为 worker 任务
     credentialFields: [
       { key: "cookie", label: "Cookie", type: "textarea", required: true },
     ],
     validateCredentials(input) { /* 规范化 + 校验，返回存库对象 */ },
     async run() { throw new Error("该任务由 worker 执行"); },
   };
   ```

2. **注册任务**：`services/daily/index.js` 的 `tasks` 数组里加上它。
   服务器会自动跳过 `executor: "worker"` 的任务，后台也不再显示「立即执行」。

3. **站点流程** `workers/example/flow.js`

   ```js
   module.exports = {
     id: "example",
     contextOptions: (env) => ({ locale: "zh-CN", timezoneId: "Asia/Shanghai" }),
     async prepare(context, credentials) {
       await context.addCookies([/* 由 credentials.cookie 解析 */]);
     },
     async run(page, credentials, { log, capture }) {
       // 页面操作 + 接口回读；返回 { status, summary }
       // status 只能是 success / already_done / skipped / failed
     },
   };
   ```

然后在 `workers/package.json` 的 `start` 或 workflow 里用 `node run.js example` 跑。
凭据、日志、后台卡片、上报链路全部复用，不需要改 server 路由或数据库。
