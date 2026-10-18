// 这里对 code 断言**字面量**而不是导入的常量：
// 断言 `body.code === VALIDATION_CODE` 是自指的——把常量值改错时测试会跟着一起改，等于没测。
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  errorHandler,
  describeError,
  GENERIC_MESSAGE,
  VALIDATION_CODE,
} = require("../middleware/errorHandler");

/** 造一个与真实泄漏现场一致的 Sequelize 数据库错误。 */
function sequelizeDatabaseError(sql) {
  const error = new Error(sql);
  error.name = "SequelizeDatabaseError";
  error.sql = sql;
  return error;
}

/** 用一个最小的假 res 捕获错误处理中间件实际写出的响应。 */
function capture(err) {
  const captured = { status: 200, body: null };
  const res = {
    status(code) {
      captured.status = code;
      return this;
    },
    json(payload) {
      captured.body = payload;
      return this;
    },
  };
  errorHandler(err, {}, res, () => {});
  return captured;
}

test("数据库报错原文不外发（实测过的泄漏现场）", () => {
  const sql =
    "You have an error in your SQL syntax; check the manual that corresponds to your MySQL server version for the right syntax to use near 'LIMIT -1'";
  const { status, body } = capture(sequelizeDatabaseError(sql));
  assert.equal(status, 500);
  assert.equal(body.error, GENERIC_MESSAGE);
  assert.equal(body.code, "SERVER_ERROR");
  assert.ok(!body.error.includes("SQL"), "不能回 SQL 原文");
  assert.ok(!JSON.stringify(body).includes("LIMIT"), "不能带出查询片段");
});

test("Undeclared variable: NaN 这类驱动报错同样被兜住", () => {
  const { body } = capture(sequelizeDatabaseError("Undeclared variable: NaN"));
  assert.equal(body.error, GENERIC_MESSAGE);
});

test("驱动层的 code 也不外发（如 ER_PARSE_ERROR）", () => {
  const error = sequelizeDatabaseError("bad sql");
  error.code = "ER_PARSE_ERROR";
  const { body } = capture(error);
  assert.equal(body.code, "SERVER_ERROR");
});

test("运行时异常不外发（TypeError 等）", () => {
  const typeError = new TypeError(
    "Cannot read properties of undefined (reading 'id')",
  );
  const { status, body } = capture(typeError);
  assert.equal(status, 500);
  assert.equal(body.error, GENERIC_MESSAGE);
});

test("业务显式抛出的可读错误照旧透传", () => {
  const upstream = new Error("稿件不可见");
  upstream.status = 502;
  const { status, body } = capture(upstream);
  assert.equal(status, 502);
  assert.equal(body.error, "稿件不可见");
});

test("带 status 的业务错误保留自定义 code", () => {
  const validation = new Error("单次最多查询 100 个标的");
  validation.status = 400;
  validation.code = "VALIDATION";
  const { status, body } = capture(validation);
  assert.equal(status, 400);
  assert.equal(body.error, "单次最多查询 100 个标的");
  assert.equal(body.code, "VALIDATION");
});

test("没有 status 的可读错误仍按 500 透传文案（如 B 站上游失败）", () => {
  const { status, body } = capture(
    new Error("B站返回异常（可能为风控拦截或登录墙），请稍后重试"),
  );
  assert.equal(status, 500);
  assert.match(body.error, /B站返回异常/);
});

test("畸形 JSON 换成人话，不回解析器偏移量", () => {
  const parseError = new SyntaxError(
    "Expected property name or '}' in JSON at position 1 (line 1 column 2)",
  );
  parseError.status = 400;
  parseError.type = "entity.parse.failed";
  const { status, body } = capture(parseError);
  assert.equal(status, 400);
  assert.equal(body.error, "请求体不是合法的 JSON");
  assert.ok(!body.error.includes("position"), "不该带出解析位置");
});

test("请求体过大换成人话并保留 413", () => {
  const tooLarge = new Error("request entity too large");
  tooLarge.status = 413;
  tooLarge.type = "entity.too.large";
  const { status, body } = capture(tooLarge);
  assert.equal(status, 413);
  assert.equal(body.error, "请求体过大，请精简后重试");
});

test("唯一约束冲突给 409 而不是 500", () => {
  const duplicate = new Error("Validation error");
  duplicate.name = "SequelizeUniqueConstraintError";
  const { status, body } = capture(duplicate);
  assert.equal(status, 409);
  assert.equal(body.error, "该记录已存在，请勿重复提交");
  assert.equal(body.code, "CONFLICT");
});

test("导出的 code 常量与实际响应里的字面量一致", () => {
  // 行为测试断言的是字面量，这里单独钉住常量本身，免得两者悄悄漂移
  assert.equal(VALIDATION_CODE, "VALIDATION_ERROR");
});

test("无 message 的错误也有兜底文案", () => {
  assert.equal(describeError(new Error("")).message, GENERIC_MESSAGE);
  assert.equal(describeError({ name: "Error" }).message, GENERIC_MESSAGE);
  assert.equal(describeError(null).status, 500);
});

/* ------------------------------------------------------------------ *
 * 输入类错误（调用方改一下请求就能过）应当给 400，而不是「服务器内部错误」
 *
 * 下面这些错误的**形状**都是在真实 MySQL 上抓下来的，不是照文档臆造的。
 * sql_mode 含 STRICT_TRANS_TABLES，所以超长/非法取值一律报错、不会静默截断。
 * ------------------------------------------------------------------ */

/** 造一个驱动程序抛出的真实形状：Sequelize 把 mysql2 的原始错误挂在 parent 上。 */
function driverError(code, sqlMessage) {
  const parent = new Error(sqlMessage);
  parent.code = code;
  parent.sqlMessage = sqlMessage;
  const error = new Error(sqlMessage);
  error.name = "SequelizeDatabaseError";
  error.parent = parent;
  error.original = parent; // Sequelize 里两者同一个对象
  return error;
}

/** 造一个模型层校验错误（Sequelize 自己抛的那种）。 */
function validationError(items, message = "Validation error") {
  const error = new Error(message);
  error.name = "SequelizeValidationError";
  error.errors = items;
  return error;
}

test("超长字段（模型层 len 校验）给 400，并指出是哪个字段", () => {
  // 实测：username 传 200 字 → Validation len on username failed
  const { status, body } = capture(
    validationError([
      {
        path: "username",
        validatorKey: "len",
        type: "Validation error",
        message: "Validation len on username failed",
      },
    ]),
  );
  assert.equal(status, 400);
  assert.equal(body.code, "VALIDATION_ERROR");
  assert.match(body.error, /username/);
  assert.match(body.error, /长度/);
  assert.ok(
    !JSON.stringify(body).includes("failed"),
    "不能回显 Sequelize 的英文原文",
  );
});

test("必填字段缺失（notNull 违例）给 400，而不是 500", () => {
  // 实测：icon=null → {"path":"icon","validatorKey":"is_null","type":"notNull Violation"}
  const { status, body } = capture(
    validationError([
      { path: "icon", validatorKey: "is_null", type: "notNull Violation" },
    ]),
  );
  assert.equal(status, 400);
  assert.equal(body.code, "VALIDATION_ERROR");
  assert.equal(body.error, "提交的数据不符合要求：字段 icon 不能为空");
});

test("多处校验失败时如实报出总数", () => {
  const { body } = capture(
    validationError([
      { path: "name", validatorKey: "len" },
      { path: "icon", validatorKey: "is_null" },
      { path: "version", validatorKey: "len" },
    ]),
  );
  assert.match(body.error, /字段 name/);
  assert.match(body.error, /共 3 处/);
});

test("拿不到字段名时也给 400，不编造字段", () => {
  const noItems = capture(validationError(undefined));
  assert.equal(noItems.status, 400);
  assert.equal(noItems.body.error, "提交的数据不符合要求，请检查后重试");

  // path 不是合法标识符：不回显（避免把调用方内容写进文案）
  const weird = capture(validationError([{ path: "<img src=x>", validatorKey: "len" }]));
  assert.equal(weird.body.error, "提交的数据不符合要求，请检查后重试");
  assert.ok(!weird.body.error.includes("img"), "不该回显非常规字段名");
});

test("内容超出列宽（ER_DATA_TOO_LONG）给 400 并指出列名", () => {
  // 实测：description 传 70000 字 → ER_DATA_TOO_LONG / errno 1406
  const { status, body } = capture(
    driverError("ER_DATA_TOO_LONG", "Data too long for column 'description' at row 1"),
  );
  assert.equal(status, 400);
  assert.equal(body.code, "VALIDATION_ERROR");
  assert.match(body.error, /description/);
  assert.match(body.error, /长度/);
  assert.ok(!JSON.stringify(body).includes("at row 1"), "不能回驱动原文");
});

test("ENUM 传非法取值（WARN_DATA_TRUNCATED）给 400", () => {
  // 实测：status='bogus-status' → WARN_DATA_TRUNCATED / errno 1265
  const { status, body } = capture(
    driverError("WARN_DATA_TRUNCATED", "Data truncated for column 'status' at row 1"),
  );
  assert.equal(status, 400);
  assert.match(body.error, /status/);
  assert.match(body.error, /取值/);
});

test("格式非法时不回显调用方传入的那个值", () => {
  // 1366 的真实报文里，第一处引号是**调用方传的值**：
  //   Incorrect integer value: 'abc' for column 'foo' at row 1
  const { body } = capture(
    driverError(
      "ER_TRUNCATED_WRONG_VALUE_FOR_FIELD",
      "Incorrect integer value: 'abc' for column 'foo' at row 1",
    ),
  );
  assert.match(body.error, /foo/, "应指出列名");
  assert.ok(!JSON.stringify(body).includes("'abc'"), "不能把传入值原样回显");
  assert.ok(!body.error.includes("abc"));
});

test("必填字段为 null（ER_BAD_NULL_ERROR）给 400", () => {
  const { body } = capture(
    driverError("ER_BAD_NULL_ERROR", "Column 'fileKey' cannot be null"),
  );
  assert.equal(body.code, "VALIDATION_ERROR");
  assert.match(body.error, /fileKey/);
  assert.match(body.error, /不能为空/);
});

test("外键指向不存在的行给 400", () => {
  const error = new Error("insert or update on table violates foreign key constraint");
  error.name = "SequelizeForeignKeyConstraintError";
  const { status, body } = capture(error);
  assert.equal(status, 400);
  assert.equal(body.code, "VALIDATION_ERROR");
  assert.match(body.error, /关联的数据不存在/);
});

test("真正的服务端数据库故障仍然 500（别把输入错当挡箭牌）", () => {
  // 1364 缺默认值 / 1064 语法错 / 1146 表不存在：这些是我们自己写错了 SQL，
  // 报 400 会把服务端缺陷伪装成「你输入有误」，反而掩盖问题。
  for (const [code, message] of [
    ["ER_NO_DEFAULT_FOR_FIELD", "Field 'songData' doesn't have a default value"],
    ["ER_PARSE_ERROR", "You have an error in your SQL syntax near 'LIMIT -1'"],
    ["ER_NO_SUCH_TABLE", "Table 'shop.orders' doesn't exist"],
  ]) {
    const { status, body } = capture(driverError(code, message));
    assert.equal(status, 500, `${code} 应仍是 500`);
    assert.equal(body.code, "SERVER_ERROR");
    assert.equal(body.error, GENERIC_MESSAGE);
  }
});

test("驱动错误号命中原型链上的键时不会被误判成 400", () => {
  for (const code of ["__proto__", "constructor", "toString"]) {
    const { status, body } = capture(driverError(code, "boom"));
    assert.equal(status, 500, `${code} 不应该被当成已知的输入错误号`);
    assert.equal(body.error, GENERIC_MESSAGE);
  }
});
