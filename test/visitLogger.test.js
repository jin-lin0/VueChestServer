const test = require("node:test");
const assert = require("node:assert/strict");

const LOGGER_PATH = require.resolve("../middleware/visitLogger");
const VISIT_LOG_PATH = require.resolve("../models/visitLog");

/** 每个用例都要一份全新的 visitLogger：它的计数 buffer 是模块级状态。 */
function freshLogger(visitLog) {
  const previousLog = require.cache[VISIT_LOG_PATH];
  const previousLogger = require.cache[LOGGER_PATH];
  require.cache[VISIT_LOG_PATH] = {
    id: VISIT_LOG_PATH,
    filename: VISIT_LOG_PATH,
    loaded: true,
    exports: visitLog,
  };
  delete require.cache[LOGGER_PATH];
  const logger = require("../middleware/visitLogger");
  return {
    logger,
    restore() {
      if (previousLog) require.cache[VISIT_LOG_PATH] = previousLog;
      else delete require.cache[VISIT_LOG_PATH];
      if (previousLogger) require.cache[LOGGER_PATH] = previousLogger;
      else delete require.cache[LOGGER_PATH];
    },
  };
}

/** 造一个非内网来源的请求，让它真的进 buffer。 */
function hit(logger, { path = "/api/questions", ip = "8.8.8.8", geo } = {}) {
  const headers = { "x-forwarded-for": ip };
  if (geo) headers["x-client-geo"] = geo;
  logger({ path, headers, ip }, {}, () => {});
}

async function flushQuietly(logger) {
  const restore = silentConsoleError();
  try {
    return await logger.flushToDB();
  } finally {
    restore();
  }
}

/** 首次请求会自动归档，先完成预热以隔离后续缓冲区断言。 */
async function seed(logger, paths) {
  // 预热那一次同样会走「批量→兜底」，而模型的桩故意没有 sequelize，
  // 于是它的 console.error 是**同步**发生的 —— 静音要包住 hit 本身才盖得住。
  const restore = silentConsoleError();
  try {
    hit(logger, { path: "/api/__prime" });
    await logger.flushToDB();
  } finally {
    restore();
  }
  for (const path of paths) hit(logger, { path });
}

/** 省略批量写入接口，强制进入逐条写入兜底。 */
function makeVisitLog(handler) {
  const queries = [];
  return {
    queries,
    findOrCreate: async (query) => {
      queries.push(query.where);
      return handler(query, queries.length);
    },
  };
}

/** 只提供批量能力的模型桩：记录语句，不落库。 */
function makeBulkVisitLog({ onQuery } = {}) {
  const calls = [];
  return {
    calls,
    findOrCreate: async () => {
      throw new Error("批量路径正常时不该退到逐条");
    },
    getTableName: () => "visit_logs",
    sequelize: {
      query: async (sql, options) => {
        calls.push({ sql, options });
        if (onQuery) return onQuery(sql, options, calls.length);
        return [{}, 1];
      },
    },
  };
}

const okRow = () => [{ increment: async () => {} }, true];

function silentConsoleError() {
  const real = console.error;
  console.error = () => {};
  return () => {
    console.error = real;
  };
}

test("全部写成功时 flushed 记成功数、failed 为 0", async () => {
  const visitLog = makeVisitLog(okRow);
  const { logger, restore } = freshLogger(visitLog);
  try {
    await seed(logger, ["/api/questions", "/api/market/apps"]);
    const result = await flushQuietly(logger);
    assert.deepEqual(result, { flushed: 2, failed: 0 });
    assert.equal(logger.getBufferSize(), 0, "成功后 buffer 应清空");
  } finally {
    restore();
  }
});

test("建行失败：计入 failed 并放回 buffer 以便重试", async () => {
  const visitLog = makeVisitLog(async (query) => {
    if (query.where.path === "/api/broken") throw new Error("ER_NO_SUCH_TABLE");
    return okRow();
  });
  const { logger, restore } = freshLogger(visitLog);
  try {
    await seed(logger, ["/api/broken"]);
    const result = await flushQuietly(logger);
    assert.deepEqual(result, { flushed: 0, failed: 1 }, "写失败不能再报成功");
    assert.equal(logger.getBufferSize(), 1, "失败条目要放回 buffer 等下次重试");
  } finally {
    restore();
  }
});

test("累加明确回滚时保留增量，下次重试只记一次", async () => {
  let attempts = 0;
  let total = 0;
  const visitLog = makeVisitLog(async (query) => {
    if (query.where.path === "/api/incr-fail") {
      return [
        {
          increment: async (_field, { by }) => {
            attempts += 1;
            if (attempts === 1) throw Object.assign(new Error("ER_LOCK_WAIT_TIMEOUT"), { code: "ER_LOCK_WAIT_TIMEOUT" });
            total += by;
          },
        },
        false,
      ];
    }
    return okRow();
  });
  const { logger, restore } = freshLogger(visitLog);
  try {
    await seed(logger, ["/api/incr-fail"]);
    const result = await flushQuietly(logger);
    assert.deepEqual(result, { flushed: 0, failed: 1 });
    assert.equal(logger.getBufferSize(), 1, "增量还没提交，不能丢弃");
    assert.deepEqual(await flushQuietly(logger), { flushed: 1, failed: 0 });
    assert.equal(total, 1);
    assert.equal(logger.getBufferSize(), 0);
  } finally {
    restore();
  }
});

test("部分失败时成功数与失败数分开统计", async () => {
  const visitLog = makeVisitLog(async (query) => {
    if (query.where.path === "/api/b") throw new Error("boom");
    return okRow();
  });
  const { logger, restore } = freshLogger(visitLog);
  try {
    await seed(logger, ["/api/a", "/api/b", "/api/c"]);
    const result = await flushQuietly(logger);
    assert.deepEqual(result, { flushed: 2, failed: 1 });
    assert.equal(logger.getBufferSize(), 1);
  } finally {
    restore();
  }
});

test("buffer 为空时直接返回 0/0，不碰数据库", async () => {
  const visitLog = makeVisitLog(okRow);
  const { logger, restore } = freshLogger(visitLog);
  try {
    assert.deepEqual(await flushQuietly(logger), { flushed: 0, failed: 0 });
    assert.equal(visitLog.queries.length, 0);
  } finally {
    restore();
  }
});

test("并发 flush 复用同一个 promise，不会把同一批数据写两遍", async () => {
  let releases = 0;
  const visitLog = {
    queries: [],
    findOrCreate: async (query) => {
      visitLog.queries.push(query.where);
      releases += 1;
      await new Promise((resolve) => setImmediate(resolve));
      return okRow();
    },
  };
  const { logger, restore } = freshLogger(visitLog);
  try {
    await seed(logger, ["/api/once"]);
    const before = releases;
    const [first, second] = await Promise.all([
      flushQuietly(logger),
      flushQuietly(logger),
    ]);
    assert.equal(releases - before, 1, "同一批数据只能写一次");
    assert.deepEqual(first, { flushed: 1, failed: 0 });
    assert.deepEqual(second, first);
  } finally {
    restore();
  }
});

test("本地来源不入 buffer（沿用原有取舍）", async () => {
  const visitLog = makeVisitLog(okRow);
  const { logger, restore } = freshLogger(visitLog);
  try {
    hit(logger, { ip: "127.0.0.1" });
    hit(logger, { ip: "192.168.1.5" });
    assert.equal(logger.getBufferSize(), 0);
    assert.deepEqual(await flushQuietly(logger), { flushed: 0, failed: 0 });
    assert.equal(visitLog.queries.length, 0);
  } finally {
    restore();
  }
});

test("非 /api 路径不入 buffer", async () => {
  const visitLog = makeVisitLog(okRow);
  const { logger, restore } = freshLogger(visitLog);
  try {
    hit(logger, { path: "/health" });
    hit(logger, { path: "/api/stats/overview" });
    assert.equal(logger.getBufferSize(), 0);
  } finally {
    restore();
  }
});

// 批量归档

test("整批只发一条 upsert 语句：列名/占位符/别名写法都对得上", async () => {
  const visitLog = makeBulkVisitLog();
  const { logger, restore } = freshLogger(visitLog);
  try {
    await seed(logger, ["/api/a", "/api/b", "/api/c"]);
    const result = await flushQuietly(logger);

    assert.deepEqual(result, { flushed: 3, failed: 0 });
    assert.equal(logger.getBufferSize(), 0);
    assert.equal(visitLog.calls.length, 2, "预热 1 条 + 本批 1 条");

    const { sql, options } = visitLog.calls.at(-1);
    // 使用行别名引用待插入值，避免已废弃的 VALUES() 用法。
    assert.equal(
      sql,
      "INSERT INTO `visit_logs` (`date`,`path`,`country`,`city`,`count`) VALUES " +
        "(?,?,?,?,?),(?,?,?,?,?),(?,?,?,?,?) AS `new` " +
        "ON DUPLICATE KEY UPDATE `count` = `visit_logs`.`count` + `new`.`count`",
    );

    // replacements 的顺序必须与 UPSERT_COLUMNS 一一对应，错位就会把 count 写进 city。
    const date = new Date().toISOString().slice(0, 10);
    assert.deepEqual(options.replacements, [
      date,
      "/api/a",
      "",
      "",
      1,
      date,
      "/api/b",
      "",
      "",
      1,
      date,
      "/api/c",
      "",
      "",
      1,
    ]);
  } finally {
    restore();
  }
});

test("批量路径下并发 flush 复用同一个 promise，不会写两遍", async () => {
  const visitLog = makeBulkVisitLog();
  const { logger, restore } = freshLogger(visitLog);
  try {
    await seed(logger, ["/api/once"]);
    const before = visitLog.calls.length;
    const [first, second] = await Promise.all([
      flushQuietly(logger),
      flushQuietly(logger),
    ]);
    assert.equal(visitLog.calls.length - before, 1, "同一批数据只能发一条语句");
    assert.deepEqual(first, { flushed: 1, failed: 0 });
    assert.deepEqual(second, first);
  } finally {
    restore();
  }
});

test("批量语句失败：退回逐条，其余维度照样写成功，只有失败那条放回 buffer", async () => {
  const visitLog = makeBulkVisitLog({
    onQuery: async () => {
      throw new Error("You have an error in your SQL syntax");
    },
  });
  const seen = [];
  visitLog.findOrCreate = async (query) => {
    seen.push(query.where.path);
    if (query.where.path === "/api/bad") throw new Error("Data too long for column 'path'");
    return okRow();
  };
  const { logger, restore } = freshLogger(visitLog);
  try {
    await seed(logger, ["/api/ok1", "/api/bad", "/api/ok2"]);
    const result = await flushQuietly(logger);

    assert.deepEqual(result, { flushed: 2, failed: 1 }, "不能因为一条坏行就整批丢掉");
    assert.equal(logger.getBufferSize(), 1, "只有失败那条放回等重试");
    assert.deepEqual(
      seen.filter((p) => p !== "/api/__prime").sort(),
      ["/api/bad", "/api/ok1", "/api/ok2"],
    );
  } finally {
    restore();
  }
});

test("批量失败且逐条也失败：整批放回 buffer，flushed 一个都不记", async () => {
  const visitLog = makeBulkVisitLog({
    onQuery: async () => {
      throw new Error("ER_NO_SUCH_TABLE");
    },
  });
  const broken = new Set(["/api/a", "/api/b"]);
  visitLog.findOrCreate = async (query) => {
    if (broken.has(query.where.path)) throw new Error("ER_NO_SUCH_TABLE");
    return okRow();
  };
  const { logger, restore } = freshLogger(visitLog);
  try {
    await seed(logger, ["/api/a", "/api/b"]);
    const result = await flushQuietly(logger);

    assert.deepEqual(result, { flushed: 0, failed: 2 });
    assert.equal(logger.getBufferSize(), 2, "两条都要放回");
  } finally {
    restore();
  }
});

test("逐条兜底按批并发，不会一次把连接池排满", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const visitLog = makeVisitLog(async () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setImmediate(resolve));
    inFlight -= 1;
    return okRow();
  });
  const { logger, restore } = freshLogger(visitLog);
  try {
    await seed(
      logger,
      Array.from({ length: 40 }, (_, i) => `/api/bulk_${i}`),
    );
    const result = await flushQuietly(logger);
    assert.deepEqual(result, { flushed: 40, failed: 0 });
    assert.ok(maxInFlight <= 16, `每批最多 16 个，实测并发峰值 ${maxInFlight}`);
    assert.ok(maxInFlight > 1, "不该退回串行");
  } finally {
    restore();
  }
});

// 输入边界：字段长度、维度编码和缓冲容量

test("超长 path / 地区在进 buffer 前被截断到列宽", async () => {
  const visitLog = makeBulkVisitLog();
  const { logger, restore } = freshLogger(visitLog);
  try {
    await seed(logger, []);
    hit(logger, {
      path: `/api/${"x".repeat(300)}`,
      geo: `${"y".repeat(150)},${"z".repeat(150)}`,
    });
    await flushQuietly(logger);

    const [, path, country, city] = visitLog.calls.at(-1).options.replacements;
    assert.equal(path.length, logger.FIELD_LIMITS.path);
    assert.equal(country.length, logger.FIELD_LIMITS.country);
    assert.equal(city.length, logger.FIELD_LIMITS.city);
  } finally {
    restore();
  }
});

test("path 里的 | 不再把 country/city 挤错位", async () => {
  // 路径含分隔符时，维度编码仍须保持字段对应。
  const visitLog = makeBulkVisitLog();
  const { logger, restore } = freshLogger(visitLog);
  try {
    await seed(logger, []);
    hit(logger, { path: "/api/__pipe|probe", geo: "CN,Beijing" });
    await flushQuietly(logger);

    assert.deepEqual(visitLog.calls.at(-1).options.replacements, [
      new Date().toISOString().slice(0, 10),
      "/api/__pipe|probe",
      "CN",
      "Beijing",
      1,
    ]);
  } finally {
    restore();
  }
});

test("缓冲区满时丢弃新维度，已在计数的维度继续累加并每轮汇总一条 warn", async () => {
  const visitLog = makeBulkVisitLog();
  const { logger, restore } = freshLogger(visitLog);
  const warns = [];
  const realWarn = console.warn;
  console.warn = (...args) => warns.push(args.join(" "));
  try {
    await seed(logger, []);
    const cap = logger.MAX_BUFFER_KEYS;
    for (let i = 0; i < cap; i += 1) hit(logger, { path: `/api/fill_${i}` });
    assert.equal(logger.getBufferSize(), cap);

    hit(logger, { path: "/api/fill_0" });
    hit(logger, { path: "/api/overflow" });
    assert.equal(logger.getBufferSize(), cap, "满了之后不再接受新维度");

    const result = await flushQuietly(logger);
    assert.deepEqual(result, { flushed: cap, failed: 0 });

    const flat = visitLog.calls.at(-1).options.replacements;
    const records = [];
    for (let i = 0; i < flat.length; i += 5) records.push(flat.slice(i, i + 5));
    assert.equal(records.length, cap);
    assert.equal(records.find((r) => r[1] === "/api/fill_0")[4], 2, "已有维度还能继续累加");
    assert.equal(records.find((r) => r[1] === "/api/overflow"), undefined);
    assert.equal(warns.length, 1, "每轮 flush 只汇总一条 warn");
    assert.match(warns[0], new RegExp(String(cap)));
  } finally {
    console.warn = realWarn;
    restore();
  }
});

test("FIELD_LIMITS 与 models/visitLog.js 的列宽一致（防止改列宽忘改这里）", () => {
  const RealVisitLog = require("../models/visitLog");
  const limits = require("../middleware/visitLogger").FIELD_LIMITS;
  for (const [field, limit] of Object.entries(limits)) {
    assert.equal(
      RealVisitLog.rawAttributes[field].type.options.length,
      limit,
      `${field} 的截断长度与模型列宽漂移了`,
    );
  }
});

test("批量已提交但连接断开时，不退回逐条造成重复累加", async () => {
  let committed = 0;
  let fallbackCalls = 0;
  const visitLog = makeBulkVisitLog({
    onQuery: async (_sql, options, call) => {
      if (call === 1) return;
      committed += options.replacements[4];
      throw Object.assign(new Error("connection lost after commit"), { code: "ECONNRESET" });
    },
  });
  visitLog.findOrCreate = async () => {
    fallbackCalls += 1;
    return [{ increment: async () => { committed += 1; } }, false];
  };
  const { logger, restore } = freshLogger(visitLog);
  try {
    await seed(logger, ["/api/once"]);
    assert.deepEqual(await flushQuietly(logger), { flushed: 0, failed: 1 });
    assert.equal(fallbackCalls, 0);
    assert.equal(committed, 1);
  } finally {
    restore();
  }
});

test("flush 期间新请求占满 buffer 后，失败回填也不得突破容量上限", async () => {
  let rejectBulk;
  const visitLog = makeBulkVisitLog({
    onQuery: async (_sql, _options, call) => {
      if (call === 1) return;
      await new Promise((_resolve, reject) => { rejectBulk = reject; });
    },
  });
  visitLog.findOrCreate = async () => { throw new Error("database unavailable"); };
  const { logger, restore } = freshLogger(visitLog);
  try {
    const cap = logger.MAX_BUFFER_KEYS;
    await seed(logger, Array.from({ length: cap }, (_, i) => `/api/old-${i}`));
    const flushing = flushQuietly(logger);
    for (let i = 0; i < cap; i++) hit(logger, { path: `/api/new-${i}` });
    rejectBulk(new Error("database unavailable"));
    assert.deepEqual(await flushing, { flushed: 0, failed: cap });
    assert.equal(logger.getBufferSize(), cap);
  } finally {
    restore();
  }
});
