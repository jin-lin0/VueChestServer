const REQUEST_TIMEOUT_MS = 10000;

function instrument(raw) {
  const text = String(raw || "")
    .trim()
    .toLowerCase();
  const match = /^(sh|sz)(\d{6})$/.exec(text);
  if (!match) {
    const error = new Error("请输入沪深市场代码，例如 sh000001、sz000001");
    error.status = 400;
    error.code = "VALIDATION";
    throw error;
  }
  const code = match[2];
  const market = match[1];
  if (
    !(
      market === "sh"
        ? /^(6\d{5}|5\d{5}|000\d{3})$/
        : /^(0\d{5}|3\d{5}|1[56]\d{4})$/
    ).test(code)
  ) {
    const error = new Error("暂只支持沪深股票、指数与交易所基金");
    error.status = 400;
    error.code = "VALIDATION";
    throw error;
  }
  const type =
    (market === "sh" && code.startsWith("000")) ||
    (market === "sz" && code.startsWith("399"))
      ? "index"
      : (market === "sh" && code.startsWith("5")) ||
          (market === "sz" && code.startsWith("1"))
        ? "fund"
        : "stock";
  return { code, market, symbol: `${market}${code}`, type };
}

function finite(value, divisor = 1) {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number / divisor : null;
}

// All quote consumers use this decoder. Prices: yuan; volume: shares; amount/caps: yuan.
function decodeQuotes(text, symbols, fetchedAt = Date.now()) {
  const fieldsBySymbol = new Map(
    [...text.matchAll(/v_((?:sh|sz)\d{6})="([^"]*)"/g)].map((match) => [
      match[1],
      match[2].split("~"),
    ]),
  );
  return symbols.flatMap((symbol) => {
    const meta = instrument(symbol);
    const fields = fieldsBySymbol.get(symbol);
    if (!fields || fields.length < 50 || (finite(fields[3]) ?? 0) <= 0)
      return [];
    return [
      {
        ...meta,
        source: "tencent",
        fetchedAt,
        asOf: /^\d{14}$/.test(fields[30] || "") ? fields[30] : null,
        name: fields[1] || meta.code,
        price: finite(fields[3]),
        high: finite(fields[33]),
        low: finite(fields[34]),
        open: finite(fields[5]),
        previousClose: finite(fields[4]),
        change: finite(fields[31]),
        changePercent: finite(fields[32]),
        volume: finite(fields[36], 0.01),
        amount: finite(fields[57], 0.0001),
        outerVolume: finite(fields[7], 0.01),
        volumeRatio: finite(fields[49]),
        totalMarketCap: meta.type === "stock" ? finite(fields[45], 1e-8) : null,
        floatMarketCap: meta.type === "stock" ? finite(fields[44], 1e-8) : null,
        pe: meta.type === "stock" ? finite(fields[39]) : null,
        pb: meta.type === "stock" ? finite(fields[46]) : null,
        turnover: finite(fields[38]),
        amplitude: finite(fields[43]),
      },
    ];
  });
}

async function fetchQuotes(symbols) {
  const response = await fetch(`https://qt.gtimg.cn/q=${symbols.join(",")}`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`腾讯行情返回 ${response.status}`);
  const text = new TextDecoder("gbk").decode(await response.arrayBuffer());
  return decodeQuotes(text, symbols);
}

module.exports = { instrument, finite, fetchQuotes };
