const express = require("express");
const router = express.Router();
const { authMiddleware } = require("../middleware/auth");
const MusicFavoriteGroup = require("../models/musicFavoriteGroup");
const MusicFavoriteSong = require("../models/musicFavoriteSong");

// 确保用户存在默认收藏组「我的喜欢」，返回该组
async function ensureDefaultGroup(userId) {
  const [group] = await MusicFavoriteGroup.findOrCreate({
    where: { userId, isDefault: true },
    defaults: { userId, name: "我的喜欢", isDefault: true },
  });
  return group;
}

// 读取某用户全部收藏组，并附带各自歌曲
async function loadGroupsWithSongs(userId) {
  const groups = await MusicFavoriteGroup.findAll({
    where: { userId },
    order: [
      ["isDefault", "DESC"],
      ["id", "ASC"],
    ],
  });

  const result = [];
  for (const g of groups) {
    const rows = await MusicFavoriteSong.findAll({
      where: { groupId: g.id },
      order: [["id", "ASC"]],
    });
    result.push({
      id: g.id,
      name: g.name,
      isDefault: g.isDefault,
      songs: rows.map((r) => r.songData).filter(Boolean),
    });
  }
  return result;
}

// 列出当前用户全部收藏组（含歌曲）
router.get("/groups", authMiddleware, async (req, res) => {
  try {
    await ensureDefaultGroup(req.user.id);
    const groups = await loadGroupsWithSongs(req.user.id);
    res.json({ success: true, data: groups });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message, code: "SERVER_ERROR" });
  }
});

// 新建收藏分组
router.post("/groups", authMiddleware, async (req, res) => {
  try {
    const name = (req.body?.name || "").trim();
    if (!name) {
      return res.status(400).json({ success: false, error: "分组名不能为空", code: "VALIDATION" });
    }
    if (name.length > 20) {
      return res.status(400).json({ success: false, error: "分组名最多 20 字", code: "VALIDATION" });
    }
    const group = await MusicFavoriteGroup.create({
      userId: req.user.id,
      name,
      isDefault: false,
    });
    res.json({
      success: true,
      data: { id: group.id, name: group.name, isDefault: false, songs: [] },
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message, code: "SERVER_ERROR" });
  }
});

// 删除收藏分组（默认组不可删）
router.delete("/groups/:id", authMiddleware, async (req, res) => {
  try {
    const groupId = parseInt(req.params.id);
    const group = await MusicFavoriteGroup.findOne({
      where: { id: groupId, userId: req.user.id },
    });
    if (!group) {
      return res.status(404).json({ success: false, error: "分组不存在", code: "NOT_FOUND" });
    }
    if (group.isDefault) {
      return res.status(400).json({ success: false, error: "默认分组不可删除", code: "VALIDATION" });
    }
    await MusicFavoriteSong.destroy({ where: { groupId } });
    await group.destroy();
    res.json({ success: true, data: { id: groupId } });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message, code: "SERVER_ERROR" });
  }
});

// 向某分组添加歌曲
router.post("/groups/:id/songs", authMiddleware, async (req, res) => {
  try {
    const groupId = parseInt(req.params.id);
    const song = req.body?.song;
    if (!song || !song.id) {
      return res.status(400).json({ success: false, error: "歌曲数据无效", code: "VALIDATION" });
    }
    const group = await MusicFavoriteGroup.findOne({
      where: { id: groupId, userId: req.user.id },
    });
    if (!group) {
      return res.status(404).json({ success: false, error: "分组不存在", code: "NOT_FOUND" });
    }

    const [row] = await MusicFavoriteSong.findOrCreate({
      where: { groupId, songId: String(song.id) },
      defaults: {
        groupId,
        userId: req.user.id,
        songId: String(song.id),
        songData: song,
      },
    });
    res.json({ success: true, data: row.songData });
  } catch (e) {
    // 唯一冲突（同组重复添加）视为成功
    if (e.name === "SequelizeUniqueConstraintError") {
      return res.json({ success: true, data: req.body?.song });
    }
    res.status(500).json({ success: false, error: e.message, code: "SERVER_ERROR" });
  }
});

// 从某分组移除歌曲
router.delete("/groups/:id/songs/:songId", authMiddleware, async (req, res) => {
  try {
    const groupId = parseInt(req.params.id);
    const songId = req.params.songId;
    const group = await MusicFavoriteGroup.findOne({
      where: { id: groupId, userId: req.user.id },
    });
    if (!group) {
      return res.status(404).json({ success: false, error: "分组不存在", code: "NOT_FOUND" });
    }
    await MusicFavoriteSong.destroy({ where: { groupId, songId } });
    res.json({ success: true, data: { groupId, songId } });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message, code: "SERVER_ERROR" });
  }
});

module.exports = router;
