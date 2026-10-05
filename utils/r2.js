const {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const BUCKET = process.env.R2_BUCKET_NAME || "vuechest";
const PUBLIC_URL = (
  process.env.R2_PUBLIC_URL || "https://files.020201.xyz"
).replace(/\/$/, "");

let client;
function getClient() {
  if (client) return client;
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = process.env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    throw new Error("R2 环境变量未完整配置");
  }
  client = new S3Client({
    region: "auto",
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
    // AWS SDK v3 自 3.729 起默认给请求附加校验和，预签名 PUT 会被写进
    // `x-amz-checksum-crc32=AAAAAA==`（**空 body** 的 CRC32，因为签名时还不知道
    // 真实内容），同时把 `x-amz-meta-*` 从签名头挪到查询参数里。后果是：
    //   · 客户端把 x-amz-meta-sha256 当请求头发出 → 规范化请求与签名不一致
    //     → R2 返回 SignatureDoesNotMatch（应用包上传 403，就是这个问题）；
    //   · 客户端不发该头 → 对象拿不到 sha256 元数据 → /complete 的完整性校验必然失败。
    // 两个默认值都关掉，让元数据回到「签进签名头、由客户端发送」的正常形态。
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  return client;
}

function publicUrl(key) {
  return `${PUBLIC_URL}/${key}`;
}

async function createUploadUrl(key, contentType, metadata) {
  const command = new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ContentType: contentType,
    ...(metadata ? { Metadata: metadata } : {}),
  });
  // 把 x-amz-meta-* 钉在签名头里（与上面 S3Client 的说明配套），
  // 否则 presigner 会把它们提升为查询参数，客户端再发送同名请求头就会签名不匹配。
  const metadataHeaders = metadata
    ? Object.keys(metadata).map((name) => `x-amz-meta-${name}`)
    : [];
  return getSignedUrl(getClient(), command, {
    expiresIn: 600,
    ...(metadataHeaders.length
      ? { unhoistableHeaders: new Set(metadataHeaders) }
      : {}),
  });
}

async function headObject(key) {
  return getClient().send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
}

async function deleteObject(key) {
  return getClient().send(
    new DeleteObjectCommand({ Bucket: BUCKET, Key: key }),
  );
}

module.exports = { createUploadUrl, headObject, deleteObject, publicUrl };
