const compression = require("compression");

function isStreamingRequest(req) {
  const path = String(req.path || req.originalUrl || "").split("?", 1)[0];
  return (
    path === "/api/ai-chat/chat" ||
    path.startsWith("/api/ai-chat/chat/") ||
    path === "/api/bilibili/analyze/stream" ||
    path === "/api/bilibili/ask/stream"
  );
}

function compressionFilter(req, res) {
  if (isStreamingRequest(req)) return false;
  return compression.filter(req, res);
}

const responseCompression = compression({ filter: compressionFilter });

module.exports = { responseCompression, compressionFilter, isStreamingRequest };
