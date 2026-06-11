// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  OFF-SITE BACKUP UPLOAD  (S3-compatible: AWS S3 / Cloudflare R2 / B2)
//
//  Closes the single-point-of-failure in backup.js: VACUUM INTO snapshots
//  live on the SAME Railway volume as the live DB, so a volume
//  delete / detach / corruption loses the backups along with the data.
//  This uploads each daily snapshot to an off-site S3-compatible bucket.
//
//  Dependency-free on purpose — a SigV4 PUT via Node's built-in crypto +
//  global fetch (Node >=18). Adds nothing to package.json (and can't break
//  `npm install` on a machine with TLS-intercept issues). Optional
//  client-side AES-256-GCM encryption (BACKUP_ENCRYPTION_KEY) so the bucket
//  holder never sees plaintext PII.
//
//  GATED OFF by default: with no BACKUP_S3_* env vars every function here is
//  a no-op and backup.js behaves exactly as before. To enable, set the vars
//  below and redeploy, then:
//    1. WATCH the boot self-test line in logs ("off-site self-test PASSED").
//    2. Do a manual RESTORE DRILL (download a snapshot, open it, verify row
//       counts) before relying on this — the SigV4 signing here has NOT been
//       exercised against a live bucket in-repo.
//  For continuous (not just daily) replication, Litestream is the more
//  robust option — see BACKUP-OFFSITE.md.
//
//  Env:
//    BACKUP_S3_BUCKET             (required) bucket name
//    BACKUP_S3_ACCESS_KEY_ID      (required)
//    BACKUP_S3_SECRET_ACCESS_KEY  (required)
//    BACKUP_S3_REGION             default 'auto' (R2); set your AWS region for S3
//    BACKUP_S3_ENDPOINT           R2/B2 endpoint, e.g.
//                                 https://<acct>.r2.cloudflarestorage.com
//                                 (omit for AWS S3 → virtual-hosted URL)
//    BACKUP_S3_PREFIX             key prefix, default 'minicaai-db-backups'
//    BACKUP_ENCRYPTION_KEY        optional 64-hex (32-byte) AES-256-GCM key
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function cfg() {
  return {
    bucket: process.env.BACKUP_S3_BUCKET || '',
    region: process.env.BACKUP_S3_REGION || 'auto',
    accessKeyId: process.env.BACKUP_S3_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.BACKUP_S3_SECRET_ACCESS_KEY || '',
    endpoint: process.env.BACKUP_S3_ENDPOINT || '',
    prefix: (process.env.BACKUP_S3_PREFIX || 'minicaai-db-backups').replace(/^\/+|\/+$/g, ''),
    encKeyHex: process.env.BACKUP_ENCRYPTION_KEY || '',
  };
}

function isConfigured() {
  const c = cfg();
  return !!(c.bucket && c.accessKeyId && c.secretAccessKey);
}

function sha256hex(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function hmac(key, str) { return crypto.createHmac('sha256', key).update(str, 'utf8').digest(); }

// RFC3986-encode a single path segment for the SigV4 canonical URI. encode
// everything except unreserved chars; the slash separators between segments
// are added by the caller and never encoded.
function uriEncodeSegment(seg) {
  return encodeURIComponent(seg).replace(/[!*'()]/g, ch => '%' + ch.charCodeAt(0).toString(16).toUpperCase());
}

// Resolve { host, origin, pathname } for an object key. Path-style when an
// explicit endpoint is set (R2/B2: https://host/<bucket>/<key>), virtual-
// hosted for AWS S3 (https://<bucket>.s3.<region>.amazonaws.com/<key>).
function resolveTarget(c, key) {
  if (c.endpoint) {
    const u = new URL(c.endpoint);
    const pathname = '/' + [c.bucket, ...key.split('/')].map(uriEncodeSegment).join('/');
    return { host: u.host, origin: `${u.protocol}//${u.host}`, pathname };
  }
  const host = `${c.bucket}.s3.${c.region}.amazonaws.com`;
  const pathname = '/' + key.split('/').map(uriEncodeSegment).join('/');
  return { host, origin: `https://${host}`, pathname };
}

// Sign + send a single S3 REST request (AWS Signature V4). body is a Buffer
// (empty for GET/DELETE). Content-Length is left to fetch; it is not a
// signed header, so it never affects the signature.
async function signedRequest(method, key, body) {
  const c = cfg();
  const payload = body || Buffer.alloc(0);
  const { host, origin, pathname } = resolveTarget(c, key);
  const amzdate = new Date().toISOString().replace(/[:-]/g, '').replace(/\.\d{3}/, ''); // YYYYMMDDTHHMMSSZ
  const datestamp = amzdate.slice(0, 8);
  const payloadHash = sha256hex(payload);

  const canonicalHeaders =
    `host:${host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzdate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = [method, pathname, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');

  const scope = `${datestamp}/${c.region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzdate,
    scope,
    sha256hex(Buffer.from(canonicalRequest, 'utf8')),
  ].join('\n');

  const kDate = hmac('AWS4' + c.secretAccessKey, datestamp);
  const kRegion = hmac(kDate, c.region);
  const kService = hmac(kRegion, 's3');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${c.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return fetch(origin + pathname, {
    method,
    headers: {
      'Authorization': authorization,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzdate,
    },
    body: method === 'PUT' ? payload : undefined,
  });
}

// Optional client-side encryption. Layout: [12-byte IV][16-byte GCM tag][ciphertext].
function maybeEncrypt(buf) {
  const c = cfg();
  if (!c.encKeyHex) return { data: buf, ext: '' };
  const key = Buffer.from(c.encKeyHex, 'hex');
  if (key.length !== 32) {
    throw new Error('BACKUP_ENCRYPTION_KEY must be 64 hex chars (32 bytes) for AES-256-GCM');
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(buf), cipher.final()]);
  return { data: Buffer.concat([iv, cipher.getAuthTag(), enc]), ext: '.enc' };
}

// Upload one local snapshot file. Resolves { skipped } when unconfigured,
// or { key, bytes }. Throws on a non-2xx response (caller logs; never lets
// it break the local backup).
async function uploadBackup(localPath) {
  if (!isConfigured()) return { skipped: true };
  const c = cfg();
  const raw = fs.readFileSync(localPath);
  const { data, ext } = maybeEncrypt(raw);
  const key = `${c.prefix}/${path.basename(localPath)}${ext}`;
  const res = await signedRequest('PUT', key, data);
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`off-site upload ${res.status}: ${t.slice(0, 300)}`);
  }
  return { key, bytes: data.length };
}

// Boot-time connectivity + credential check: PUT a tiny probe, GET it back,
// compare, then best-effort DELETE. Surfaces a misconfiguration loudly in
// logs instead of during a real disaster. Resolves { skipped } / { ok:true }
// or throws.
async function selfTest() {
  if (!isConfigured()) return { skipped: true };
  const c = cfg();
  const key = `${c.prefix}/.selftest-${Date.now()}`;
  const probe = Buffer.from(`minicaai backup self-test ${new Date().toISOString()}`);
  const put = await signedRequest('PUT', key, probe);
  if (!put.ok) throw new Error(`self-test PUT ${put.status}: ${(await put.text().catch(() => '')).slice(0, 200)}`);
  const get = await signedRequest('GET', key, Buffer.alloc(0));
  if (!get.ok) throw new Error(`self-test GET ${get.status}`);
  const back = Buffer.from(await get.arrayBuffer());
  try { await signedRequest('DELETE', key, Buffer.alloc(0)); } catch { /* cleanup best-effort */ }
  if (!back.equals(probe)) throw new Error('self-test readback mismatch');
  return { ok: true };
}

module.exports = { isConfigured, uploadBackup, selfTest, cfg };
