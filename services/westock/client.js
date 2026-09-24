const { spawn } = require("node:child_process");
const path = require("node:path");

// westock 两个混淆 CLI（含硬编码 token + 混淆 X-Signature），直接 spawn 复用其取数能力。
// 不尝试复刻签名（算法在混淆层内，非 node:crypto / Web Crypto），而是原样运行官方 CLI。
const ENGINE_FILES = {
  data: path.join(__dirname, "westock-data.js"),
  screen: path.join(__dirname, "westock-tool.js"),
};

const DEFAULT_TIMEOUT_MS =
  Number.parseInt(process.env.WESTOCK_TIMEOUT_MS || "", 10) || 20000;
const MAX_STDOUT_BYTES = 6 * 1024 * 1024; // 6MB 上限保护

function looksLikeError(stdout) {
  return /执行失败|操作被中止|This operation was aborted|fetch failed|网络异常|请求超时|超时|未找到[^。]*数据|暂无[^。]*数据|no data|data not found/i.test(
    stdout,
  );
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

/**
 * 运行 westock CLI。
 * @param {"data"|"screen"} engine
 * @param {string[]} args
 * @returns {Promise<object>} { success, exitCode, stdout, stderr, kind, ... }
 */
function runWestock(engine, args) {
  return new Promise((resolve, reject) => {
    const tool = ENGINE_FILES[engine];
    if (!tool) {
      reject(Object.assign(new Error(`未知引擎：${engine}`), { status: 400 }));
      return;
    }
    if (!Array.isArray(args) || args.length === 0) {
      reject(Object.assign(new Error("args 不能为空"), { status: 400 }));
      return;
    }

    const child = spawn(process.execPath, [tool, ...args], {
      cwd: __dirname,
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(Object.assign(new Error("Westock 执行超时"), { status: 504 }));
    }, DEFAULT_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      if (stdout.length < MAX_STDOUT_BYTES) {
        stdout += String(chunk).slice(0, MAX_STDOUT_BYTES - stdout.length);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      const parsed = parseOutput(stdout);
      const success = exitCode === 0 && !looksLikeError(stdout);
      resolve({ success, exitCode, stdout, stderr, ...parsed });
    });
  });
}

module.exports = { runWestock, ENGINE_FILES };
