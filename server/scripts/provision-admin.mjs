#!/usr/bin/env node
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  PROVISION AN ADMIN ACCOUNT
//
//  Admin authority in this codebase is derived from the email string:
//  middleware/admin.js, middleware/tier.js, middleware/regionGate.js and
//  the support-WS agent role all decide by comparing against ADMIN_EMAILS.
//  Nothing reads a flag on the row.
//
//  That is why routes/auth.js refuses to CREATE an account for any
//  ADMIN_EMAILS address (see isReservedAdminEmail): while such an address
//  had no account, whoever signed up with it first became an admin. This
//  script is the deliberate replacement — run by someone who already has
//  the database and the environment, which is the proof self-serve signup
//  could never provide.
//
//  Usage (from the server/ directory, with the real env loaded):
//
//    node scripts/provision-admin.mjs --email you@example.com
//    node scripts/provision-admin.mjs --email you@example.com --password '…'
//
//  With no --password a strong one is generated and printed once. The
//  address must already be listed in ADMIN_EMAILS; this script grants no
//  authority of its own, it only creates the account that address will
//  be recognised through.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

function die(msg) {
  console.error(`\n  ✗ ${msg}\n`);
  process.exit(1);
}

const email = String(arg('email') || '').trim().toLowerCase();
if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  die('Pass a valid address:  node scripts/provision-admin.mjs --email you@example.com');
}

const adminEmails = (process.env.ADMIN_EMAILS || '')
  .split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);

if (!adminEmails.length) {
  die('ADMIN_EMAILS is not set in this environment. Load the real env first — provisioning an account for an address the server will not recognise as admin achieves nothing.');
}
if (!adminEmails.includes(email)) {
  die(`${email} is not in ADMIN_EMAILS (${adminEmails.join(', ')}). Add it there first — this script does not grant authority, it only creates the account the address is recognised through.`);
}

// Generated passwords go through the same alphabet as everything else a
// human may have to retype once. 20 chars ≈ 100 bits.
function generatePassword() {
  const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%^&*';
  const bytes = crypto.randomBytes(20);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

const password = arg('password') || generatePassword();
const generated = !arg('password');
if (password.length < 8) die('Password must be at least 8 characters (isStrongPassword in routes/auth.js).');

const db = require(path.join(here, '..', 'src', 'database.js'));

const existing = db.getUserByEmail(email);
if (existing) {
  die(`An account already exists for ${email} (id ${existing.id}). Nothing to do — it is already recognised as admin by every gate. Use the password-reset flow if you have lost the password.`);
}

const { v4: uuidv4 } = require('uuid');
const userId = uuidv4();
const now = Date.now();

db.createUser({
  id: userId,
  email,
  name: email.split('@')[0],
  password,
  tier: 'ultra',
  country_code: String(arg('country') || 'US').toUpperCase(),
});

db.createLicense({
  key: `MNC-${userId.slice(0, 8).toUpperCase()}-${now.toString(36).toUpperCase()}`,
  user_id: userId,
  email,
  tier: 'ultra',
  status: 'active',
  country_code: String(arg('country') || 'US').toUpperCase(),
  expires_at: -1,
  sessions_limit: -1,
});

try {
  db.logAdminAction(email, 'admin-account-provisioned', userId, email, { via: 'scripts/provision-admin.mjs' });
} catch { /* audit is best-effort */ }

console.log(`\n  ✓ Provisioned admin account for ${email}`);
console.log(`    user id : ${userId}`);
console.log(`    tier    : ultra (never expires)`);
if (generated) {
  console.log(`\n    password: ${password}`);
  console.log('\n    ↑ shown once, not stored anywhere in plain text. Save it now,');
  console.log('      then sign in and change it from the app.\n');
} else {
  console.log('\n    Sign in with the password you passed.\n');
}
