// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  .env.example MUST NAME EVERY VARIABLE THE SERVER READS.
//
//  It had drifted to missing ~32 of them — every LLM provider key, both
//  Deepgram keys, the entitlement signing key, the admin IP allowlist,
//  the per-tier Stripe price ids. None of those stop the server booting.
//  They fail later, one feature at a time, at whatever hour a real user
//  first touches that feature:
//
//    no OPENAI_API_KEY        → every GPT route 503s mid-interview
//    no DEEPGRAM_API_KEY      → voice mode never transcribes
//    no ENTITLEMENT_PRIVATE_KEY → Auto-Type entitlement falls back to a probe
//    no ADMIN_IP_ALLOWLIST    → admin surfaces have no network restriction
//
//  A deploy checklist cannot catch what the checklist does not know
//  about, so this asserts the property directly against the source.
//  Static — it greps src/, it does not execute anything.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, '..', 'src');
const ENV_EXAMPLE = path.join(here, '..', '.env.example');

// Injected by the hosting platform at runtime. Nobody sets these by hand,
// and listing them as blanks to fill in would be actively misleading —
// an operator who "filled in" RAILWAY_REPLICA_ID would be doing harm.
// database.js reads them to decide whether it is on a hosted deploy.
const PLATFORM_INJECTED = new Set([
  'RAILWAY_DEPLOYMENT_ID',
  'RAILWAY_ENVIRONMENT',
  'RAILWAY_ENVIRONMENT_NAME',
  'RAILWAY_PROJECT_ID',
  'RAILWAY_PUBLIC_DOMAIN',
  'RAILWAY_REPLICA_ID',
  'RAILWAY_SERVICE_ID',
  // Standard Node/PaaS conventions, documented by their own ecosystems.
  'NODE_ENV',
  'PORT',
]);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

/** Every `process.env.NAME` and `process.env['NAME']` under src/. */
function readEnvVarsFromSource() {
  const found = new Map(); // NAME → first file that reads it
  for (const file of walk(SRC)) {
    const text = fs.readFileSync(file, 'utf8');
    const rel = path.relative(path.join(here, '..'), file).replace(/\\/g, '/');
    for (const m of text.matchAll(/process\.env\.([A-Z0-9_]+)/g)) {
      if (!found.has(m[1])) found.set(m[1], rel);
    }
    for (const m of text.matchAll(/process\.env\[\s*['"]([A-Z0-9_]+)['"]\s*\]/g)) {
      if (!found.has(m[1])) found.set(m[1], rel);
    }
  }
  return found;
}

/**
 * Variables looked up through a table rather than literally, e.g.
 * `process.env[STRIPE_PRICE_ENV[tier]]`. The regex above cannot see
 * these, so the tables themselves are the source — pulled from the
 * string literals in the map so a renamed var is still caught.
 */
function readIndirectEnvVars() {
  const payments = fs.readFileSync(path.join(SRC, 'routes', 'payments.js'), 'utf8');
  const names = new Set();
  for (const block of ['STRIPE_PRICE_ENV', 'RAZORPAY_PLAN_ENV']) {
    const start = payments.indexOf(`const ${block} = {`);
    if (start === -1) continue;
    const end = payments.indexOf('};', start);
    for (const m of payments.slice(start, end).matchAll(/'([A-Z0-9_]+)'/g)) names.add(m[1]);
  }
  return names;
}

/** Every NAME= line in .env.example, commented-out ones included. */
function readDocumentedVars() {
  const text = fs.readFileSync(ENV_EXAMPLE, 'utf8');
  const names = new Set();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*#?\s*([A-Z0-9_]+)\s*=/);
    if (m) names.add(m[1]);
  }
  // Also honour a bare mention in prose ("ANTHROPIC_API_KEY is set further
  // up") so a variable documented once needn't be re-declared to satisfy
  // this test.
  for (const m of text.matchAll(/\b([A-Z][A-Z0-9_]{3,})\b/g)) names.add(m[1]);
  return names;
}

describe('.env.example covers what the server reads', () => {
  it('names every process.env variable used under src/', () => {
    const used = readEnvVarsFromSource();
    const documented = readDocumentedVars();

    const missing = [...used.keys()]
      .filter((name) => !PLATFORM_INJECTED.has(name))
      .filter((name) => !documented.has(name))
      .sort()
      .map((name) => `${name}  (read in ${used.get(name)})`);

    expect(missing, `\n.env.example is missing:\n  ${missing.join('\n  ')}\n`).toEqual([]);
  });

  it('names the variables reached through a lookup table', () => {
    // These never appear as `process.env.NAME` anywhere, so nothing else
    // in this file would notice them going undocumented. STRIPE_PRICE_ULTRA_USD
    // was exactly that case.
    const documented = readDocumentedVars();
    const missing = [...readIndirectEnvVars()].filter((n) => !documented.has(n)).sort();
    expect(missing, `\nIndirect env vars missing from .env.example:\n  ${missing.join('\n  ')}\n`).toEqual([]);
  });

  it('marks the security-relevant defaults explicitly', () => {
    // Each of these is safe-by-omission in a way that is NOT obvious, so
    // the file has to say what leaving it blank actually does. A future
    // edit that strips the explanation down to a bare `NAME=` loses the
    // only warning an operator gets.
    const text = fs.readFileSync(ENV_EXAMPLE, 'utf8');

    // The note may sit above the declaration or below it — both are used
    // in this file — so look at the surrounding block rather than
    // assuming an order.
    const nearby = (name, window = 500) => {
      const i = text.indexOf(`${name}=`);
      if (i === -1) return '';
      return text.slice(Math.max(0, i - window), i + window);
    };

    expect(nearby('ADMIN_IP_ALLOWLIST')).toMatch(/no network restriction/i);
    expect(nearby('GOOGLE_POLL_REQUIRE_CODE')).toMatch(/takeover/i);
    expect(nearby('RAILWAY_VOLUME_MOUNT_PATH')).toMatch(/ephemeral/i);
  });
});
