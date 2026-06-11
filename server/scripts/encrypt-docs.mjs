#!/usr/bin/env node
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  encrypt-docs.mjs — CLI for the engineering-docs encryption pipeline
//
//  Usage (from repo root or server/):
//    node server/scripts/encrypt-docs.mjs             # encrypt all
//    node server/scripts/encrypt-docs.mjs --check     # verify decryption
//    node server/scripts/encrypt-docs.mjs --keygen    # print a fresh key
//
//  Reads docs/private/*.md (plaintext, gitignored), writes
//  docs/private/*.md.enc (ciphertext, committed). Key from
//  ENGINEERING_DOCS_KEY env (.env or shell). Files matching .enc that
//  no longer have a matching plaintext are not removed — delete by
//  hand if you intend to retire a doc.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// Load .env so the script works without manually exporting the key.
// dotenv is already a server dep.
try {
  require('dotenv').config({ path: path.resolve(fileURLToPath(import.meta.url), '../../.env') });
} catch { /* dotenv optional if env already set */ }

const { encryptBuffer, decryptBuffer, loadKey, generateKey } = require('../src/utils/cryptoDocs');

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const REPO_ROOT  = path.resolve(__dirname, '../..');
const PRIVATE_DIR = path.join(REPO_ROOT, 'docs', 'private');

const args = new Set(process.argv.slice(2));

if (args.has('--keygen') || args.has('-k')) {
  const key = generateKey();
  console.log('Generated ENGINEERING_DOCS_KEY (base64, 32 bytes):');
  console.log();
  console.log(`  ${key}`);
  console.log();
  console.log('Save this in:');
  console.log('  • server/.env  →  ENGINEERING_DOCS_KEY=<paste>');
  console.log('  • Railway env  →  ENGINEERING_DOCS_KEY (Production env vars)');
  console.log();
  console.log('DO NOT commit the key. If you lose it, the encrypted docs are unrecoverable.');
  process.exit(0);
}

function listPlainDocs() {
  if (!fs.existsSync(PRIVATE_DIR)) return [];
  return fs.readdirSync(PRIVATE_DIR)
    .filter(f => f.endsWith('.md') && !f.endsWith('.enc'))
    .map(f => path.join(PRIVATE_DIR, f));
}

function listEncDocs() {
  if (!fs.existsSync(PRIVATE_DIR)) return [];
  return fs.readdirSync(PRIVATE_DIR)
    .filter(f => f.endsWith('.md.enc'))
    .map(f => path.join(PRIVATE_DIR, f));
}

let key;
try {
  key = loadKey();
} catch (err) {
  console.error('❌  ' + err.message);
  if (err.code === 'NO_KEY') {
    console.error();
    console.error('Generate a key first:  node server/scripts/encrypt-docs.mjs --keygen');
    console.error('Then add it to server/.env  →  ENGINEERING_DOCS_KEY=<value>');
  }
  process.exit(1);
}

if (args.has('--check') || args.has('-c')) {
  const encFiles = listEncDocs();
  if (encFiles.length === 0) {
    console.log('No .md.enc files found in docs/private/. Nothing to verify.');
    process.exit(0);
  }
  let failures = 0;
  for (const f of encFiles) {
    try {
      const payload = fs.readFileSync(f);
      const plain = decryptBuffer(payload, key).toString('utf8');
      console.log(`✓ ${path.relative(REPO_ROOT, f)}  (${plain.length} chars)`);
    } catch (err) {
      console.error(`✗ ${path.relative(REPO_ROOT, f)}  — ${err.message}`);
      failures += 1;
    }
  }
  if (failures > 0) {
    console.error(`\n${failures} file(s) failed to decrypt. Wrong key, or files corrupted.`);
    process.exit(1);
  }
  console.log(`\nAll ${encFiles.length} encrypted doc(s) decrypt cleanly.`);
  process.exit(0);
}

// Default: encrypt all plaintext → .enc
const plainFiles = listPlainDocs();
if (plainFiles.length === 0) {
  console.log('No plaintext .md files in docs/private/. Nothing to encrypt.');
  console.log();
  console.log(`Drop your engineering docs in:  ${path.relative(REPO_ROOT, PRIVATE_DIR)}`);
  console.log('Then re-run this script.');
  process.exit(0);
}

let encrypted = 0;
let skipped = 0;
for (const src of plainFiles) {
  const enc = src + '.enc';
  const plaintext = fs.readFileSync(src);
  // Skip if .enc already matches (avoids touching mtime + git noise)
  if (fs.existsSync(enc)) {
    try {
      const existing = decryptBuffer(fs.readFileSync(enc), key);
      if (existing.equals(plaintext)) {
        console.log(`= ${path.relative(REPO_ROOT, src)}  (unchanged)`);
        skipped += 1;
        continue;
      }
    } catch {
      // existing .enc decrypts to something else — fall through and rewrite
    }
  }
  const ciphertext = encryptBuffer(plaintext, key);
  fs.writeFileSync(enc, ciphertext);
  console.log(`✓ ${path.relative(REPO_ROOT, src)}  →  ${path.basename(enc)}  (${plaintext.length} → ${ciphertext.length} bytes)`);
  encrypted += 1;
}

console.log();
console.log(`Encrypted ${encrypted} file(s); ${skipped} unchanged.`);
console.log('Commit the .enc files; the plaintext .md is gitignored.');
