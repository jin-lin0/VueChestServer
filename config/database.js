const { Sequelize } = require("sequelize");
require("dotenv").config();

/**
 * 连接池参数的取法，两个环境不一样，理由见下面的逐条注释。
 * 抽成函数是为了让 test/databasePool.test.js 能直接断言这两个分支，
 * 而不是靠「本地跑一次觉得快」这种无法回归的证据。
 *
 * @param {boolean} serverless 是否跑在 Vercel（进程会被冻结，不能留常驻连接）
 */
function poolOptions(serverless) {
  return {
    // Serverless 每个实例只保留一个连接，避免多实例冷启动耗尽 MySQL 连接数。
    max: serverless ? 1 : 5,
    // 常驻连接数。这里曾经是 0，于是**所有**连接在 idle 10s 后都被关掉，
    // 下一个请求要重付一次到远端 MySQL 的握手。
    // 实测（config/database.js 同款配置，mysql.sqlpub.com）：
    //   min:0 → 热 47.4ms，静置 14s 后首次 205.9ms（+158ms）
    //   min:1 → 热 41.1ms，静置 14s 后首次  43.2ms（无惩罚）
    // 服务端 wait_timeout 是 28800s（8 小时），远大于正常使用间隔；
    // 万一连接真的被服务端回收，socket 会变 destroyed，而 Sequelize 的
    // mysql 驱动 validate() 正会检查 `stream.destroyed`，
    // 该连接会被丢弃重建 —— 最坏情况与 min:0 完全一样，不会更差。
    // Vercel 上实例被冻结后连接本就不可用，留着白占额度，仍取 0。
    min: serverless ? 0 : 1,
    acquire: serverless ? 8000 : 30000,
    idle: 10000,
  };
}

const sequelize = new Sequelize(
  process.env.DB_NAME,
  process.env.DB_USER,
  process.env.DB_PASSWORD,
  {
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    dialect: "mysql",
    dialectModule: require("mysql2"),
    logging: false,
    pool: poolOptions(Boolean(process.env.VERCEL)),
  }
);

module.exports = sequelize;
