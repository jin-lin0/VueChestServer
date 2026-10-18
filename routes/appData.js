const express = require("express");
const AppData = require("../models/appData");
const User = require("../models/user");
const { authMiddleware } = require("../middleware/auth");
const { isPositiveIntParam } = require("../utils/queryParams");

/** 市场应用云端键值存储，所有读写按当前 userId 和 appId 隔离。 */
const router = express.Router();
router.use(authMiddleware);

const MAX_KEY_CHARS = 120;
const MAX_VALUE_CHARS = 200_000;

// 限制每个用户、每个应用的键数量，约束存储量和列表返回规模。
const MAX_KEYS_PER_APP = 200;

function readKey(raw) {
  const key = String(raw ?? "");
  if (!key || key.length > MAX_KEY_CHARS) return null;
  return key;
}

/** 路径里的应用 id：整段十进制正整数才算合法，否则 400。 */
function readAppId(raw) {
  return isPositiveIntParam(raw) ? Number(raw) : null;
}

/** 同一个 (userId, appId) 下当前已存的键数量。 */
async function countKeys(userId, appId, transaction) {
  return AppData.count({ where: { userId, appId }, transaction });
}

// 列出该应用在当前用户名下的全部键（只返回键与更新时间，不回传数据本体）
router.get("/:appId", async (req, res) => {
  const appId = readAppId(req.params.appId);
  if (!appId) return res.status(400).json({ error: "无效的应用 ID" });
  const rows = await AppData.findAll({
    where: { userId: req.user.id, appId },
    attributes: ["dataKey", "updatedAt"],
    order: [["updatedAt", "DESC"]],
  });
  res.json({
    success: true,
    data: {
      items: rows.map((row) => ({ key: row.dataKey, updatedAt: row.updatedAt })),
    },
  });
});

router.get("/:appId/:key", async (req, res) => {
  const appId = readAppId(req.params.appId);
  const key = readKey(req.params.key);
  if (!appId || !key) return res.status(400).json({ error: "无效的键" });
  const row = await AppData.findOne({
    where: { userId: req.user.id, appId, dataKey: key },
  });
  let value = null;
  if (row) {
    try {
      value = JSON.parse(row.value);
    } catch {
      value = null;
    }
  }
  res.json({ success: true, data: { value } });
});

router.put("/:appId/:key", async (req, res) => {
  const appId = readAppId(req.params.appId);
  const key = readKey(req.params.key);
  if (!appId || !key) return res.status(400).json({ error: "无效的键" });

  let serialized;
  try {
    serialized = JSON.stringify(req.body?.value ?? null);
  } catch {
    return res.status(400).json({ error: "数据无法序列化" });
  }
  if (serialized.length > MAX_VALUE_CHARS) {
    return res.status(413).json({ error: "单条数据过大" });
  }

  const row = await AppData.sequelize.transaction(async (transaction) => {
    // 锁定确实存在的用户行，使同账号的配额检查和写入跨进程串行生效。
    // 不能先创建再数条数并删除：那会短暂暴露未获准的键，并可能删掉并发请求刚确认的写入。
    const owner = await User.findByPk(req.user.id, {
      attributes: ["id"],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!owner) throw Object.assign(new Error("账号不存在，请重新登录"), { status: 401 });

    const existing = await AppData.findOne({
      where: { userId: req.user.id, appId, dataKey: key },
      transaction,
    });
    if (existing) {
      await existing.update({ value: serialized }, { transaction });
      return existing;
    }
    if ((await countKeys(req.user.id, appId, transaction)) >= MAX_KEYS_PER_APP) return null;
    return AppData.create({
      userId: req.user.id,
      appId,
      dataKey: key,
      value: serialized,
    }, { transaction });
  });

  if (!row) {
    return res.status(409).json({
      error: `该应用在本账号下的键数量已达上限（${MAX_KEYS_PER_APP} 个）`,
      code: "APP_DATA_QUOTA_EXCEEDED",
    });
  }

  res.json({ success: true, data: { key, updatedAt: row.updatedAt } });
});

router.delete("/:appId/:key", async (req, res) => {
  const appId = readAppId(req.params.appId);
  const key = readKey(req.params.key);
  if (!appId || !key) return res.status(400).json({ error: "无效的键" });
  const deleted = await AppData.destroy({
    where: { userId: req.user.id, appId, dataKey: key },
  });
  res.json({ success: true, data: { deleted } });
});

module.exports = router;
