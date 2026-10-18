const { Sequelize } = require("sequelize");
require("dotenv").config();

/**
 * Serverless 限制单实例连接数且不保留空闲连接；常驻服务保留连接以减少握手。
 * @param {boolean} serverless 是否运行于 Serverless 环境
 */
function poolOptions(serverless) {
  return {
    // Serverless 每个实例只保留一个连接，避免多实例冷启动耗尽 MySQL 连接数。
    max: serverless ? 1 : 5,

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
