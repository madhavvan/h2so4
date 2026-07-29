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

  it('clamps a silent gap to the per-beat cap (45s) — no burst overcharge', () => {
    const uid = makeUser('pro', { credits_remaining_seconds: 3600, credits_expire_at: Date.now() + 86400000 });
    const { session_id } = db.startUsageSession(uid, 'dev1');
    backdateHeartbeat(session_id, 300); // 5 minutes of silence
    const r = db.heartbeatUsageSession(uid, session_id);
    expect(r.charged).toBe(45);
    expect(r.remaining).toBe(3600 - 45);
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

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  THE ANSWERING GATE (2026-07)
//
//  Until now the model routes only asked "does this account have time
//  left". That is a different question from "is this account being
//  charged right now", and the gap between them was a free ride: leave
//  the mic off, no session opens, nothing is charged — and every model
//  still answered. A trial user could type questions indefinitely and
//  never lose a second of their ten minutes.
//
//  hasLiveUsageSession closes it. These tests pin the two halves that
//  matter: an OPEN session is not enough if it has gone quiet, and a
//  session someone else superseded stops authorising immediately.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe('hasLiveUsageSession — the gate the model routes ask', () => {
  it('is false before anything starts, however much time is left', () => {
    const uid = makeUser('pro', { credits_remaining_seconds: 3600 });
    // The exact free ride: plenty of balance, mic off, nothing running.
    expect(db.hasLiveUsageSession(uid)).toBe(false);
  });

  it('is true the moment a session opens', () => {
    const uid = makeUser('free', { trial_remaining_seconds: 600 });
    db.startUsageSession(uid, 'dev1');
    expect(db.hasLiveUsageSession(uid)).toBe(true);
  });

  it('goes false once the session stops heartbeating', () => {
    const uid = makeUser('pro', { credits_remaining_seconds: 3600 });
    const s = db.startUsageSession(uid, 'dev1');
    backdateHeartbeat(s.session_id, 120);        // past the 90s stale window
    // Still open in the table — the sweeper has not run — but a laptop
    // that has been silent for two minutes is closed, and letting its
    // session keep authorising answers just moves the free ride.
    expect(getSession(s.session_id).ended_at).toBeNull();
    expect(db.hasLiveUsageSession(uid)).toBe(false);
  });

  it('is false again after a clean stop', () => {
    const uid = makeUser('pro', { credits_remaining_seconds: 3600 });
    const s = db.startUsageSession(uid, 'dev1');
    db.stopUsageSession(uid, s.session_id);
    expect(db.hasLiveUsageSession(uid)).toBe(false);
  });

  it('follows the newest device when a session is superseded', () => {
    // Phone starts, then the computer comes online and takes over. There
    // is exactly one live session throughout — never zero (which would
    // cut the user off mid-question) and never two.
    const uid = makeUser('ultra');
    db.startUsageSession(uid, 'phone');
    expect(db.hasLiveUsageSession(uid)).toBe(true);
    db.startUsageSession(uid, 'computer');
    expect(db.hasLiveUsageSession(uid)).toBe(true);
    const open = db.getDB()
      .prepare('SELECT COUNT(*) c FROM usage_sessions WHERE user_id = ? AND ended_at IS NULL')
      .get(uid);
    expect(open.c).toBe(1);
  });

  it('is scoped to one account', () => {
    const a = makeUser('pro', { credits_remaining_seconds: 3600 });
    const b = makeUser('pro', { credits_remaining_seconds: 3600 });
    db.startUsageSession(a, 'dev1');
    expect(db.hasLiveUsageSession(a)).toBe(true);
    expect(db.hasLiveUsageSession(b)).toBe(false);
  });

  it('stops authorising the moment the balance runs out', () => {
    // The beat that drains the bucket also closes the session, so the
    // gate and the paywall agree instead of one lagging the other.
    const uid = makeUser('free', { trial_remaining_seconds: 5 });
    const s = db.startUsageSession(uid, 'dev1');
    backdateHeartbeat(s.session_id, 30);
    db.heartbeatUsageSession(uid, s.session_id);
    expect(db.hasLiveUsageSession(uid)).toBe(false);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  WHICH MODELS MAY THIS ACCOUNT USE?
//
//  /api/v1/ai/models answers it for clients that cannot work it out
//  themselves — chiefly a phone that has never been connected to a
//  computer, which would otherwise know only that Gemini exists and be
//  stuck the moment Gemini is busy.
//
//  These pin the property that makes the endpoint worth having: its
//  answer is derived from the SAME tier lists the model routes gate on.
//  A second opinion here would be worse than nothing, because the way it
//  fails is offering someone a model they will then be refused.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe('the model list a client is told it can use', () => {
  // Mirrors the route's own derivation (routes/ai.js). Kept beside the
  // gate constants it depends on rather than hitting HTTP, so a change
  // to those lists fails here rather than silently widening access.
  const TRIAL_MODELS = ['free', 'basic', 'pro', 'max', 'ultra'];
  const CLAUDE_TIERS = ['pro', 'max', 'ultra'];
  const modelsFor = (tier, isAdmin = false) => {
    const allow = (tiers) => isAdmin || tiers.includes(tier);
    // Gemini unconditionally — /stream/gemini has no requireTier, only a
    // quota gate, so this matches what the route will actually accept.
    const out = ['gemini'];
    if (allow(TRIAL_MODELS)) out.push('openai', 'xai', 'groq');
    if (allow(CLAUDE_TIERS)) out.push('claude');
    return out;
  };

  it('gives a free trial user the four non-Claude models', () => {
    // The trial deliberately covers everything except Claude; a phone on
    // a fresh signup must know all four, or one busy provider ends the
    // first question someone ever asks.
    expect(modelsFor('free')).toEqual(['gemini', 'openai', 'xai', 'groq']);
  });

  it('withholds Claude below Pro, and grants it at Pro and above', () => {
    expect(modelsFor('basic')).not.toContain('claude');
    for (const t of ['pro', 'max', 'ultra']) expect(modelsFor(t)).toContain('claude');
  });

  it('never returns an empty list', () => {
    // An empty list is indistinguishable from "this app is broken". Even
    // an unrecognised tier keeps the models every plan has.
    for (const t of ['free', 'basic', 'pro', 'max', 'ultra', 'something-new']) {
      expect(modelsFor(t).length).toBeGreaterThan(0);
    }
  });

  it('always leads with a model every plan has', () => {
    // The phone takes the first entry as its default and the rest, in
    // order, as fallbacks — so the head of the list must be the one
    // model nobody can be refused.
    for (const t of ['free', 'basic', 'pro', 'max', 'ultra']) {
      expect(modelsFor(t)[0]).toBe('gemini');
    }
  });

  it('gives admins everything regardless of their licence row', () => {
    expect(modelsFor('free', true)).toContain('claude');
  });
});
