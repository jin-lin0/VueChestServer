const express = require("express");
const crypto = require("crypto");
const User = require("../models/user");
const { authMiddleware } = require("../middleware/auth");
const {
  createUploadUrl,
  headObject,
  deleteObject,
  publicUrl,
} = require("../utils/r2");
const slugify = require("../utils/slugify");

const router = express.Router();
const limits = { avatar: 2 * 1024 * 1024, app: 10 * 1024 * 1024 };
const types = {
  avatar: new Set(["image/jpeg", "image/png", "image/webp"]),
  app: new Set([
    "application/javascript",
    "text/javascript",
    "application/x-javascript",
  ]),
};

router.post("/presign", authMiddleware, async (req, res) => {
  const { kind, contentType, size, name } = req.body;
  if (
    !limits[kind] ||
    !types[kind]?.has(contentType) ||
    !Number.isInteger(size) ||
    size <= 0 ||
    size > limits[kind]
  ) {
    return res
      .status(400)
      .json({ error: "文件类型或大小不符合要求", code: "VALIDATION_ERROR" });
  }

  const extension =
    kind === "app" ? "js" : contentType.split("/")[1].replace("jpeg", "jpg");
  const readableName = slugify(name, kind === "avatar" ? "avatar" : "app");
  const suffix = crypto.randomUUID().slice(0, 8); // 短随机后缀，防止同名覆盖
  const key = `${kind === "avatar" ? "avatars" : "apps"}/${req.user.id}/${readableName}-${suffix}.${extension}`;
  const uploadUrl = await createUploadUrl(key, contentType);
  res.json({
    success: true,
    data: { key, uploadUrl, publicUrl: publicUrl(key), expiresIn: 600 },
  });
});

router.post("/complete", authMiddleware, async (req, res) => {
  const { kind, key } = req.body;
  const prefix = `${kind === "avatar" ? "avatars" : "apps"}/${req.user.id}/`;
  if (!limits[kind] || typeof key !== "string" || !key.startsWith(prefix)) {
    return res
      .status(400)
      .json({ error: "无效的文件路径", code: "VALIDATION_ERROR" });
  }

  const object = await headObject(key);
  if (!object.ContentLength || object.ContentLength > limits[kind]) {
    await deleteObject(key).catch(() => {});
    return res
      .status(400)
      .json({ error: "文件大小不符合要求", code: "VALIDATION_ERROR" });
  }

  const url = publicUrl(key);
  if (kind === "avatar")
    await User.update({ avatar: url }, { where: { id: req.user.id } });
  res.json({
    success: true,
    data: {
      key,
      url,
      size: object.ContentLength,
      contentType: object.ContentType,
    },
  });
});

module.exports = router;
