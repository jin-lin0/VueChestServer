#!/usr/bin/env node
/**
 * 自动签到凭据录入脚本：本地跑一遍登录，直接得到 AT/RT 并写进数据库。
 *
 *   pnpm login                                   # 方向键选站点，回车确认
 *   pnpm login workbuddy-cn
 *   pnpm login workbuddy-cn --phone 13800000000 --code 123456
 *   pnpm login workbuddy-cn --dry-run            # 只打印，不写库
 *
 * 为什么不放在外部项目：凭据格式、加密密钥、入库方式都在本仓库，
 * 登录脚本放这里才能"跑完即用"，不必手工复制或跨仓库同步。
 */

require("dotenv").config({ path: require("node:path").resolve(__dirname, "../../.env") });
const readline = require("node:readline/promises");
const { stdin, stdout } = require("node:process");
const sequelize = require("../../config/database");
const User = require("../../models/user");
const State = require("../../models/dailyTaskState");
const Run = require("../../models/cronRun");
const { tasks, createDailyTaskService } = require("../../services/daily");
const workbuddy = require("./workbuddy-cn");
const { selectOption } = require("./prompt-select");

const providers = new Map([[workbuddy.id, workbuddy]]);

const HELP = `用法: pnpm login [站点] [站点选项...]

不写站点时进入交互式选择（方向键移动，回车确认）；其余参数原样交给该站点的登录脚本。

通用选项
  --owner <id>   凭据归属的超级管理员 ID（默认取唯一启用的超管）
  --dry-run      只打印凭据，不写入数据库
  -h, --help     站点前的 --help 显示本帮助，站点后的 --help 显示该站点选项

站点
${[...providers.values()]
  .map((item) => `  ${item.id.padEnd(14)}${item.summary}`)
  .join("\n")}`;

/**
 * 只解析所有站点都需要的参数；站点私有参数（手机号、验证码、Cookie 等）
 * 由各站点的 run() 自己解析，通用入口不认识这些业务概念。
 */
function splitArgs(argv) {
  const args = { owner: "", dryRun: false, help: false, rest: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === "--owner") args.owner = argv[++i] ?? "";
    else if (item === "--dry-run") args.dryRun = true;
    else if (item === "-h" || item === "--help") args.help = true;
    else args.rest.push(item);
  }
  return args;
}

function createPrompter() {
  let rl;
  return {
    async ask(question) {
      if (!rl) rl = readline.createInterface({ input: stdin, output: stdout });
      return rl.question(question);
    },
    close() {
      rl?.close();
    },
  };
}

async function resolveOwnerId(requested) {
  if (requested) {
    const id = Number(requested);
    if (!Number.isInteger(id) || id < 1) throw new Error("--owner 需要正整数用户 ID");
    const user = await User.findByPk(id, { attributes: ["id", "username", "role"] });
    if (!user || user.role !== "super_admin")
      throw new Error(`用户 ${id} 不存在或不是超级管理员`);
    return user.id;
  }
  const admins = await User.findAll({
    where: { role: "super_admin", isActive: true },
    attributes: ["id", "username"],
    order: [["id", "ASC"]],
  });
  if (admins.length === 1) return admins[0].id;
  if (admins.length === 0)
    throw new Error("没有启用的超级管理员，请先运行 scripts/init-admin.js");
  throw new Error(
    `存在多个超级管理员，请用 --owner <id> 指定归属：${admins
      .map((admin) => `${admin.id}=${admin.username}`)
      .join("，")}`,
  );
}

function taskLabel(taskId) {
  const task = tasks.find((item) => item.id === taskId);
  return task ? task.name : taskId;
}

async function main() {
  const input = process.argv.slice(2);
  const explicitTask = input.length > 0 && !input[0].startsWith("-");
  let taskId = explicitTask ? input.shift() : "";
  const args = splitArgs(input);

  // 没有站点时的 --help 只看通用帮助，站点后的 --help 看该站点自己的参数。
  if (args.help && !taskId) {
    console.log(HELP);
    return;
  }
  if (!taskId) {
    if (!process.stdin.isTTY)
      throw new Error(
        `当前环境无法交互选择，请显式指定站点：${[...providers.keys()].join("、")}`,
      );
    const chosen = await selectOption({
      message: "选择要生成凭据的站点（↑/↓ 移动，回车确认）",
      options: [...providers.values()].map((item) => ({
        label: item.label,
        hint: item.summary,
        value: item.id,
      })),
    });
    taskId = chosen.value;
  }
  const provider = providers.get(taskId);
  if (!provider)
    throw new Error(
      `没有为「${taskId}」提供登录脚本，可选：${[...providers.keys()].join("、")}`,
    );
  if (args.help) {
    console.log(`用法: pnpm login ${provider.usage}\n\n${provider.description}`);
    return;
  }

  const ownerId = await resolveOwnerId(args.owner);
  const prompter = createPrompter();
  try {
    console.log(`🔐 ${provider.label} 凭据录入（归属超管 ${ownerId}）`);
    const { credentials, account } = await provider.run(args.rest, {
      ask: prompter.ask,
      log: (line) => console.log(line),
    });
    prompter.close();

    if (!args.dryRun) {
      const service = createDailyTaskService({ State, Run });
      await service.configure(ownerId, provider.id, credentials);
    }

    console.log("\n" + "═".repeat(60));
    console.log(`✅ ${taskLabel(provider.id)} 凭据（账号 ${account}）`);
    console.log(`accessToken : ${credentials.accessToken}`);
    console.log(`refreshToken: ${credentials.refreshToken}`);
    console.log("═".repeat(60));
    console.log(
      args.dryRun
        ? "ℹ️ dry-run：未写入数据库"
        : "💾 已加密写入 daily_task_states，定时任务会直接使用这份凭据",
    );
    console.log("ℹ️ 令牌每次续期都会轮换，请勿再手工粘贴旧值覆盖");
  } finally {
    prompter.close();
  }
}

main()
  .catch((error) => {
    console.error(`❌ ${error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await sequelize.close().catch(() => {});
  });
