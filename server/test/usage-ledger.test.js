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
    sessions_limit: (tier === 'ultra' || tier === 'enterprise') ? -1 : 3,
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

  it('gives enterprise an unlimited session', () => {
    const uid = makeUser('enterprise');
    const r = db.startUsageSession(uid, 'dev1');
    expect(r.source).toBe('unlimited');
    expect(r.remaining).toBe(-1);
  });

  // 2026-08: Ultra stopped being the unlimited tier and became a metered
  // 9-hour monthly allowance. It draws from the SAME credit bucket the
  // passes do — that is the whole change, and it is worth pinning because
  // every "unlimited" path in this file used to be spelled 'ultra'.
  it('meters ultra against its 9-hour credit bucket', () => {
    const uid = makeUser('ultra', { credits_remaining_seconds: 9 * 3600, credits_expire_at: 0, expires_at: -1 });
    const r = db.startUsageSession(uid, 'dev1');
    expect(r.source).toBe('credits');
    expect(r.remaining).toBe(9 * 3600);
  });

  // The grandfather clause: a pre-2026-08 Ultra row still carries the -1
  // credit sentinel, and must keep unlimited access until a renewal
  // re-seeds it. Cutting an existing subscriber to a meter mid-cycle is
  // exactly what isUnlimitedLicenseRow exists to prevent.
  it('keeps a legacy ultra (-1 sentinel) unlimited', () => {
    const uid = makeUser('ultra', { credits_remaining_seconds: -1, credits_expire_at: -1, expires_at: -1 });
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

  it('clamps a silent gap to the charge cap (90s) — no burst overcharge', () => {
    const uid = makeUser('pro', { credits_remaining_seconds: 3600, credits_expire_at: Date.now() + 86400000 });
    const { session_id } = db.startUsageSession(uid, 'dev1');
    backdateHeartbeat(session_id, 300); // 5 minutes of silence
    const r = db.heartbeatUsageSession(uid, session_id);
    expect(r.charged).toBe(90);
    expect(r.remaining).toBe(3600 - 90);
  });

  // ⚠️ THE CAP AND THE WINDOW ARE DIFFERENT NUMBERS NOW, ON PURPOSE.
  //
  // They used to be equal, and the argument for equality was this test's
  // original subject: a cap SMALLER than the window is a discount, because
  // a client that beats slowly stays live and pays the cap for a longer
  // gap. That is still true and is now an accepted, bounded cost.
  //
  // What flipped the decision is the other direction. The window is 15
  // minutes so an interview survives a WiFi handover or an API cold start
  // without being refused; an equal cap would then bill a fourteen-minute
  // laptop sleep as fourteen minutes of a Pro user's one-hour pass, in a
  // single beat — and tick() makes that certain, because on wake its
  // displaySeconds hits 0 and fires a confirming heartbeat immediately.
  // Overcharging honest users beat a discount that needs a patched client.
  //
  // So this pins what still holds: a gap inside the CAP is charged in full,
  // with no rounding-down anywhere in the path.
  it('charges the full gap for a slow-beating client, up to the cap', () => {
    const uid = makeUser('pro', { credits_remaining_seconds: 3600, credits_expire_at: Date.now() + 86400000 });
    const { session_id } = db.startUsageSession(uid, 'dev1');
    backdateHeartbeat(session_id, 85); // inside the 90s cap, and far inside the window
    expect(db.hasLiveUsageSession(uid)).toBe(true);
    const r = db.heartbeatUsageSession(uid, session_id);
    expect(r.charged).toBe(85);          // was 45 — a 47% discount on used time
    expect(r.remaining).toBe(3600 - 85);
  });

  // The two constants must never be silently re-coupled: setting the cap
  // back to the window would restore the sleep overcharge, and shrinking
  // the window back toward the cap would restore the 428 mid-interview.
  it('keeps the liveness window well clear of the charge cap', () => {
    expect(db.USAGE_STALE_AFTER_MS).toBe(15 * 60 * 1000);
    expect(db.USAGE_HEARTBEAT_CAP_S).toBe(90);
    expect(
      db.USAGE_STALE_AFTER_MS,
      'the window must outlast the blips an interview contains, not just a few beats',
    ).toBeGreaterThan(db.USAGE_HEARTBEAT_CAP_S * 1000);
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
    const uid = makeUser('enterprise');
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
    // Derived, not a literal: this said 120 for a 90s window and silently
    // stopped exercising the sweeper the moment the window moved.
    backdateHeartbeat(session_id, Math.ceil(db.USAGE_STALE_AFTER_MS / 1000) + 30);
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
//  ULTRA — THE TIER THAT NEVER BEAT.
//
//  The heartbeat and the billing clock are one mechanism: the client's
//  interval charges time AND refreshes last_heartbeat_at. Ultra has no time
//  to charge, so creditTimerService.start() returned before creating that
//  interval — "no countdown to run" — and an Ultra account never beat once.
//  Its row went stale 90 seconds in while the interview was still running.
//
//  Nothing surfaced it, because the only reader that can refuse a user is
//  hasLiveUsageSession and requireActiveSession is still dormant. Arming it
//  would have refused every non-admin unlimited user 90 seconds into every
//  interview — the top-paying tier, deterministically, BECAUSE it is the
//  one tier with nothing to bill. (That tier was Ultra when this was
//  written; since 2026-08 it is Enterprise, and Ultra meters like a pass.)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe('an unlimited session is live whether or not it ever beat', () => {
  // 2026-08: the unlimited tier is ENTERPRISE. Ultra used to be it, and the
  // narrative above still reads correctly with the name swapped — the bug it
  // describes is about sessions that are never charged, not about which SKU
  // happens to be uncharged this quarter.
  it('stays live past the window with a heartbeat that never came', () => {
    const uid = makeUser('enterprise');
    const { session_id, source } = db.startUsageSession(uid, 'dev1');
    expect(source).toBe('unlimited');
    // Older than the window by an hour — an interview well past the point
    // the client "should" have beaten, if it were ever going to.
    backdateHeartbeat(session_id, Math.ceil(db.USAGE_STALE_AFTER_MS / 1000) + 3600);
    expect(
      db.hasLiveUsageSession(uid),
      'requireActiveSession would 428 here — "Turn the mic on to start your ' +
        'session", to an Ultra user whose mic is on',
    ).toBe(true);
  });

  it('is not swept away underneath itself', () => {
    // hasLiveUsageSession also tests `ended_at IS NULL`, so a sweeper that
    // closed the row would re-open the hole from the other side.
    const uid = makeUser('enterprise');
    const { session_id } = db.startUsageSession(uid, 'dev1');
    backdateHeartbeat(session_id, Math.ceil(db.USAGE_STALE_AFTER_MS / 1000) + 3600);
    db.sweepStaleUsageSessions();
    expect(getSession(session_id).ended_at).toBeNull();
    expect(db.hasLiveUsageSession(uid)).toBe(true);
  });

  it('does NOT hand the same exemption to a metered session', () => {
    // The control. If this ever goes green, staleness has stopped meaning
    // anything and the mic-off free ride is back for everyone.
    const uid = makeUser('pro', { credits_remaining_seconds: 3600, credits_expire_at: Date.now() + 86400000 });
    const { session_id, source } = db.startUsageSession(uid, 'dev1');
    expect(source).toBe('credits');
    backdateHeartbeat(session_id, Math.ceil(db.USAGE_STALE_AFTER_MS / 1000) + 60);
    expect(db.hasLiveUsageSession(uid)).toBe(false);
  });

  it('charges nothing when an unlimited session does beat', () => {
    const uid = makeUser('enterprise');
    const { session_id } = db.startUsageSession(uid, 'dev1');
    backdateHeartbeat(session_id, 300);
    const r = db.heartbeatUsageSession(uid, session_id);
    expect(r.charged).toBe(0);
    expect(r.remaining).toBe(-1);
    expect(getSession(session_id).seconds_charged).toBe(0);
  });
});

// The server-side exemption above is the belt. This is the braces: the
// client must actually beat, or Ultra sessions would only ever be "live"
// by exemption and nothing would notice the next time the interval moved.
describe('the client no longer skips the interval for unlimited', () => {
  const fs = require('node:fs');
  // ESM: no __dirname here. Resolve against this module's own URL.
  const svc = fs.readFileSync(
    new URL('../../services/creditTimerService.ts', import.meta.url), 'utf8',
  );

  it('does not return before setInterval on an unlimited session', () => {
    const start = svc.indexOf('async start()');
    const end = svc.indexOf('stop(): void', start);
    const body = svc.slice(start, end);
    const interval = body.indexOf('this.intervalId = setInterval');
    expect(interval).toBeGreaterThan(-1);
    const before = body.slice(0, interval);
    // The exact shape of the bug: a bare `return` under an unlimited test,
    // sitting between the server session and the interval that beats for it.
    expect(
      /if \(this\.source === 'unlimited'\)[\s\S]{0,400}?\n\s*return;/.test(before),
      'unlimited must reach setInterval — that interval is what heartbeats, ' +
        'not just what counts down',
    ).toBe(false);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  -1 MEANS UNLIMITED, NOT EMPTY.
//
//  chargeLicenseSeconds returns readBucketRemaining, which yields the -1
//  sentinel for an unlimited credits bucket. `-1 <= 0` is true, so the next
//  heartbeat ended the session as 'exhausted' and the client told someone who
//  had just been granted unlimited time that theirs was used up — stopping
//  their mic mid-interview.
//
//  The session-level unlimited short-circuit does NOT cover this: it reads the
//  source recorded when the session OPENED, so a session that began on credits
//  keeps running through the charge path after the licence became unlimited.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe('an unlimited grant never reads as exhaustion', () => {
  it('does not end a credits session whose licence became unlimited', () => {
    const uid = makeUser('pro', { credits_remaining_seconds: 600, credits_expire_at: Date.now() + 86400000 });
    const { session_id, source } = db.startUsageSession(uid, 'dev1');
    expect(source).toBe('credits');           // opened while metered

    // The upgrade lands mid-interview: the bucket becomes the -1 sentinel.
    db.getDB().prepare('UPDATE licenses SET credits_remaining_seconds = -1 WHERE user_id = ?').run(uid);

    backdateHeartbeat(session_id, 25);
    const r = db.heartbeatUsageSession(uid, session_id);
    expect(r.exhausted, 'a person who just paid was told their time was used up').toBeFalsy();
    expect(r.remaining).toBe(-1);
    expect(getSession(session_id).ended_at, 'their session was ended under them').toBeNull();
  });

  it('still ends a session that genuinely ran out', () => {
    // The control — without it the fix above could disable exhaustion entirely.
    const uid = makeUser('pro', { credits_remaining_seconds: 10, credits_expire_at: Date.now() + 86400000 });
    const { session_id } = db.startUsageSession(uid, 'dev1');
    backdateHeartbeat(session_id, 30);
    const r = db.heartbeatUsageSession(uid, session_id);
    expect(r.exhausted).toBe(true);
    expect(getSession(session_id).end_reason).toBe('exhausted');
  });
});
