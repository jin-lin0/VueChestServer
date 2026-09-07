async function* readSseData(body, signal) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let data = [];
  const checkAborted = () => {
    if (signal?.aborted) throw new DOMException("请求已取消", "AbortError");
  };
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    checkAborted();
    while (true) {
      const { done, value } = await reader.read();
      checkAborted();
      buffer += done
        ? decoder.decode()
        : decoder.decode(value, { stream: true });
      let end;
      while ((end = buffer.search(/[\r\n]/)) >= 0) {
        if (!done && buffer[end] === "\r" && end === buffer.length - 1) break;
        const line = buffer.slice(0, end);
        const length = buffer[end] === "\r" && buffer[end + 1] === "\n" ? 2 : 1;
        buffer = buffer.slice(end + length);
        checkAborted();
        if (!line) {
          if (data.length) yield data.join("\n");
          data = [];
        } else if (line === "data" || line.startsWith("data:")) {
          data.push(line.slice(5).replace(/^ /, ""));
        }
      }
      if (done) break;
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    try {
      await reader.cancel();
    } catch {}
    reader.releaseLock();
  }
}
module.exports = { readSseData };
