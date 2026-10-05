#!/usr/bin/env node
/**
 * 模型 ↔ 数据库 结构漂移检查（**只读，不改任何东西**）。
 *
 * 为什么需要它：本项目不用迁移框架，表结构由启动时的 `sequelize.sync()` 维护。
 * 但 `sync()` 只做 `CREATE TABLE IF NOT EXISTS` —— **从不 ALTER 已存在的表**。
 * 所以给已有模型加字段后，线上库不会自动跟上，接口会以 `Unknown column` 报 500。
 *
 * 这个脚本把「到底缺什么、该执行哪句 DDL」算出来，但不执行：
 *
 *   node scripts/schema-check.js          # 检查并打印需要的 DDL
 *   node scripts/schema-check.js --quiet  # 只在有漂移时输出
 *
 * 退出码：0 = 无漂移；1 = 有漂移。可以接进 CI 当护栏，
 * 但注意 CI 需要能连上目标库，连不上会直接报错退出。
 *
 * 它替代了完整迁移体系里唯一有价值的那部分（「sync 做不到什么」），
 * 却不引入 `schema_migrations` 表、迁移目录和版本排序 —— 零状态。
 */

const fs = require("fs");
const path = require("path");

const sequelize = require("../config/database");

const MODELS_DIR = path.resolve(__dirname, "../models");
const QUIET = process.argv.includes("--quiet");

/** 只比较「类型族」，避免 int(11) / INTEGER 这类写法差异造成误报。 */
const TYPE_FAMILY = {
  INT: "INT",
  INTEGER: "INT",
  BIGINT: "BIGINT",
  SMALLINT: "SMALLINT",
  MEDIUMINT: "MEDIUMINT",
  TINYINT: "TINYINT",
  BOOLEAN: "TINYINT", // Sequelize 在 MySQL 上把 BOOLEAN 落成 tinyint(1)
  VARCHAR: "VARCHAR",
  STRING: "VARCHAR",
  CHAR: "CHAR",
  TEXT: "TEXT",
  DATE: "DATETIME",
  DATETIME: "DATETIME",
  TIMESTAMP: "TIMESTAMP",
  JSON: "JSON",
  FLOAT: "FLOAT",
  DOUBLE: "DOUBLE",
  DECIMAL: "DECIMAL",
  BLOB: "BLOB",
};

/** `varchar(50)` → `{ family: 'VARCHAR', width: 50 }`；无法识别时 family 为原始串。 */
function parseType(raw) {
  const text = String(raw || "").toUpperCase().trim();
  const match = /^([A-Z]+)(?:\((\d+)(?:,\d+)?\))?/.exec(text);
  if (!match) return { family: text, width: null };
  const [, name, width] = match;
  return { family: TYPE_FAMILY[name] || name, width: width ? Number(width) : null };
}

function sameType(modelType, dbType) {
  const left = parseType(modelType);
  const right = parseType(dbType);
  if (left.family !== right.family) return false;
  // 只对变长字符类型比较长度，其余忽略（int(11) / bigint(20) 是显示宽度，无语义）
  if (left.family === "VARCHAR" && left.width !== null && right.width !== null) {
    return left.width === right.width;
  }
  return true;
}

/** 载入 models/ 下所有模型，让 sequelize.models 填充完整。 */
function loadModels() {
  for (const file of fs.readdirSync(MODELS_DIR)) {
    if (!file.endsWith(".js")) continue;
    // eslint-disable-next-line global-require, import/no-dynamic-require
    require(path.join(MODELS_DIR, file));
  }
  return Object.values(sequelize.models);
}

function tableNameOf(model) {
  const raw = model.getTableName();
  return typeof raw === "string" ? raw : raw.tableName;
}

/** 模型声明的索引 → 便于比较的签名，如 `userId+readAt`。 */
function indexSignature(fields) {
  return fields.map((field) => String(field)).join("+");
}

/** 数据库已有索引 → 签名集合（忽略主键）。 */
function dbIndexSignatures(rows) {
  const result = new Set();
  for (const row of rows || []) {
    const fields = (row.fields || [])
      .map((item) => item.attribute || item.columnName || item)
      .filter(Boolean)
      .map(String);
    if (!fields.length) continue;
    if (row.primary || String(row.name).toUpperCase() === "PRIMARY") continue;
    result.add(indexSignature(fields));
  }
  return result;
}

/**
 * 取类型的 SQL 写法。
 *
 * 坑：`ENUM` 这类类型的 `toSql()` **和 `toString()` 都需要 dialect 上下文**
 * （Sequelize 内部要调 `dialect.escape` 去转义枚举值），直接调用会抛
 * `Cannot read properties of undefined (reading 'escape')`。
 * 所以这里逐级降级：toSql → 手工拼 ENUM → toString → type.key。
 */
function sqlTypeOf(attribute) {
  const type = attribute && attribute.type;
  if (!type) return "TEXT";

  if (typeof type.toSql === "function") {
    try {
      return type.toSql();
    } catch {
      /* 需要 dialect，走下面的兜底 */
    }
  }
  if (Array.isArray(type.values)) {
    return `ENUM(${type.values.map((value) => `'${value}'`).join(", ")})`;
  }
  try {
    return String(type);
  } catch {
    return type.key || "TEXT";
  }
}

/** 生成 MySQL 的 ADD COLUMN 语句。 */
function addColumnSql(table, column, attribute) {
  const sqlType = sqlTypeOf(attribute);
  const parts = [`ADD COLUMN \`${column}\` ${sqlType}`];
  if (attribute.allowNull === false) {
    parts.push("NOT NULL");
    if (attribute.defaultValue === undefined) {
      // 表里已有数据时，NOT NULL 且无默认值会直接失败
      parts.push(`/* 注意：已有数据的表需要先给个 DEFAULT，否则 ALTER 会失败 */`);
    }
  } else {
    parts.push("NULL");
  }
  return `ALTER TABLE \`${table}\` ${parts.join(" ")};`;
}

async function main() {
  const queryInterface = sequelize.getQueryInterface();
  const models = loadModels();

  const existingTables = new Set(
    (await queryInterface.showAllTables()).map((item) =>
      typeof item === "string" ? item : item.tableName || item.name,
    ),
  );

  const missingTables = [];
  const missingColumns = [];
  const typeDrifts = [];
  const missingIndexes = [];

  for (const model of models) {
    const table = tableNameOf(model);
    if (!existingTables.has(table)) {
      missingTables.push({ model: model.name, table });
      continue;
    }

    const described = await queryInterface.describeTable(table);
    for (const [column, attribute] of Object.entries(model.getAttributes())) {
      const actual = described[column];
      if (!actual) {
        missingColumns.push({ table, column, attribute, model: model.name });
        continue;
      }
      const modelSql = sqlTypeOf(attribute);
      if (!sameType(modelSql, actual.type)) {
        typeDrifts.push({
          table,
          column,
          model: modelSql,
          db: String(actual.type).toUpperCase(),
        });
      }
    }

    const declared = (model.options.indexes || []).map((index) =>
      indexSignature(index.fields || []),
    );
    if (declared.length) {
      const existing = dbIndexSignatures(
        await queryInterface.showIndex(table).catch(() => []),
      );
      for (const signature of declared) {
        if (!existing.has(signature)) missingIndexes.push({ table, signature });
      }
    }
  }

  const hasDrift =
    missingTables.length || missingColumns.length || missingIndexes.length || typeDrifts.length;

  if (!QUIET || hasDrift) {
    console.log("模型 ↔ 数据库 结构漂移检查（只读）\n");

    if (missingTables.length) {
      console.log("【缺表】让 sync() 跑一次即可创建（Vercel 运行时跳过了 sync）：");
      for (const item of missingTables) {
        console.log(`  · ${item.table}  (模型 ${item.model})`);
      }
      console.log("  → 本地启动一次服务即可（本机与 Vercel 指向同一个库），或手动执行 CREATE TABLE");
      console.log("");
    }

    if (missingColumns.length) {
      console.log("【缺列】⚠️ 必须手动执行 DDL，sync() 不会补：");
      for (const item of missingColumns) {
        console.log(`  · ${item.table}.${item.column}  (模型 ${item.model})`);
        console.log(`      ${addColumnSql(item.table, item.column, item.attribute)}`);
      }
      console.log("");
    }

    if (missingIndexes.length) {
      console.log("【缺索引】模型声明了但库里没有（sync() 不会补）：");
      for (const item of missingIndexes) {
        console.log(`  · ${item.table}  (${item.signature})`);
      }
      console.log("      → 用 CREATE INDEX 补，或删掉模型里的 indexes 声明");
      console.log("");
    }

    if (typeDrifts.length) {
      console.log("【类型不一致】仅供参考，多数是显示宽度差异，不影响使用：");
      for (const item of typeDrifts) {
        console.log(`  · ${item.table}.${item.column}: 模型 ${item.model} / 库 ${item.db}`);
      }
      console.log("");
    }

    if (!hasDrift) console.log("✅ 无漂移，模型与数据库结构一致。\n");
  }

  await sequelize.close();
  process.exitCode = hasDrift ? 1 : 0;
}

main().catch(async (error) => {
  // 诊断脚本出错时打印完整堆栈，否则「某处 undefined」这类报错很难定位
  console.error("结构检查失败：\n", error.stack || error.message);
  await sequelize.close().catch(() => {});
  process.exitCode = 1;
});
