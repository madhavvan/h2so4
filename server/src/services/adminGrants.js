// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ADMIN GRANTS — the one definition of "an admin put this user on a plan"
//
//  Two consoles can do it: the dashboard (routes/admin.js change-tier /
//  upgrade / downgrade) and the support bot (services/botTools.js
//  change_user_tier). Until 2026-09 each carried its own copy of the tier
//  defaults and its own licence write, and the copies had drifted: the bot
//  moved a user to Pro with the credit columns untouched and no admin-grant
//  marker, so the "grant" was unlimited only through the legacy expires_at
//  sentinel and evaporated on the next lifecycle event for any old
//  subscription. One function, both callers.
//
//  Policy (2026-08 owner rule): an admin grant of ANY paid tier is
//  Enterprise-equivalent time —
//    expires_at -1, sessions_limit -1, credits_remaining_seconds -1,
//    credits_expire_at -1, admin_granted_at = now
//  — and stays that way until an admin changes the plan again. The named tier
//  still decides FEATURES (Basic has no Claude, Pro/Max no Auto-Type); it no
//  longer decides how much time the person gets. Moving to free clears
//  everything, including the marker.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const db = require('../database');

const DAY_MS = 24 * 60 * 60 * 1000;

const TIER_LICENSE_DEFAULTS = {
  free:       { expires_at: () => Date.now() + 30 * DAY_MS, sessions_limit: 5 },
  basic:      { expires_at: () => -1, sessions_limit: -1 },
  pro:        { expires_at: () => -1, sessions_limit: -1 },
  max:        { expires_at: () => -1, sessions_limit: -1 },
  ultra:      { expires_at: () => -1, sessions_limit: -1 },
  enterprise: { expires_at: () => -1, sessions_limit: -1 },
};
const VALID_TIERS = Object.keys(TIER_LICENSE_DEFAULTS);
const PAID_TIERS = VALID_TIERS.filter(t => t !== 'free');

// The credit grant an admin activation writes, for every paid tier.
const ENTERPRISE_EQUIVALENT_CREDITS = {
  credits_remaining_seconds: -1, // unlimited — same sentinel Enterprise carries
  credits_expire_at: -1,         // never voids
};
const NO_CREDITS = { credits_remaining_seconds: 0, credits_expire_at: 0 };

// Move `user` (a users row) to `tier` as an admin action. Returns
//   { ok: true, previousTier, paidGrant, license }
//   { ok: false, error }   — invalid tier, or the licence row could not be
//                            created (the caller decides the HTTP shape).
// Writes users.tier and the licence in the same shape for every caller, and
// carries adminOverride so the deliberate admin downgrade to free is the one
// path allowed to remove an admin-granted plan.
function applyAdminTierChange(user, tier) {
  if (!user || !user.id) return { ok: false, error: 'user required' };
  if (!VALID_TIERS.includes(tier)) {
    return { ok: false, error: `tier must be one of: ${VALID_TIERS.join(', ')}` };
  }
  // Materialise a licence row first — updateLicenseOnPayment is a bare UPDATE
  // and would silently affect zero rows for a user who never got one.
  if (!db.ensureLicenseForUser(user.id)) {
    return { ok: false, error: 'Could not create a license for this user' };
  }
  const previousTier = user.tier;
  const defaults = TIER_LICENSE_DEFAULTS[tier];
  const paidGrant = tier !== 'free';
  db.updateUserTier(user.id, tier, { adminOverride: true });
  db.updateLicenseOnPayment(user.id, {
    tier,
    status: 'active',
    expires_at: defaults.expires_at(),
    sessions_limit: defaults.sessions_limit,
    ...(paidGrant ? ENTERPRISE_EQUIVALENT_CREDITS : NO_CREDITS),
    // While the marker is set, NO automatic path can take this plan away —
    // not a provider webhook for an older subscription, not a refund or a
    // dispute on an old charge, not the cycle-end sweeper, not the lapsed-plan
    // repair in /license/validate. A later REAL purchase clears it (the paid
    // plan's lifecycle then governs) — see the checkout grant paths.
    admin_granted_at: paidGrant ? Date.now() : 0,
    admin_override: true,
  });
  return { ok: true, previousTier, paidGrant, license: db.getLicenseByUserId(user.id) };
}

module.exports = {
  DAY_MS,
  TIER_LICENSE_DEFAULTS,
  VALID_TIERS,
  PAID_TIERS,
  ENTERPRISE_EQUIVALENT_CREDITS,
  NO_CREDITS,
  applyAdminTierChange,
};
