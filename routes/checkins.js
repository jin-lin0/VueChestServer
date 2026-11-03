const express = require("express");
const State = require("../models/checkinState");
const Run = require("../models/cronRun");
const cronAuth = require("../middleware/cronAuth");
const { createCheckinService } = require("../services/checkins");

const service = createCheckinService({ State, Run });
const router = express.Router();

async function run(req, res) {
  const result = await service.runAll();
  res.status(result.success ? 200 : 502).json(result);
}

// 个人运维入口：定时触发和手动补跑都只使用 Cron 密钥。
router.route("/run").get(cronAuth, run).post(cronAuth, run);

// 仅写入，不提供凭据读取接口；与定时入口使用同一运维密钥。
router.put("/credentials/:task", cronAuth, async (req, res) => {
  const data = await service.configure(req.params.task, req.body);
  res.json({ success: true, data });
});

module.exports = router;
