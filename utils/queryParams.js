/**
 * query / params 里的数字收成有界正整数。
 *
 * 为什么需要它：Express 的 query 全是字符串，而把 `parseInt` 的结果直接塞进 SQL
 * 是一类反复踩到的坑 —— `?page=abc` → NaN，`Math.max(1, NaN)` 依然是 NaN；
 * `?limit=-1` → -1。两者都会拼出 `LIMIT -1` / `OFFSET NaN` 这种语法错误，
 * 在免登录路由上就等于「任何人加个参数把接口打成 500」。实测过的现场：
 *   GET /api/questions?limit=-1     → 500 You have an error in your SQL syntax...
 *   GET /api/questions?page=abc     → 500 Undeclared variable: NaN
 *   GET /api/market/apps?page=abc   → 500（market 首页在用的公开接口）
 *   GET /api/market/apps?limit=abc  → 500
 *
 * 语义：非数字 / 0 / 负数 → fallback；超过 max → 截断到 max。
 * 即「坏参数退回默认，超大参数退回上限」，不返回 400 —— 这与这些接口原本
 * `Math.min(50, Math.max(1, ...))` 的意图一致，只是把 NaN 与负数也纳进来。
 */

/**
 * page 只用来算 offset。给个上限，避免 `?page=9.9e19` 把 OFFSET 撑成 SQL 语法错误。
 * 10 万页 × 每页 100 条 = 1000 万条偏移，远超本站数据量。
 */
const MAX_PAGE = 100000;

/**
 * @param {unknown} value    原始 query / params 值（可能是数组，取第一个）
 * @param {object}  options
 * @param {number}  options.fallback 非法值时的回退值
 * @param {number}  [options.max]    上限，超出则截断
 */
function toBoundedInt(value, { fallback, max } = {}) {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return max === undefined ? parsed : Math.min(parsed, max);
}

/**
 * 批量取 id 的上限。真实场景（一次拿十几个已装应用 / 勾选几十道题）远达不到，
 * 同时挡住 `?ids=1,2,3,...`（一万个）这种滥用：它会让 `IN (...)` 长得离谱。
 */
const MAX_BATCH_IDS = 100;

/**
 * 把 `"1,2,3"` / `["1", "2"]` / `[1, 2, 3]` 收成去重、只含正整数的 id 数组。
 *
 * 为什么要有它：进来的东西可能是 query 字符串、也可能是 JSON body 里的数组，
 * 里面可能混着重复项、`abc`、`-1`、`0`、空串。这些如果直通 `Op.in`，
 * 要么无意义地重复查同一行，要么把 0 / 负数当成合法主键（这两个 id 从来不存在，
 * 但会让调用方误以为「请求了 3 个，只删掉 2 个」是数据问题）。
 *
 * 这里刻意用「整段必须都是数字」而不是 `parseInt`：`parseInt("1;2;3")` 会得到 1，
 * 于是 `"1;2;3"` 这种明显坏掉的输入会被静默当成「删 id=1」。对删除类接口，
 * 悄悄删掉一个客户端没打算删的东西，比直接判空拒绝要危险得多。
 * 空 token 仍然放行（`,` 结尾 / `1,,2` 是很常见的拼接结果），其余一律丢弃。
 */
function parseIdList(value) {
  const raw = Array.isArray(value) ? value.join(",") : String(value ?? "");
  const ids = raw
    .split(",")
    .map((item) => String(item).trim())
    .filter((item) => /^[0-9]+$/.test(item))
    .map((item) => Number.parseInt(item, 10))
    .filter((id) => Number.isInteger(id) && id > 0);
  return [...new Set(ids)].slice(0, MAX_BATCH_IDS);
}

/**
 * 单个**路径参数**里的正整数判据。
 *
 * 与 `toBoundedInt` 的分工不同：那个面向 query，语义是「坏参数退回默认值」；
 * 路径参数没有「默认值」可退，一个坏 id 只可能意味着「这个资源不存在」，
 * 所以这里只回答 true/false，由调用方决定回 404 还是 400。
 *
 * 为什么不能用 `parseInt` / `Number`：
 *   parseInt("1.5") → 1    拿调用方指定的 id 去操作**另一个**资源；
 *   parseInt("1e3") → 1    同上；
 *   parseInt("1abc") → 1   同上；
 *   Number("1e3")   → 1000 这个更糟，它指向一个真实存在但没人指定的 id。
 * 只有「整段都是十进制数字」才算合法，且必须在安全整数范围内
 * （超出后 Number() 会丢精度，两个不同的 id 可能化成同一个数）。
 */
function isPositiveIntParam(raw) {
  const text = String(raw ?? "");
  if (!/^[1-9]\d*$/.test(text)) return false;
  return Number.isSafeInteger(Number(text));
}

module.exports = { toBoundedInt, MAX_PAGE, parseIdList, MAX_BATCH_IDS, isPositiveIntParam };
