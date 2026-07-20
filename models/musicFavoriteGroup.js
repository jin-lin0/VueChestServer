const { DataTypes } = require("sequelize");

const sequelize = require("../config/database");

// 音乐收藏夹（每个用户有一个默认组「我的喜欢」，其余为用户自建分组）
const MusicFavoriteGroup = sequelize.define(
  "MusicFavoriteGroup",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    name: {
      type: DataTypes.STRING(50),
      allowNull: false,
      validate: { len: [1, 20] },
    },
    isDefault: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
  },
  {
    tableName: "music_favorite_groups",
    timestamps: true,
    indexes: [{ fields: ["userId"] }],
  },
);

module.exports = MusicFavoriteGroup;
