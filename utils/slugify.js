// 把名字转成安全、可读的文件名（保留中英文和数字，去掉路径分隔符等危险字符）。
// uploads 预签名与 R2 迁移脚本共用，保证命名规则一致。
function slugify(input, fallback) {
  const base = String(input || "")
    .normalize("NFKC")
    .trim()
    .replace(/\.[^.]+$/, ""); // 去掉原始扩展名，避免出现双扩展名
  const cleaned = base
    .replace(/[^\p{L}\p{N}._-]+/gu, "-") // 只保留字母/数字/点/下划线/连字符，其余转为 -
    .replace(/^[-_.]+|[-_.]+$/g, "") // 去掉首尾的分隔符
    .slice(0, 60);
  return cleaned || fallback;
}

module.exports = slugify;
