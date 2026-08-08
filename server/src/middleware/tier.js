// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  TIER GATE — server-side enforcement of paid-feature access
//
//  Why this exists: until v3.4.7 the AI proxy and auto-type endpoints
//  trusted the renderer to enforce its own feature gates. A free user
//  with DevTools could copy their Bearer token and POST to /chat/claude
//  to use Sonnet 4.6 indefinitely, or to /autotype-plan to burn Haiku
//  tokens at our cost. Client gates aren't enforcement — they're UX.
//
//  Reads the LICENSE row (not req.user.tier from the JWT) because:
//    - JWTs are issued at login with tier baked in. After a paid upgrade
//      the webhook updates the license, but the live JWT still says
//      'free' until the next /license/validate refresh (≤ 30 min).
//    - Conversely, after a refund the JWT still says 'pro' until a
//      refresh, but we want gates to deny access immediately.
//  License is the source of truth.
//
//  Admins (ADMIN_EMAILS env) bypass all tier gates. This mirrors the
//  client-side admin short-circuit at services/licenseService.ts so
//  internal QA can hit any endpoint with their dev account.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const db = require('../database');
const { hasAccess } = require('../services/subscriptionStates');

const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
  .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);

// ── The decision itself, with no HTTP attached ───────────────────────────
// evaluateTier(user, allowedTiers) is the whole access ruling as a pure
// function of (user, license row, clock). It was extracted out of the
// middleware below because a SECOND caller now needs the identical answer
// without an Express response to write it to: routes/license.js mints a
// signed Auto-Type entitlement claim that the desktop app caches offline
// for a week, and that claim must say exactly what requireTier('ultra')
// would say at the same instant. Two hand-maintained copies of this ladder
// would drift, and both directions of drift are bad — a claim that grants
// Auto-Type where the route 403s makes the feature look broken, and a claim
// that denies where the route allows locks a paying Ultra customer out of
// the thing they pay $159/mo for. One function, one truth.
//
// Returns either
//   { ok: true,  license }            — allowed; `license` is what the
//                                       middleware attaches as req.license
//   { ok: false, status, body }       — denied; `body` is the VERBATIM JSON
//                                       requireTier has always responded
//                                       with, so the wrapper below is a pure
//                                       transport shim over this function.
// Throws on a database failure (or a caller who passes no user at all) —
// requireTier turns that into the same 500 it always did, and any other
// caller must decide for itself, because "the database is down" is not an
// entitlement answer and must never be mistaken for one.
function evaluateTier(user, allowedTiers) {
  // Mirrors requireTier's own construction-time guard for callers that come
  // in through this door instead. An empty list would otherwise deny
  // everyone with `required: []`, which reads like a licensing outage rather
  // than the caller bug it actually is.
  if (!Array.isArray(allowedTiers) || allowedTiers.length === 0) {
    throw new Error('evaluateTier called with no allowed tiers');
  }

  // Admin bypass — same logic as the client-side admin short-circuit
  // in services/licenseService.ts. Admins effectively get Max access.
  const email = (user?.email || '').toLowerCase();
  if (ADMIN_EMAILS.includes(email)) {
    // Still return the license so downstream handlers have it; falls
    // back to a synthetic Max placeholder if no license row exists
    // (admin who never went through the normal signup flow).
    return { ok: true, license: db.getLicenseByUserId(user.id) || { tier: 'max', status: 'active' } };
  }

  const license = db.getLicenseByUserId(user.id);
  if (!license) {
    return {
      ok: false,
      status: 403,
      body: {
        error: 'tier_required',
        required: allowedTiers,
        current: 'none',
        message: 'No active license found for this account.',
      },
    };
  }
  if (!allowedTiers.includes(license.tier)) {
    return {
      ok: false,
      status: 403,
      body: {
        error: 'tier_required',
        required: allowedTiers,
        current: license.tier,
        message: `This feature requires ${allowedTiers.join(' or ')} tier.`,
      },
    };
  }
  // Free tier (2026-07): routes that EXPLICITLY allow 'free' (the
  // 10-minute-trial model routes in routes/ai.js) must not bounce
  // free users on the paid-subscription checks below — free licenses
  // sit at status='trial' forever (hasAccess() is false by design;
  // see services/subscriptionStates.js: 'trial' has no automatic
  // transition) and their 30-day expires_at is UI bookkeeping, not
  // an access boundary. The free tier's real limit is the one-time
  // consumption trial bucket, enforced by requireTimeRemaining
  // (402 at 0 seconds). Routes that don't list 'free' are unaffected:
  // the allowedTiers check above already rejected free there.
  if (license.tier === 'free') {
    return { ok: true, license };
  }
  // Tier matches. The tier is meant to encode "paid for this feature" —
  // webhooks reset tier→free on cancel/refund/expiry. But if a webhook
  // is LOST (and the cycle-end sweeper only scans 'canceling'), a stale
  // row can sit at tier='pro' past its expiry and keep serving paid AI
  // to a DevTools user indefinitely. So we ALSO require an access status
  // and a non-lapsed expiry — the same defense-in-depth regionGate.js
  // already applies. hasAccess() (subscriptionStates) is the shared
  // predicate: active / canceling / past_due.
  if (!hasAccess(license.status)) {
    return {
      ok: false,
      status: 403,
      body: {
        error: 'tier_required',
        required: allowedTiers,
        current: license.tier,
        current_status: license.status,
        message: 'Your subscription is not active. Please renew to continue.',
      },
    };
  }
  // expires_at = -1 sentinel = "never expires" (recurring Pro/Max).
  if (license.expires_at > 0 && Date.now() > license.expires_at) {
    return {
      ok: false,
      status: 403,
      body: {
        error: 'tier_required',
        required: allowedTiers,
        current: license.tier,
        current_status: 'lapsed',
        message: 'Your subscription has expired. Please renew to continue.',
      },
    };
  }
  return { ok: true, license };
}

// requireTier('basic', 'pro', 'max') — allow any of those tiers. To gate
// to one specific tier, pass a single arg: requireTier('max').
//
// Attaches `req.license` to the request so handlers don't need to
// re-query for license data they already verified.
function requireTier(...allowedTiers) {
  if (allowedTiers.length === 0) {
    throw new Error('requireTier called with no allowed tiers');
  }
  return (req, res, next) => {
    try {
      const decision = evaluateTier(req.user, allowedTiers);
      if (!decision.ok) {
        return res.status(decision.status).json(decision.body);
      }
      req.license = decision.license;
      next();
    } catch (err) {
      console.error('[tier-gate] error:', err.message);
      return res.status(500).json({ error: 'Tier check failed' });
    }
  };
}

module.exports = { requireTier, evaluateTier };
