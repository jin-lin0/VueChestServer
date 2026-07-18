"use strict";

const {
  fetchText,
  fetchGBKText,
  getDailyCache,
  setDailyCache,
  num,
  mapLimit,
} = require("./http");

// 沪市代码以 6 开头（含 688 科创），其余（0/2/3 开头）为深市
function marketPrefix(code) {
  if (
    code === "000001" ||
    code === "000300" ||
    code === "000688" ||
    code === "000905"
  )
    return "sh"; // 指数特例
  return code[0] === "6" ? "sh" : "sz";
}

// 排除规则：ST、*ST、退市（名称含"退"字）一律不参与分析与推荐
const EXCLUDE_RE = /ST|退|\*/;

// —— 全市场 A 股列表（腾讯 qt.gtimg.cn 批量报价，免 token）——
// 仅纳入主板：用户要求排除创业板(300/301)、科创板(688)、北交所(8/4 开头)与 ST/*/退市股
function buildCandidateCodes() {
  const out = [];
  const add = (prefix, start, end) => {
    for (let i = start; i <= end; i++)
      out.push(prefix + String(i).padStart(6, "0"));
  };
  add("sh", 600000, 605999); // 沪市主板（600/601/603/605 开头）
  add("sz", 1, 4999); // 深市主板（000/001/002/003/004 开头）
  // 已排除：科创板 688xxx、创业板 300xxx/301xxx、北交所 8xxxxx/4xxxxx
  return out;
}

function chunkify(arr, n) {
  const r = [];
  for (let i = 0; i < arr.length; i += n) r.push(arr.slice(i, i + n));
  return r;
}

// 解析腾讯批量报价文本：v_sh600519="1~贵州茅台~600519~...";
function parseQuotes(text) {
  const out = [];
  const re = /v_(\w+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(text))) {
    const key = m[1]; // 例如 sh600519
    const f = m[2].split("~");
    if (!f[1]) continue; // 无效代码（空名称）
    const price = num(f[3]);
    if (!price) continue;
    // f[44]/f[45] 为市值，单位「亿」；顺序不定（流通/总），用 max/min 自动区分
    const mcA = num(f[44]) * 1e8;
    const mcB = num(f[45]) * 1e8;
    const totalMv = Math.max(mcA, mcB);
    const circMv = Math.min(mcA, mcB);
    // f[35] = "现价/成交量(手)/成交额(元)"
    const amtParts = String(f[35] || "").split("/");
    const amount = num(amtParts[2]) || num(f[37]) * 1e4;
    out.push({
      code: key.slice(2), // 取 6 位代码
      name: String(f[1]).trim(),
      price,
      changePct: num(f[32]),
      amount,
      turnoverRate: num(f[38]),
      totalMv,
      circMv,
      mainNetInflow: 0,
    });
  }
  return out;
}

async function fetchQuoteBatch(codes) {
  const url = `https://qt.gtimg.cn/q=${codes.join(",")}`;
  const text = await fetchGBKText(url);
  return parseQuotes(text);
}

async function getAshareList() {
  const cached = getDailyCache("ashare_list");
  if (cached) return cached;

  const codes = buildCandidateCodes();
  const CHUNK = 150;
  const CONC = 6;
  const batches = chunkify(codes, CHUNK);
  const results = await mapLimit(batches, CONC, (batch) =>
    fetchQuoteBatch(batch).catch(() => []),
  );

  const list = [];
  for (const arr of results) {
    if (!arr || !arr.length) continue;
    // 排除：名称含 ST/退/*；以及当日无成交额的僵尸股（长期停牌/已退市但腾讯仍保留旧报价）
    for (const q of arr)
      if (q && q.name && !EXCLUDE_RE.test(q.name) && (q.amount || 0) > 0)
        list.push(q);
  }

  setDailyCache("ashare_list", list);
  return list;
}

// 解析 K 线 JSON：统一处理「接口错误校验 + 节点提取 + 字段映射」，供 getKline/getIndexKline 复用
function parseKlineNode(json, symbol) {
  if (json && json.code !== 0)
    throw new Error(`K线接口返回错误: ${json.msg || json.code}`);
  const node = json?.data?.[symbol];
  const arr = node?.day || node?.qfqday || [];
  return arr.map((r) => ({
    date: String(r[0]),
    open: num(r[1]),
    close: num(r[2]),
    high: num(r[3]),
    low: num(r[4]),
    volume: num(r[5]),
  }));
}

// 统一 K 线拉取：getKline / getIndexKline 仅 isIndex 标志与缓存前缀不同，共用此实现
async function fetchKline(code, count = 250, { isIndex = false } = {}) {
  const cacheKey = (isIndex ? "indexkline:" : "kline:") + code + ":" + count;
  const cached = getDailyCache(cacheKey);
  if (cached) return cached;
  const symbol = `${marketPrefix(code)}${code}`;
  const url = `https://web.ifzq.gtimg.cn/appstock/app/kline/kline?param=${symbol},day,,,${count},&qfq=1`;
  const text = await fetchText(url);
  const result = parseKlineNode(JSON.parse(text), symbol);
  setDailyCache(cacheKey, result);
  return result;
}

// 个股日 K 线
async function getKline(code, count = 250) {
  return fetchKline(code, count);
}

// 上证指数 K 线，作为"强势回调抗跌"对比基准
async function getIndexKline(code = "000001", count = 120) {
  return fetchKline(code, count, { isIndex: true });
}

module.exports = {
  getAshareList,
  getKline,
  getIndexKline,
  marketPrefix,
  parseQuotes,
  fetchQuoteBatch,
};
