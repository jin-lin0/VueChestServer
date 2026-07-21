// R2 存量文件重命名迁移脚本
// 用法:
//   node scripts/migrate-r2-names.js --dry     # 只读，打印计划 + 备份到 /tmp
//   node scripts/migrate-r2-names.js --apply   # 实际执行 copy -> 更新DB -> 删除旧key
//
// 新命名规则(可读 + 唯一, 用数据库主键做后缀):
//   应用:  apps/{uploadedBy}/{slug(name)}-v{version}-{id}.js
//   头像:  avatars/{userId}/{slug(username)}-{id}.{ext}
// 例:  apps/123/我的天气应用-v1.2.0-45.js  /  avatars/7/hejinlin-7.jpg

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const {
  S3Client,
  ListObjectsV2Command,
  CopyObjectCommand,
  DeleteObjectCommand,
} = require("@aws-sdk/client-s3");
const mysql = require("mysql2/promise");
const fs = require("fs");
const slugify = require("../utils/slugify");

const BUCKET = process.env.R2_BUCKET_NAME || "vuechest";
const PUBLIC_URL = (
  process.env.R2_PUBLIC_URL || "https://files.020201.xyz"
).replace(/\/$/, "");
const ACCOUNT = process.env.R2_ACCOUNT_ID;

const client = new S3Client({
  region: "auto",
  endpoint: `https://${ACCOUNT}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const publicUrl = (key) => `${PUBLIC_URL}/${key}`;
const copySource = (key) =>
  `${BUCKET}/${key.split("/").map(encodeURIComponent).join("/")}`;
const extOf = (key) => (key.split(".").pop() || "bin").toLowerCase();

async function buildPlan() {
  const db = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });

  const [apps] = await db.execute(
    "SELECT id, name, version, fileKey, uploadedBy FROM market_apps WHERE fileKey IS NOT NULL AND fileKey != ''",
  );
  const [users] = await db.execute(
    "SELECT id, username, avatar FROM users WHERE avatar IS NOT NULL AND avatar != ''",
  );
  await db.end();

  const plan = [];
  for (const a of apps) {
    const oldKey = a.fileKey;
    const owner = a.uploadedBy || "unknown";
    const name = slugify(`${a.name}-v${a.version}`, `app-${a.id}`);
    const newKey = `apps/${owner}/${name}-${a.id}.${extOf(oldKey)}`;
    if (newKey !== oldKey) plan.push({ type: "app", id: a.id, oldKey, newKey });
  }
  for (const u of users) {
    if (!u.avatar.startsWith(PUBLIC_URL)) continue; // 非 R2 文件, 跳过
    const oldKey = u.avatar.slice(PUBLIC_URL.length + 1);
    const name = slugify(u.username, `user-${u.id}`);
    const newKey = `avatars/${u.id}/${name}-${u.id}.${extOf(oldKey)}`;
    if (newKey !== oldKey)
      plan.push({ type: "avatar", id: u.id, oldKey, newKey });
  }
  return plan;
}

async function apply(plan) {
  let ok = 0,
    fail = 0;
  for (const p of plan) {
    try {
      // 1) 复制到新 key (保留原内容/元数据)
      await client.send(
        new CopyObjectCommand({
          Bucket: BUCKET,
          CopySource: copySource(p.oldKey),
          Key: p.newKey,
        }),
      );
      // 2) 更新数据库指向新 key
      const db = await mysql.createConnection({
        host: process.env.DB_HOST,
        port: Number(process.env.DB_PORT) || 3306,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
      });
      if (p.type === "app")
        await db.execute(
          "UPDATE market_apps SET fileKey = ?, fileUrl = ? WHERE id = ?",
          [p.newKey, publicUrl(p.newKey), p.id],
        );
      else
        await db.execute("UPDATE users SET avatar = ? WHERE id = ?", [
          publicUrl(p.newKey),
          p.id,
        ]);
      await db.end();
      // 3) 确认新 key 已写入后再删旧 key
      await client.send(
        new DeleteObjectCommand({ Bucket: BUCKET, Key: p.oldKey }),
      );
      ok++;
      console.log(`  ✓ [${p.type}] ${p.oldKey} -> ${p.newKey}`);
    } catch (e) {
      fail++;
      console.error(`  ✗ [${p.type}] ${p.oldKey}: ${e.message}`);
    }
  }
  console.log(`\n完成: 成功 ${ok} 个, 失败 ${fail} 个`);
}

async function main() {
  const dry = process.argv.includes("--dry");
  const plan = await buildPlan();

  // 备份(便于回滚)
  fs.writeFileSync(
    "/tmp/r2-rename-backup.json",
    JSON.stringify({ generatedAt: new Date().toISOString(), plan }, null, 2),
  );

  if (dry) {
    console.log(`DRY RUN: 共 ${plan.length} 个对象待重命名\n`);
    for (const p of plan)
      console.log(`[${p.type}] ${p.oldKey}\n        -> ${p.newKey}`);
    console.log(`\n备份已写入 /tmp/r2-rename-backup.json`);
    return;
  }

  console.log(`APPLY: 开始重命名 ${plan.length} 个对象...\n`);
  await apply(plan);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
