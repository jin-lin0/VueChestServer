/** 进程内 TTL 缓存，合并相同 key 的并发加载；只缓存成功结果。 */

/**
 * @param {object} [options]
 * @param {number} [options.maxEntries=256] 最大条目数，超出时按插入顺序淘汰
 * @param {number} [options.maxValueBytes=Infinity] 单条序列化字节上限，超限结果仍返回但不缓存
 * @returns {{ get: Function, prune: Function, clear: Function, size: () => number }}
 */
function createTtlCache({
  maxEntries = 256,
  maxValueBytes = Infinity,
} = {}) {
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new TypeError("maxEntries 必须是正整数");
  }
  if (typeof maxValueBytes !== "number" || Number.isNaN(maxValueBytes)) {
    throw new TypeError("maxValueBytes 必须是数字");
  }

  /** @type {Map<string, { expiresAt: number, value: unknown }>} */
  const cache = new Map();
  /** @type {Map<string, Promise<unknown>>} */
  const inFlight = new Map();

  /** 粗估一个值占多少字节。算不出来（循环引用等）时按「不可缓存」处理。 */
  function sizeOf(value) {
    if (typeof value === "string") return value.length;
    try {
      const json = JSON.stringify(value);
      return json === undefined ? 0 : json.length;
    } catch {
      return Infinity;
    }
  }

  /** 清掉已过期的条目。过期条目留在 Map 里会白占 maxEntries 配额。 */
  function prune(now = Date.now()) {
    for (const [key, entry] of cache) {
      if (entry.expiresAt <= now) cache.delete(key);
    }
  }

  function write(key, value, ttl) {
    // maxValueBytes 默认为 Infinity，这条判断整个跳过，省掉一次多余的序列化。
    if (maxValueBytes !== Infinity && sizeOf(value) > maxValueBytes) return;
    // 先腾位置再写，保证 size 永远不超过 maxEntries（先写后腾会短暂越界）。
    if (cache.size >= maxEntries) cache.delete(cache.keys().next().value);
    cache.set(key, {
      expiresAt: Date.now() + (typeof ttl === "function" ? ttl(value) : ttl),
      value,
    });
  }

  /**
   * 取缓存；未命中则调 `loader()` 并写入。同 key 的并发调用共用同一个 loader 结果。
   * `loader()` 抛错时**不写缓存**，并立刻释放 in-flight 槽位，让下一个请求能重试。
   */
  async function get(key, ttl, loader) {
    prune();
    const hit = cache.get(key);
    if (hit) return hit.value;

    const pending = inFlight.get(key);
    if (pending) return pending;

    const task = (async () => {
      const value = await loader();
      write(key, value, ttl);
      return value;
    })();
    inFlight.set(key, task);
    try {
      return await task;
    } finally {
      inFlight.delete(key);
    }
  }

  return {
    get,
    prune,
    clear: () => {
      cache.clear();
      inFlight.clear();
    },
    size: () => cache.size,
  };
}

module.exports = { createTtlCache };
