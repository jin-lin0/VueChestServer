const express = require("express");
const { Op, fn, col } = require("sequelize");
const MarketApp = require("../models/marketApp");
const MarketAppVersion = require("../models/marketAppVersion");
const MarketAppVersionReview = require("../models/marketAppVersionReview");
const AppReport = require("../models/appReport");
const AppComment = require("../models/appComment");
const { authMiddleware, optionalAuth } = require("../middleware/auth");
const { adminOnly, isAdmin } = require("../middleware/superAdmin");
const { publicUrl, headObject, deleteObject } = require("../utils/r2");
const {
  normalizeSha256,
  assertObjectIntegrity,
} = require("../utils/bundleIntegrity");
const { parsePermissions, serializePermissions } = require("../utils/permissions");
const {
  VERSION_RE,
  approveVersion,
  canViewApp,
  compareVersions,
  createPendingVersion,
  parseAllowNetwork,
  recordReview,
  recordVersion,
  reviewFeedback,
} = require("../services/marketVersionService");
const { safeNotify } = require("../services/notificationService");
const { notifyReviewResult } = require("../services/marketNotifications");

const router = express.Router();
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

// 热门榜：按下载量排序的已上架应用，附带评分聚合（仅统计有打分的可见评论）
router.get("/ranking", async (req, res) => {
  const limitNum = Math.min(30, Math.max(1, parseInt(req.query.limit) || 10));
  const apps = await MarketApp.findAll({
    where: { status: "approved", isListed: true },
    attributes: [
      "id",
      "name",
      "icon",
      "description",
      "category",
      "version",
      "downloads",
      "isOfficial",
    ],
    order: [
      ["downloads", "DESC"],
      ["updatedAt", "DESC"],
    ],
    limit: limitNum,
  });

  const ids = apps.map((app) => app.id);
  const ratingRows = ids.length
    ? await AppComment.findAll({
        attributes: [
          "appId",
          [fn("AVG", col("rating")), "average"],
          [fn("COUNT", col("rating")), "count"],
        ],
        where: {
          appId: { [Op.in]: ids },
          status: "visible",
          rating: { [Op.ne]: null },
        },
        group: ["appId"],
        raw: true,
      })
    : [];
  const ratingMap = new Map(
    ratingRows.map((row) => [
      Number(row.appId),
      {
        average: row.average == null ? null : Number(Number(row.average).toFixed(1)),
        count: Number(row.count) || 0,
      },
    ]),
  );

  res.json({
    success: true,
    data: {
      items: apps.map((app) => {
        const data = app.toJSON();
        data.rating = ratingMap.get(app.id) || { average: null, count: 0 };
        return data;
      }),
    },
  });
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
    "permissions",
    "sha256",
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
        d.permissions = parsePermissions(d.permissions);
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
      "permissions",
      "sha256",
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
  data.permissions = parsePermissions(data.permissions);
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
  const privileged =
    isAdmin(req.user) || (req.user && req.user.id === app.uploadedBy);
  const versions = await MarketAppVersion.findAll({
    where: {
      appId: app.id,
      ...(privileged ? {} : { status: "active", reviewStatus: "approved" }),
    },
    attributes: [
      "id",
      "version",
      "size",
      "releaseNotes",
      "allowNetwork",
      "permissions",
      "sha256",
      "status",
      "reviewStatus",
      "reviewCategory",
      "reviewNote",
      "reviewedAt",
      "submissionCount",
      "createdAt",
      "updatedAt",
    ],
    order: [["createdAt", "DESC"]],
  });
  res.json({
    success: true,
    data: versions.map((version) => {
      const data = version.toJSON();
      data.allowNetwork = parseAllowNetwork(data.allowNetwork);
      data.permissions = parsePermissions(data.permissions);
      return data;
    }),
  });
});

// 下载指定历史版本。
router.get("/apps/:id/versions/:versionId/download", async (req, res) => {
  const app = await MarketApp.findByPk(req.params.id, {
    attributes: ["id", "name", "status"],
  });
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
  MarketApp.increment("downloads", { by: 1, where: { id: app.id } }).catch(
    () => {},
  );
  res.json({
    success: true,
    data: {
      name: app.name,
      version: version.version,
      fileUrl: version.fileUrl || publicUrl(version.fileKey),
      allowNetwork: parseAllowNetwork(version.allowNetwork),
      permissions: parsePermissions(version.permissions),
      sha256: version.sha256 || null,
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
    if (!["active", "yanked"].includes(status)) {
      return res.status(400).json({ error: "版本状态无效" });
    }
    const app = await MarketApp.findByPk(req.params.id);
    const version = await MarketAppVersion.findOne({
      where: { id: req.params.versionId, appId: req.params.id },
    });
    if (!app || !version)
      return res.status(404).json({ error: "应用版本不存在" });

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
        return res
          .status(400)
          .json({ error: "当前版本是唯一可用版本，无法下架" });
      }
      await app.update({
        version: fallback.version,
        fileKey: fallback.fileKey,
        fileUrl: fallback.fileUrl,
        size: fallback.size,
        releaseNotes: fallback.releaseNotes || "",
        allowNetwork: fallback.allowNetwork || "[]",
        permissions: fallback.permissions || "[]",
        sha256: fallback.sha256 || null,
      });
    }

    await version.update({ status });
    res.json({ success: true, data: { id: version.id, status } });
  },
);

// 下载应用 JS 包（只允许下载已通过的应用）
router.get("/apps/:id/download", async (req, res) => {
  const app = await MarketApp.findByPk(req.params.id, {
    attributes: [
      "fileKey",
      "fileUrl",
      "name",
      "version",
      "status",
      "allowNetwork",
      "permissions",
      "sha256",
    ],
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
      allowNetwork: parseAllowNetwork(app.allowNetwork),
      permissions: parsePermissions(app.permissions),
      sha256: app.sha256 || null,
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
    permissions,
    sha256,
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
    return res
      .status(400)
      .json({ error: "版本号格式无效，请使用如 1.2.0 或 1.2.0-beta.1" });
  }
  const fileObject = await headObject(fileKey).catch(() => null);
  if (
    !fileObject ||
    !fileObject.ContentLength ||
    fileObject.ContentLength > 10 * 1024 * 1024
  ) {
    return res.status(400).json({ error: "应用文件不存在或大小不符合要求" });
  }
  const verifiedSha256 = assertObjectIntegrity(fileObject, sha256, true);

  if (Array.isArray(screenshots) && screenshots.length > 3) {
    return res.status(400).json({ error: "最多上传 3 张截图" });
  }

  // 幂等发布：同名 + 同作者已存在则更新（官方重发直接通过审核），否则新建
  const existing = await MarketApp.findOne({
    where: { name, uploadedBy: req.user.id },
  });
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
      permissions: serializePermissions(permissions),
      sha256: verifiedSha256,
      status: isAdmin(req.user) ? "approved" : existing.status,
    });
    await recordVersion(existing, req.user.id);
    return res.status(200).json({
      success: true,
      message: "更新成功",
      data: {
        id: existing.id,
        name: existing.name,
        version: existing.version,
        status: existing.status,
      },
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
    permissions: serializePermissions(permissions),
    sha256: verifiedSha256,
    uploadedBy: req.user.id,
    status: isAdmin(req.user) ? "approved" : "pending",
    isListed: true,
  });
  const createdVersion = await recordVersion(
    app,
    req.user.id,
    isAdmin(req.user) ? "approved" : "pending",
  );
  if (createdVersion) {
    await recordReview(
      createdVersion,
      req.user.id,
      isAdmin(req.user) ? "approved" : "submitted",
    );
  }

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
    const feedback = reviewFeedback(req.body);
    if (version) await approveVersion(app, version, req.user.id, feedback);
    else {
      await app.update({ status: "approved", isListed: true });
      await recordVersion(app, req.user.id, "approved");
    }

    await safeNotify(
      notifyReviewResult({
        app,
        version,
        approved: true,
        category: feedback.category,
        note: feedback.message,
        actorId: req.user.id,
      }),
    );

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

  const feedback = reviewFeedback(req.body, true);
  const versions = await MarketAppVersion.findAll({
    where: { appId: app.id, reviewStatus: "pending" },
  });
  await app.update({ status: "rejected" });
  for (const version of versions) {
    await version.update({
      reviewStatus: "rejected",
      reviewCategory: feedback.category,
      reviewNote: feedback.message,
      reviewedBy: req.user.id,
      reviewedAt: new Date(),
    });
    await recordReview(version, req.user.id, "rejected", feedback);
  }

  await safeNotify(
    notifyReviewResult({
      app,
      version: versions.length === 1 ? versions[0] : null,
      approved: false,
      category: feedback.category,
      note: feedback.message,
      actorId: req.user.id,
    }),
  );

  res.json({
    success: true,
    message: "应用已拒绝",
  });
});

router.get(
  "/admin/pending-versions",
  authMiddleware,
  adminOnly,
  async (req, res) => {
    const versions = await MarketAppVersion.findAll({
      where: { reviewStatus: "pending" },
      order: [["createdAt", "ASC"]],
    });
    const apps = await MarketApp.findAll({
      where: {
        id: { [Op.in]: [...new Set(versions.map((version) => version.appId))] },
      },
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
  },
);

router.post(
  "/apps/:id/versions/:versionId/approve",
  authMiddleware,
  adminOnly,
  async (req, res) => {
    const app = await MarketApp.findByPk(req.params.id);
    const version = await MarketAppVersion.findOne({
      where: {
        id: req.params.versionId,
        appId: req.params.id,
        reviewStatus: "pending",
      },
    });
    if (!app || !version)
      return res.status(404).json({ error: "待审核版本不存在" });
    if (
      app.status === "approved" &&
      compareVersions(version.version, app.version) <= 0
    ) {
      return res.status(409).json({
        error: `线上版本已是 v${app.version}，不能批准较低或相同版本`,
      });
    }
    const approvedFeedback = reviewFeedback(req.body);
    await approveVersion(app, version, req.user.id, approvedFeedback);
    await safeNotify(
      notifyReviewResult({
        app,
        version,
        approved: true,
        category: approvedFeedback.category,
        note: approvedFeedback.message,
        actorId: req.user.id,
      }),
    );
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
      where: {
        id: req.params.versionId,
        appId: req.params.id,
        reviewStatus: "pending",
      },
    });
    if (!app || !version)
      return res.status(404).json({ error: "待审核版本不存在" });
    const feedback = reviewFeedback(req.body, true);
    await version.update({
      reviewStatus: "rejected",
      reviewCategory: feedback.category,
      reviewNote: feedback.message,
      reviewedBy: req.user.id,
      reviewedAt: new Date(),
    });
    await recordReview(version, req.user.id, "rejected", feedback);
    if (app.status === "pending") await app.update({ status: "rejected" });
    await safeNotify(
      notifyReviewResult({
        app,
        version,
        approved: false,
        category: feedback.category,
        note: feedback.message,
        actorId: req.user.id,
      }),
    );
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
    permissions,
    isOfficial,
    sha256,
  } = req.body;

  const updateData = {};
  if (Array.isArray(screenshots) && screenshots.length > 3) {
    return res.status(400).json({ error: "最多上传 3 张截图" });
  }
  if (version !== undefined && !VERSION_RE.test(String(version).trim())) {
    return res
      .status(400)
      .json({ error: "版本号格式无效，请使用如 1.2.0 或 1.2.0-beta.1" });
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
  if (permissions !== undefined)
    updateData.permissions = serializePermissions(permissions);
  if (isOfficial !== undefined) updateData.isOfficial = !!isOfficial;

  if (fileKey !== undefined) {
    if (typeof fileKey !== "string" || !fileKey.startsWith("apps/")) {
      return res.status(400).json({ error: "应用文件路径无效" });
    }
    const fileObject = await headObject(fileKey).catch(() => null);
    if (
      !fileObject?.ContentLength ||
      fileObject.ContentLength > 10 * 1024 * 1024
    ) {
      return res.status(400).json({ error: "应用文件不存在或大小不符合要求" });
    }
    updateData.fileKey = fileKey;
    updateData.fileUrl = publicUrl(fileKey);
    updateData.size = fileObject.ContentLength;
    updateData.sha256 = assertObjectIntegrity(fileObject, sha256, true);
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
  const keys = new Set(
    versions.map((version) => version.fileKey).filter(Boolean),
  );
  if (app.fileKey) keys.add(app.fileKey);
  await Promise.all([...keys].map((key) => deleteObject(key).catch(() => {})));
  await MarketAppVersionReview.destroy({ where: { appId: app.id } });
  await AppReport.destroy({ where: { appId: app.id } });
  await MarketAppVersion.destroy({ where: { appId: app.id } });
  await app.destroy();

  res.json({
    success: true,
    message: "删除成功",
  });
});

module.exports = router;
