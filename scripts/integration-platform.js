require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const crypto = require("crypto");
const sequelize = require("../config/database");
const User = require("../models/user");
const UserSession = require("../models/userSession");
const UserWorkspace = require("../models/userWorkspace");
const WorkspaceTemplate = require("../models/workspaceTemplate");
const MarketApp = require("../models/marketApp");
const MarketAppVersion = require("../models/marketAppVersion");

const API_BASE = process.env.TEST_API_BASE || "http://127.0.0.1:3000";

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || `${path} returned ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return body;
}

async function main() {
  const suffix = crypto.randomBytes(5).toString("hex");
  const username = `it_${suffix}`;
  const password = `Pass_${suffix}_123`;
  let user;
  let shareCode;
  let testApp;

  try {
    user = await User.create({
      username,
      password,
      email: `${username}@example.invalid`,
      role: "admin",
      isActive: true,
      installedApps: [],
    });

    const login = await request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
      headers: { "User-Agent": "VueChest Integration Test" },
    });
    const token = login.data.token;
    const authHeaders = { Authorization: `Bearer ${token}` };

    const sessions = await request("/api/auth/sessions", { headers: authHeaders });
    if (sessions.data.length !== 1 || !sessions.data[0].isCurrent) {
      throw new Error("session list did not identify the current device");
    }

    const cloudConfig = {
      version: 1,
      workspaces: [
        { id: `test-${suffix}`, name: "集成测试", icon: "T", items: [{ appKey: "builtin:1" }] },
      ],
      updatedAt: Date.now(),
    };
    await request("/api/auth/workspace", {
      method: "PUT",
      headers: authHeaders,
      body: JSON.stringify({ config: cloudConfig }),
    });
    const cloud = await request("/api/auth/workspace", { headers: authHeaders });
    if (cloud.data.config.workspaces[0].name !== "集成测试") {
      throw new Error("cloud workspace round trip failed");
    }

    const shared = await request("/api/workspace-templates", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        template: {
          version: 1,
          name: "集成模板",
          icon: "T",
          description: "temporary integration fixture",
          appKeys: ["builtin:1", "market:999999"],
        },
      }),
    });
    shareCode = shared.data.shareCode;
    const fetched = await request(`/api/workspace-templates/${shareCode}`);
    if (fetched.data.template.appKeys.length !== 2) {
      throw new Error("shared template round trip failed");
    }
    await request(`/api/workspace-templates/${shareCode}/use`, { method: "POST" });
    await request(`/api/workspace-templates/${shareCode}`, {
      method: "DELETE",
      headers: authHeaders,
    });
    shareCode = undefined;

    testApp = await MarketApp.create({
      name: `版本测试_${suffix}`,
      icon: "T",
      description: "temporary version fixture",
      version: "2.0.0",
      author: username,
      category: "工具",
      fileKey: `apps/${user.id}/fixture-v2.js`,
      fileUrl: "https://example.invalid/fixture-v2.js",
      size: 20,
      releaseNotes: "v2",
      allowNetwork: "[]",
      uploadedBy: user.id,
      status: "approved",
    });
    const v1 = await MarketAppVersion.create({
      appId: testApp.id,
      version: "1.0.0",
      fileKey: `apps/${user.id}/fixture-v1.js`,
      fileUrl: "https://example.invalid/fixture-v1.js",
      size: 10,
      releaseNotes: "v1",
      allowNetwork: "[]",
      publishedBy: user.id,
      status: "active",
    });
    const v2 = await MarketAppVersion.create({
      appId: testApp.id,
      version: "2.0.0",
      fileKey: testApp.fileKey,
      fileUrl: testApp.fileUrl,
      size: 20,
      releaseNotes: "v2",
      allowNetwork: "[]",
      publishedBy: user.id,
      status: "active",
    });
    const history = await request(`/api/market/apps/${testApp.id}/versions`);
    if (history.data.length !== 2) throw new Error("version history did not return both releases");
    await request(`/api/market/apps/${testApp.id}/versions/${v2.id}/status`, {
      method: "PUT",
      headers: authHeaders,
      body: JSON.stringify({ status: "yanked" }),
    });
    await testApp.reload();
    if (testApp.version !== v1.version) throw new Error("yanking current version did not roll back market latest");

    await request("/api/auth/workspace", { method: "DELETE", headers: authHeaders });
    await request("/api/auth/logout", { method: "POST", headers: authHeaders });

    let revoked = false;
    try {
      await request("/api/auth/sessions", { headers: authHeaders });
    } catch (error) {
      revoked = error.status === 401;
    }
    if (!revoked) throw new Error("revoked token remained usable");

    console.log("PLATFORM_INTEGRATION_OK", JSON.stringify({ sessions: true, cloud: true, templates: true, versions: true, revoke: true }));
  } finally {
    if (testApp) {
      await MarketAppVersion.destroy({ where: { appId: testApp.id }, force: true });
      await testApp.destroy({ force: true });
    }
    if (user) {
      await Promise.all([
        UserSession.destroy({ where: { userId: user.id }, force: true }),
        UserWorkspace.destroy({ where: { userId: user.id }, force: true }),
        WorkspaceTemplate.destroy({ where: { createdBy: user.id }, force: true }),
      ]);
      await user.destroy({ force: true });
    } else if (shareCode) {
      await WorkspaceTemplate.destroy({ where: { shareCode }, force: true });
    }
    await sequelize.close();
  }
}

main().catch((error) => {
  console.error("PLATFORM_INTEGRATION_FAILED", error.message);
  process.exitCode = 1;
});
