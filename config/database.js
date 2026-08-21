const { Sequelize } = require("sequelize");
require("dotenv").config();

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
    pool: {
      // Serverless 每个实例只保留一个连接，避免多实例冷启动耗尽 MySQL 连接数。
      max: process.env.VERCEL ? 1 : 5,
      min: 0,
      acquire: process.env.VERCEL ? 8000 : 30000,
      idle: 10000,
    },
  }
);

module.exports = sequelize;
