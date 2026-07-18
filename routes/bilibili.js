const express = require("express");
const router = express.Router();
const crypto = require("crypto");

/**
 * B站字幕提取接口
 * -------------------------------------------------------------
 * 本模块提供两个接口，配合前端「先选分P、再提取字幕」的交互：
 *
 *   POST /api/bilibili/info      { url, sessdata? }
 *        └─ 调 view 接口拿到视频标题 + 完整分P列表 pages[]（每个分P一个 cid）
 *        └─ 返回给前端，用于渲染「分P选择器」（含「全部P」选项）
 *
 *   POST /api/bilibili/subtitle  { bvid, cid?, all?, sessdata? }
 *        └─ 单P：传 cid，提取该分P字幕
 *        └─ 全P：传 all=true，遍历 pages 逐个提取，返回 pages 数组
 *
 * 单条分P的字幕提取流程（extractOnePage）：
 *
 *   1. player 接口    x/player/wbi/v2?bvid=xxx&cid=xxx&w_rid=签名
 *        └─ 经 WBI 签名后请求，拿到该分P的字幕列表 subtitles[]
 *
 *   2. 选轨道          优先 中文(zh-CN/zh-Hans) → AI 中文(ai-zh) → 第一条
 *
 *   3. 下载 bcc        subtitle_url 指向一个 JSON 字幕文件（B站自定义格式）
 *        └─ 把 body[].content 按顺序拼成纯文本 / 带时间戳文本后返回
 *
 * 关于 bvid 与 cid：
 *   bvid 是「作品级」唯一 ID（URL 里的 BV 号）；cid 是「分P级」播放 ID。
 *   一个 bvid 可能对应多个 cid（多P 视频每P一个），字幕挂在 cid 上，
 *   所以必须先用 view 接口拿到 pages[]，才能知道有哪些 cid 可取。
 *
 * 为什么需要 WBI 签名？
 *   B站自 2023 年起对 player 类接口加了 WBI（Web-Interface）签名校验，
 *   query 里必须带 w_rid（签名）和 wts（时间戳），否则返回 -412。
 *   签名 = md5(排序后的 query 串 + mixinKey)，mixinKey 由 nav 接口下发的
 *   两张图片(img_url / sub_url)的文件名按固定表重排得到，约 10 分钟有效，故做缓存。
 */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const REFERER = "https://www.bilibili.com";

// 字幕选轨优先级：简体中文 → AI 中文 → 兜底第一条
const PREFERRED_LANGS = ["zh-CN", "zh-Hans", "ai-zh"];

// WBI 签名所需的固定重排表（B站官方算法，顺序不可改）
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 57, 56, 51, 21, 44, 34, 36, 22, 54, 20, 25, 52, 59, 6, 60, 11,
  4, 30, 62, 63, 64,
];

// 标准 md5，用于对请求参数串做哈希签名
function md5(str) {
  return crypto.createHash("md5").update(str).digest("hex");
}

// 由 nav 下发的 imgKey / subKey 计算出 32 位 mixinKey：
// 两者拼接后，按 MIXIN_KEY_ENC_TAB 的下标顺序取字符，再截断到 32 位。
function getMixinKey(imgKey, subKey) {
  const raw = imgKey + subKey;
  let key = "";
  for (const i of MIXIN_KEY_ENC_TAB) key += raw[i] ?? "";
  return key.slice(0, 32);
}

// 拉取并缓存 mixinKey（10 分钟内复用，避免每次请求都打 nav 接口）
let cachedKeys = { key: "", ts: 0 };
async function getWbiKeys() {
  if (cachedKeys.key && Date.now() - cachedKeys.ts < 10 * 60 * 1000) {
    return cachedKeys.key;
  }

  const json = await fetchJson("https://api.bilibili.com/x/web-interface/nav", {
    headers: { "User-Agent": UA, Referer: REFERER },
  });
  // 从两张图片 URL 的文件名（去掉扩展名）分别取出 imgKey / subKey
  const img =
    json?.data?.wbi_img?.img_url?.split("/").pop().split(".")[0] || "";
  const sub =
    json?.data?.wbi_img?.sub_url?.split("/").pop().split(".")[0] || "";
  const key = getMixinKey(img, sub);
  cachedKeys = { key, ts: Date.now() };
  return key;
}

// 对传入参数做 WBI 签名：追加 wts 时间戳 → 按键名升序排序 → 拼成 query 串
// → md5(query + mixinKey) 得到 w_rid，返回带签名的完整参数对象。
async function sign(params) {
  const mixinKey = await getWbiKeys();
  const wts = Math.floor(Date.now() / 1000);
  const merged = { ...params, wts };
  const query = Object.keys(merged)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(merged[k])}`)
    .join("&");
  return { ...merged, w_rid: md5(query + mixinKey) };
}

// 公共请求头；带 sessdata 时附上 Cookie，可解锁需登录才可见的 AI 字幕
function buildHeaders(sessdata) {
  const headers = { "User-Agent": UA, Referer: REFERER };
  if (sessdata) {
    if (!/^[\w%.-]+$/.test(sessdata)) throw new Error("SESSDATA 格式非法");
    headers["Cookie"] = `SESSDATA=${sessdata}`;
  }
  return headers;
}

// 统一的 JSON 请求：先读文本，若响应是 HTML（B站风控墙 / 登录墙）则抛出可读错误，
// 否则 JSON.parse。避免 res.json() 遇到 HTML 抛出不友好的 "Unexpected token <"，
// 且不会因 content-type 非 application/json（如 bcc 字幕文件）而误判。
async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  const head = text.trimStart();
  if (head.startsWith("<!DOCTYPE") || head.startsWith("<html")) {
    throw new Error("B站返回异常（可能为风控拦截或登录墙），请稍后重试");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("B站响应解析失败，请稍后重试");
  }
}

// 步骤一：调 view 接口拿到视频标题 + 完整分P列表。
// 关键：多P 视频的所有 cid 都在 data.pages[] 里，data.cid 只是第1P，
// 因此必须遍历 pages 才能拿到全部分P，不能只取 data.cid。
async function fetchView(bvid, sessdata) {
  const headers = buildHeaders(sessdata);
  const view = await fetchJson(
    `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`,
    { headers },
  );
  if (view.code !== 0 || !view.data) {
    throw new Error(view.message || "视频不存在或请求被拒绝");
  }
  // pages 是完整分P清单，每个含独立 cid；part 为分P标题
  const pages = (view.data.pages || []).map((p) => ({
    cid: p.cid,
    page: p.page,
    part: p.part || `第${p.page}P`,
    duration: p.duration || 0,
  }));
  // 兜底：极个别老视频可能 pages 为空但 data.cid 存在，补一条默认分P
  if (!pages.length && view.data.cid) {
    pages.push({
      cid: view.data.cid,
      page: 1,
      part: view.data.title || "第1P",
      duration: 0,
    });
  }
  return { title: view.data.title, pages };
}

// 步骤二：提取「单个 cid」的字幕（一条分P的完整流水线）。
// 返回 { lan, lanDoc, text, timed, count }。无字幕或需登录时抛出可读错误。
async function extractOnePage(bvid, cid, sessdata) {
  const headers = buildHeaders(sessdata);

  // 1. WBI 签名后请求 player 接口，拿到该分P的字幕列表
  const params = await sign({ bvid, cid });
  const playerUrl =
    "https://api.bilibili.com/x/player/wbi/v2?" +
    new URLSearchParams(params).toString();
  const player = await fetchJson(playerUrl, { headers });
  if (player.code !== 0) {
    throw new Error(player.message || "字幕接口请求失败（签名或风控拦截）");
  }
  const subtitle = (player.data && player.data.subtitle) || {};
  const subs = subtitle.subtitles || [];

  // 没有字幕：区分"需登录才能看"和"真的没有"，给出不同提示
  if (!subs.length) {
    if (subtitle.need_login_subtitle) {
      throw new Error("该分P字幕需登录后查看，请在下方填入 SESSDATA 后重试");
    }
    throw new Error("该分P暂无字幕（既无官方字幕也无 AI 字幕）");
  }

  // 2. 选字幕轨道：按优先级取第一条命中的轨道，均无则兜底第一条
  const sub =
    PREFERRED_LANGS.map((lan) => subs.find((s) => s.lan === lan)).find(Boolean) ||
    subs[0];

  // 3. 下载并解析 bcc：subtitle_url 是协议相对地址（以 // 开头），补成 https
  const bccUrl = "https:" + sub.subtitle_url;
  const bcc = await fetchJson(bccUrl, { headers });
  const body = Array.isArray(bcc.body) ? bcc.body : [];

  // 拼文本：text 为纯文本；timed 为带 [起播秒数] 前缀的时间轴文本
  const text = body.map((s) => s.content).join("\n");
  const timed = body
    .map((s) => `[${Number(s.from).toFixed(1)}s] ${s.content}`)
    .join("\n");

  return {
    lan: sub.lan,
    lanDoc: sub.lan_doc || sub.lan,
    text,
    timed,
    count: body.length,
  };
}

// 主入口：单P（传 cid）或 全P（传 all=true）。
// 单P返回单条结果对象；全P返回 { all:true, pages:[每条分P的结果] }。
async function extractSubtitle(bvid, sessdata, { cid, all } = {}) {
  const { title, pages } = await fetchView(bvid, sessdata);

  if (all) {
    // 遍历所有分P，逐条提取；单条失败不影响其他分P，记录 error 即可
    const results = [];
    for (const p of pages) {
      try {
        const r = await extractOnePage(bvid, p.cid, sessdata);
        results.push({ ...p, ...r });
      } catch (e) {
        results.push({ ...p, error: e.message });
      }
    }
    return { title, bvid, all: true, pages: results };
  }

  // 单P：未指定 cid 时默认取第1P
  const target = cid || (pages[0] && pages[0].cid);
  if (!target) throw new Error("无法确定要提取的分P");
  const r = await extractOnePage(bvid, target, sessdata);
  const pageInfo = pages.find((p) => p.cid === target) || {};
  return { title, bvid, all: false, ...pageInfo, ...r };
}

// 路由1：解析视频信息（拿标题 + 分P列表），供前端渲染分P选择器
// POST /api/bilibili/info  { url, sessdata? }
// 错误无需本地 try/catch —— 冒泡到全局错误处理中间件（index.js）统一返回 { error, code }
router.post("/info", async (req, res) => {
  const { url, sessdata } = req.body || {};
  const bvid = (url || "").match(/BV\w+/)?.[0];
  if (!bvid) {
    return res.status(400).json({ error: "请输入有效的 B站视频链接（需包含 BV 号）" });
  }
  const { title, pages } = await fetchView(bvid, sessdata);
  res.json({ success: true, data: { bvid, title, pages } });
});

// 路由2：提取字幕。单P 传 cid；全P 传 all=true
// POST /api/bilibili/subtitle  { bvid, cid?, all?, sessdata? }
router.post("/subtitle", async (req, res) => {
  const { bvid, cid, all, sessdata } = req.body || {};
  if (!bvid) {
    return res.status(400).json({ error: "缺少 bvid，请先解析视频" });
  }
  const data = await extractSubtitle(bvid, sessdata, {
    cid: cid ? Number(cid) : undefined,
    all: !!all,
  });
  res.json({ success: true, data });
});

module.exports = router;
