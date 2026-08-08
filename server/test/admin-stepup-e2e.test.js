// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ADMIN STEP-UP — REAL HTTP (2026-07-29)
//
//  Boots the real admin router behind the real authMiddleware on a real
//  socket and drives it with fetch, because the defect this pins was not
//  visible in any unit test: the dashboard's `activeToken()` closed over
//  the step-up token from the render that STARTED a request, so the retry
//  that runs after the password prompt still presented the un-elevated
//  token. The server was correct and said `step_up_required` a second
//  time; the console reported a raw error and the action silently didn't
//  happen. Every privileged action needed two clicks.
//
//  What this asserts is the exact contract the fixed client relies on:
//   1. a base admin token is REJECTED on a step-up route
//   2. /reauth exchanges a password for an elevated token
//   3. replaying the SAME request with the elevated token SUCCEEDS
//   4. the elevated token is what makes the difference — nothing else
//      about the request changes between (1) and (3)
//
//  Plus two admin-surface invariants worth locking down:
//   · `ultra` is grantable through change-tier (the console could not send
//     it, so the top plan was unassignable from the dashboard)
//   · GET /users never emits password_hash or google_id
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';

process.env.DATABASE_PATH = ':memory:';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
// The router reads ADMIN_EMAILS at require() time, so it must be set first.
process.env.ADMIN_EMAILS = 'e2e.admin@minicaai.test';

const require = createRequire(import.meta.url);
const express = require('express');
const db = require('../src/database.js');
const { generateToken } = require('../src/middleware/auth.js');
const adminRouter = require('../src/routes/admin.js');

const ADMIN_EMAIL = 'e2e.admin@minicaai.test';
const ADMIN_PASSWORD = 'correct-horse-battery-staple';
const TARGET_EMAIL = 'e2e.target@minicaai.test';

let server;
let base;
let baseToken;

function url(path) { return `${base}${path}`; }

async function call(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(url(path), {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { status: res.status, body: json, raw: text };
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/admin', adminRouter);
  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });

  db.createUser({
    id: 'e2e_admin', email: ADMIN_EMAIL, name: 'E2E Admin',
    password: ADMIN_PASSWORD, tier: 'ultra', country_code: 'US',
  });
  db.createUser({
    id: 'e2e_target', email: TARGET_EMAIL, name: 'E2E Target',
    password: 'target-password-123', tier: 'free', country_code: 'US',
  });
  db.createLicense({
    key: 'LIC-e2e-target', user_id: 'e2e_target', email: TARGET_EMAIL,
    tier: 'free', status: 'active', country_code: 'US',
    expires_at: Date.now() + 30 * 86400000, sessions_limit: 5,
  });

  // Exactly what licenseService holds after a normal admin sign-in: no
  // stepUp claim.
  baseToken = generateToken({ id: 'e2e_admin', email: ADMIN_EMAIL, name: 'E2E Admin', tier: 'ultra' });
});

afterAll(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
});

describe('admin auth gates', () => {
  it('rejects an unauthenticated caller', async () => {
    const r = await call('/api/v1/admin/stats');
    expect(r.status).toBe(401);
  });

  it('allows a plain admin token on a read route', async () => {
    const r = await call('/api/v1/admin/stats', { token: baseToken });
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty('total_users');
  });

  it('rejects a non-admin JWT and audits the attempt', async () => {
    const outsider = generateToken({ id: 'e2e_target', email: TARGET_EMAIL, name: 'E2E Target', tier: 'free' });
    const r = await call('/api/v1/admin/stats', { token: outsider });
    expect(r.status).toBe(403);
    const audit = db.queryAuditLog({ action: 'unauthorized-admin-attempt', limit: 10 });
    expect(audit.length).toBeGreaterThan(0);
  });
});

describe('step-up: base token is refused, elevated token succeeds', () => {
  it('refuses a step-up route when the token carries no stepUp claim', async () => {
    const r = await call('/api/v1/admin/users/ban', {
      method: 'POST', token: baseToken, body: { email: TARGET_EMAIL, reason: 'e2e' },
    });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('step_up_required');
    // And nothing happened.
    expect(db.getUserByEmail(TARGET_EMAIL).is_banned).toBeFalsy();
  });

  it('rejects /reauth with a wrong password', async () => {
    const r = await call('/api/v1/admin/reauth', {
      method: 'POST', token: baseToken, body: { password: 'not-the-password' },
    });
    expect(r.status).toBe(401);
  });

  it('exchanges the correct password for an elevated token', async () => {
    const r = await call('/api/v1/admin/reauth', {
      method: 'POST', token: baseToken, body: { password: ADMIN_PASSWORD },
    });
    expect(r.status).toBe(200);
    expect(typeof r.body.token).toBe('string');
    expect(r.body.step_up_expires_at).toBeGreaterThan(Date.now());
    // The elevated token must differ from the base one — this is precisely
    // what the client has to start sending on the retry.
    expect(r.body.token).not.toBe(baseToken);
  });

  it('accepts the SAME banned request once the elevated token is presented', async () => {
    const up = await call('/api/v1/admin/reauth', {
      method: 'POST', token: baseToken, body: { password: ADMIN_PASSWORD },
    });
    const stepUpToken = up.body.token;

    const r = await call('/api/v1/admin/users/ban', {
      method: 'POST', token: stepUpToken, body: { email: TARGET_EMAIL, reason: 'e2e step-up proof' },
    });
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(db.getUserByEmail(TARGET_EMAIL).is_banned).toBeTruthy();

    // The ban reason reached the audit trail.
    const audit = db.queryAuditLog({ action: 'ban', limit: 5 });
    expect(audit[0].target_email).toBe(TARGET_EMAIL);
    expect(JSON.parse(audit[0].details_json).reason).toBe('e2e step-up proof');

    // Put the user back so later cases start clean.
    const un = await call('/api/v1/admin/users/unban', {
      method: 'POST', token: stepUpToken, body: { email: TARGET_EMAIL },
    });
    expect(un.status).toBe(200);
  });
});

describe('ultra is grantable through the admin API', () => {
  it('moves a user to ultra via change-tier', async () => {
    const up = await call('/api/v1/admin/reauth', {
      method: 'POST', token: baseToken, body: { password: ADMIN_PASSWORD },
    });
    const stepUpToken = up.body.token;

    const r = await call('/api/v1/admin/users/change-tier', {
      method: 'POST', token: stepUpToken, body: { email: TARGET_EMAIL, tier: 'ultra' },
    });
    expect(r.status).toBe(200);
    expect(r.body.tier).toBe('ultra');
    expect(db.getUserByEmail(TARGET_EMAIL).tier).toBe('ultra');

    // Admin grants are unlimited-until-revoked: never-expires + -1 sentinels.
    const lic = db.getLicenseByUserId('e2e_target');
    expect(lic.tier).toBe('ultra');
    expect(lic.expires_at).toBe(-1);
    expect(lic.sessions_limit).toBe(-1);
  });

  it('still rejects a tier that is not in VALID_TIERS', async () => {
    const up = await call('/api/v1/admin/reauth', {
      method: 'POST', token: baseToken, body: { password: ADMIN_PASSWORD },
    });
    const r = await call('/api/v1/admin/users/change-tier', {
      method: 'POST', token: up.body.token, body: { email: TARGET_EMAIL, tier: 'platinum' },
    });
    expect(r.status).toBe(400);
  });
});

describe('grants on a user with NO license row are not half-applied', () => {
  // Every signup path creates a license, so this is the odd/legacy account
  // case — but it used to fail SILENTLY, which is the part that matters:
  // change-tier answered { success: true } after writing only users.tier,
  // leaving the customer with no license and still gated out.
  beforeAll(() => {
    db.createUser({
      id: 'e2e_nolicense', email: 'e2e.nolicense@minicaai.test', name: 'No License',
      password: 'nolicense-pw-123', tier: 'free', country_code: 'US',
    });
  });

  it('starts with no license row (precondition)', () => {
    expect(db.getLicenseByUserId('e2e_nolicense')).toBeFalsy();
  });

  it('change-tier materializes a license and applies the grant', async () => {
    const up = await call('/api/v1/admin/reauth', {
      method: 'POST', token: baseToken, body: { password: ADMIN_PASSWORD },
    });
    const r = await call('/api/v1/admin/users/change-tier', {
      method: 'POST', token: up.body.token,
      body: { email: 'e2e.nolicense@minicaai.test', tier: 'ultra' },
    });
    expect(r.status).toBe(200);
    expect(db.getUserByEmail('e2e.nolicense@minicaai.test').tier).toBe('ultra');

    const lic = db.getLicenseByUserId('e2e_nolicense');
    expect(lic).toBeTruthy();
    expect(lic.tier).toBe('ultra');
    expect(lic.status).toBe('active');
    expect(lic.expires_at).toBe(-1);
    expect(lic.sessions_limit).toBe(-1);
    expect(lic.key).toMatch(/^MNC-/);
  });

  it('ensureLicenseForUser never clobbers an existing license', () => {
    const before = db.getLicenseByUserId('e2e_nolicense');
    const again = db.ensureLicenseForUser('e2e_nolicense');
    expect(again.key).toBe(before.key);
    expect(again.tier).toBe(before.tier);
    expect(db.getDB().prepare('SELECT COUNT(*) c FROM licenses WHERE user_id = ?').get('e2e_nolicense').c).toBe(1);
  });

  it('grant-comp on a licenseless user succeeds instead of 500-ing mid-write', async () => {
    db.createUser({
      id: 'e2e_nolicense2', email: 'e2e.nolicense2@minicaai.test', name: 'No License 2',
      password: 'nolicense-pw-456', tier: 'free', country_code: 'US',
    });
    expect(db.getLicenseByUserId('e2e_nolicense2')).toBeFalsy();

    const up = await call('/api/v1/admin/reauth', {
      method: 'POST', token: baseToken, body: { password: ADMIN_PASSWORD },
    });
    const r = await call('/api/v1/admin/users/e2e_nolicense2/grant-comp', {
      method: 'POST', token: up.body.token, body: { tier: 'ultra', note: 'regression: licenseless comp' },
    });
    expect(r.status).toBe(200);

    const lic = db.getLicenseByUserId('e2e_nolicense2');
    expect(lic.tier).toBe('ultra');
    expect(lic.expires_at).toBe(-1);
    // The comp payment must be recorded at zero and attributed to admin-comp.
    const pay = db.getPaymentsByUser('e2e_nolicense2');
    expect(pay.length).toBe(1);
    expect(pay[0].provider).toBe('admin-comp');
    expect(pay[0].amount).toBe(0);
    // And the audit row must carry the payment id it used to lose.
    const audit = db.queryAuditLog({ action: 'grant-comp', limit: 5 });
    const row = audit.find(a => a.target_email === 'e2e.nolicense2@minicaai.test');
    expect(row).toBeTruthy();
    expect(JSON.parse(row.details_json).payment_id).toBe(pay[0].id);
  });

  it('comp grants add no revenue', () => {
    // This suite records no real charges — only the $0 admin-comp row above.
    // So every revenue surface must still read zero, and the comp must not
    // show up on the Ultra tier card or in the top-customers leaderboard.
    const s = db.getStats();
    expect(s.revenue_by_tier_by_currency.ultra.USD || 0).toBe(0);
    expect(s.revenue_this_month_by_currency).toEqual({});
    expect(s.total_revenue_by_currency).toEqual({});
    expect(db.getTopCustomers(10)).toEqual([]);
  });
});

describe('GET /users leaks nothing sensitive', () => {
  it('omits password_hash and google_id from every row', async () => {
    const r = await call('/api/v1/admin/users', { token: baseToken });
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(true);
    expect(r.body.length).toBeGreaterThan(0);
    for (const row of r.body) {
      expect(row).not.toHaveProperty('password_hash');
      expect(row).not.toHaveProperty('google_id');
      expect(row).toHaveProperty('email');
      expect(row).toHaveProperty('tier');
    }
    // The raw string must not carry a bcrypt hash anywhere either.
    expect(r.raw).not.toMatch(/\$2[aby]\$/);
  });
});
