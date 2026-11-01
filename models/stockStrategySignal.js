const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

/**
 * 策略每日选股快照 + 次日表现评估。
 *
 * 一行 = 「某策略在某个信号日的一批候选股」。
 * - picks：当日命中的股票列表 [{ symbol, name }]，上限由采集侧控制。
 * - 评估：次一交易日收盘后（实际是再下一天早上的 cron）用腾讯批量行情回看
 *   每只股票当日涨跌，upCount/total 即该策略该信号日的「预测正确率」。
 * - (strategyId, signalDate) 唯一：cron 重跑/手动触发不会产生重复样本，
 *   否则历史正确率会被重复天数加权污染。
 */
const StockStrategySignal = sequelize.define(
  "StockStrategySignal",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    strategyId: {
      type: DataTypes.STRING(64),
      allowNull: false,
    },
    strategyName: {
      type: DataTypes.STRING(64),
      allowNull: false,
    },
    // 信号产生的交易日（来自 CLI 结果标题，不是 cron 运行日）
    signalDate: {
      type: DataTypes.DATEONLY,
      allowNull: false,
    },
    picks: {
      type: DataTypes.JSON,
      allowNull: false,
    },
    evaluated: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    // 用于评估的交易日（信号日的次一交易日）
    evalDate: {
      type: DataTypes.DATEONLY,
      allowNull: true,
    },
    // 评估样本数（行情缺失的股票不计入）
    total: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    upCount: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    // 评估日全部样本的平均涨跌幅（%）
    avgChangePercent: {
      type: DataTypes.FLOAT,
      allowNull: true,
    },
  },
  {
    tableName: "stock_strategy_signals",
    timestamps: true,
    updatedAt: false,
    indexes: [
      { unique: true, fields: ["strategyId", "signalDate"] },
      { fields: ["evaluated"] },
    ],
  },
);

module.exports = StockStrategySignal;
