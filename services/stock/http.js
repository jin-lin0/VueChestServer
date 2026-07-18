"use strict";

// 通用 HTTP 封装：超时控制 + 必要请求头 + 代理支持 + 简易内存缓存 + 并发限制
const DEFAULT_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
  Referer: "https://quote.eastmoney.com/",
};

// —— 关键：fetch 与 dispatcher 必须来自同一份 undici ——
// Node 内置的全局 fetch 用的是「内部 undici」，而 npm 安装的 undici 是另一份，
// 两份的 Dispatcher 类型不互通。若把 npm undici 的 Agent/ProxyAgent 传给全局 fetch，
// 会在类型校验阶段直接抛 UND_ERR_INVALID_ARG（而非真实网络错误）。
// 因此这里统一从 npm undici 取出 fetch / Agent / ProxyAgent，保证类型一致。
let _undici = null;
try {
  _undici = require("undici");
} catch (e) {
  console.warn(
    "[stock/http] 未安装 undici，将退回 Node 内置 fetch（不支持代理/强制 IPv4）:",
    e.message,
  );
}
const realFetch = _undici && _undici.fetch ? _undici.fetch : fetch;

// —— 代理支持 ——
// Node 内置 fetch(undici) 不读取 HTTP(S)_PROXY 环境变量，也不读 macOS 系统代理；
// 用户本机直连行情站点会被重置(UND_ERR_SOCKET)，必须走本地 Clash 代理(127.0.0.1:7897)才通。
// 因此：优先取环境变量里的代理，没有则回退到 Clash 默认端口 7897；仍失败则直连兜底。
// 仅探测 7897（实测 7890/1087 在用户环境为 ECONNREFUSED，无需尝试）；正常情况静默，仅失败 warn。
let _proxyAgents = undefined;
function resolveProxyAgents() {
  if (_proxyAgents !== undefined) return _proxyAgents;
  _proxyAgents = [];
  if (!(_undici && _undici.ProxyAgent)) return _proxyAgents;

  const envProxy =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy;
  const candidates = [];
  if (envProxy) candidates.push(envProxy);
  candidates.push("http://127.0.0.1:7897"); // Clash 默认端口

  for (const url of [...new Set(candidates)]) {
    try {
      _proxyAgents.push(new _undici.ProxyAgent(url));
    } catch (e) {
      console.warn(`[stock/http] 代理 ${url} 初始化失败，跳过: ${e.message}`);
    }
  }
  return _proxyAgents;
}

// —— 直连强制 IPv4 ——
// Node 内置 fetch(undici) 默认可能优先 IPv6；部分网络下 IPv6 到行情站点不通/被重置，
// 表现为 UND_ERR_SOCKET。这里用 family:4 的 Agent 强制 IPv4，与 curl 行为一致。
let _directAgent = undefined;
function resolveDirectAgent() {
  if (_directAgent !== undefined) return _directAgent;
  if (_undici && _undici.Agent) {
    try {
      _directAgent = new _undici.Agent({
        connect: { family: 4, timeout: 10000 },
      });
    } catch (e) {
      console.warn(
        "[stock/http] 初始化 IPv4 直连 Agent 失败，将退回裸直连:",
        e.message,
      );
      _directAgent = null;
    }
  } else {
    _directAgent = null;
  }
  return _directAgent;
}

async function doFetch(url, opts, signal, dispatcher) {
  return realFetch(url, {
    ...opts,
    headers: { ...DEFAULT_HEADERS, ...(opts.headers || {}) },
    signal,
    ...(dispatcher ? { dispatcher } : {}),
  });
}

async function fetchWithTimeout(url, opts = {}, timeout = 12000) {
  const direct = resolveDirectAgent();
  const proxies = resolveProxyAgents();
  let lastErr = null;

  // 尝试顺序：候选代理逐个尝试（用户环境直连常被重置/拦截），最后直连兜底。
  const tryOrder = [...proxies];
  if (direct) tryOrder.push(direct);
  // 极端情况（代理与直连都未初始化）退回裸直连
  if (tryOrder.length === 0) tryOrder.push(null);

  for (const dispatcher of tryOrder) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await doFetch(url, opts, controller.signal, dispatcher);
      clearTimeout(timer);
      return res;
    } catch (e) {
      lastErr = e;
    } finally {
      clearTimeout(timer);
    }
  }

  // 透出真实原因：Node fetch 失败时 e.message 通常是泛化的 "fetch failed"，
  // 真实原因在 e.cause（ECONNREFUSED / ENOTFOUND / 证书错误等）。
  const reason =
    lastErr && lastErr.cause
      ? ` (${lastErr.cause.code || lastErr.cause.message || lastErr.cause})`
      : "";
  const err = new Error(`fetch failed for ${url}${reason}`);
  err.cause = lastErr && lastErr.cause;
  throw err;
}

// fetch + HTTP 状态校验（200 才放行），供文本/GBK 两种解码复用，避免重复校验逻辑
async function fetchAssertOk(url, opts) {
  const res = await fetchWithTimeout(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res;
}

async function fetchText(url, opts) {
  return (await fetchAssertOk(url, opts)).text();
}

// 腾讯 qt.gtimg.cn 行情接口返回 GBK 编码，需按 GBK 解码（否则中文名乱码）。
// Node 22 内置 TextDecoder 支持 'gbk'（full-icu），无需额外依赖。
async function fetchGBKText(url, opts) {
  const res = await fetchAssertOk(url, opts);
  const buf = await res.arrayBuffer();
  return new TextDecoder("gbk").decode(buf);
}

// 简易 TTL 缓存（按自然日失效），用于缓存全市场列表 / K线 / 推荐结果
const memoryCache = new Map();
// 本地日期字符串：必须与 setDailyCache 的本地午夜 TTL 同源，否则跨时区前缀错乱
function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function getCache(key) {
  const hit = memoryCache.get(key);
  if (!hit) return null;
  if (hit.expire < Date.now()) {
    memoryCache.delete(key);
    return null;
  }
  return hit.value;
}
// 周期性清扫已过期条目：daily 缓存 key 带日期前缀，跨天后旧 key 不会被再次访问，
// 仅靠「访问时惰性删除」会无限堆积；每累计若干次写入扫一遍，抑制长驻进程内存增长。
let _setCounter = 0;
function sweepExpired() {
  const now = Date.now();
  for (const [k, v] of memoryCache) if (v.expire < now) memoryCache.delete(k);
}
function setCache(key, value, ttlMs) {
  memoryCache.set(key, {
    value,
    expire: Date.now() + (ttlMs || 1000 * 60 * 30),
  });
  if (++_setCounter % 1000 === 0) sweepExpired();
}
// 按自然日缓存的便捷封装
function getDailyCache(key) {
  return getCache(`daily:${todayStr()}:${key}`);
}
function setDailyCache(key, value) {
  // 自然日剩余秒数 + 缓冲
  const now = new Date();
  const end = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1,
    0,
    0,
    0,
  );
  const ttl = end - now + 60 * 1000;
  setCache(`daily:${todayStr()}:${key}`, value, ttl);
}

// 并发限制：用固定数量的 worker 消费 items
async function mapLimit(items, limit, fn) {
  if (!items.length) return [];
  const results = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      try {
        results[idx] = await fn(items[idx], idx);
      } catch (e) {
        results[idx] = null;
      }
    }
  };
  const workers = Array.from({ length: Math.min(limit, items.length) }, () =>
    worker(),
  );
  await Promise.all(workers);
  return results;
}

function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

module.exports = {
  fetchText,
  fetchGBKText,
  getDailyCache,
  setDailyCache,
  mapLimit,
  num,
};
