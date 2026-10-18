/**
 * 全局错误处理：统一响应契约 `{ success: false, error, code }`。
 *
 * 为什么不能直接用 `err.message`：
 * 「兜底未捕获异常」和「把原始报错原文回给客户端」是两件事。实测过这类泄漏：
 *   GET /api/questions?limit=-1
 *     → 500 {"error":"You have an error in your SQL syntax; check the manual ..."}
 *   GET /api/questions?page=abc
 *     → 500 {"error":"Undeclared variable: NaN"}
 *   POST /api/questions (畸形 JSON)
 *     → 400 {"error":"Expected property name or '}' in JSON at position 1"}
 * 前两类把库表结构与 SQL 片段暴露给了**未登录**调用方，还顺带告诉攻击者
 * 「这个参数进了 SQL」；第三类暴露了 parser 内部偏移量。
 *
 * 所以把「错误 → 响应」收成一张规则表（describeError）：
 *   - 请求体解析失败 / 过大：换成人话（状态码沿用 express 给的）；
 *   - 唯一约束冲突：这是调用方能自己修的问题，给 409，不该按 500 报；
 *   - **模型/驱动判定为「输入有问题」的报错**：同样是调用方能自己修的问题，给 400；
 *   - 其余驱动层报错（Sequelize*）与 JS 运行时异常（TypeError 等）：
 *     只回通用文案，细节留服务端日志；
 *   - 业务显式抛出的可读错误（`throw new Error("稿件不可见")`、`error.status = 400`）：照旧透传。
 */

/** 驱动层 / 运行时异常：这些原文一律不外发。 */
const INTERNAL_ERROR_NAME =
  /^(Sequelize|TypeError|ReferenceError|RangeError|SyntaxError)/;

const GENERIC_MESSAGE = "服务器内部错误";
const INTERNAL_CODE = "SERVER_ERROR";
/** 输入类错误的统一 code：调用方改一下请求就能通过。 */
const VALIDATION_CODE = "VALIDATION_ERROR";

/**
 * 模型层校验的失败原因（Sequelize 的 validatorKey → 中文）。
 * 这些字段名来自我们自己的模型定义，不是客户端可控内容。
 */
const VALIDATOR_REASON = Object.freeze({
  is_null: "不能为空",
  notEmpty: "不能为空",
  len: "长度不符合要求",
  minLength: "长度不足",
  maxLength: "长度超出限制",
  isIn: "取值不在允许范围内",
  isEmail: "不是合法的邮箱地址",
  isUrl: "不是合法的链接",
  isDate: "不是合法的日期",
  isInt: "必须是整数",
  isFloat: "必须是数字",
  isBoolean: "必须是布尔值",
  isArray: "必须是数组",
  isUuid: "格式不正确",
  isJSON: "不是合法的 JSON",
  min: "取值过小",
  max: "取值过大",
});

/**
 * 驱动层里「换个输入就能过」的 MySQL 错误号 → 中文原因。
 *
 * 为什么按错误号白名单，而不是把所有 SequelizeDatabaseError 都当 400：
 * 语法的错、缺默认值（1364）、表不存在这类是**真正的服务端故障**，
 * 报 400 会把「我们自己写错了 SQL」伪装成「你输入有误」，反而掩盖问题。
 * 实测过这几类输入错的形状（sql_mode 含 STRICT_TRANS_TABLES，所以都是报错而非静默截断）：
 *   description 70000 字 → ER_DATA_TOO_LONG / errno 1406
 *   status='bogus'      → WARN_DATA_TRUNCATED / errno 1265
 */
const INPUT_FAULT_DB_CODES = Object.freeze({
  ER_DATA_TOO_LONG: "内容超出该字段允许的长度",
  ER_WARN_DATA_OUT_OF_RANGE: "数值超出允许范围",
  WARN_DATA_TRUNCATED: "取值不在允许范围内",
  ER_TRUNCATED_WRONG_VALUE: "格式不正确",
  ER_TRUNCATED_WRONG_VALUE_FOR_FIELD: "格式不正确",
  ER_BAD_NULL_ERROR: "不能为空",
  ER_NO_REFERENCED_ROW_2: "关联的数据不存在",
  ER_ROW_IS_REFERENCED_2: "该数据仍被引用，无法删除",
});

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
// 只认这两种句式，且只从 `for column 'X'` / `Column 'X' cannot be null` 里取列名。
// 不能用「第一处引号内容」：1366 的报文形如
//   Incorrect integer value: 'abc' for column 'foo' at row 1
// 第一处引号是**调用方传进来的值**，回显它等于把客户端内容原样写进错误文案。
const COLUMN_FOR_RE = /for column '([A-Za-z_][A-Za-z0-9_]*)'/;
const COLUMN_NULL_RE = /Column '([A-Za-z_][A-Za-z0-9_]*)' cannot be null/;

/** 从驱动报文中取出列名；取不到就返回空串，绝不回显整句。 */
function columnFromSqlMessage(message) {
  if (typeof message !== "string") return "";
  const match = COLUMN_FOR_RE.exec(message) || COLUMN_NULL_RE.exec(message);
  return match ? match[1] : "";
}

/** 把「字段 + 原因」拼成人话；拿不到字段名就只说原因。 */
function inputFaultMessage(reason, field) {
  return field
    ? `提交的数据不符合要求：字段 ${field} ${reason}`
    : `提交的数据不符合要求：${reason}`;
}

/** SequelizeValidationError：必填缺失、字符串超长、格式不符等模型层校验失败。 */
function describeValidationFault(error) {
  const items = Array.isArray(error.errors) ? error.errors : [];
  const first = items[0] || {};
  const field =
    typeof first.path === "string" && IDENTIFIER_RE.test(first.path)
      ? first.path
      : "";
  const reason = Object.hasOwn(VALIDATOR_REASON, first.validatorKey)
    ? VALIDATOR_REASON[first.validatorKey]
    : "";
  const suffix = items.length > 1 ? `（共 ${items.length} 处）` : "";
  if (!field) return `提交的数据不符合要求，请检查后重试${suffix}`;
  const message = reason
    ? inputFaultMessage(reason, field)
    : `提交的数据不符合要求：字段 ${field} 校验未通过`;
  return `${message}${suffix}`;
}

/**
 * 驱动层错误里属于「调用方输入问题」的那部分。
 * 返回可外发的中文文案；不属于输入问题则返回 null（交回通用 500 处理）。
 */
function describeInputFault(error) {
  // 外键指向不存在的行（1452 插入 / 1451 删除，两个号都会走到这里）
  if (error.name === "SequelizeForeignKeyConstraintError") {
    return "关联的数据不存在或已被删除";
  }
  const parent = error.parent || error.original || {};
  // hasOwn 而不是直接取值：parent.code 是驱动给的字符串，别让 __proto__ 这类键命中原型
  if (!Object.hasOwn(INPUT_FAULT_DB_CODES, parent.code)) return null;
  return inputFaultMessage(
    INPUT_FAULT_DB_CODES[parent.code],
    columnFromSqlMessage(parent.sqlMessage),
  );
}

/**
 * 把任意错误翻译成可安全外发的 `{ status, code, message }`。
 * @param {any} err 捕获到的错误（不保证是 Error 实例）
 */
function describeError(err) {
  const error = err || {};
  const type = error.type;

  // express.json() 的解析失败 / 体积超限：status 已由 body-parser 给出
  if (type === "entity.parse.failed") {
    return {
      status: error.status || 400,
      code: INTERNAL_CODE,
      message: "请求体不是合法的 JSON",
    };
  }
  if (type === "entity.too.large") {
    return {
      status: error.status || 413,
      code: INTERNAL_CODE,
      message: "请求体过大，请精简后重试",
    };
  }

  // 唯一约束冲突是可修复的调用方错误，给 409 而不是 500
  if (error.name === "SequelizeUniqueConstraintError") {
    return {
      status: 409,
      code: "CONFLICT",
      message: "该记录已存在，请勿重复提交",
    };
  }

  // 模型层校验失败（必填缺失、超长、格式不符）：调用方改一下请求就能过，给 400。
  // 实测：username 传 200 字 → Validation len on username failed（原来报 500）
  if (error.name === "SequelizeValidationError") {
    return {
      status: 400,
      code: VALIDATION_CODE,
      message: describeValidationFault(error),
    };
  }

  // 驱动层 / 运行时异常：文案与 code 都不外发（driver 的 code 形如 ER_PARSE_ERROR）
  if (INTERNAL_ERROR_NAME.test(error.name || "")) {
    // 但其中「输入有问题」的那几类要单独给 400：否则用户传个超长内容
    // 只会看到「服务器内部错误」，以为服务坏了从而放弃重试。
    const inputFault = describeInputFault(error);
    if (inputFault) {
      return { status: 400, code: VALIDATION_CODE, message: inputFault };
    }
    return {
      status: error.status || 500,
      code: INTERNAL_CODE,
      message: GENERIC_MESSAGE,
    };
  }

  return {
    status: error.status || 500,
    code: error.code || INTERNAL_CODE,
    message: error.message || GENERIC_MESSAGE,
  };
}

// eslint-disable-next-line no-unused-vars -- Express 靠 4 个形参识别错误处理中间件
function errorHandler(err, req, res, next) {
  const { status, code, message } = describeError(err);
  // 真实错误只进日志：排查问题靠这里，不靠响应体
  console.error("未捕获错误:", err);
  res.status(status).json({ success: false, error: message, code });
}

module.exports = {
  errorHandler,
  describeError,
  GENERIC_MESSAGE,
  INTERNAL_CODE,
  VALIDATION_CODE,
  INPUT_FAULT_DB_CODES,
};
