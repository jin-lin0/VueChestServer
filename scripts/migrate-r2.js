const sequelize = require("../config/database");

async function migrate() {
  const queryInterface = sequelize.getQueryInterface();
  const table = await queryInterface.describeTable("market_apps");

  if (table.fileContent) await queryInterface.removeColumn("market_apps", "fileContent");
  if (!table.fileKey) await queryInterface.addColumn("market_apps", "fileKey", { type: "VARCHAR(255)" });
  if (!table.fileUrl) await queryInterface.addColumn("market_apps", "fileUrl", { type: "VARCHAR(500)" });
  if (!table.contentType) await queryInterface.addColumn("market_apps", "contentType", { type: "VARCHAR(100)" });

  console.log("R2 字段迁移完成");
}

migrate().catch((error) => {
  console.error("R2 字段迁移失败:", error);
  process.exitCode = 1;
}).finally(() => sequelize.close());
