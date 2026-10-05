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
const {
  normalizeSha256,
  assertObjectIntegrity,
} = require("../utils/bundleIntegrity");

const router = express.Router();
const limits = {
  avatar: 2 * 1024 * 1024,
  app: 10 * 1024 * 1024,
  screenshot: 5 * 1024 * 1024,
  // 市场应用通过沙箱 files.upload 上传的附件（图片 / 文档 / 压缩包等）
  appfile: 4 * 1024 * 1024,
};
const types = {
  avatar: new Set(["image/jpeg", "image/png", "image/webp"]),
  app: new Set([
    "application/javascript",
    "text/javascript",
    "application/x-javascript",
  ]),
  screenshot: new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]),
  appfile: new Set([
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
    "image/svg+xml",
    "application/pdf",
    "text/plain",
    "text/markdown",
    "text/csv",
    "application/json",
    "application/zip",
    "application/octet-stream",
  ]),
};

const EXT_BY_TYPE = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/svg+xml": "svg",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/markdown": "md",
  "text/csv": "csv",
  "application/json": "json",
  "application/zip": "zip",
  "application/octet-stream": "bin",
};

function extensionFor(kind, contentType) {
  if (kind === "app") return "js";
  return (
    EXT_BY_TYPE[contentType] ||
    (contentType.split("/")[1] || "bin").replace("jpeg", "jpg")
  );
}

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

  const extension = extensionFor(kind, contentType);
  const readableName = slugify(
    name,
    kind === "avatar"
      ? "avatar"
      : kind === "screenshot"
        ? "screenshot"
        : kind === "appfile"
          ? "file"
          : "app",
  );
  // app 用稳定 key（apps/<userId>/<slug>.js）覆盖式更新，避免每次随机后缀在 R2 堆积；
  // 头像/截图/应用附件仍加随机后缀，防止不同文件互相覆盖。
  const suffix =
    kind === "app" && name ? "" : `-${crypto.randomUUID().slice(0, 8)}`;
  let key;
  if (kind === "appfile") {
    // 应用附件按 <userId>/<appId> 分层，既保证归属校验，也便于按应用清理。
    const appId = Number.parseInt(req.body.appId, 10);
    if (!Number.isInteger(appId) || appId <= 0) {
      return res
        .status(400)
        .json({ error: "缺少有效的应用 ID", code: "VALIDATION_ERROR" });
    }
    key = `appfiles/${req.user.id}/${appId}/${readableName}${suffix}.${extension}`;
  } else {
    key = `${kind === "avatar" ? "avatars" : "apps"}/${req.user.id}/${readableName}${suffix}.${extension}`;
  }
  const sha256 = kind === "app" ? normalizeSha256(req.body.sha256, true) : null;
  const uploadUrl = await createUploadUrl(
    key,
    contentType,
    sha256 ? { sha256 } : undefined,
  );
  res.json({
    success: true,
    data: {
      key,
      uploadUrl,
      publicUrl: publicUrl(key),
      expiresIn: 600,
      headers: sha256 ? { "x-amz-meta-sha256": sha256 } : {},
    },
  });
});

router.post("/complete", authMiddleware, async (req, res) => {
  const { kind, key } = req.body;
  const prefix =
    kind === "appfile"
      ? `appfiles/${req.user.id}/`
      : `${kind === "avatar" ? "avatars" : "apps"}/${req.user.id}/`;
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
  const sha256 =
    kind === "app"
      ? assertObjectIntegrity(object, req.body.sha256, true)
      : null;

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
      sha256,
    },
  });
});

module.exports = router;
