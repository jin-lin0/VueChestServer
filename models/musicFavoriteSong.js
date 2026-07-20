const { DataTypes } = require("sequelize");

const sequelize = require("../config/database");

// 收藏歌曲（每个收藏夹内的一首歌；songData 冗余存储完整 Song 以便离线渲染，无需回源）
const MusicFavoriteSong = sequelize.define(
  "MusicFavoriteSong",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    groupId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    songId: {
      type: DataTypes.STRING(64),
      allowNull: false,
    },
    songData: {
      type: DataTypes.TEXT,
      allowNull: false,
      get() {
        const raw = this.getDataValue("songData");
        try {
          return JSON.parse(raw);
        } catch {
          return null;
        }
      },
      set(value) {
        this.setDataValue("songData", JSON.stringify(value));
      },
    },
  },
  {
    tableName: "music_favorite_songs",
    timestamps: true,
    indexes: [
      { fields: ["groupId"] },
      { unique: true, fields: ["groupId", "songId"] },
    ],
  },
);

module.exports = MusicFavoriteSong;
