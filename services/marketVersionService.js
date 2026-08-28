const MarketAppVersion = require("../models/marketAppVersion");
const MarketAppVersionReview = require("../models/marketAppVersionReview");
const { isAdmin } = require("../middleware/superAdmin");
const { publicUrl } = require("../utils/r2");
const { normalizeSha256 } = require("../utils/bundleIntegrity");

const VERSION_RE =
  /^v?\d+(?:\.\d+){0,3}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const REVIEW_CATEGORIES = new Set([
  "functionality",
  "security",
  "metadata",
  "compatibility",
  "other",
]);

function reviewFeedback(body, required = false) {
  if (!required && !body?.category && !String(body?.message || "").trim()) {
    return { category: null, message: "" };
  }
  const category = String(body?.category || "other").trim();
  const message = String(body?.message || "").trim();
  if (!REVIEW_CATEGORIES.has(category)) {
    const error = new Error("审核问题类型无效");
    error.status = 400;
    throw error;
  }
  if (required && message.length < 2) {
    const error = new Error("拒绝时必须填写至少 2 个字符的原因");
    error.status = 400;
    throw error;
  }
  if (message.length > 1000) {
    const error = new Error("审核意见不能超过 1000 个字符");
    error.status = 400;
    throw error;
  }
  return { category, message };
}

async function recordReview(version, actorId, action, feedback = {}) {
  return MarketAppVersionReview.create({
    appId: version.appId,
    versionId: version.id,
    actorId,
    action,
    category: feedback.category || null,
    message: feedback.message || null,
  });
}

function parseVersion(value) {
  const [main, prerelease = ""] = String(value || "0")
    .replace(/^v/i, "")
    .split("-", 2);
  return {
    parts: main.split(".").map((part) => parseInt(part, 10) || 0),
    prerelease,
  };
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
    sha256: app.sha256 || null,
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

function canViewApp(app, user) {
  if (!app) return false;
  return (
    app.status === "approved" ||
    isAdmin(user) ||
    (user && user.id === app.uploadedBy)
  );
}

async function createPendingVersion(app, payload, userId, fileSize) {
  const version = String(payload.version || "").trim();
  if (compareVersions(version, app.version) <= 0) {
    const error = new Error(`新版本必须高于当前线上版本 v${app.version}`);
    error.status = 400;
    throw error;
  }
  const existing = await MarketAppVersion.findOne({
    where: { appId: app.id, version },
  });
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
    sha256: normalizeSha256(payload.sha256, true),
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
    reviewCategory: null,
    reviewNote: null,
    reviewedBy: null,
    reviewedAt: null,
  };
  let pending;
  if (existing) {
    await existing.update({
      ...values,
      submissionCount: Number(existing.submissionCount || 1) + 1,
    });
    pending = existing;
  } else {
    pending = await MarketAppVersion.create({ ...values, submissionCount: 1 });
  }
  await recordReview(pending, userId, existing ? "resubmitted" : "submitted");
  return pending;
}

async function approveVersion(app, version, reviewerId, feedback = {}) {
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
    sha256: version.sha256 || null,
    status: "approved",
    isListed: true,
  });
  await version.update({
    reviewStatus: "approved",
    status: "active",
    reviewCategory: feedback.category || null,
    reviewNote: feedback.message || null,
    reviewedBy: reviewerId,
    reviewedAt: new Date(),
  });
  await recordReview(version, reviewerId, "approved", feedback);
}

function parseAllowNetwork(raw) {
  const values = Array.isArray(raw)
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
  if (!Array.isArray(values)) return [];
  return values
    .filter((value) => typeof value === "string" && value.trim())
    .map((value) => value.trim());
}

module.exports = {
  VERSION_RE,
  approveVersion,
  canViewApp,
  compareVersions,
  createPendingVersion,
  parseAllowNetwork,
  recordReview,
  recordVersion,
  reviewFeedback,
};
