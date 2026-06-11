// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  cryptoDocs — AES-256-GCM at-rest encryption for engineering docs
//
//  Why: docs/private/*.md contain implementation details (stealth
//  mechanics, auto-type internals, prompts, server architecture) that
//  are safe to keep in version control AS LONG AS they're encrypted.
//  Anyone who clones the GitHub repo gets the ciphertext files but no
//  key — they can't read them. The key lives in the ENGINEERING_DOCS_KEY
//  env var on the developer's machine + on the Railway production env;
//  it is never written to the repo.
//
//  Format (per file):
//    bytes 0..16   IV (random per encryption)
//    bytes 16..32  GCM auth tag
//    bytes 32..    ciphertext (the doc bytes)
//
//  AES-256-GCM was chosen for:
//    - authenticated encryption (a flipped bit anywhere → decryption fails)
//    - small overhead (~28 bytes per file regardless of size)
//    - native node:crypto support, no external deps
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

'use strict';

const crypto = require('node:crypto');

const ALGO = 'aes-256-gcm';
const KEY_LEN = 32;  // 256-bit
const IV_LEN  = 16;  // 128-bit IV (GCM accepts variable, 16 is recommended)
const TAG_LEN = 16;  // 128-bit GCM tag

// Decode the env-supplied key. Supports base64 (recommended, 44 chars
// including padding) or hex (64 chars). Anything else throws — we'd
// rather crash loudly at boot than silently encrypt with a degraded key.
function loadKey() {
  const raw = process.env.ENGINEERING_DOCS_KEY;
  if (!raw) {
    const err = new Error('ENGINEERING_DOCS_KEY is not set');
    err.code = 'NO_KEY';
    throw err;
  }
  let key;
  const cleaned = raw.trim();
  if (/^[A-Fa-f0-9]+$/.test(cleaned) && cleaned.length === KEY_LEN * 2) {
    key = Buffer.from(cleaned, 'hex');
  } else {
    // Base64 / base64url
    try {
      key = Buffer.from(cleaned, 'base64');
    } catch {
      throw new Error('ENGINEERING_DOCS_KEY is not valid base64 or hex');
    }
  }
  if (key.length !== KEY_LEN) {
    throw new Error(`ENGINEERING_DOCS_KEY must decode to ${KEY_LEN} bytes; got ${key.length}`);
  }
  return key;
}

function encryptBuffer(plain, key) {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Layout: IV (16) | TAG (16) | CIPHERTEXT
  return Buffer.concat([iv, tag, encrypted]);
}

function decryptBuffer(payload, key) {
  if (!Buffer.isBuffer(payload) || payload.length < IV_LEN + TAG_LEN) {
    throw new Error('ciphertext too short');
  }
  const iv  = payload.subarray(0, IV_LEN);
  const tag = payload.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct  = payload.subarray(IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

// Convenience: encrypt/decrypt a UTF-8 string with the env-supplied key.
function encryptString(plaintext) {
  return encryptBuffer(Buffer.from(plaintext, 'utf8'), loadKey());
}

function decryptString(payload) {
  return decryptBuffer(payload, loadKey()).toString('utf8');
}

// Generate a fresh key — used by the CLI / docs.
function generateKey() {
  return crypto.randomBytes(KEY_LEN).toString('base64');
}

module.exports = {
  encryptBuffer,
  decryptBuffer,
  encryptString,
  decryptString,
  loadKey,
  generateKey,
  ALGO, KEY_LEN, IV_LEN, TAG_LEN,
};
