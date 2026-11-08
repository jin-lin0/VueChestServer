const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createClient } = require("../workers/shared/api");
const { runTask } = require("../workers/shared/runner");

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  };
}

test("worker 客户端带 Bearer 密钥，按站点取账号与凭据并上报", async () => {
  const calls = [];
  const client = createClient({
    server: "https://example.test/",
    secret: "cron-secret",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith("/owners")) return jsonResponse({ success: true, data: { ownerIds: [2, 3] } });
      if (url.includes("/credentials/"))
        return jsonResponse({ success: true, data: { credentials: { cookie: "sessionid=x" } } });
      return jsonResponse({ success: true, data: { recorded: true } });
    },
  });

  assert.deepEqual(await client.ownerIds("juejin"), [2, 3]);
  assert.deepEqual(await client.credentials("juejin", 3), { cookie: "sessionid=x" });
  await client.report("juejin", 3, { status: "success", summary: "ok", durationMs: 10 });

  assert.match(calls[0].url, /^https:\/\/example\.test\/api\/checkins\/workers\/juejin\/owners$/);
  assert.match(calls[1].url, /\/credentials\/juejin\?ownerId=3$/);
  assert.equal(calls[2].url, "https://example.test/api/checkins/report");
  assert.deepEqual(JSON.parse(calls[2].options.body), {
    status: "success",
    summary: "ok",
    durationMs: 10,
    ownerId: 3,
    task: "juejin",
  });
  for (const call of calls)
    assert.equal(call.options.headers.Authorization, "Bearer cron-secret");
});

test("服务端拒绝时把错误原文抛给调用方", async () => {
  const client = createClient({
    server: "https://example.test",
    secret: "k",
    fetchImpl: async () =>
      jsonResponse({ success: false, error: "尚未录入该站点的凭据" }, 404),
  });
  await assert.rejects(() => client.ownerIds("juejin"), /尚未录入该站点的凭据/);
});

function fakeBrowser(events) {
  return {
    newContext: async (options) => ({
      options,
      newPage: async () => ({
        setDefaultTimeout() {},
        screenshot: async ({ path: file }) => {
          events.push({ type: "screenshot", file });
        },
      }),
      close: async () => {},
    }),
    close: async () => {},
  };
}

function fixture({ owners, run, reports } = {}) {
  const events = [];
  const reported = reports || [];
  const client = {
    ownerIds: async () => owners,
    credentials: async (task, ownerId) => ({ cookie: `sessionid=${ownerId}` }),
    report: async (task, ownerId, result) => {
      reported.push({ task, ownerId, ...result });
    },
  };
  const flow = {
    id: "demo",
    contextOptions: () => ({ locale: "zh-CN" }),
    prepare: async () => {},
    run: async (page, credentials, { capture }) => run(credentials, { capture }),
  };
  return { events, reported, client, flow };
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "worker-debug-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("逐个超管执行，互不影响，成功后各自上报", async (t) => {
  const f = fixture({
    owners: [2, 3],
    run: async (credentials) => ({
      status: "success",
      summary: `cookie=${credentials.cookie}`,
    }),
  });
  const result = await runTask({
    task: "demo",
    flow: f.flow,
    client: f.client,
    launcher: { launch: async () => fakeBrowser(f.events) },
    env: {},
    log: () => {},
    debugDir: tempDir(t),
  });

  assert.deepEqual(result, { total: 2, failed: 0 });
  assert.deepEqual(
    f.reported.map((item) => [item.ownerId, item.status]),
    [
      [2, "success"],
      [3, "success"],
    ],
  );
});

test("上报日志带上摘要，便于直接在 Actions 里看结果", async (t) => {
  const logs = [];
  const f = fixture({
    owners: [2],
    run: async () => ({ status: "already_done", summary: "今天已经签到过了" }),
  });
  await runTask({
    task: "demo",
    flow: f.flow,
    client: f.client,
    launcher: { launch: async () => fakeBrowser(f.events) },
    env: {},
    log: (...args) => logs.push(args.join(" ")),
    debugDir: tempDir(t),
  });

  assert.equal(logs.length, 1);
  assert.match(logs[0], /上报成功：already_done · 今天已经签到过了/);
});

test("一个超管失败仍继续下一个，并各自记录失败", async (t) => {
  const f = fixture({
    owners: [2, 3],
    run: async (credentials) => {
      if (credentials.cookie.endsWith("2")) throw new Error("Cookie 已失效");
      return { status: "success", summary: "ok" };
    },
  });
  const dir = tempDir(t);

  const result = await runTask({
    task: "demo",
    flow: f.flow,
    client: f.client,
    launcher: { launch: async () => fakeBrowser(f.events) },
    env: {},
    log: () => {},
    debugDir: dir,
  });

  assert.deepEqual(result, { total: 2, failed: 1 });
  assert.deepEqual(
    f.reported.map((item) => [item.ownerId, item.status]),
    [
      [2, "failed"],
      [3, "success"],
    ],
  );
  assert.equal(f.events.filter((event) => event.type === "screenshot").length, 1);
});

test("上报失败不会中断后续超管，但会计入失败数", async (t) => {
  const f = fixture({
    owners: [2, 3],
    run: async () => ({ status: "success", summary: "ok" }),
  });
  let call = 0;
  f.client.report = async () => {
    call += 1;
    if (call === 1) throw new Error("网络中断");
  };
  const result = await runTask({
    task: "demo",
    flow: f.flow,
    client: f.client,
    launcher: { launch: async () => fakeBrowser(f.events) },
    env: {},
    log: () => {},
    debugDir: tempDir(t),
  });
  assert.deepEqual(result, { total: 2, failed: 1 });
  assert.equal(call, 2);
});

test("指定 CHECKIN_OWNER_ID 时只跑该超管，不请求账号列表", async (t) => {
  const f = fixture({ owners: [2, 3], run: async () => ({ status: "success", summary: "ok" }) });
  f.client.ownerIds = async () => assert.fail("不应请求账号列表");
  const result = await runTask({
    task: "demo",
    flow: f.flow,
    client: f.client,
    launcher: { launch: async () => fakeBrowser(f.events) },
    env: { CHECKIN_OWNER_ID: "3" },
    log: () => {},
    debugDir: tempDir(t),
  });
  assert.deepEqual(result, { total: 1, failed: 0 });
  assert.equal(f.reported[0].ownerId, 3);
});
