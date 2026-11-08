const MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

module.exports = function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => MAP[ch]);
};
