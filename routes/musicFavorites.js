const express = require("express");
const { Op } = require("sequelize");
const router = express.Router();
const { authMiddleware } = require("../middleware/auth");
const MusicFavoriteGroup = require("../models/musicFavoriteGroup");
const MusicFavoriteSong = require("../models/musicFavoriteSong");
const { isPositiveIntParam } = require("../utils/queryParams");

// 确保用户存在默认收藏组「我的喜欢」，返回该组
async function ensureDefaultGroup(userId) {
  const [group] = await MusicFavoriteGroup.findOrCreate({
    where: { userId, isDefault: true },
    defaults: { userId, name: "我的喜欢", isDefault: true },
  });
  return group;
}

// 分组和歌曲各查询一次，再按 groupId 分组；仅缺少默认组时补建。
// 分组按 isDefault DESC / id ASC、歌曲按 id ASC 保持顺序。
async function loadGroupsWithSongs(userId) {
  let groups = await MusicFavoriteGroup.findAll({
    where: { userId },
    order: [
      ["isDefault", "DESC"],
      ["id", "ASC"],
    ],
  });

  if (!groups.some((group) => group.isDefault)) {
    const created = await ensureDefaultGroup(userId);
    // 默认组排序时 isDefault DESC 必然排在最前，与直接建表后重查的结果一致。
    if (created) groups = [created, ...groups];
  }

  // 归桶时惰性建桶（不预铺 groups 的 id），这样「输出时兜底 []」就是空分组唯一的收敛点，
  // 不会出现「预铺 + 兜底」两套机制互相掩盖、谁删掉测试都发现不了的情况。
  const songsByGroup = new Map();
  const rows = await MusicFavoriteSong.findAll({
    where: { groupId: { [Op.in]: groups.map((group) => group.id) } },
    order: [["id", "ASC"]],
  });
  for (const row of rows) {
    // songData 的 getter 在 JSON 解析失败时返回 null：等同于逐组查询时的 filter(Boolean)，丢掉。
    if (!row.songData) continue;
    const bucket = songsByGroup.get(row.groupId) || [];
    bucket.push(row.songData);
    songsByGroup.set(row.groupId, bucket);
  }

  return groups.map((group) => ({
    id: group.id,
    name: group.name,
    isDefault: group.isDefault,
    songs: songsByGroup.get(group.id) || [],
  }));
}

// 列出当前用户全部收藏组（含歌曲）
router.get("/groups", authMiddleware, async (req, res, next) => {
  try {
    const groups = await loadGroupsWithSongs(req.user.id);
    res.json({ success: true, data: groups });
  } catch (e) {

    next(e);
  }
});

// 新建收藏分组
router.post("/groups", authMiddleware, async (req, res, next) => {
  try {
    // 类型守卫：`(req.body?.name || "").trim()` 在 name 是数字/对象时会抛
    // `trim is not a function`，被下面的 catch 兜成 500 并把原始报错回给客户端。
    const rawName = req.body?.name;
    const name = typeof rawName === "string" ? rawName.trim() : "";
    if (!name) {
      return res
        .status(400)
        .json({ success: false, error: "分组名不能为空", code: "VALIDATION" });
    }
    if (name.length > 20) {
      return res
        .status(400)
        .json({
          success: false,
          error: "分组名最多 20 字",
          code: "VALIDATION",
        });
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

    next(e);
  }
});

// 删除收藏分组（默认组不可删）
router.delete("/groups/:id", authMiddleware, async (req, res, next) => {
  try {

    if (!isPositiveIntParam(req.params.id)) {
      return res
        .status(404)
        .json({ success: false, error: "分组不存在", code: "NOT_FOUND" });
    }
    const groupId = Number(req.params.id);
    const group = await MusicFavoriteGroup.findOne({
      where: { id: groupId, userId: req.user.id },
    });
    if (!group) {
      return res
        .status(404)
        .json({ success: false, error: "分组不存在", code: "NOT_FOUND" });
    }
    if (group.isDefault) {
      return res
        .status(400)
        .json({
          success: false,
          error: "默认分组不可删除",
          code: "VALIDATION",
        });
    }
    await MusicFavoriteSong.destroy({ where: { groupId } });
    await group.destroy();
    res.json({ success: true, data: { id: groupId } });
  } catch (e) {

    next(e);
  }
});

// 批量写入设置服务端上限，客户端分批迁移。
const MAX_BATCH_SONGS = 200;
// 与模型 songId 的 STRING(64) 对齐：更长的 id 到 MySQL 会被静默截断，
// 截断后可能撞上 (groupId, songId) 唯一索引，变成一条看不懂的冲突。
const MAX_SONG_ID_LENGTH = 64;
// 按序列化字节数限制歌曲大小，与 songData 的 TEXT 列容量保持一致。
const MAX_SONG_DATA_BYTES = 65535;

/** 序列化后的字节数；无法序列化（循环引用等）返回 null。 */
function songDataBytes(song) {
  try {
    const serialized = JSON.stringify(song);
    return serialized === undefined ? null : Buffer.byteLength(serialized);
  } catch {
    return null;
  }
}

/** 单首歌曲的数据量是否还在 songData 的列宽以内。 */
function songFitsColumn(song) {
  const bytes = songDataBytes(song);
  return bytes !== null && bytes <= MAX_SONG_DATA_BYTES;
}

// 批量添加收藏：校验分组归属、读取已有歌曲，再一次性插入缺失记录。
router.post("/groups/:id/songs/batch", authMiddleware, async (req, res, next) => {
  try {
    if (!isPositiveIntParam(req.params.id)) {
      return res
        .status(404)
        .json({ success: false, error: "分组不存在", code: "NOT_FOUND" });
    }
    const groupId = Number(req.params.id);
    const raw = req.body?.songs;
    if (!Array.isArray(raw)) {
      return res
        .status(400)
        .json({
          success: false,
          error: "songs 必须是数组",
          code: "VALIDATION",
        });
    }

    // 逐项收口：只收「对象 + 有非空 id」的项，并按 songId 去重
    // （同一次请求里重复提交同一首只写一次，否则会撞唯一索引把整条 INSERT 打回）。
    const bySongId = new Map();
    for (const song of raw) {
      if (!song || typeof song !== "object" || Array.isArray(song)) continue;
      if (song.id === undefined || song.id === null) continue;
      const songId = String(song.id);
      if (!songId.trim() || songId.length > MAX_SONG_ID_LENGTH) continue;
      // 超限记录使整批请求失败，避免静默跳过后被客户端误判为已迁移。
      if (!songFitsColumn(song)) {
        return res.status(400).json({
          success: false,
          error: "歌曲数据过大（单首上限 64KB）",
          code: "VALIDATION",
        });
      }
      if (!bySongId.has(songId)) bySongId.set(songId, song);
      if (bySongId.size >= MAX_BATCH_SONGS) break;
    }
    if (bySongId.size === 0) {
      return res
        .status(400)
        .json({
          success: false,
          error: "没有可加入的歌曲",
          code: "VALIDATION",
        });
    }

    const group = await MusicFavoriteGroup.findOne({
      where: { id: groupId, userId: req.user.id },
    });
    if (!group) {
      return res
        .status(404)
        .json({ success: false, error: "分组不存在", code: "NOT_FOUND" });
    }

    const songIds = [...bySongId.keys()];
    const existing = await MusicFavoriteSong.findAll({
      where: { groupId, songId: { [Op.in]: songIds } },
      attributes: ["songId"],
    });
    const present = new Set(existing.map((row) => row.songId));
    const rows = songIds
      .filter((songId) => !present.has(songId))
      .map((songId) => ({
        groupId,
        userId: req.user.id,
        songId,
        songData: bySongId.get(songId),
      }));

    // 如实报数：并发下（同一账号在两台设备上同时迁移）另一条 INSERT 可能先落库，
    // 此时这条 bulkCreate 会整体回滚（MySQL 单语句原子性），所以 added 记 0 而不是 rows.length。
    let added = 0;
    if (rows.length) {
      try {
        await MusicFavoriteSong.bulkCreate(rows);
        added = rows.length;
      } catch (e) {
        if (e.name !== "SequelizeUniqueConstraintError") throw e;
      }
    }

    res.json({
      success: true,
      data: {
        requested: bySongId.size,
        added,
        skipped: bySongId.size - added,
      },
    });
  } catch (e) {

    next(e);
  }
});

// 向某分组添加歌曲
router.post("/groups/:id/songs", authMiddleware, async (req, res, next) => {
  try {

    if (!isPositiveIntParam(req.params.id)) {
      return res
        .status(404)
        .json({ success: false, error: "分组不存在", code: "NOT_FOUND" });
    }
    const groupId = Number(req.params.id);
    const song = req.body?.song;
    if (!song || !song.id) {
      return res
        .status(400)
        .json({ success: false, error: "歌曲数据无效", code: "VALIDATION" });
    }
    if (!songFitsColumn(song)) {
      return res.status(400).json({
        success: false,
        error: "歌曲数据过大（单首上限 64KB）",
        code: "VALIDATION",
      });
    }
    const group = await MusicFavoriteGroup.findOne({
      where: { id: groupId, userId: req.user.id },
    });
    if (!group) {
      return res
        .status(404)
        .json({ success: false, error: "分组不存在", code: "NOT_FOUND" });
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
    next(e);
  }
});

// 从某分组移除歌曲
router.delete("/groups/:id/songs/:songId", authMiddleware, async (req, res, next) => {
  try {

    if (!isPositiveIntParam(req.params.id)) {
      return res
        .status(404)
        .json({ success: false, error: "分组不存在", code: "NOT_FOUND" });
    }
    const groupId = Number(req.params.id);
    const songId = req.params.songId;
    const group = await MusicFavoriteGroup.findOne({
      where: { id: groupId, userId: req.user.id },
    });
    if (!group) {
      return res
        .status(404)
        .json({ success: false, error: "分组不存在", code: "NOT_FOUND" });
    }
    await MusicFavoriteSong.destroy({ where: { groupId, songId } });
    res.json({ success: true, data: { groupId, songId } });
  } catch (e) {

    next(e);
  }
});

module.exports = router;
