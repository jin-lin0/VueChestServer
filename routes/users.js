const express = require("express");
const User = require("../models/user");
const { authMiddleware } = require("../middleware/auth");
const { superAdminOnly } = require("../middleware/superAdmin");

const router = express.Router();

// 获取用户列表
router.get("/", authMiddleware, superAdminOnly, async (req, res) => {
  try {
    const { page = "1", limit = "20", role, keyword } = req.query;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(50, Math.max(1, parseInt(limit)));
    const offset = (pageNum - 1) * limitNum;

    const where = {};
    if (role) where.role = role;
    if (keyword) {
      where[require("sequelize").Op.or] = [
        { username: { [require("sequelize").Op.like]: `%${keyword}%` } },
        { email: { [require("sequelize").Op.like]: `%${keyword}%` } },
      ];
    }

    const { rows, count } = await User.findAndCountAll({
      where,
      attributes: { exclude: ["password"] },
      order: [["createdAt", "DESC"]],
      offset,
      limit: limitNum,
    });

    res.json({
      success: true,
      data: {
        items: rows,
        total: count,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(count / limitNum),
      },
    });
  } catch (error) {
    console.error("获取用户列表错误:", error);
    res.status(500).json({ error: "服务器内部错误" });
  }
});

// 创建用户（可指定角色）
router.post("/", authMiddleware, superAdminOnly, async (req, res) => {
  try {
    const { username, password, email, role } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: "用户名和密码不能为空" });
    }

    const existing = await User.findOne({ where: { username } });
    if (existing) {
      return res.status(409).json({ error: "用户名已存在" });
    }

    const user = await User.create({
      username,
      password,
      email,
      role: role || "user",
      isActive: true,
      installedApps: [],
    });

    res.status(201).json({
      success: true,
      data: user.toJSON(),
    });
  } catch (error) {
    console.error("创建用户错误:", error);
    res.status(500).json({ error: "服务器内部错误" });
  }
});

// 获取用户详情
router.get("/:id", authMiddleware, superAdminOnly, async (req, res) => {
  try {
    const user = await User.findByPk(req.params.id, {
      attributes: { exclude: ["password"] },
    });

    if (!user) {
      return res.status(404).json({ error: "用户不存在" });
    }

    res.json({
      success: true,
      data: user.toJSON(),
    });
  } catch (error) {
    console.error("获取用户详情错误:", error);
    res.status(500).json({ error: "服务器内部错误" });
  }
});

// 更新用户信息
router.put("/:id", authMiddleware, superAdminOnly, async (req, res) => {
  try {
    const user = await User.findByPk(req.params.id);
    if (!user) {
      return res.status(404).json({ error: "用户不存在" });
    }

    const { username, password, email, role, isActive, avatar } = req.body;
    const updateData = {};
    if (username !== undefined) updateData.username = username;
    if (email !== undefined) updateData.email = email;
    if (role !== undefined) updateData.role = role;
    if (isActive !== undefined) updateData.isActive = isActive;
    if (avatar !== undefined) updateData.avatar = avatar;
    if (password && password.length >= 6) updateData.password = password;

    await user.update(updateData);

    res.json({
      success: true,
      data: user.toJSON(),
    });
  } catch (error) {
    console.error("更新用户错误:", error);
    res.status(500).json({ error: "服务器内部错误" });
  }
});

// 删除/停用用户
router.delete("/:id", authMiddleware, superAdminOnly, async (req, res) => {
  try {
    const user = await User.findByPk(req.params.id);
    if (!user) {
      return res.status(404).json({ error: "用户不存在" });
    }

    if (user.id === req.user.id) {
      return res.status(400).json({ error: "不能删除自己" });
    }

    await user.update({ isActive: false });

    res.json({
      success: true,
      message: "用户已停用",
    });
  } catch (error) {
    console.error("删除用户错误:", error);
    res.status(500).json({ error: "服务器内部错误" });
  }
});

module.exports = router;
