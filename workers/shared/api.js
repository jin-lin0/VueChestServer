/**
 * worker 与 server 之间的唯一通道：取账号列表、取凭据、上报结果。
 * 只认 CRON_SECRET，不接触任何超管密码或数据库。
 */
function createClient({ server, secret, fetchImpl = fetch, timeoutMs = 15000 }) {
  const base = String(server || "").replace(/\/+$/, "");

  async function call(pathname, options = {}) {
    const response = await fetchImpl(`${base}/api/checkins${pathname}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.success)
      throw new Error(
        payload?.error || `${pathname} 返回 HTTP ${response.status}`,
      );
    return payload.data;
  }

  return {
    async ownerIds(task) {
      const data = await call(`/workers/${encodeURIComponent(task)}/owners`);
      return data.ownerIds;
    },
    async credentials(task, ownerId) {
      const data = await call(
        `/credentials/${encodeURIComponent(task)}?ownerId=${encodeURIComponent(ownerId)}`,
      );
      return data.credentials;
    },
    async report(task, ownerId, result) {
      return call("/report", {
        method: "POST",
        body: JSON.stringify({ ...result, ownerId, task }),
      });
    },
  };
}

module.exports = { createClient };
