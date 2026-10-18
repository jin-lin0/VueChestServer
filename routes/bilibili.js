const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const { authMiddleware } = require("../middleware/auth");
const {
  analyzeTranscript,
  analyzeTranscriptStream,
  answerTranscriptQuestion,
  answerTranscriptQuestionStream,
} = require("../services/bilibiliAnalysisService");

function createSseSession(req, res) {
  const controller = new AbortController();
  let clientGone = false;
  req.once("aborted", () => controller.abort());
  res.once("close", () => {
    clientGone = true;
    if (!res.writableEnded) controller.abort();
  });
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  return {
    signal: controller.signal,
    write(payload) {
      if (clientGone) return;
      try {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
        if (typeof res.flush === "function") res.flush();
      } catch {
        clientGone = true;
        controller.abort();
      }
    },
    finish() {
      if (clientGone) return;
      try {
        res.write("data: [DONE]\n\n");
        if (typeof res.flush === "function") res.flush();
        res.end();
      } catch {}
    },
    get clientGone() {
      return clientGone;
    },
  };
}

/**
 * 视频信息接口返回标题和分 P 列表；字幕接口按 cid 提取单 P，或遍历全部 pages。
 * bvid 标识视频，cid 标识分 P，字幕按 cid 查询。
 * player 请求使用 WBI 签名；字幕轨道依次选择中文、AI 中文、首条可用轨道。
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

// 优先使用用户提供的 SESSDATA，再使用服务端已有配置。
function resolveSessdata(sessdata) {
  // 请求体先做类型校验，再调用字符串方法。
  const own = typeof sessdata === "string" ? sessdata.trim() : "";
  if (own) return own;
  return (process.env.BILI_SESSDATA || "").trim();
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

// 先读文本再解析 JSON，兼容 bcc 的 content-type，并识别上游 HTML 错误页。
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

// 完整分 P 列表来自 data.pages，data.cid 仅代表第一 P。
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
      throw new Error(
        "该分P字幕需登录后查看，可在「高级」里填入你自己的 SESSDATA 后重试",
      );
    }
    if (sessdata) {
      throw new Error(
        "未获取到该分P字幕；当前 SESSDATA 可能已过期，更新凭证后重试，或确认视频确实没有字幕",
      );
    }
    throw new Error(
      "未获取到公开字幕；该视频可能需要登录后查看，请填写你自己的 SESSDATA 后重试",
    );
  }

  // 2. 选字幕轨道：按优先级取第一条命中的轨道，均无则兜底第一条
  const sub =
    PREFERRED_LANGS.map((lan) => subs.find((s) => s.lan === lan)).find(
      Boolean,
    ) || subs[0];

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

// 视频信息与分 P 列表；错误统一交给全局中间件。
router.post("/info", async (req, res) => {
  const { url, sessdata } = req.body || {};
  // 同上：url 非字符串时 `.match` 会抛 TypeError；这里统一按「链接不合法」处理
  const bvid = typeof url === "string" ? url.match(/BV\w+/)?.[0] : null;
  if (!bvid) {
    return res
      .status(400)
      .json({ error: "请输入有效的 B站视频链接（需包含 BV 号）" });
  }
  const { title, pages } = await fetchView(bvid, resolveSessdata(sessdata));
  res.json({ success: true, data: { bvid, title, pages } });
});

// 路由2：提取字幕。单P 传 cid；全P 传 all=true
// POST /api/bilibili/subtitle  { bvid, cid?, all?, sessdata? }
router.post("/subtitle", async (req, res) => {
  const { bvid, cid, all, sessdata } = req.body || {};
  if (!bvid) {
    return res.status(400).json({ error: "缺少 bvid，请先解析视频" });
  }
  const data = await extractSubtitle(bvid, resolveSessdata(sessdata), {
    cid: cid ? Number(cid) : undefined,
    all: !!all,
  });
  res.json({ success: true, data });
});

// AI 字幕分析需要登录，复用统一模型白名单、限流降级与错误契约。
router.post("/analyze", authMiddleware, async (req, res) => {
  const { title, bvid, text, provider, model, type, prompt } = req.body || {};
  if (!bvid || !provider || !model || !text) {
    return res.status(400).json({
      success: false,
      error: "缺少视频、字幕或模型信息",
      code: "VALIDATION",
    });
  }

  const controller = new AbortController();
  req.once("aborted", () => controller.abort());
  try {
    const data = await analyzeTranscript({
      title: String(title || bvid).slice(0, 200),
      bvid: String(bvid).slice(0, 20),
      text,
      providerId: provider,
      model,
      type: ["overview", "translate", "custom"].includes(type)
        ? type
        : "overview",
      prompt,
      signal: controller.signal,
    });
    res.json({ success: true, data });
  } catch (error) {
    res.status(error.status || 502).json({
      success: false,
      error: error.message || "字幕分析失败",
      code: error.code || "AI_ANALYSIS_FAILED",
    });
  }
});

router.post("/analyze/stream", authMiddleware, async (req, res) => {
  const { title, bvid, text, provider, model, type, prompt } = req.body || {};
  if (!bvid || !provider || !model || !text) {
    return res.status(400).json({
      success: false,
      error: "缺少视频、字幕或模型信息",
      code: "VALIDATION",
    });
  }

  const session = createSseSession(req, res);
  try {
    const data = await analyzeTranscriptStream({
      title: String(title || bvid).slice(0, 200),
      bvid: String(bvid).slice(0, 20),
      text,
      providerId: provider,
      model,
      type: ["overview", "translate", "custom"].includes(type)
        ? type
        : "overview",
      prompt,
      signal: session.signal,
      onDelta: (delta) => session.write({ type: "delta", delta }),
      onProgress: (progress) =>
        session.write({ type: "progress", ...progress }),
    });
    session.write({ type: "complete", data });
  } catch (error) {
    if (!session.signal.aborted && !session.clientGone) {
      session.write({
        type: "error",
        error: error.message || "字幕分析失败",
        code: error.code || "AI_ANALYSIS_FAILED",
      });
    }
  } finally {
    session.finish();
  }
});

// 基于当前字幕与分析结果原地追问，避免跳转到通用 AI 页面丢失视频上下文。
router.post("/ask", authMiddleware, async (req, res) => {
  const { title, bvid, text, analysis, question, history, provider, model } =
    req.body || {};
  if (!bvid || !provider || !model || !text || !question) {
    return res.status(400).json({
      success: false,
      error: "缺少视频、字幕、问题或模型信息",
      code: "VALIDATION",
    });
  }

  const controller = new AbortController();
  req.once("aborted", () => controller.abort());
  try {
    const data = await answerTranscriptQuestion({
      title: String(title || bvid).slice(0, 200),
      text,
      analysis,
      question,
      history,
      providerId: provider,
      model,
      signal: controller.signal,
    });
    res.json({ success: true, data });
  } catch (error) {
    res.status(error.status || 502).json({
      success: false,
      error: error.message || "字幕问答失败",
      code: error.code || "AI_QUESTION_FAILED",
    });
  }
});

router.post("/ask/stream", authMiddleware, async (req, res) => {
  const { title, bvid, text, analysis, question, history, provider, model } =
    req.body || {};
  if (!bvid || !provider || !model || !text || !question) {
    return res.status(400).json({
      success: false,
      error: "缺少视频、字幕、问题或模型信息",
      code: "VALIDATION",
    });
  }

  const session = createSseSession(req, res);
  try {
    const data = await answerTranscriptQuestionStream({
      title: String(title || bvid).slice(0, 200),
      text,
      analysis,
      question,
      history,
      providerId: provider,
      model,
      signal: session.signal,
      onDelta: (delta) => session.write({ type: "delta", delta }),
    });
    session.write({ type: "complete", data });
  } catch (error) {
    if (!session.signal.aborted && !session.clientGone) {
      session.write({
        type: "error",
        error: error.message || "字幕问答失败",
        code: error.code || "AI_QUESTION_FAILED",
      });
    }
  } finally {
    session.finish();
  }
});

module.exports = router;
