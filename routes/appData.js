const express = require("express");
const AppData = require("../models/appData");
const { authMiddleware } = require("../middleware/auth");

/**
 * 市场应用的云端键值存储接口（需登录）。
 *
 * 路径中的 :appId 与应用市场里的应用 id 对应，:key 由应用自定义。
 * 所有读写都以「当前用户 + appId」为作用域，天然隔离不同用户、不同应用的数据。
 * 沙箱侧通过 __VueChest__.cloud.* 调用本路由（见 src/lib/sandbox-bridge.ts）。
 */
const router = express.Router();
router.use(authMiddleware);

const MAX_KEY_CHARS = 120;
const MAX_VALUE_CHARS = 200_000;

function parseAppId(raw) {
  const id = Number.parseInt(raw, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function readKey(raw) {
  const key = String(raw ?? "");
  if (!key || key.length > MAX_KEY_CHARS) return null;
  return key;
}

// 列出该应用在当前用户名下的全部键（只返回键与更新时间，不回传数据本体）
router.get("/:appId", async (req, res) => {
  const appId = parseAppId(req.params.appId);
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
  const appId = parseAppId(req.params.appId);
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
  const appId = parseAppId(req.params.appId);
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

  const [row, created] = await AppData.findOrCreate({
    where: { userId: req.user.id, appId, dataKey: key },
    defaults: { value: serialized },
  });
  if (!created) await row.update({ value: serialized });

  res.json({ success: true, data: { key, updatedAt: row.updatedAt } });
});

router.delete("/:appId/:key", async (req, res) => {
  const appId = parseAppId(req.params.appId);
  const key = readKey(req.params.key);
  if (!appId || !key) return res.status(400).json({ error: "无效的键" });
  const deleted = await AppData.destroy({
    where: { userId: req.user.id, appId, dataKey: key },
  });
  res.json({ success: true, data: { deleted } });
});

module.exports = router;
