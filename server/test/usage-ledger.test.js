// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  USAGE LEDGER — server-authoritative interview clock (2026-07)
//
//  These tests pin the money-critical properties of the new billing core:
//  · time is charged from the SERVER clock, clamped per heartbeat, so a
//    stalled/malicious client can neither over- nor under-pay
//  · the beat that drains the bucket also closes the session (exactly one
//    'exhausted'), and a dead session can't be beaten back to life
//  · a second start supersedes the first (popout/second-device double-burn)
//  · the stale sweeper settles crashed sessions AT the last heartbeat —
//    the user never pays for time after their client died
//  · grantTimeExtension (plan-specific top-up: basic +30 min, pro/max
//    +60 min) preserves Pro/Max tiers and never shrinks an unlimited/
//    comp license
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';

process.env.DATABASE_PATH = ':memory:';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const require = createRequire(import.meta.url);
const db = require('../src/database.js');

let seq = 0;
function makeUser(tier, licensePatch = {}) {
  seq += 1;
  const id = `u_usage_${seq}`;
  const email = `${id}@test.example`;
  db.createUser({ id, email, name: 'Usage Tester', password: 'pw-123456', tier, country_code: 'US' });
  db.createLicense({
    key: `LIC-${id}`,
    user_id: id,
    email,
    tier,
    status: 'active',
    country_code: 'US',
    expires_at: Date.now() + 30 * 86400000,
    sessions_limit: tier === 'ultra' ? -1 : 3,
  });
  if (Object.keys(licensePatch).length) {
    const sets = Object.keys(licensePatch).map(k => `${k} = ?`).join(', ');
    db.getDB().prepare(`UPDATE licenses SET ${sets} WHERE user_id = ?`)
      .run(...Object.values(licensePatch), id);
  }
  return id;
}

function backdateHeartbeat(sessionId, seconds) {
  db.getDB().prepare('UPDATE usage_sessions SET last_heartbeat_at = ? WHERE id = ?')
    .run(Date.now() - seconds * 1000, sessionId);
}

function getSession(sessionId) {
  return db.getDB().prepare('SELECT * FROM usage_sessions WHERE id = ?').get(sessionId);
}

beforeAll(() => {
  // Force schema creation (lazy singleton).
  db.getDB();
});

describe('startUsageSession', () => {
  it('opens a trial session for a free user with balance', () => {
    const uid = makeUser('free', { trial_remaining_seconds: 1800 });
    const r = db.startUsageSession(uid, 'dev1');
    expect(r.session_id).toBeTruthy();
    expect(r.source).toBe('trial');
    expect(r.remaining).toBe(1800);
  });

  it('refuses when the balance is zero', () => {
    const uid = makeUser('free', { trial_remaining_seconds: 0 });
    const r = db.startUsageSession(uid, 'dev1');
    expect(r.error).toBe('exhausted');
    expect(r.remaining).toBe(0);
  });

  it('gives ultra an unlimited session', () => {
    const uid = makeUser('ultra');
    const r = db.startUsageSession(uid, 'dev1');
    expect(r.source).toBe('unlimited');
    expect(r.remaining).toBe(-1);
  });

  it('supersedes a prior open session (no double clock)', () => {
    const uid = makeUser('basic', { credits_remaining_seconds: 1800, credits_expire_at: Date.now() + 86400000 });
    const first = db.startUsageSession(uid, 'main-window');
    const second = db.startUsageSession(uid, 'popout');
    const old = getSession(first.session_id);
    expect(old.ended_at).toBeTruthy();
    expect(old.end_reason).toBe('superseded');
    expect(getSession(second.session_id).ended_at).toBeNull();
  });
});

describe('heartbeatUsageSession', () => {
  it('charges elapsed server-clock seconds against the bucket', () => {
    const uid = makeUser('basic', { credits_remaining_seconds: 1800, credits_expire_at: Date.now() + 86400000 });
    const { session_id } = db.startUsageSession(uid, 'dev1');
    backdateHeartbeat(session_id, 25);
    const r = db.heartbeatUsageSession(uid, session_id);
    expect(r.charged).toBe(25);
    expect(r.remaining).toBe(1775);
    expect(db.getLicenseByUserId(uid).credits_remaining_seconds).toBe(1775);
  });

  it('clamps a silent gap to the stale window (90s) — no burst overcharge', () => {
    const uid = makeUser('pro', { credits_remaining_seconds: 3600, credits_expire_at: Date.now() + 86400000 });
    const { session_id } = db.startUsageSession(uid, 'dev1');
    backdateHeartbeat(session_id, 300); // 5 minutes of silence
    const r = db.heartbeatUsageSession(uid, session_id);
    expect(r.charged).toBe(90);
    expect(r.remaining).toBe(3600 - 90);
  });

  // The cap is the STALE WINDOW, not the beat cadence. When it was 45s a
  // client could beat every ~85s — still inside the 90s live window, so it
  // kept getting answers — and pay 45s for every 85s it used. The ceiling
  // has to reach the whole window or that gap is half-price interview time.
  it('charges the full gap for a slow-beating client just inside the live window', () => {
    const uid = makeUser('pro', { credits_remaining_seconds: 3600, credits_expire_at: Date.now() + 86400000 });
    const { session_id } = db.startUsageSession(uid, 'dev1');
    backdateHeartbeat(session_id, 85); // still live (< 90s), but a slow beat
    expect(db.hasLiveUsageSession(uid)).toBe(true);
    const r = db.heartbeatUsageSession(uid, session_id);
    expect(r.charged).toBe(85);          // was 45 — a 47% discount on used time
    expect(r.remaining).toBe(3600 - 85);
  });

  it('drains the bucket exactly once and closes the session', () => {
    const uid = makeUser('free', { trial_remaining_seconds: 10 });
    const { session_id } = db.startUsageSession(uid, 'dev1');
    backdateHeartbeat(session_id, 30);
    const r = db.heartbeatUsageSession(uid, session_id);
    expect(r.exhausted).toBe(true);
    expect(r.remaining).toBe(0);
    const sess = getSession(session_id);
    expect(sess.ended_at).toBeTruthy();
    expect(sess.end_reason).toBe('exhausted');
    // A dead session cannot be beaten back to life.
    const again = db.heartbeatUsageSession(uid, session_id);
    expect(again.error).toBe('no_session');
  });

  it('never charges an unlimited session', () => {
    const uid = makeUser('ultra');
    const { session_id } = db.startUsageSession(uid, 'dev1');
    backdateHeartbeat(session_id, 40);
    const r = db.heartbeatUsageSession(uid, session_id);
    expect(r.remaining).toBe(-1);
    expect(r.charged).toBe(0);
  });
});

describe('stopUsageSession', () => {
  it('settles the final partial interval and closes cleanly', () => {
    const uid = makeUser('basic', { credits_remaining_seconds: 1800, credits_expire_at: Date.now() + 86400000 });
    const { session_id } = db.startUsageSession(uid, 'dev1');
    backdateHeartbeat(session_id, 12);
    const r = db.stopUsageSession(uid, session_id);
    expect(r.charged).toBe(12);
    expect(r.remaining).toBe(1788);
    expect(getSession(session_id).end_reason).toBe('stopped');
  });
});

describe('sweepStaleUsageSessions', () => {
  it('settles a crashed session AT its last heartbeat — no post-crash charge', () => {
    const uid = makeUser('basic', { credits_remaining_seconds: 1800, credits_expire_at: Date.now() + 86400000 });
    const { session_id } = db.startUsageSession(uid, 'dev1');
    backdateHeartbeat(session_id, 120); // silent past the 90s threshold
    const before = db.getLicenseByUserId(uid).credits_remaining_seconds;
    const closed = db.sweepStaleUsageSessions();
    expect(closed).toBeGreaterThanOrEqual(1);
    const sess = getSession(session_id);
    expect(sess.end_reason).toBe('stale');
    expect(sess.ended_at).toBe(sess.last_heartbeat_at); // settled at the last beat
    // The sweep itself charges nothing beyond what heartbeats already took.
    expect(db.getLicenseByUserId(uid).credits_remaining_seconds).toBe(before);
  });
});

describe('grantTimeExtension (flat +30 min top-up, 2026-07)', () => {
  // Each top-up grants a flat +30 minutes and PRESERVES the current tier
  // (a Pro/Max top-up must not relabel the user Basic).
  it('adds +30 min for a Basic license', () => {
    const uid = makeUser('basic', { credits_remaining_seconds: 100, credits_expire_at: Date.now() + 60000 });
    const updated = db.grantTimeExtension(uid);
    expect(updated.tier).toBe('basic');
    expect(updated.credits_remaining_seconds).toBe(100 + 1800);
    expect(updated.status).toBe('active');
  });

  it('adds +30 min and PRESERVES the Pro tier', () => {
    const uid = makeUser('pro', { credits_remaining_seconds: 100, credits_expire_at: Date.now() + 60000 });
    const updated = db.grantTimeExtension(uid);
    expect(updated.tier).toBe('pro');
    expect(updated.credits_remaining_seconds).toBe(100 + 1800);
    expect(updated.status).toBe('active');
  });

  it('adds +30 min and PRESERVES the Max tier', () => {
    const uid = makeUser('max', { credits_remaining_seconds: 250, credits_expire_at: Date.now() + 60000 });
    const updated = db.grantTimeExtension(uid);
    expect(updated.tier).toBe('max');
    expect(updated.credits_remaining_seconds).toBe(250 + 1800);
  });

  it('drops a stale (expired-window) balance instead of resurrecting it', () => {
    const uid = makeUser('basic', { credits_remaining_seconds: 900, credits_expire_at: Date.now() - 1000 });
    const updated = db.grantTimeExtension(uid);
    expect(updated.credits_remaining_seconds).toBe(1800);
  });

  it('reactivates a free/expired user as Basic with the Basic unit (legacy behavior)', () => {
    const uid = makeUser('free', { trial_remaining_seconds: 0 });
    const updated = db.grantTimeExtension(uid);
    expect(updated.tier).toBe('basic');
    expect(updated.credits_remaining_seconds).toBe(1800);
  });

  it('never shrinks an unlimited/comp license', () => {
    const uid = makeUser('max', { credits_remaining_seconds: -1, credits_expire_at: -1 });
    const updated = db.grantTimeExtension(uid);
    expect(updated.credits_remaining_seconds).toBe(-1);
  });
});

describe('resolveTimeBucket', () => {
  it('reports zero once the credit window has passed', () => {
    const uid = makeUser('pro', { credits_remaining_seconds: 500, credits_expire_at: Date.now() - 1 });
    const b = db.resolveTimeBucket(db.getLicenseByUserId(uid));
    expect(b.source).toBe('credits');
    expect(b.remaining).toBe(0);
  });
});
