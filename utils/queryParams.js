/** 分页参数转换为有界正整数：非法值使用 fallback，超出 max 时截断。 */

/** 限制页数，避免计算出过大的数据库偏移量。 */
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

/** 限制批量查询规模，避免过长的 IN 条件。 */
const MAX_BATCH_IDS = 100;

/**
 * 解析逗号分隔字符串或数组，过滤非法 id 并去重。
 * 要求完整十进制正整数，避免将 1abc、1.5 等输入误解为其他资源 id。
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

/** 路径 id 必须完整匹配十进制正整数且处于安全整数范围；不提供默认值。 */
function isPositiveIntParam(raw) {
  const text = String(raw ?? "");
  if (!/^[1-9]\d*$/.test(text)) return false;
  return Number.isSafeInteger(Number(text));
}

module.exports = { toBoundedInt, MAX_PAGE, parseIdList, MAX_BATCH_IDS, isPositiveIntParam };
