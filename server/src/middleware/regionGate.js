// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  REGION GATE — paid-subscription-required regions
//
//  Policy (May 2026): in India, the app requires an ACTIVE paid
//  subscription to use any AI feature. Free tier, 30-day trial,
//  expired-after-payment, and refunded states all return 403. The
//  only bypasses are:
//    1. Admin emails (ADMIN_EMAILS env) — internal QA / support
//    2. status='canceling' — user has paid through current cycle, keeps
//       access until expires_at
//    3. status='past_due' — Razorpay auto-retries failed charges within
//       ~7 days; we keep access during the retry window so a transient
//       bank decline doesn't lock the user out mid-interview. If retry
//       fails, subscription.halted webhook flips status='expired' and
//       this gate then rejects on the next request.
//
//  Why server-side: the renderer's gate (SubscriptionGate.tsx) is UX,
//  not enforcement. Without a server check, an IN user with DevTools
//  could bypass the paywall by editing client state. This middleware
//  is the actual enforcement.
//
//  Why on the AI router: blocks chat/stream/autotype/prefetch/deepgram-
//  key — every AI feature that costs us money to serve. Other routes
//  (auth, payments, license validation, conversations) remain open so
//  the user can sign up, log in, see their state, and BUY a subscription
//  to unlock the AI.
//
//  Reads the LIVE license row (not req.user.tier from the JWT) — JWTs
//  are issued at login with tier baked in; webhook updates land on the
//  license row first. Same reasoning as requireTier.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const db = require('../database');

const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
  .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);

// Tiers that count as "paid". Anything else (free, trial-as-tier) is
// blocked. We don't list 'admin' here — admins bypass via email check.
const PAID_TIERS = new Set(['basic', 'pro', 'max', 'ultra', 'enterprise']);

// Statuses that retain access. 'canceling' = paid through cycle end.
// 'past_due' = Razorpay retry window (~7 days). 'active' = nominal.
// Anything else (trial, expired, refunded, paused, revoked, disputed) blocks.
const ACCESS_STATES = new Set(['active', 'canceling', 'past_due']);

// Single point of policy: which regions force paid subscription? Today
// only India. Adding a region later is a one-line change.
function regionRequiresPaidSubscription(countryCode) {
  return String(countryCode || '').toUpperCase() === 'IN';
}

function requireActiveSubscriptionInRegion(req, res, next) {
  try {
    // Admin bypass — same logic as requireTier and the client-side
    // admin short-circuit. Admins get full access regardless of region
    // (so internal QA can hit any endpoint with their dev account).
    const email = (req.user?.email || '').toLowerCase();
    if (ADMIN_EMAILS.includes(email)) return next();

    // Country lives on the user record (set at signup, updatable via
    // /profile with strict 2-letter validation). Pre-v3.4.7 this could
    // be spoofed via req.body.country_code — that's been removed.
    const user = db.getUserById(req.user.id);
    const countryCode = user?.country_code || 'US';

    if (!regionRequiresPaidSubscription(countryCode)) {
      return next();  // US/EU/everything else — region gate doesn't apply
    }

    // India path: must have active paid subscription.
    const license = db.getLicenseByUserId(req.user.id);
    if (!license) {
      return res.status(403).json({
        error: 'subscription_required',
        region: countryCode,
        current_tier: 'none',
        current_status: 'none',
        message: 'A paid subscription is required to use the app in your region. Please subscribe to continue.',
      });
    }

    if (!PAID_TIERS.has(license.tier)) {
      return res.status(403).json({
        error: 'subscription_required',
        region: countryCode,
        current_tier: license.tier,
        current_status: license.status,
        message: 'A paid subscription is required to use the app in your region. Please subscribe to continue.',
      });
    }

    if (!ACCESS_STATES.has(license.status)) {
      return res.status(403).json({
        error: 'subscription_required',
        region: countryCode,
        current_tier: license.tier,
        current_status: license.status,
        message: 'Your subscription has lapsed. Please renew to continue using the app.',
      });
    }

    // Hard expiry check — even with status='active' or 'canceling',
    // a stale license row with expires_at in the past should be denied.
    // expires_at = -1 sentinel = "never expires" (Pro/Max recurring).
    if (license.expires_at > 0 && Date.now() > license.expires_at) {
      return res.status(403).json({
        error: 'subscription_required',
        region: countryCode,
        current_tier: license.tier,
        current_status: 'lapsed',
        message: 'Your subscription has expired. Please renew to continue.',
      });
    }

    // All checks passed — attach license for downstream handlers and proceed.
    req.license = license;
    return next();
  } catch (err) {
    console.error('[region-gate] error:', err.message);
    // Fail closed — denying access on internal error is safer than
    // accidentally letting through a non-paying user from a paid-only
    // region. The user retries; if the issue is transient they get in.
    return res.status(500).json({ error: 'Region check failed' });
  }
}

module.exports = {
  requireActiveSubscriptionInRegion,
  regionRequiresPaidSubscription,
  PAID_TIERS,
  ACCESS_STATES,
};
