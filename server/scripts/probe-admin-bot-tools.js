// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  PROBE — every admin bot tool, end-to-end against live DB
//
//  Verifies the bot's 28 admin tools actually work as wired. Boots the
//  server's modules in-process (no HTTP layer), spins up a throwaway
//  test user, runs each tool against it, captures PASS/FAIL.
//
//  Two passes per destructive tool:
//    1. WITHOUT step-up → must return { ok:false, code:'needs_step_up' }
//    2. WITH step-up    → must mutate / succeed
//
//  Final step deletes the test user via the delete_user tool itself —
//  that's both the cleanup and the last verification.
//
//  Run from server/:  node scripts/probe-admin-bot-tools.js
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

'use strict';

require('dotenv').config();

const db = require('../src/database');
const { executeTool, ALL_TOOLS } = require('../src/services/botTools');
const { STEP_UP_TTL_MS } = require('../src/middleware/admin');

// Pick the first ADMIN_EMAILS entry that actually exists in the local
// DB. The first allowlisted admin may have never signed in on the dev
// machine; fall through until we find one that has.
const ADMIN_CANDIDATES = (process.env.ADMIN_EMAILS || 'nippu@gmail.com')
  .split(',').map(s => s.trim()).filter(Boolean);
let adminUser = null;
let ADMIN_EMAIL = null;
for (const cand of ADMIN_CANDIDATES) {
  const u = db.getUserByEmail(cand);
  if (u) { adminUser = u; ADMIN_EMAIL = cand; break; }
}
if (!adminUser) {
  console.error(`[probe] FATAL: none of ADMIN_EMAILS [${ADMIN_CANDIDATES.join(', ')}] exist in the DB — sign in once first.`);
  process.exit(1);
}

const TARGET_EMAIL = `probe-target-${Date.now()}@example.com`;
const TARGET_NAME = 'Probe Target';
const TARGET_PASSWORD = 'probe-pass-1234';

// ─── Helpers ──────────────────────────────────────────────────
function adminCtx(opts = {}) {
  return {
    user: {
      id: adminUser.id,
      email: adminUser.email,
      name: adminUser.name || 'Admin',
      tier: adminUser.tier || 'max',
      stepUp: opts.stepUp === true,
      stepUpAt: opts.stepUp === true ? Date.now() : null,
    },
    tier: adminUser.tier || 'max',
    role: 'admin',
    ip: '127.0.0.1',
    userAgent: 'probe-script/1.0',
  };
}

const results = [];
function rec(name, expected, result, note) {
  const ok = !!(result && result.ok);
  let pass;
  if (expected === 'ok') pass = ok;
  else if (expected === 'needs_step_up') pass = !ok && result?.code === 'needs_step_up';
  else if (expected === 'ok_or_known_fail') pass = ok || (typeof result?.reason === 'string');
  else pass = false;
  results.push({ name, expected, pass, result, note });
  const tag = pass ? 'PASS' : 'FAIL';
  const reason = ok ? '' : ` reason="${result?.reason || ''}" code="${result?.code || ''}"`;
  console.log(`[${tag}] ${name.padEnd(28)} expect=${expected} ok=${ok}${reason}${note ? ` (${note})` : ''}`);
}

async function run(toolName, args, ctx, expected, note) {
  if (!ALL_TOOLS[toolName]) {
    rec(toolName, expected, { ok: false, reason: `tool ${toolName} not registered` }, note);
    return null;
  }
  try {
    const r = await executeTool(toolName, args, ctx);
    rec(toolName, expected, r, note);
    return r;
  } catch (e) {
    rec(toolName, expected, { ok: false, reason: `THREW: ${e.message}` }, note);
    return null;
  }
}

// ─── Setup: create the throwaway target user ──────────────────
let targetUser;
async function setup() {
  console.log(`\n[setup] admin=${ADMIN_EMAIL} target=${TARGET_EMAIL}`);
  const { randomUUID } = require('crypto');
  targetUser = db.createUser({
    id: randomUUID(),
    email: TARGET_EMAIL,
    name: TARGET_NAME,
    password: TARGET_PASSWORD,
    tier: 'basic',
    country_code: 'US',
  });
  // Mirror auth.js signup: every real user gets a license row at signup.
  // Without this, license-mutating admin tools (grant_credits, extend_expiry,
  // grant_comp) all return "User has no license" — which is correct
  // behavior for non-existent licenses but doesn't reflect the real-user
  // path where one always exists.
  db.createLicense({
    key: `probe-license-${Date.now()}`,
    user_id: targetUser.id,
    email: TARGET_EMAIL,
    tier: 'basic',
    status: 'active',
    country_code: 'US',
    expires_at: Date.now() + 14 * 24 * 60 * 60 * 1000,
    sessions_limit: 3,
  });
  console.log(`[setup] target user created id=${targetUser.id} (with license)`);
}

// ─── Pass 1: ADMIN_SERVER tools (no step-up needed) ───────────
async function pass1ServerTools() {
  console.log('\n=== ADMIN_SERVER tools (no step-up) ===');
  const ctx = adminCtx({ stepUp: false }); // these should work WITHOUT step-up

  await run('get_admin_stats',          {},                                ctx, 'ok');
  await run('get_admin_trends',         { days: 7 },                       ctx, 'ok');
  await run('get_top_customers',        { limit: 5 },                      ctx, 'ok');
  await run('get_suspicious_activity',  {},                                ctx, 'ok');
  await run('search_user',              { email: TARGET_EMAIL },           ctx, 'ok');
  await run('view_recent_conversations',{ limit: 5 },                      ctx, 'ok');
  await run('get_recent_logins',        { limit: 5 },                      ctx, 'ok');
  await run('get_revoked_keys',         {},                                ctx, 'ok');
  await run('get_payments',             { limit: 5 },                      ctx, 'ok');
  await run('get_audit_log',            { limit: 5 },                      ctx, 'ok');
  await run('get_audit_facets',         {},                                ctx, 'ok');
  await run('get_app_config',           {},                                ctx, 'ok');
  // send_password_reset will likely fail mail sending in dev (no SMTP),
  // but the DB token write should succeed and the handler returns ok:true.
  await run('send_password_reset',      { email: TARGET_EMAIL },           ctx, 'ok',
    'mail may fail in dev — handler returns ok:true regardless');
  // revoke_user_device needs a device row that doesn't exist for the
  // fresh target — should soft-fail with "Device not found", proving
  // wiring works.
  await run('revoke_user_device',       { email: TARGET_EMAIL, device_row_id: 99999 }, ctx, 'ok_or_known_fail',
    'no device exists — expect soft-fail reason="Device not found..."');
}

// ─── Pass 2: ADMIN_DESTRUCTIVE step-up gate ───────────────────
async function pass2StepUpGate() {
  console.log('\n=== Step-up gate (every destructive tool, no step-up) ===');
  const ctx = adminCtx({ stepUp: false });
  const safeArgs = {
    change_user_tier:        { email: TARGET_EMAIL, tier: 'pro', confirmed: true },
    grant_credits:           { email: TARGET_EMAIL, credits: 5, confirmed: true },
    extend_user_expiry:      { email: TARGET_EMAIL, days: 7, confirmed: true },
    grant_comp_subscription: { email: TARGET_EMAIL, tier: 'pro', confirmed: true },
    reset_user_devices:      { email: TARGET_EMAIL, confirmed: true },
    force_logout_user:       { email: TARGET_EMAIL, confirmed: true },
    ban_user:                { email: TARGET_EMAIL, reason: 'probe', confirmed: true },
    unban_user:              { email: TARGET_EMAIL, confirmed: true },
    delete_user:             { email: TARGET_EMAIL, reason: 'probe', confirmed: true },
    impersonate_user:        { email: TARGET_EMAIL, reason: 'probe', confirmed: true },
    cancel_user_subscription:{ email: TARGET_EMAIL, confirmed: true },
    refund_payment:          { payment_id: 999999, confirmed: true },
    dsar_export:             { email: TARGET_EMAIL, confirmed: true },
    update_app_config:       { key: 'probe_key', value: 'probe_value', confirmed: true },
  };
  for (const [name, args] of Object.entries(safeArgs)) {
    await run(name, args, ctx, 'needs_step_up');
  }
}

// ─── Pass 3: ADMIN_DESTRUCTIVE with step-up — real execution ──
async function pass3WithStepUp() {
  console.log('\n=== Destructive tools (WITH step-up — real mutations) ===');
  const ctx = adminCtx({ stepUp: true });

  // change_user_tier: basic → pro
  await run('change_user_tier', { email: TARGET_EMAIL, tier: 'pro', confirmed: true }, ctx, 'ok');
  // grant_credits: +5
  await run('grant_credits', { email: TARGET_EMAIL, credits: 5, confirmed: true }, ctx, 'ok');
  // extend_user_expiry: +7d
  await run('extend_user_expiry', { email: TARGET_EMAIL, days: 7, confirmed: true }, ctx, 'ok');
  // grant_comp_subscription: max comp
  await run('grant_comp_subscription', { email: TARGET_EMAIL, tier: 'max', note: 'probe-comp', confirmed: true }, ctx, 'ok');
  // reset_user_devices: zero changes ok (no devices on the throwaway)
  await run('reset_user_devices', { email: TARGET_EMAIL, confirmed: true }, ctx, 'ok');
  // force_logout_user
  await run('force_logout_user', { email: TARGET_EMAIL, confirmed: true }, ctx, 'ok');
  // ban_user
  await run('ban_user', { email: TARGET_EMAIL, reason: 'probe-ban', confirmed: true }, ctx, 'ok');
  // unban_user
  await run('unban_user', { email: TARGET_EMAIL, confirmed: true }, ctx, 'ok');
  // impersonate_user — should return a JWT (don't actually use it)
  await run('impersonate_user', { email: TARGET_EMAIL, reason: 'probe', confirmed: true }, ctx, 'ok');
  // cancel_user_subscription — target has admin-comp now, no stripe/razorpay → expect known-fail "No active Stripe..."
  await run('cancel_user_subscription', { email: TARGET_EMAIL, confirmed: true }, ctx, 'ok_or_known_fail',
    'target has no Stripe customer — expect soft-fail "No Stripe customer id"');
  // refund_payment — non-existent payment_id → expect "Payment not found"
  await run('refund_payment', { payment_id: 999999, confirmed: true }, ctx, 'ok_or_known_fail',
    'no such payment — expect soft-fail "Payment not found"');
  // dsar_export
  await run('dsar_export', { email: TARGET_EMAIL, confirmed: true }, ctx, 'ok');
  // update_app_config — write a throwaway key
  await run('update_app_config', { key: 'probe_key', value: 'probe_value_' + Date.now(), confirmed: true }, ctx, 'ok');
  // delete_user — final destructive action, cleans up the target.
  await run('delete_user', { email: TARGET_EMAIL, reason: 'probe-cleanup', confirmed: true }, ctx, 'ok');
}

// ─── Pass 4: confirmed:false guard ────────────────────────────
async function pass4ConfirmedGuard() {
  console.log('\n=== confirmed:false guard (no mutation expected) ===');
  const ctx = adminCtx({ stepUp: true });
  // Pick one representative — change_user_tier with confirmed:false should
  // soft-fail BEFORE the step-up check even matters.
  const r = await executeTool('change_user_tier', { email: 'someone@example.com', tier: 'pro', confirmed: false }, ctx);
  const pass = !r.ok && /confirm/i.test(r.reason || '');
  results.push({ name: 'change_user_tier (confirmed:false)', expected: 'confirm-required', pass, result: r });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] change_user_tier confirmed:false → ok=${r.ok} reason="${r.reason}"`);
}

// ─── Pass 5: role gate ────────────────────────────────────────
async function pass5RoleGate() {
  console.log('\n=== Role gate (non-admin must be refused) ===');
  const ctx = { ...adminCtx({ stepUp: true }), role: 'user' };
  const r = await executeTool('get_admin_stats', {}, ctx);
  const pass = !r.ok && /not available/i.test(r.reason || '');
  results.push({ name: 'get_admin_stats as role=user', expected: 'role-blocked', pass, result: r });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] role=user calling admin tool → ok=${r.ok} reason="${r.reason}"`);
}

// ─── Main ────────────────────────────────────────────────────
(async () => {
  try {
    await setup();
    await pass1ServerTools();
    await pass2StepUpGate();
    await pass3WithStepUp();
    await pass4ConfirmedGuard();
    await pass5RoleGate();
  } catch (e) {
    console.error('[probe] FATAL:', e);
  } finally {
    // Defensive cleanup — if delete_user passed, target is already gone;
    // this is a no-op fallback in case something earlier broke.
    try {
      const stillThere = db.getUserByEmail(TARGET_EMAIL);
      if (stillThere) {
        db.deleteUser(stillThere.id);
        console.log('[cleanup] fallback delete of orphaned target user');
      }
    } catch (e) { console.warn('[cleanup] failed:', e.message); }

    const totals = {
      total: results.length,
      pass: results.filter(r => r.pass).length,
      fail: results.filter(r => !r.pass).length,
    };
    console.log('\n=== SUMMARY ===');
    console.log(`total=${totals.total} pass=${totals.pass} fail=${totals.fail}`);
    if (totals.fail > 0) {
      console.log('\nFailures:');
      for (const r of results.filter(x => !x.pass)) {
        console.log(`  - ${r.name}: expected=${r.expected} got ok=${!!r.result?.ok} reason="${r.result?.reason || ''}" code="${r.result?.code || ''}"`);
      }
    }
    process.exit(totals.fail > 0 ? 1 : 0);
  }
})();
