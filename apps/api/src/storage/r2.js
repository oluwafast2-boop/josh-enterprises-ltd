// Cloudflare R2 helper (S3-compatible). Zero-dep runnable: without
// @aws-sdk/client-s3 or R2 creds it runs in stub mode so the API boots.
// Install later: npm i @aws-sdk/client-s3 @aws-sdk/s3-request-presigner
//
// Buckets: josh-listings (public via CDN), josh-private (KYC/evidence, presigned GET only).
const hasSdk = (() => { try { require.resolve('@aws-sdk/client-s3'); return true; } catch { return false; } })();
const hasCreds = !!(process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY);
const MODE = hasSdk && hasCreds ? 'real' : 'stub';

function endpoint() {
  return `https://${process.env.R2_ACCOUNT_ID || 'account-id'}.r2.cloudflarestorage.com`;
}

async function presignedPut(bucket, key, contentType = 'application/octet-stream') {
  if (MODE !== 'real') return { mode: MODE, bucket, key, url: null, hint: 'set R2_* env + npm i @aws-sdk/client-s3' };
  const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
  const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
  const client = new S3Client({ region: 'auto', endpoint: endpoint(), credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY } });
  const url = await getSignedUrl(client, new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType }), { expiresIn: 900 });
  return { mode: MODE, bucket, key, url };
}

module.exports = { MODE, presignedPut, buckets: { listings: process.env.R2_BUCKET_LISTINGS || 'josh-listings', private: process.env.R2_BUCKET_PRIVATE || 'josh-private' } };
