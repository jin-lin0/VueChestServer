/**
 * 进程内 TTL 缓存 + 同 key 并发合并（in-flight coalescing）。
 *
 * 存在的理由：本服务有几处「把第三方上游的只读结果原样转发」的路由
 * （`routes/stockResearch.js` 的腾讯行情、`routes/netease.js` 的网易云音乐）。
 * 这些上游的共同点是：
 *
 * 1. **慢**——一次未命中就是 100~300ms 的出网往返，而调用方（股票页 60 秒轮询、
 *    音乐页首屏 7 个并发请求）会反复打同一批 URL；
 * 2. **同 key 并发重复**——首屏多个组件同时要同一份数据时，没合并就会有 N 个出网请求；
 * 3. **失败不能缓存**——上游抖一下就把错误缓存住，等于把一次瞬时故障放大成整个 TTL 内全挂。
 *
 * 所以这里只做三件事，不做更多：查表、合并、以及**只缓存成功结果**。
 * 明确不做的：不做过期后台刷新、不做持久化、不做跨进程共享——本服务是单进程，
 * 引入这些只会多出一堆失效路径。
 */

/**
 * @param {object} [options]
 * @param {number} [options.maxEntries=256] 最多保留多少条。超出时按**插入顺序**淘汰最旧的一条
 *   （Map 保序，取第一个 key 即可）。故意不做 LRU 刷新：命中时改动 Map 顺序会让
 *   淘汰行为依赖访问序列、更难推理，而这里要的只是「内存有上限」。
 * @param {number} [options.maxValueBytes=Infinity] 单条值超过这个字节数就**不入缓存**
 *   （仍然照常返回给调用方）。条数上限管不住内存：一条 400KB 的响应在 V8 堆里往往
 *   是好几 MB，几十条就能吃掉几十 MB。默认不限，只有明确知道值会很大的缓存才需要传。
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
