// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  EXTENSION PACKS — graduated top-up pack tests (2026-07)
//
//  Pins each pack's amount+seconds so a pricing change is
//  caught immediately. Also verifies that the server ALWAYS
//  re-derives amounts from the pack id — a client sending a
//  wrong/absent pack falls back to the m30 default, never
//  to a caller-supplied price.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';

process.env.DATABASE_PATH = ':memory:';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const require = createRequire(import.meta.url);
const db = require('../src/database.js');
const payments = require('../src/routes/payments.js');
const { EXTENSION_PACKS, resolveExtensionPack } = payments._test;

let seq = 0;
function makeUser(tier, licensePatch = {}) {
  seq += 1;
  const uid = `u_pack_${seq}`;
  const email = `${uid}@test.example`;
  db.createUser({ id: uid, email, name: 'Pack Tester', password: 'pw-123456', tier, country_code: 'US' });
  db.createLicense({
    key: `lic_pack_${seq}`,
    user_id: uid,
    email,
    tier,
    status: 'active',
    country_code: 'US',
    expires_at: Date.now() + 14 * 24 * 60 * 60 * 1000,
    sessions_limit: tier === 'ultra' ? -1 : 10,
  });
  if (Object.keys(licensePatch).length) {
    const sets = Object.keys(licensePatch).map(k => k + ' = ?').join(', ');
    db.getDB().prepare('UPDATE licenses SET ' + sets + ' WHERE user_id = ?')
      .run(...Object.values(licensePatch), uid);
  }
  return uid;
}

// ── resolveExtensionPack ─────────────────────────────────────

describe('resolveExtensionPack', () => {
  it('resolves m30 pack with correct amounts and seconds', () => {
    const p = resolveExtensionPack('m30');
    expect(p.id).toBe('m30');
    expect(p.seconds).toBe(1800);
    expect(p.usd_cents).toBe(2500);
    expect(p.inr_paise).toBe(209900);
    expect(p.label).toBe('+30 min');
  });

  it('resolves h1 pack with correct amounts and seconds', () => {
    const p = resolveExtensionPack('h1');
    expect(p.id).toBe('h1');
    expect(p.seconds).toBe(3600);
    expect(p.usd_cents).toBe(4500);
    expect(p.inr_paise).toBe(379900);
    expect(p.label).toBe('+1 hour');
  });

  it('resolves h3 pack with correct amounts and seconds', () => {
    const p = resolveExtensionPack('h3');
    expect(p.id).toBe('h3');
    expect(p.seconds).toBe(10800);
    expect(p.usd_cents).toBe(8000);
    expect(p.inr_paise).toBe(679900);
    expect(p.label).toBe('+3 hours');
  });

  it('defaults to m30 when packId is undefined', () => {
    const p = resolveExtensionPack(undefined);
    expect(p.id).toBe('m30');
    expect(p.seconds).toBe(1800);
    expect(p.usd_cents).toBe(2500);
  });

  it('defaults to m30 when packId is an unknown string', () => {
    const p = resolveExtensionPack('bogus-pack');
    expect(p.id).toBe('m30');
    expect(p.seconds).toBe(1800);
    expect(p.usd_cents).toBe(2500);
  });

  it('defaults to m30 when packId is null', () => {
    const p = resolveExtensionPack(null);
    expect(p.id).toBe('m30');
  });

  it('EXTENSION_PACKS object has exactly 3 packs keyed by id', () => {
    expect(Object.keys(EXTENSION_PACKS).sort()).toEqual(['h1', 'h3', 'm30']);
  });
});

// ── grantTimeExtension with pack seconds ─────────────────────

describe('grantTimeExtension with pack-specific seconds', () => {
  it('grants 3600s (h1 pack) and preserves Pro tier', () => {
    const uid = makeUser('pro', { credits_remaining_seconds: 100, credits_expire_at: Date.now() + 60000 });
    const updated = db.grantTimeExtension(uid, 3600);
    expect(updated.tier).toBe('pro');
    expect(updated.credits_remaining_seconds).toBe(100 + 3600);
    expect(updated.status).toBe('active');
  });

  it('grants 10800s (h3 pack) and preserves Max tier', () => {
    const uid = makeUser('max', { credits_remaining_seconds: 500, credits_expire_at: Date.now() + 60000 });
    const updated = db.grantTimeExtension(uid, 10800);
    expect(updated.tier).toBe('max');
    expect(updated.credits_remaining_seconds).toBe(500 + 10800);
  });

  it('grants 1800s (m30 pack) explicitly', () => {
    const uid = makeUser('basic', { credits_remaining_seconds: 200, credits_expire_at: Date.now() + 60000 });
    const updated = db.grantTimeExtension(uid, 1800);
    expect(updated.credits_remaining_seconds).toBe(200 + 1800);
  });

  it('defaults to 1800s when no seconds arg supplied (legacy / no-pack webhook)', () => {
    const uid = makeUser('basic', { credits_remaining_seconds: 300, credits_expire_at: Date.now() + 60000 });
    const updated = db.grantTimeExtension(uid);
    expect(updated.credits_remaining_seconds).toBe(300 + 1800);
  });

  it('defaults to 1800s when seconds arg is 0', () => {
    const uid = makeUser('basic', { credits_remaining_seconds: 100, credits_expire_at: Date.now() + 60000 });
    const updated = db.grantTimeExtension(uid, 0);
    expect(updated.credits_remaining_seconds).toBe(100 + 1800);
  });

  it('defaults to 1800s when seconds arg is negative', () => {
    const uid = makeUser('basic', { credits_remaining_seconds: 100, credits_expire_at: Date.now() + 60000 });
    const updated = db.grantTimeExtension(uid, -500);
    expect(updated.credits_remaining_seconds).toBe(100 + 1800);
  });

  it('never shrinks an unlimited/comp license (h3 pack variant)', () => {
    const uid = makeUser('max', { credits_remaining_seconds: -1, credits_expire_at: -1 });
    const updated = db.grantTimeExtension(uid, 10800);
    expect(updated.credits_remaining_seconds).toBe(-1);
  });

  it('drops stale credits before adding h1 grant (same as m30 behavior)', () => {
    const uid = makeUser('pro', { credits_remaining_seconds: 999, credits_expire_at: Date.now() - 1000 });
    const updated = db.grantTimeExtension(uid, 3600);
    // stale 999 is dropped; grant = 3600
    expect(updated.credits_remaining_seconds).toBe(3600);
  });
});
