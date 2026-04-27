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

const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
  .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);

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
      // Admin bypass — same logic as the client-side admin short-circuit
      // in services/licenseService.ts. Admins effectively get Max access.
      const email = (req.user?.email || '').toLowerCase();
      if (ADMIN_EMAILS.includes(email)) {
        // Still attach the license so downstream handlers have it; falls
        // back to a synthetic Max placeholder if no license row exists
        // (admin who never went through the normal signup flow).
        req.license = db.getLicenseByUserId(req.user.id) || { tier: 'max', status: 'active' };
        return next();
      }

      const license = db.getLicenseByUserId(req.user.id);
      if (!license) {
        return res.status(403).json({
          error: 'tier_required',
          required: allowedTiers,
          current: 'none',
          message: 'No active license found for this account.',
        });
      }
      if (!allowedTiers.includes(license.tier)) {
        return res.status(403).json({
          error: 'tier_required',
          required: allowedTiers,
          current: license.tier,
          message: `This feature requires ${allowedTiers.join(' or ')} tier.`,
        });
      }
      // License row exists and tier matches. We don't gate on
      // `license.status === 'active'` here because the tier itself
      // already encodes "they've paid for the feature" — an expired
      // Pro license already has tier=='free' (set by the cancel/refund
      // webhook handlers). Status checks would double-count.
      req.license = license;
      next();
    } catch (err) {
      console.error('[tier-gate] error:', err.message);
      return res.status(500).json({ error: 'Tier check failed' });
    }
  };
}

module.exports = { requireTier };
