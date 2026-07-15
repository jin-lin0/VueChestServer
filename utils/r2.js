const { S3Client, PutObjectCommand, HeadObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const BUCKET = process.env.R2_BUCKET_NAME || "vuechest";
const PUBLIC_URL = (process.env.R2_PUBLIC_URL || "https://files.020201.xyz").replace(/\/$/, "");

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
    credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
  });
  return client;
}

function publicUrl(key) {
  return `${PUBLIC_URL}/${key}`;
}

async function createUploadUrl(key, contentType) {
  const command = new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: contentType });
  return getSignedUrl(getClient(), command, { expiresIn: 600 });
}

async function headObject(key) {
  return getClient().send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
}

async function deleteObject(key) {
  return getClient().send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}

module.exports = { createUploadUrl, headObject, deleteObject, publicUrl };
