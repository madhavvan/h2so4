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
//  - Withholding heartbeats earns nothing: the session goes stale and is
//    settled at the LAST beat by the sweeper, and a dead session can't be
//    heartbeated back to life — the client must /start again, which
//    re-checks the balance.
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
    const result = db.heartbeatUsageSession(req.user.id, sessionId);
    if (result?.error === 'no_session') {
      // Session was superseded (another device/window took over), swept
      // stale, or already exhausted. 410 tells the client to stop its
      // local clock and re-/start if the user is still interviewing.
      return res.status(410).json({ error: 'session_gone' });
    }
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
    const result = db.stopUsageSession(req.user.id, sessionId);
    if (result?.error === 'no_session') {
      // Already closed (exhausted beat, sweeper, supersede) — that's fine;
      // report the current balance so the client lands consistent.
      const license = db.getLicenseByUserId(req.user.id);
      const bucket = db.resolveTimeBucket(license);
      return res.json({ remaining: bucket.remaining, source: bucket.source, already_closed: true });
    }
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
