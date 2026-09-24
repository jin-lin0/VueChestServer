const { spawn } = require("node:child_process");
const path = require("node:path");
const { createLimiter, positiveInt } = require("./limiter");

// westock 两个混淆 CLI（含硬编码 token + 混淆 X-Signature），直接 spawn 复用其取数能力。
// 不尝试复刻签名（算法在混淆层内，非 node:crypto / Web Crypto），而是原样运行官方 CLI。
//
// 必须保留 .mjs 后缀：Vercel 的 @vercel/node 构建器会遍历函数内被 nft 追踪到的文件，
// 把「非 .ts/.mts/.mjs」的 ESM 源文件用 babel 编译成 CommonJS；本项目根 package.json 无
// "type": "module"（后端整体是 CJS，不能加），所以这两个 CLI 会被转译成 require() 形式，
// 而它们内部含顶层 await —— 转译后两者并存，Node 直接抛 ERR_AMBIGUOUS_MODULE_SYNTAX。
// 引用 builder 源码：esmPaths 的过滤条件显式排除了 .mjs，因此 .mjs 不会被转译。
const ENGINE_FILES = {
  data: path.join(__dirname, "westock-data.mjs"),
  screen: path.join(__dirname, "westock-tool.mjs"),
};

const DEFAULT_TIMEOUT_MS = positiveInt(process.env.WESTOCK_TIMEOUT_MS, 20000);
const KILL_GRACE_MS = 2000;
// 上限按 UTF-16 字符数计（String.length），对中文表体而言足够接近字节数，
// 目的是兜住内存，不追求精确的字节计量。
const MAX_STDOUT_CHARS = 6 * 1024 * 1024;
const MAX_STDERR_CHARS = 64 * 1024;
const MAX_ERROR_CHARS = 500;

// 交给第三方混淆 CLI 的环境变量白名单。子进程只需要网络与基础运行时变量，
// 绝不能把 JWT_SECRET / 数据库口令等服务端机密透传到混淆代码里。
// 如果 CLI 升级后需要新的环境变量，在这里显式补，而不是整个 process.env 透传。
const CHILD_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "TZ",
  "NODE_OPTIONS",
  "NODE_EXTRA_CA_CERTS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
];

function buildChildEnv() {
  const env = { NODE_NO_WARNINGS: "1" };
  for (const key of CHILD_ENV_ALLOWLIST) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  // 便于运维按需微调 westock 自身的行为，但不放行任意变量名。
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("WESTOCK_")) env[key] = value;
  }
  return env;
}

const limiter = createLimiter({
  max: positiveInt(process.env.WESTOCK_MAX_CONCURRENT, 4),
  maxQueue: positiveInt(process.env.WESTOCK_MAX_QUEUE, 16),
  waitMs: DEFAULT_TIMEOUT_MS,
});

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400, code: "VALIDATION" });
}

// 顶层子命令白名单，来源为两个 CLI 的 `--help`。
// CLI 升级新增命令时这里要同步补，否则新命令会被拒绝 —— 这是有意为之：
// 参数从 HTTP 直通到进程，宁可漏放也不能默认放行。
const KNOWN_COMMANDS = new Set([
  // westock-data
  "bond", "buyback", "calendar", "changedist", "chip", "connect", "consensus",
  "dehydrated", "disclosure", "dividend", "etf", "events", "finance", "forex",
  "fund", "futures", "hot", "index", "ipo", "kline", "lhb", "macro", "market",
  "minute", "notice", "profile", "quote", "rating", "report", "risk", "score",
  "search", "sector", "shareholder", "stocklist", "suspension", "technical",
  // westock-tool
  "event", "filter", "label", "ranking", "strategy",
]);

// 长参数白名单，来源同上。
// ranking 的 `--min-<字段>` 是动态字段名（help 里写作 `--min-<字段>`），
// 一并放行 `--max-<字段>` 以备上游扩展，两者都用正则校验，不做无脑放行。
const KNOWN_FLAGS = new Set([
  "--all", "--asc", "--asset", "--date", "--days", "--desc", "--end", "--event",
  "--exchange", "--fq", "--group", "--limit", "--list", "--list-presets",
  "--market", "--num", "--offset", "--orderby", "--period", "--preset", "--raw",
  "--schedule", "--scope", "--sort", "--start", "--terms", "--type", "--types",
  "--universe", "--within-event", "--within-label", "--within-strategy",
  "--year", "--years",
]);

// 字段名可能含数字与下划线，例如 --min-cap_main_5d。
const DYNAMIC_FLAG = /^--(min|max)-[a-z0-9_]+$/i;
const NEGATIVE_NUMBER = /^-\d/;
// 拒绝路径分隔符、家目录符号与控制字符：参数最终作为 argv 交给子进程，
// 不允许出现任何形式的文件路径。
const UNSAFE_VALUE = /[/\\~\u0000-\u001f\u007f]/;
const MAX_ARGS = 40;
const MAX_ARG_LENGTH = 200;

function assertSafeArgs(args) {
  if (!Array.isArray(args) || args.length === 0) {
    throw badRequest("args 不能为空");
  }
  if (args.length > MAX_ARGS) {
    throw badRequest(`参数过多（上限 ${MAX_ARGS}）`);
  }

  // 先把所有元素规范成字符串，后续校验与最终 spawn 都用这一份，
  // 避免「校验的是 A、执行的是 B」。
  const normalized = args.map((arg) => (arg === undefined || arg === null ? "" : String(arg)));

  const command = normalized[0].trim();
  // 命令取自白名单，白名单内全是 [a-z]+，因此这一步同时也校验了 args[0] 的合法性。
  if (!KNOWN_COMMANDS.has(command)) {
    throw badRequest(`未知命令：${command || "(空)"}`);
  }

  for (const arg of normalized.slice(1)) {
    if (arg.length > MAX_ARG_LENGTH) {
      throw badRequest(`单个参数过长（上限 ${MAX_ARG_LENGTH}）`);
    }
    if (UNSAFE_VALUE.test(arg) || arg === "." || arg === "..") {
      throw badRequest(`参数含非法字符：${arg.slice(0, 40)}`);
    }
    if (arg.startsWith("--")) {
      const name = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
      if (!KNOWN_FLAGS.has(name) && !DYNAMIC_FLAG.test(name)) {
        throw badRequest(`不支持的参数：${name}`);
      }
    } else if (arg.startsWith("-") && !NEGATIVE_NUMBER.test(arg)) {
      throw badRequest(`不支持的参数：${arg}`);
    }
  }

  return [command, ...normalized.slice(1)];
}

function looksLikeError(stdout) {
  // CLI 的参数错误会走 stderr + 非零退出码，这里的正则针对的是「退出码 0 但正文其实是失败」
  // 的情况，因此同时覆盖参数错误文案，作为兜底。
  return /执行失败|操作被中止|未知参数|不支持此参数|This operation was aborted|fetch failed|网络异常|请求超时|超时|未找到[^。]*数据|暂无[^。]*数据|no data|data not found/i.test(
    stdout,
  );
}

function describeFailure(exitCode, stderr, stdout) {
  const detail = (stderr.trim() || stdout.trim()).replace(/\s+/g, " ");
  if (!detail) return `westock CLI 执行失败（exitCode=${exitCode}）`;
  return detail.slice(0, MAX_ERROR_CHARS);
}

function splitRow(line) {
  const inner = line.replace(/^\|/, "").replace(/\|$/, "");
  return inner.split("|").map((cell) => cell.trim());
}

function isSeparator(cells) {
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell));
}

// 将 westock 表格类命令的 Markdown 输出解析为结构化数据。
// 形如：
//   **标题** (日期) - 共 N 只 | 显示 a-b/N
//   | col1 | col2 |
//   | --- | --- |
//   | v1 | v2 |
function parseMarkdownTable(text) {
  const lines = text.split("\n").map((line) => line.trim());
  const titleMatch = text.match(/\*\*(.+?)\*\*/);
  const title = titleMatch ? titleMatch[1].trim() : "";
  const metaLine = lines.find((line) => line.includes("**"));
  let meta = "";
  if (metaLine) {
    meta = metaLine.replace(/\*\*(.+?)\*\*/g, "$1").trim();
  }

  const tableLines = lines.filter((line) => line.startsWith("|"));
  if (tableLines.length < 2) return null;

  const header = splitRow(tableLines[0]);
  if (!header.length) return null;

  const rows = [];
  for (let i = 1; i < tableLines.length; i++) {
    const cells = splitRow(tableLines[i]);
    if (isSeparator(cells)) continue;
    if (cells.length < header.length) continue;
    const row = {};
    header.forEach((key, idx) => {
      row[key] = cells[idx] ?? "";
    });
    rows.push(row);
  }
  if (!rows.length) return null;
  return { kind: "table", title, meta, columns: header, rows };
}

function parseOutput(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return { kind: "text", text: "" };
  if (trimmed[0] === "{" || trimmed[0] === "[") {
    try {
      const data = JSON.parse(trimmed);
      return { kind: "json", data };
    } catch {
      /* 非严格 JSON，落到后续解析 */
    }
  }
  const table = parseMarkdownTable(trimmed);
  if (table) return table;
  return { kind: "text", text: trimmed };
}

function appendBounded(current, chunk, limit) {
  if (current.length >= limit) return current;
  return current + String(chunk).slice(0, limit - current.length);
}

/**
 * 运行 westock CLI。
 * @param {"data"|"screen"} engine
 * @param {string[]} args
 * @returns {Promise<object>} { success, exitCode, stdout, stderr, kind, error?, ... }
 */
async function runWestock(engine, args) {
  const tool = ENGINE_FILES[engine];
  if (!tool) {
    throw badRequest(`未知引擎：${engine}`);
  }
  const safeArgs = assertSafeArgs(args);

  await limiter.acquire();
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [tool, ...safeArgs], {
        cwd: __dirname,
        env: buildChildEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let timer = null;
      let killTimer = null;

      // 只清理尚未触发的定时器。超时分支里 killTimer 必须留着，
      // 否则 SIGKILL 兜底会被立刻取消，SIGTERM 被忽略时就留下僵尸进程。
      const clearPendingTimers = () => {
        if (timer) clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
      };

      timer = setTimeout(() => {
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
        // unref：兜底定时器不应该把函数实例的存活时间拖长。
        killTimer.unref?.();
        reject(Object.assign(new Error("Westock 执行超时"), { status: 504 }));
      }, DEFAULT_TIMEOUT_MS);

      child.stdout.on("data", (chunk) => {
        stdout = appendBounded(stdout, chunk, MAX_STDOUT_CHARS);
      });
      child.stderr.on("data", (chunk) => {
        stderr = appendBounded(stderr, chunk, MAX_STDERR_CHARS);
      });
      child.on("error", (error) => {
        clearPendingTimers();
        reject(error);
      });
      child.on("close", (exitCode) => {
        clearPendingTimers();
        const parsed = parseOutput(stdout);
        const success = exitCode === 0 && !looksLikeError(stdout);
        const result = { success, exitCode, stdout, stderr, ...parsed };
        if (!success) {
          // 失败详情主要在 stderr（CLI 的参数错误就走 stderr），
          // 透出一段摘要，前端才不会只显示「请求未成功」。
          result.error = describeFailure(exitCode, stderr, stdout);
        }
        resolve(result);
      });
    });
  } finally {
    limiter.release();
  }
}

module.exports = {
  runWestock,
  assertSafeArgs,
  parseOutput,
  describeFailure,
  buildChildEnv,
  ENGINE_FILES,
  KNOWN_COMMANDS,
  KNOWN_FLAGS,
  limiter,
};
