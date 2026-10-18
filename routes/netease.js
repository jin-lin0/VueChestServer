const express = require("express");
const router = express.Router();
const NeteaseCloudMusicApi = require("NeteaseCloudMusicApi");
const { createIpRateLimit } = require("../middleware/rateLimit");
const { createTtlCache } = require("../utils/ttlCache");

// 本路由不要求登录（游客也能用音乐播放），但每个请求都会打到网易云。
// 没有额度时它就是一台免费公共代理，故加一层按 IP 的请求额度；额度取值见 middleware/rateLimit.js。
router.use(createIpRateLimit({ scope: "音乐接口" }));

// ===== 上游结果缓存 =====
//
// 为什么要缓存：音乐页首屏一次并发打 7 个本路由的接口，每个未命中都是一次出网往返
// （实测 80~340ms）。前端 `src/lib/musicApi.ts` 自己有一层 5 分钟内存缓存，但那是
// **按会话**的：每次整页刷新（深链接、刷新、新设备）都从零开始，缓存全部落空。
// 后端这一层是跨刷新、跨用户的，同时也是对那台免费公共上游的保护——
// 上游一旦因为请求量被限流，整个音乐应用就一起哑掉。
//
// 只缓存**只读、与用户身份无关**的结果。明确不缓存的见 CACHE_TTL_BY_API 的注释。
//
// maxValueBytes 的取值依据：本路由最大的两个响应是新歌速递（`type=0` 实测 383KB）
// 和榜单列表（89KB），它们恰好是最慢的两个，所以上限必须容得下 383KB；
// 取 512KB 留一点余量，同时把「某个超大歌单详情」挡在缓存外。条数 48
// 与 512KB 相乘是内存上界的最坏情况，实际工作集（一次听歌会话）通常只有十几条。
const NETEASE_CACHE_MAX_ENTRIES = 48;
const NETEASE_CACHE_MAX_VALUE_BYTES = 512 * 1024;
const catalogCache = createTtlCache({
  maxEntries: NETEASE_CACHE_MAX_ENTRIES,
  maxValueBytes: NETEASE_CACHE_MAX_VALUE_BYTES,
});

// 榜单 / 推荐 / 新歌这类会滚动更新的：10 分钟
const TTL_CATALOG = 10 * 60 * 1000;
// 分类表、歌词、专辑与歌手元信息这类基本不动的：30 分钟
const TTL_TAXONOMY = 30 * 60 * 1000;

/**
 * 哪些上游方法可以缓存、各自 TTL 多少。
 *
 * 这是一份**白名单**：没列进来的方法一律直连上游、不缓存。这样以后新加接口时，
 * 默认是「不缓存」这个安全的错，而不是「悄悄缓存了带时效的东西」。
 *
 * 三个必须留在名单外的，各自原因不同，都不是「暂时没加」：
 *   - `search`        关键字基数无上限，且用户对搜索结果的新鲜度有预期；
 *   - `search_suggest` 随输入逐字变化，缓存只会制造「改了字还看到旧建议」的错觉；
 *   - `song_url`      **返回的是签过名、带时效的播放地址**，缓存等于把过期链接发出去。
 */
const CACHE_TTL_BY_API = {
  personalized: TTL_CATALOG,
  top_song: TTL_CATALOG,
  top_playlist: TTL_CATALOG,
  playlist_detail: TTL_CATALOG,
  toplist_detail: TTL_CATALOG,
  search_hot_detail: TTL_CATALOG,
  artist_list: TTL_CATALOG,
  artist_album: TTL_CATALOG,
  simi_song: TTL_CATALOG,
  playlist_catlist: TTL_TAXONOMY,
  artists: TTL_TAXONOMY,
  album: TTL_TAXONOMY,
  song_detail: TTL_TAXONOMY,
  lyric: TTL_TAXONOMY,
};

/**
 * `NeteaseCloudMusicApi` 失败时 reject 的是它自己的 `{ status, body, cookie }` 普通对象，
 * 不是 Error（见该包 `util/request.js` 的 reject(answer)）。直接交给 errorHandler 会有两个问题：
 *
 * 1. 它没有 message 字段，最后会回一句「服务器内部错误」，把「上游不可用」说成了本服务的 bug；
 * 2. 它的 `status` 是上游给的状态码（可能是 400/404），于是**上游的毛病会以 4xx 的形式
 *    回给调用方**，看起来像客户端请求有错。
 *
 * 所以这里统一换成 502 + 稳定文案。原始信息只进服务端日志（本路由免登录，不外发）。
 */
function musicUpstreamError(error) {
  const status = error?.status === 504 ? 504 : 502;
  const wrapped = new Error("音乐服务暂时不可用，请稍后重试");
  wrapped.status = status;
  wrapped.code = status === 504 ? "UPSTREAM_TIMEOUT" : "UPSTREAM_ERROR";
  wrapped.cause = error;
  return wrapped;
}

/** 调上游，返回它原本的 body（与改造前 `res.json(result.body)` 完全一致）。 */
async function callUpstream(name, params) {
  const result = await NeteaseCloudMusicApi[name](params);
  return result.body;
}

/**
 * 统一的「转发上游」出口：能缓存的走缓存，不能缓存的直连；失败一律规范化后交给 errorHandler。
 *
 * 缓存 key 用 `名字|JSON.stringify(params)`。**依赖调用点用对象字面量按固定顺序构造 params**
 * ——同一组参数换个书写顺序就会算出不同 key（只是少命中一次，不会串数据，因为名字在前缀里）。
 */
async function forward(res, next, name, params) {
  const ttl = CACHE_TTL_BY_API[name];
  let body;
  try {
    body =
      ttl === undefined
        ? await callUpstream(name, params)
        : await catalogCache.get(`${name}|${JSON.stringify(params)}`, ttl, () =>
            callUpstream(name, params),
          );
  } catch (error) {
    console.error(
      `[netease] ${name} 上游失败：status=${error?.status} code=${error?.body?.code} ${
        error?.body?.msg || ""
      }`,
    );
    next(musicUpstreamError(error));
    return;
  }
  res.json(body);
}

// 搜索歌曲
router.get("/search", async (req, res, next) => {
  const { keywords, limit = 30, offset = 0 } = req.query;
  if (!keywords) {
    return res.status(400).json({ error: "搜索关键词不能为空" });
  }
  await forward(res, next, "cloudsearch", {
    keywords,
    limit: parseInt(limit),
    offset: parseInt(offset),
  });
});

// 获取歌曲详情
router.get("/song/detail", async (req, res, next) => {
  const { ids } = req.query;
  if (!ids) {
    return res.status(400).json({ error: "歌曲ID不能为空" });
  }
  await forward(res, next, "song_detail", { ids });
});

// 获取歌曲播放链接（**不缓存**：签名带时效）
router.get("/song/url", async (req, res, next) => {
  const { id, br = 320000 } = req.query;
  if (!id) {
    return res.status(400).json({ error: "歌曲ID不能为空" });
  }
  await forward(res, next, "song_url", { id, br: parseInt(br) });
});

// 获取歌词
router.get("/lyric", async (req, res, next) => {
  const { id } = req.query;
  if (!id) {
    return res.status(400).json({ error: "歌曲ID不能为空" });
  }
  await forward(res, next, "lyric", { id });
});

// 获取热门歌单
router.get("/top/playlist", async (req, res, next) => {
  const { limit = 30, offset = 0, cat = "全部" } = req.query;
  await forward(res, next, "top_playlist", {
    limit: parseInt(limit),
    offset: parseInt(offset),
    cat,
  });
});

// 获取歌单详情
router.get("/playlist/detail", async (req, res, next) => {
  const { id } = req.query;
  if (!id) {
    return res.status(400).json({ error: "歌单ID不能为空" });
  }
  await forward(res, next, "playlist_detail", { id });
});

// 获取新歌速递
router.get("/top/song", async (req, res, next) => {
  const { type = 0 } = req.query;
  await forward(res, next, "top_song", { type: parseInt(type) });
});

// 获取推荐歌单
router.get("/personalized", async (req, res, next) => {
  const { limit = 30 } = req.query;
  await forward(res, next, "personalized", { limit: parseInt(limit) });
});

// 获取热门搜索
router.get("/search/hot", async (req, res, next) => {
  await forward(res, next, "search_hot_detail", {});
});

// 获取搜索建议（**不缓存**：随输入逐字变化）
router.get("/search/suggest", async (req, res, next) => {
  const { keywords } = req.query;
  if (!keywords) {
    return res.status(400).json({ error: "搜索关键词不能为空" });
  }
  await forward(res, next, "search_suggest", { keywords });
});

// 获取榜单列表
router.get("/toplist", async (req, res, next) => {
  await forward(res, next, "toplist_detail", {});
});

// 获取歌手详情（含热门歌曲 hotSongs）
router.get("/artist", async (req, res, next) => {
  const { id } = req.query;
  if (!id) {
    return res.status(400).json({ error: "歌手ID不能为空" });
  }
  await forward(res, next, "artists", { id });
});

// 分类歌手（按地区 area 筛选：华语 7 / 欧美 96 / 日本 8 / 韩国 16 / 其他 0）
// 注意：NeteaseCloudMusicApi.artist_list 用 area 体系，cat 码会被忽略
router.get("/artist/list", async (req, res, next) => {
  const { area = 7, limit = 30, offset = 0 } = req.query;
  await forward(res, next, "artist_list", {
    area: parseInt(area),
    limit: parseInt(limit),
    offset: parseInt(offset),
  });
});

// 获取歌手专辑列表
router.get("/artist/album", async (req, res, next) => {
  const { id, limit = 30, offset = 0 } = req.query;
  if (!id) {
    return res.status(400).json({ error: "歌手ID不能为空" });
  }
  await forward(res, next, "artist_album", {
    id,
    limit: parseInt(limit),
    offset: parseInt(offset),
  });
});

// 获取专辑详情（含歌曲 songs）
router.get("/album", async (req, res, next) => {
  const { id } = req.query;
  if (!id) {
    return res.status(400).json({ error: "专辑ID不能为空" });
  }
  await forward(res, next, "album", { id });
});

// 获取相似歌曲
router.get("/simi/song", async (req, res, next) => {
  const { id, limit = 20, offset = 0 } = req.query;
  if (!id) {
    return res.status(400).json({ error: "歌曲ID不能为空" });
  }
  await forward(res, next, "simi_song", {
    id,
    limit: parseInt(limit),
    offset: parseInt(offset),
  });
});

// 获取歌单分类
router.get("/playlist/catlist", async (req, res, next) => {
  await forward(res, next, "playlist_catlist", {});
});

module.exports = router;
