// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  USAGE — server-authoritative interview clock (2026-07)
//
//  Replaces the renderer-localStorage timer ("Option A") as the source of
//  truth for trial / interview-pass time. The client:
//    POST /start      → open a session, get { session_id, remaining, source }
//    POST /heartbeat  → every ~20s; server charges wall-clock elapsed
//                       (clamped) and returns the authoritative remaining.
//                       The client's 1-second countdown is DISPLAY ONLY
//                       between beats and reconciles to every response.
//    POST /stop       → settle the final partial interval.
//    GET  /balance    → read-only balance (Billing Hub, app boot).
//
//  Failure discipline (this app runs during live interviews):
//  - A missed/failed heartbeat NEVER kills the interview client-side; the
//    client keeps counting locally and reconciles on the next beat.
//  - Withholding heartbeats earns nothing: EVERY route below settles the
//    open session against the SERVER clock before it does anything else,
//    so consumed time is charged whether or not a beat carried it —
//    including at /start, which used to throw the un-beaten tail of the
//    session it replaced away and made looping the endpoint free
//    interview time. A session silent past the stale window stops
//    authorising answers and is settled at the LAST beat by the sweeper,
//    and a dead session can't be heartbeated back to life — the client
//    must /start again, which re-checks the balance.
//  - Admins get unlimited sessions (matching middleware/tier.js policy).
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const express = require('express');
const { authMiddleware } = require('../middleware/auth');
const { isPlanLapsed } = require('../services/subscriptionStates');
const db = require('../database');

const router = express.Router();

const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
  .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
function isAdminEmail(email) {
  return !!email && ADMIN_EMAILS.includes(String(email).toLowerCase());
}

// ━━ The clock is the SERVER's — a heartbeat reports time, it never IS
//    the charge ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Charging used to happen only on the beats a client chose to send, and
// two things fell through that gap:
//   · /start dropped the tail of the session it replaced —
//     startUsageSession supersedes the old row without charging it — so
//     "open a session, use it, /start again, repeat" was unlimited free
//     interview time, and the client never had to lie about anything;
//   · a client that simply beat slowly paid the per-beat cap (45s) for a
//     gap twice that long.
// So every route below settles the open session against the server clock
// FIRST and lets the database helpers charge the residual (~0s) — their
// exhaustion / session-gone / supersede logic is untouched, and the
// legitimate 20-second beat still charges exactly what it did before.
//
// The ceiling on ONE settle is the stale window, not the per-beat cap: a
// session stops authorising answers (hasLiveUsageSession) once it has
// been silent that long, and the sweeper settles it there — so that
// window is the most time a single gap can honestly represent. Keep in
// sync with USAGE_STALE_AFTER_MS in database.js (not exported).
const USAGE_STALE_AFTER_MS = 90 * 1000;
// A /start this soon after the running one is the same client asking
// twice (a re-mounted window, a retried request — or a loop trying to
// rewind the clock): it RESUMES the live session instead of minting a
// fresh one. Deliberately short, because a genuine hand-off between
// devices happens minutes apart and must still supersede as before.
const USAGE_START_RESUME_MS = 10 * 1000;

// Charge one OPEN session for the wall time it has run since its last
// settle. Mirrors database.js chargeLicenseSeconds exactly — same
// columns, same MAX(0, …) floor, same `> 0` guard, which is also what
// keeps the -1 unlimited sentinel out of the arithmetic. seconds_charged
// grows by what the balance ACTUALLY gave up rather than by the nominal
// ask, so an empty bucket can never inflate the usage ledger the refund
// policy reads. Returns the seconds charged.
function settleUsageSession(userId, sess, now) {
  if (!sess || sess.source === 'unlimited') return 0;
  const owed = Math.max(0, Math.floor(
    Math.min(now - sess.last_heartbeat_at, USAGE_STALE_AFTER_MS) / 1000,
  ));
  if (owed <= 0) return 0;
  const col = sess.source === 'credits' ? 'credits_remaining_seconds' : 'trial_remaining_seconds';
  const d = db.getDB();
  let charged = 0;
  const tx = d.transaction(() => {
    const read = () => {
      const row = d.prepare(`SELECT ${col} AS v FROM licenses WHERE user_id = ?`).get(userId);
      return row ? (row.v || 0) : 0;
    };
    const before = read();
    d.prepare(`
      UPDATE licenses SET ${col} = MAX(0, ${col} - ?)
      WHERE user_id = ? AND ${col} > 0
    `).run(owed, userId);
    charged = Math.max(0, before - read());
    if (charged > 0) {
      d.prepare(`
        UPDATE usage_sessions
        SET last_heartbeat_at = ?, seconds_charged = seconds_charged + ?
        WHERE id = ? AND ended_at IS NULL
      `).run(now, charged, sess.id);
    }
  });
  tx();
  return charged;
}

// Settle the one session the client named (/heartbeat, /stop). An
// unknown, closed, or someone else's id settles nothing — the database
// helper that runs next answers those with its own 410.
function settleUsageSessionById(userId, sessionId, now) {
  const sess = db.getDB().prepare(
    'SELECT * FROM usage_sessions WHERE id = ? AND user_id = ? AND ended_at IS NULL'
  ).get(sessionId, userId);
  return settleUsageSession(userId, sess, now);
}

// Settle EVERY session this account still has open and return the one a
// repeat /start should land back on (newest, opened inside the resume
// window, still inside the live window) — or null, in which case the
// caller opens a new session and startUsageSession supersedes these in
// its own transaction, exactly as before. Nothing is closed here on
// purpose: that keeps "there is never a moment with zero live sessions"
// true, which is what stops a concurrent question being refused
// mid-interview.
function settleOpenUsageSessions(userId, now) {
  const open = db.getDB().prepare(`
    SELECT * FROM usage_sessions
    WHERE user_id = ? AND ended_at IS NULL
    ORDER BY started_at DESC
  `).all(userId);
  let resumable = null;
  for (const sess of open) {
    if (!resumable
        && (now - sess.started_at) < USAGE_START_RESUME_MS
        && (now - sess.last_heartbeat_at) < USAGE_STALE_AFTER_MS) {
      resumable = sess;
    }
    settleUsageSession(userId, sess, now);
  }
  return resumable;
}

// ── Open a session ──
router.post('/start', authMiddleware, (req, res) => {
  try {
    const admin = isAdminEmail(req.user.email);
    // Lapsed paid plan (calendar expiry / cancel completion / refund /
    // revoke — services/subscriptionStates.isPlanLapsed, the same
    // predicate the AI tier gates use) can't open interview sessions.
    // Without this an EXPIRED Ultra kept opening unlimited sessions
    // forever (resolveTimeBucket reads ultra as unlimited and never
    // consults status/expiry). 403 with the requireTier renew shape —
    // distinct from the 402 "top up" below, which stays reserved for
    // valid plans whose clock ran out. Free rows are exempt (their
    // status is 'trial' forever; the trial bucket is their wall).
    if (!admin) {
      const lic = db.getLicenseByUserId(req.user.id);
      if (lic && isPlanLapsed(lic)) {
        return res.status(403).json({
          error: 'tier_required',
          current: lic.tier,
          current_status: lic.status,
          message: 'Your subscription has expired. Please renew to continue.',
        });
      }
    }
    // ── Settle the server clock BEFORE opening anything ──
    // Whatever this account already has running is charged for the wall
    // time it actually ran, here, at the moment the restart is asked for.
    // Without it startUsageSession simply marked the old row 'superseded'
    // and threw its un-beaten seconds away, which made a /start loop an
    // unlimited free-time faucet.
    const now = Date.now();
    const resumable = settleOpenUsageSessions(req.user.id, now);

    // ── Repeat-/start guard ──
    // A second /start moments after the running one RESUMES that session
    // instead of minting a new one, so hammering the endpoint cannot
    // rewind the clock (and a re-mounted window / retried request lands
    // back where it was). A real hand-off — popout, phone, second device
    // — happens minutes later and still falls through to supersede.
    if (resumable) {
      if (resumable.source === 'unlimited') {
        return res.json({
          session_id: resumable.id,
          source: 'unlimited',
          remaining: -1,
          server_now: now,
          resumed: true,
        });
      }
      const bucket = db.resolveTimeBucket(db.getLicenseByUserId(req.user.id));
      if (bucket.remaining > 0) {
        return res.json({
          session_id: resumable.id,
          source: bucket.source,
          remaining: bucket.remaining,
          server_now: now,
          resumed: true,
        });
      }
      // The settle above emptied the bucket — fall through so the
      // exhausted branch answers with the normal 402 paywall shape.
    }

    const result = db.startUsageSession(req.user.id, req.body?.device_id || null, {
      unlimitedOverride: admin,
    });
    if (result.error === 'no_license') {
      return res.status(404).json({ error: 'No license found for this account.' });
    }
    if (result.error === 'exhausted') {
      return res.status(402).json({
        error: 'no_time_remaining',
        source: result.source,
        remaining: 0,
        message: result.source === 'trial'
          ? 'Your free trial time is used up. Pick a plan to keep going.'
          : 'Your interview time is used up. Extend or buy another interview to continue.',
      });
    }
    res.json(result);
  } catch (err) {
    console.error('[usage/start] error:', err.message);
    res.status(500).json({ error: 'Failed to start session' });
  }
});

// ── Heartbeat ──
router.post('/heartbeat', authMiddleware, (req, res) => {
  try {
    const sessionId = String(req.body?.session_id || '');
    if (!sessionId) return res.status(400).json({ error: 'session_id required' });
    // Settle on the server clock first (capped at the stale window, so a
    // gap longer than the per-beat cap is charged for what it held), then
    // let the database helper charge the residual — ~0s — and run the
    // exhaustion / session-gone logic exactly as it always has.
    const settled = settleUsageSessionById(req.user.id, sessionId, Date.now());
    const result = db.heartbeatUsageSession(req.user.id, sessionId);
    if (result?.error === 'no_session') {
      // Session was superseded (another device/window took over), swept
      // stale, or already exhausted. 410 tells the client to stop its
      // local clock and re-/start if the user is still interviewing.
      return res.status(410).json({ error: 'session_gone' });
    }
    if (result && typeof result.charged === 'number') result.charged += settled;
    res.json(result);
  } catch (err) {
    console.error('[usage/heartbeat] error:', err.message);
    res.status(500).json({ error: 'Heartbeat failed' });
  }
});

// ── Clean stop ──
router.post('/stop', authMiddleware, (req, res) => {
  try {
    const sessionId = String(req.body?.session_id || '');
    if (!sessionId) return res.status(400).json({ error: 'session_id required' });
    // Same server-clock settle as the heartbeat path, so a client that
    // stops after a long silent gap pays for the window it actually held
    // rather than the per-beat cap.
    const settled = settleUsageSessionById(req.user.id, sessionId, Date.now());
    const result = db.stopUsageSession(req.user.id, sessionId);
    if (result?.error === 'no_session') {
      // Already closed (exhausted beat, sweeper, supersede) — that's fine;
      // report the current balance so the client lands consistent.
      const license = db.getLicenseByUserId(req.user.id);
      const bucket = db.resolveTimeBucket(license);
      return res.json({ remaining: bucket.remaining, source: bucket.source, already_closed: true });
    }
    if (result && typeof result.charged === 'number') result.charged += settled;
    res.json(result);
  } catch (err) {
    console.error('[usage/stop] error:', err.message);
    res.status(500).json({ error: 'Stop failed' });
  }
});

// ── Read-only balance ──
router.get('/balance', authMiddleware, (req, res) => {
  try {
    if (isAdminEmail(req.user.email)) {
      return res.json({ remaining: -1, source: 'unlimited' });
    }
    const license = db.getLicenseByUserId(req.user.id);
    if (!license) return res.status(404).json({ error: 'No license found' });
    const bucket = db.resolveTimeBucket(license);
    res.json({
      remaining: bucket.remaining,
      source: bucket.source,
      credits_expire_at: license.credits_expire_at || 0,
      tier: license.tier,
    });
  } catch (err) {
    console.error('[usage/balance] error:', err.message);
    res.status(500).json({ error: 'Balance lookup failed' });
  }
});

// ── Usage summary — Settings → Usage card ──
// One read-only shape for "used vs granted this plan window" plus lifetime
// totals, driven by the SAME ledger the interview clock charges against
// (resolveTimeBucket + usage_sessions), so the card can never disagree
// with the in-interview timer. granted comes from the plan-window anchor
// licenses.credits_granted_seconds (seeded on purchase, increased by every
// top-up); MAX(granted, remaining) self-heals rows granted before that
// column existed so used >= 0 and the bar can never exceed 100%. Trial
// draws from the flat 10-minute grant (FREE_TRIAL_SECONDS in database.js).
// Unlimited (admin / ultra / -1 sentinels) reports no fraction at all.
router.get('/summary', authMiddleware, (req, res) => {
  try {
    const totals = db.getUsageTotals(req.user.id);
    if (isAdminEmail(req.user.email)) {
      return res.json({ unlimited: true, source: 'unlimited', tier: 'admin', ...totals });
    }
    const license = db.getLicenseByUserId(req.user.id);
    if (!license) return res.status(404).json({ error: 'No license found' });
    const bucket = db.resolveTimeBucket(license);
    if (bucket.remaining === -1) {
      return res.json({ unlimited: true, source: 'unlimited', tier: license.tier, ...totals });
    }
    // Metered: paid tiers anchor on the recorded grant (plan window total);
    // free anchors on FREE_TRIAL_SECONDS (single source of truth).
    // used = granted - remaining so the tube fills exactly with consumption.
    const paid = ['basic', 'pro', 'max'].includes(license.tier);
    const remaining = Math.max(0, bucket.remaining);
    const granted = paid
      ? Math.max(license.credits_granted_seconds || 0, remaining)
      : Math.max(db.FREE_TRIAL_SECONDS || 0, remaining);
    const used = Math.max(0, granted - remaining);
    const used_percent = granted > 0
      ? Math.min(100, Math.round((used / granted) * 1000) / 10) // one decimal
      : 0;
    res.json({
      unlimited: false,
      source: bucket.source,
      tier: license.tier,
      remaining_seconds: remaining,
      granted_seconds: granted,
      used_seconds: used,
      used_percent,
      lifetime_used_seconds: totals.lifetime_used_seconds,
      session_count: totals.session_count,
      credits_expire_at: license.credits_expire_at || 0,
    });
  } catch (err) {
    console.error('[usage/summary] error:', err.message);
    res.status(500).json({ error: 'Usage summary failed' });
  }
});

module.exports = router;
