const express = require("express");
const { Op, fn, col } = require("sequelize");
const MarketApp = require("../models/marketApp");
const MarketAppVersion = require("../models/marketAppVersion");
const { authMiddleware, optionalAuth } = require("../middleware/auth");
const { adminOnly, isAdmin } = require("../middleware/superAdmin");
const { publicUrl, headObject, deleteObject } = require("../utils/r2");

const router = express.Router();
const VERSION_RE = /^v?\d+(?:\.\d+){0,3}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function parseVersion(value) {
  const [main, prerelease = ""] = String(value || "0").replace(/^v/i, "").split("-", 2);
  return { parts: main.split(".").map((part) => parseInt(part, 10) || 0), prerelease };
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  const length = Math.max(a.parts.length, b.parts.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (a.parts[index] || 0) - (b.parts[index] || 0);
    if (diff) return diff > 0 ? 1 : -1;
  }
  if (!a.prerelease && b.prerelease) return 1;
  if (a.prerelease && !b.prerelease) return -1;
  return a.prerelease.localeCompare(b.prerelease, undefined, { numeric: true });
}

function versionMetadata(app, overrides = {}) {
  return {
    name: overrides.name ?? app.name,
    icon: overrides.icon ?? app.icon,
    description: overrides.description ?? app.description ?? "",
    category: overrides.category ?? app.category ?? "",
    readme: overrides.readme ?? app.readme ?? "",
    screenshots: overrides.screenshots ?? app.screenshots ?? null,
  };
}

async function recordVersion(app, publishedBy, reviewStatus = "approved") {
  if (!app.fileKey) return null;
  const payload = {
    fileKey: app.fileKey,
    fileUrl: app.fileUrl || publicUrl(app.fileKey),
    size: app.size,
    releaseNotes: app.releaseNotes || "",
    allowNetwork: app.allowNetwork || "[]",
    metadata: versionMetadata(app),
    publishedBy: publishedBy || app.uploadedBy,
    status: "active",
    reviewStatus,
  };
  const [version, created] = await MarketAppVersion.findOrCreate({
    where: { appId: app.id, version: app.version },
    defaults: { appId: app.id, version: app.version, ...payload },
  });
  if (!created) await version.update(payload);
  return version;
}

async function canViewApp(app, user) {
  if (!app) return false;
  return app.status === "approved" || isAdmin(user) || (user && user.id === app.uploadedBy);
}

async function createPendingVersion(app, payload, userId, fileSize) {
  const version = String(payload.version || "").trim();
  if (compareVersions(version, app.version) <= 0) {
    const error = new Error(`新版本必须高于当前线上版本 v${app.version}`);
    error.status = 400;
    throw error;
  }
  const existing = await MarketAppVersion.findOne({ where: { appId: app.id, version } });
  if (existing && existing.reviewStatus === "approved") {
    const error = new Error("该版本号已发布，请提高版本号");
    error.status = 409;
    throw error;
  }
  const values = {
    appId: app.id,
    version,
    fileKey: payload.fileKey,
    fileUrl: publicUrl(payload.fileKey),
    size: fileSize,
    releaseNotes: payload.releaseNotes || "",
    allowNetwork: JSON.stringify(parseAllowNetwork(payload.allowNetwork)),
    metadata: versionMetadata(app, {
      name: payload.name,
      icon: payload.icon,
      description: payload.description,
      category: payload.category,
      readme: payload.readme,
      screenshots: Array.isArray(payload.screenshots)
        ? JSON.stringify(payload.screenshots)
        : app.screenshots,
    }),
    publishedBy: userId,
    status: "active",
    reviewStatus: "pending",
  };
  if (existing) {
    await existing.update(values);
    return existing;
  }
  return MarketAppVersion.create(values);
}

async function approveVersion(app, version) {
  const metadata = version.metadata || {};
  await app.update({
    name: metadata.name || app.name,
    icon: metadata.icon || app.icon,
    description: metadata.description ?? app.description,
    category: metadata.category ?? app.category,
    readme: metadata.readme ?? app.readme,
    screenshots: metadata.screenshots ?? app.screenshots,
    version: version.version,
    fileKey: version.fileKey,
    fileUrl: version.fileUrl,
    size: version.size,
    releaseNotes: version.releaseNotes || "",
    allowNetwork: version.allowNetwork || "[]",
    status: "approved",
    isListed: true,
  });
  await version.update({ reviewStatus: "approved", status: "active" });
}

// 把（DB 存入的 JSON 串或前端传入的数组）统一规整为字符串域名数组；
// 仅保留字符串元素，过滤空值，避免注入非字符串内容。
function parseAllowNetwork(raw) {
  const arr = Array.isArray(raw)
    ? raw
    : typeof raw === "string" && raw.trim()
      ? (() => {
          try {
            return JSON.parse(raw);
          } catch {
            return raw.split(/[,\s]+/).filter(Boolean);
          }
        })()
      : [];
  if (!Array.isArray(arr)) return [];
  return arr.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim());
}

// 获取分类列表（只统计已通过的应用，单次 GROUP BY 查询，避免 N+1）
router.get("/categories", async (req, res) => {
  const rows = await MarketApp.findAll({
    attributes: ["category", [fn("COUNT", col("id")), "count"]],
    where: { status: "approved", isListed: true },
    group: ["category"],
    raw: true,
  });
  const data = rows
    .filter((r) => r.category)
    .map((r) => ({ name: r.category, count: Number(r.count) }));
  res.json({ success: true, data });
});

// 获取应用列表（公开市场只返回已通过的应用）
router.get("/apps", optionalAuth, async (req, res) => {
  const { category, keyword, page = "1", limit = "20" } = req.query;
  const pageNum = Math.max(1, parseInt(page));
  const limitNum = Math.min(50, Math.max(1, parseInt(limit)));
  const offset = (pageNum - 1) * limitNum;

  const where = {};
  // 非管理员只看到已通过的应用
  if (!isAdmin(req.user)) {
    where.status = "approved";
    where.isListed = true;
  }
  if (category) {
    where.category = category;
  }
  if (keyword) {
    where[Op.or] = [
      { name: { [Op.like]: `%${keyword}%` } },
      { description: { [Op.like]: `%${keyword}%` } },
    ];
  }

  const attributes = [
    "id",
    "name",
    "icon",
    "description",
    "version",
    "author",
    "category",
    "size",
    "isOfficial",
    "isListed",
    "downloads",
    "status",
    "allowNetwork",
    "createdAt",
    "updatedAt",
  ];

  const { rows, count } = await MarketApp.findAndCountAll({
    where,
    attributes,
    order: [["createdAt", "DESC"]],
    offset,
    limit: limitNum,
  });

  res.json({
    success: true,
    data: {
      items: rows.map((r) => {
        const d = r.toJSON();
        d.allowNetwork = parseAllowNetwork(d.allowNetwork);
        return d;
      }),
      total: count,
      page: pageNum,
      limit: limitNum,
      totalPages: Math.ceil(count / limitNum),
    },
  });
});

// 获取应用详情
router.get("/apps/:id", optionalAuth, async (req, res) => {
  const app = await MarketApp.findByPk(req.params.id, {
    attributes: [
      "id",
      "name",
      "icon",
      "description",
      "version",
      "author",
      "category",
      "size",
      "screenshots",
      "readme",
      "releaseNotes",
      "isOfficial",
      "isListed",
      "downloads",
      "status",
      "fileKey",
      "fileUrl",
      "uploadedBy",
      "allowNetwork",
      "createdAt",
      "updatedAt",
    ],
  });

  if (!app) {
    return res.status(404).json({ error: "应用不存在" });
  }

  // 非管理员且非上传者只能查看已通过的应用
  const isOwner = req.user && req.user.id === app.uploadedBy;
  if (app.status !== "approved" && !isAdmin(req.user) && !isOwner) {
    return res.status(404).json({ error: "应用不存在" });
  }

  const data = app.toJSON();
  data.allowNetwork = parseAllowNetwork(data.allowNetwork);
  if (data.screenshots) {
    try {
      data.screenshots = JSON.parse(data.screenshots);
    } catch {
      data.screenshots = [];
    }
  }

  res.json({ success: true, data });
});

// 获取版本历史。普通用户只看到可用版本，管理员和上传者可看到已下架版本。
router.get("/apps/:id/versions", optionalAuth, async (req, res) => {
  const app = await MarketApp.findByPk(req.params.id);
  if (!(await canViewApp(app, req.user))) {
    return res.status(404).json({ error: "应用不存在" });
  }
  const privileged = isAdmin(req.user) || (req.user && req.user.id === app.uploadedBy);
  const versions = await MarketAppVersion.findAll({
    where: {
      appId: app.id,
      ...(privileged ? {} : { status: "active", reviewStatus: "approved" }),
    },
    attributes: ["id", "version", "size", "releaseNotes", "status", "reviewStatus", "createdAt", "updatedAt"],
    order: [["createdAt", "DESC"]],
  });
  res.json({ success: true, data: versions });
});

// 下载指定历史版本。
router.get("/apps/:id/versions/:versionId/download", async (req, res) => {
  const app = await MarketApp.findByPk(req.params.id, { attributes: ["id", "name", "status"] });
  const version = await MarketAppVersion.findOne({
    where: {
      id: req.params.versionId,
      appId: req.params.id,
      status: "active",
      reviewStatus: "approved",
    },
  });
  if (!app || app.status !== "approved" || !version) {
    return res.status(404).json({ error: "应用版本不存在或已下架" });
  }
  MarketApp.increment("downloads", { by: 1, where: { id: app.id } }).catch(() => {});
  res.json({
    success: true,
    data: {
      name: app.name,
      version: version.version,
      fileUrl: version.fileUrl || publicUrl(version.fileKey),
      allowNetwork: parseAllowNetwork(version.allowNetwork),
    },
  });
});

// 管理员下架/恢复版本。下架当前版本时自动回退市场最新版。
router.put(
  "/apps/:id/versions/:versionId/status",
  authMiddleware,
  adminOnly,
  async (req, res) => {
    const status = req.body?.status;
    if (!['active', 'yanked'].includes(status)) {
      return res.status(400).json({ error: "版本状态无效" });
    }
    const app = await MarketApp.findByPk(req.params.id);
    const version = await MarketAppVersion.findOne({
      where: { id: req.params.versionId, appId: req.params.id },
    });
    if (!app || !version) return res.status(404).json({ error: "应用版本不存在" });

    if (status === "yanked" && version.version === app.version) {
      const fallback = await MarketAppVersion.findOne({
        where: {
          appId: app.id,
          status: "active",
          reviewStatus: "approved",
          id: { [Op.ne]: version.id },
        },
        order: [["createdAt", "DESC"]],
      });
      if (!fallback) {
        return res.status(400).json({ error: "当前版本是唯一可用版本，无法下架" });
      }
      await app.update({
        version: fallback.version,
        fileKey: fallback.fileKey,
        fileUrl: fallback.fileUrl,
        size: fallback.size,
        releaseNotes: fallback.releaseNotes || "",
        allowNetwork: fallback.allowNetwork || "[]",
      });
    }

    await version.update({ status });
    res.json({ success: true, data: { id: version.id, status } });
  },
);

// 下载应用 JS 包（只允许下载已通过的应用）
router.get("/apps/:id/download", async (req, res) => {
  const app = await MarketApp.findByPk(req.params.id, {
    attributes: ["fileKey", "fileUrl", "name", "version", "status"],
  });

  if (!app) {
    return res.status(404).json({ error: "应用不存在" });
  }

  if (app.status !== "approved") {
    return res.status(403).json({ error: "应用尚未通过审核" });
  }

  // 增加下载计数（异步，不阻塞）
  MarketApp.increment("downloads", {
    by: 1,
    where: { id: req.params.id },
  }).catch(() => {});

  const fileUrl = app.fileKey ? app.fileUrl || publicUrl(app.fileKey) : null;
  res.json({
    success: true,
    data: {
      name: app.name,
      version: app.version,
      fileUrl,
    },
  });
});

// 上传应用（任何登录用户都可以上传，状态为 pending）
router.post("/apps", authMiddleware, async (req, res) => {
  const {
    name,
    icon,
    description,
    version,
    category,
    fileKey,
    fileSize,
    screenshots,
    readme,
    releaseNotes,
    allowNetwork,
  } = req.body;

  if (
    !name ||
    !icon ||
    !fileKey ||
    !fileKey.startsWith(`apps/${req.user.id}/`)
  ) {
    return res.status(400).json({ error: "名称、图标和应用文件不能为空" });
  }
  if (version && !VERSION_RE.test(String(version).trim())) {
    return res.status(400).json({ error: "版本号格式无效，请使用如 1.2.0 或 1.2.0-beta.1" });
  }
  const fileObject = await headObject(fileKey).catch(() => null);
  if (
    !fileObject ||
    !fileObject.ContentLength ||
    fileObject.ContentLength > 10 * 1024 * 1024
  ) {
    return res.status(400).json({ error: "应用文件不存在或大小不符合要求" });
  }

  if (Array.isArray(screenshots) && screenshots.length > 3) {
    return res.status(400).json({ error: "最多上传 3 张截图" });
  }

  // 幂等发布：同名 + 同作者已存在则更新（官方重发直接通过审核），否则新建
  const existing = await MarketApp.findOne({ where: { name, uploadedBy: req.user.id } });
  if (existing) {
    await recordVersion(existing, existing.uploadedBy);
    if (!isAdmin(req.user)) {
      const pending = await createPendingVersion(
        existing,
        req.body,
        req.user.id,
        fileObject.ContentLength || Number(fileSize),
      );
      return res.status(202).json({
        success: true,
        message: "新版本已提交审核",
        data: {
          id: existing.id,
          name: existing.name,
          version: pending.version,
          status: pending.reviewStatus,
          versionId: pending.id,
        },
      });
    }
    await existing.update({
      icon,
      description: description || existing.description || "",
      version: version || existing.version,
      category: category || existing.category,
      fileKey,
      fileUrl: publicUrl(fileKey),
      size: fileObject.ContentLength || Number(fileSize) || existing.size,
      readme: readme || existing.readme || "",
      releaseNotes: releaseNotes || "",
      allowNetwork: JSON.stringify(parseAllowNetwork(allowNetwork)),
      status: isAdmin(req.user) ? "approved" : existing.status,
    });
    await recordVersion(existing, req.user.id);
    return res.status(200).json({
      success: true,
      message: "更新成功",
      data: { id: existing.id, name: existing.name, version: existing.version, status: existing.status },
    });
  }

  const app = await MarketApp.create({
    name,
    icon,
    description: description || "",
    version: version || "1.0.0",
    author: req.user.username,
    category: category || "",
    fileKey,
    fileUrl: publicUrl(fileKey),
    size: fileObject.ContentLength || Number(fileSize) || null,
    screenshots: screenshots ? JSON.stringify(screenshots) : null,
    readme: readme || "",
    releaseNotes: releaseNotes || "",
    allowNetwork: JSON.stringify(parseAllowNetwork(allowNetwork)),
    uploadedBy: req.user.id,
    status: isAdmin(req.user) ? "approved" : "pending",
    isListed: true,
  });
  await recordVersion(app, req.user.id, isAdmin(req.user) ? "approved" : "pending");

  res.status(201).json({
    success: true,
    message: "上传成功，等待管理员审核",
    data: {
      id: app.id,
      name: app.name,
      version: app.version,
      status: app.status === "approved" ? "approved" : "pending",
    },
  });
});

// 审核通过应用
router.post(
  "/apps/:id/approve",
  authMiddleware,
  adminOnly,
  async (req, res) => {
    const app = await MarketApp.findByPk(req.params.id);
    if (!app) {
      return res.status(404).json({ error: "应用不存在" });
    }
    if (app.status === "approved") {
      return res.status(400).json({ error: "应用已通过审核" });
    }

    const version = await MarketAppVersion.findOne({
      where: { appId: app.id, version: app.version },
    });
    if (version) await approveVersion(app, version);
    else {
      await app.update({ status: "approved", isListed: true });
      await recordVersion(app, req.user.id, "approved");
    }

    res.json({
      success: true,
      message: "应用已通过审核",
    });
  },
);

// 审核拒绝应用
router.post("/apps/:id/reject", authMiddleware, adminOnly, async (req, res) => {
  const app = await MarketApp.findByPk(req.params.id);
  if (!app) {
    return res.status(404).json({ error: "应用不存在" });
  }
  if (app.status === "rejected") {
    return res.status(400).json({ error: "应用已被拒绝" });
  }

  await app.update({ status: "rejected" });
  await MarketAppVersion.update(
    { reviewStatus: "rejected" },
    { where: { appId: app.id, reviewStatus: "pending" } },
  );

  res.json({
    success: true,
    message: "应用已拒绝",
  });
});

router.get("/admin/pending-versions", authMiddleware, adminOnly, async (req, res) => {
  const versions = await MarketAppVersion.findAll({
    where: { reviewStatus: "pending" },
    order: [["createdAt", "ASC"]],
  });
  const apps = await MarketApp.findAll({
    where: { id: { [Op.in]: [...new Set(versions.map((version) => version.appId))] } },
    attributes: ["id", "name", "icon", "uploadedBy", "version", "status"],
  });
  const appMap = new Map(apps.map((app) => [app.id, app.toJSON()]));
  res.json({
    success: true,
    data: versions.map((version) => ({
      ...version.toJSON(),
      app: appMap.get(version.appId),
    })),
  });
});

router.post(
  "/apps/:id/versions/:versionId/approve",
  authMiddleware,
  adminOnly,
  async (req, res) => {
    const app = await MarketApp.findByPk(req.params.id);
    const version = await MarketAppVersion.findOne({
      where: { id: req.params.versionId, appId: req.params.id, reviewStatus: "pending" },
    });
    if (!app || !version) return res.status(404).json({ error: "待审核版本不存在" });
    if (app.status === "approved" && compareVersions(version.version, app.version) <= 0) {
      return res.status(409).json({
        error: `线上版本已是 v${app.version}，不能批准较低或相同版本`,
      });
    }
    await approveVersion(app, version);
    res.json({ success: true, message: `v${version.version} 已通过审核` });
  },
);

router.post(
  "/apps/:id/versions/:versionId/reject",
  authMiddleware,
  adminOnly,
  async (req, res) => {
    const app = await MarketApp.findByPk(req.params.id);
    const version = await MarketAppVersion.findOne({
      where: { id: req.params.versionId, appId: req.params.id, reviewStatus: "pending" },
    });
    if (!app || !version) return res.status(404).json({ error: "待审核版本不存在" });
    await version.update({ reviewStatus: "rejected" });
    if (app.status === "pending") await app.update({ status: "rejected" });
    res.json({ success: true, message: `v${version.version} 已拒绝` });
  },
);

// 更新应用
router.put("/apps/:id", authMiddleware, adminOnly, async (req, res) => {
  const app = await MarketApp.findByPk(req.params.id);

  if (!app) {
    return res.status(404).json({ error: "应用不存在" });
  }

  const {
    name,
    icon,
    description,
    version,
    category,
    fileKey,
    screenshots,
    readme,
    releaseNotes,
    status,
    allowNetwork,
    isOfficial,
  } = req.body;

  const updateData = {};
  if (Array.isArray(screenshots) && screenshots.length > 3) {
    return res.status(400).json({ error: "最多上传 3 张截图" });
  }
  if (version !== undefined && !VERSION_RE.test(String(version).trim())) {
    return res.status(400).json({ error: "版本号格式无效，请使用如 1.2.0 或 1.2.0-beta.1" });
  }
  if (name !== undefined) updateData.name = name;
  if (icon !== undefined) updateData.icon = icon;
  if (description !== undefined) updateData.description = description;
  if (version !== undefined) updateData.version = version;
  if (category !== undefined) updateData.category = category;
  if (Array.isArray(screenshots))
    updateData.screenshots = JSON.stringify(screenshots);
  if (readme !== undefined) updateData.readme = readme;
  if (releaseNotes !== undefined) updateData.releaseNotes = releaseNotes;
  if (status !== undefined) updateData.status = status;
  if (allowNetwork !== undefined)
    updateData.allowNetwork = JSON.stringify(parseAllowNetwork(allowNetwork));
  if (isOfficial !== undefined) updateData.isOfficial = !!isOfficial;

  if (fileKey !== undefined) {
    if (typeof fileKey !== "string" || !fileKey.startsWith("apps/")) {
      return res.status(400).json({ error: "应用文件路径无效" });
    }
    updateData.fileKey = fileKey;
    updateData.fileUrl = publicUrl(fileKey);
  }

  await recordVersion(app, app.uploadedBy);
  await app.update(updateData);
  await recordVersion(app, req.user.id);

  res.json({
    success: true,
    message: "更新成功",
  });
});

// 删除应用
router.delete("/apps/:id", authMiddleware, adminOnly, async (req, res) => {
  const app = await MarketApp.findByPk(req.params.id);

  if (!app) {
    return res.status(404).json({ error: "应用不存在" });
  }

  const versions = await MarketAppVersion.findAll({ where: { appId: app.id } });
  const keys = new Set(versions.map((version) => version.fileKey).filter(Boolean));
  if (app.fileKey) keys.add(app.fileKey);
  await Promise.all([...keys].map((key) => deleteObject(key).catch(() => {})));
  await MarketAppVersion.destroy({ where: { appId: app.id } });
  await app.destroy();

  res.json({
    success: true,
    message: "删除成功",
  });
});

module.exports = router;
