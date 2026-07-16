require("dotenv").config({
  path: require("path").join(__dirname, "..", ".env"),
});
const sequelize = require("../config/database");
const MarketApp = require("../models/marketApp");
const { deleteObject } = require("../utils/r2");

async function main() {
  const apps = await MarketApp.findAll({ attributes: ["id", "fileKey"] });
  for (const app of apps) {
    if (app.fileKey) await deleteObject(app.fileKey).catch(() => {});
  }
  await MarketApp.destroy({ where: {} });
  console.log(`已清空 ${apps.length} 个市场应用及其 R2 文件`);
}

main()
  .catch((error) => {
    console.error("清空市场应用失败:", error.message);
    process.exitCode = 1;
  })
  .finally(() => sequelize.close());
