const express = require("express");
const router = express.Router();
const NeteaseCloudMusicApi = require("NeteaseCloudMusicApi");

// 搜索歌曲
router.get("/search", async (req, res) => {
  const { keywords, limit = 30, offset = 0 } = req.query;
  if (!keywords) {
    return res.status(400).json({ error: "搜索关键词不能为空" });
  }
  const result = await NeteaseCloudMusicApi.cloudsearch({
    keywords,
    limit: parseInt(limit),
    offset: parseInt(offset),
  });
  res.json(result.body);
});

// 获取歌曲详情
router.get("/song/detail", async (req, res) => {
  const { ids } = req.query;
  if (!ids) {
    return res.status(400).json({ error: "歌曲ID不能为空" });
  }
  const result = await NeteaseCloudMusicApi.song_detail({ ids });
  res.json(result.body);
});

// 获取歌曲播放链接
router.get("/song/url", async (req, res) => {
  const { id, br = 320000 } = req.query;
  if (!id) {
    return res.status(400).json({ error: "歌曲ID不能为空" });
  }
  const result = await NeteaseCloudMusicApi.song_url({ id, br: parseInt(br) });
  res.json(result.body);
});

// 获取歌词
router.get("/lyric", async (req, res) => {
  const { id } = req.query;
  if (!id) {
    return res.status(400).json({ error: "歌曲ID不能为空" });
  }
  const result = await NeteaseCloudMusicApi.lyric({ id });
  res.json(result.body);
});

// 获取热门歌单
router.get("/top/playlist", async (req, res) => {
  const { limit = 30, offset = 0, cat = "全部" } = req.query;
  const result = await NeteaseCloudMusicApi.top_playlist({
    limit: parseInt(limit),
    offset: parseInt(offset),
    cat,
  });
  res.json(result.body);
});

// 获取歌单详情
router.get("/playlist/detail", async (req, res) => {
  const { id } = req.query;
  if (!id) {
    return res.status(400).json({ error: "歌单ID不能为空" });
  }
  const result = await NeteaseCloudMusicApi.playlist_detail({ id });
  res.json(result.body);
});

// 获取新歌速递
router.get("/top/song", async (req, res) => {
  const { type = 0 } = req.query;
  const result = await NeteaseCloudMusicApi.top_song({ type: parseInt(type) });
  res.json(result.body);
});

// 获取推荐歌单
router.get("/personalized", async (req, res) => {
  const { limit = 30 } = req.query;
  const result = await NeteaseCloudMusicApi.personalized({ limit: parseInt(limit) });
  res.json(result.body);
});

// 获取热门搜索
router.get("/search/hot", async (req, res) => {
  const result = await NeteaseCloudMusicApi.search_hot_detail();
  res.json(result.body);
});

// 获取搜索建议
router.get("/search/suggest", async (req, res) => {
  const { keywords } = req.query;
  if (!keywords) {
    return res.status(400).json({ error: "搜索关键词不能为空" });
  }
  const result = await NeteaseCloudMusicApi.search_suggest({ keywords });
  res.json(result.body);
});

// 获取榜单列表
router.get("/toplist", async (req, res) => {
  const result = await NeteaseCloudMusicApi.toplist_detail();
  res.json(result.body);
});

module.exports = router;
