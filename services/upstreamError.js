function upstreamError(message, status = 502) {
  const error = new Error(message);
  error.status = status;
  error.code = status === 504 ? "UPSTREAM_TIMEOUT" : "UPSTREAM_ERROR";
  return error;
}

function asUpstreamError(error) {
  if (error.status) return error;
  if (error.name === "AbortError" || error.name === "TimeoutError")
    return upstreamError("行情服务请求超时", 504);
  return upstreamError(error.message || "行情服务请求失败");
}

module.exports = { upstreamError, asUpstreamError };
