// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  SUBSCRIPTION STATE MACHINE — license.status canonical values
//
//  Centralizes every license status the system uses so:
//    1. Writers can validate before persisting (typo'd 'cancling'
//       was the kind of bug that historically hid for weeks).
//    2. Readers (client + server gates) have a single source of
//       documented truth instead of grep-archaeology.
//    3. Enterprise auditors can review the state machine at a glance.
//
//  ┌────────────────────────────────────────────────────────────┐
//  │  LICENSE STATE MACHINE (textual diagram)                   │
//  ├────────────────────────────────────────────────────────────┤
//  │                                                            │
//  │   signup (free) ──→ trial                                  │
//  │                       │ (the user pays — webhook lands)    │
//  │                       ↓                                    │
//  │                    active ←─────────┐                      │
//  │                       │             │ (retry succeeds)     │
//  │       ┌───────────────┼───────────┐ │                      │
//  │       ↓               ↓           ↓ │                      │
//  │  user cancels   payment fails  paused                      │
//  │       ↓               ↓           ↓                        │
//  │   canceling      past_due    (resume webhook)              │
//  │       ↓               │           ↓                        │
//  │    cycle ends    retry exhausted active                    │
//  │       ↓               ↓                                    │
//  │    expired        expired                                  │
//  │                                                            │
//  │   active ──(refund processed)──→ refunded                  │
//  │   active ──(Stripe dispute filed)──→ disputed              │
//  │     disputed ──(won)──→ active                             │
//  │     disputed ──(lost)──→ refunded                          │
//  │   active ──(12-cycle Razorpay natural end)──→ expired      │
//  │   any state ──(admin revoke)──→ revoked                    │
//  │                                                            │
//  │  IMPORTANT: 'trial' has NO automatic transition. The 30-day│
//  │  expires_at on free signups is bookkeeping for the         │
//  │  ui banner; functional access is gated by tier=='free' (→  │
//  │  the 10-min trial bucket) and never by trial-status-       │
//  │  expiry. After 30 days, status STAYS 'trial' until the     │
//  │  user pays (→ active) or an admin changes it. Region-gated │
//  │  users (IN) are blocked at the AI router regardless — see  │
//  │  middleware/regionGate.js.                                 │
//  │                                                            │
//  └────────────────────────────────────────────────────────────┘
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// Every legal license.status value. Writers should validate against this
// set before persisting; readers can switch/case exhaustively.
const LICENSE_STATUSES = Object.freeze({
  // INITIAL / NORMAL ──────────────────────────────────────────
  TRIAL:     'trial',     // Default for free signups; 30-day expiry; tier='free'
  ACTIVE:    'active',    // Paid + nominal; tier ∈ {basic, pro, max}; valid through expires_at

  // INTERIM ───────────────────────────────────────────────────
  CANCELING: 'canceling', // User clicked Cancel; access continues until expires_at
                          // (cycle_end). On webhook subscription.cancelled →
                          // status='expired'. Reactivation (Stripe only)
                          // returns to 'active'.
  PAST_DUE:  'past_due',  // Payment failed once; provider auto-retrying.
                          // On retry success → 'active'. On retry exhaustion →
                          // 'expired' (via subscription.halted webhook).

  // TERMINAL / DENY ───────────────────────────────────────────
  EXPIRED:   'expired',   // Sub ended cleanly (cancelled cycle-end / halted /
                          // 12-cycle complete). tier reset to 'free'.
  REFUNDED:  'refunded',  // Full refund processed. tier reset to 'free'.
                          // Distinct from 'expired' for accounting / churn analysis.
  PAUSED:    'paused',    // Razorpay-only: merchant or user paused billing.
                          // No access during pause; subscription.resumed → 'active'.
  REVOKED:   'revoked',   // Admin-manual revoke (e.g. policy violation).
                          // Tier reset to 'free'; user can resubscribe but
                          // history is flagged.
  DISPUTED:  'disputed',  // Stripe-only chargeback dispute open. Access continues
                          // until dispute closes ('won' → 'active', 'lost' → 'refunded').
                          // Currently set by /webhooks/stripe charge.dispute.created;
                          // reconciled by charge.dispute.closed.
});

const ALL_STATUSES = new Set(Object.values(LICENSE_STATUSES));

// Statuses where the user retains access to AI features. Read by tier
// gate, region gate, and client license validity check. This is the
// "user can use the app" predicate — not "user is paying" (e.g.
// canceling users still have access through cycle end).
const ACCESS_STATUSES = Object.freeze(new Set([
  LICENSE_STATUSES.ACTIVE,
  LICENSE_STATUSES.CANCELING,
  LICENSE_STATUSES.PAST_DUE,
]));

// Statuses that mean "the subscription is over for accounting / display
// purposes" — distinct from 'access denied' (which is the inverse of
// ACCESS_STATUSES). A canceling user is "ending" but still has access.
const TERMINAL_STATUSES = Object.freeze(new Set([
  LICENSE_STATUSES.EXPIRED,
  LICENSE_STATUSES.REFUNDED,
  LICENSE_STATUSES.REVOKED,
]));

function isValidStatus(status) {
  return typeof status === 'string' && ALL_STATUSES.has(status);
}

function hasAccess(status) {
  return typeof status === 'string' && ACCESS_STATUSES.has(status);
}

function isTerminal(status) {
  return typeof status === 'string' && TERMINAL_STATUSES.has(status);
}

// ── Paid-plan lapse predicate ──
// The canonical "has this PAID plan ended?" check: a non-access status
// (expired / refunded / revoked / paused / disputed) OR a passed
// expires_at (-1 sentinel = never expires, 0 = no expiry recorded).
// These are the SAME two checks middleware/tier.js applies to paid tiers;
// factored here so gates without a requireTier (the gemini model routes,
// /usage/start) can deny a lapsed plan identically instead of each
// growing its own drifting copy. Free rows are exempt by design — their
// status sits at 'trial' forever (see the state-machine diagram above)
// and their real wall is the one-time trial bucket.
//
// Lapse is deliberately DISTINCT from time exhaustion: a Basic/Pro/Max
// whose credit seconds hit 0 inside a valid window is NOT lapsed — they
// keep their tier (client mirrors this in licenseService.isPlanLapsed)
// and get 402 "top up" from the time gate, never 403 "renew".
function isPlanLapsed(license) {
  if (!license) return false;
  if (!['basic', 'pro', 'max', 'ultra'].includes(license.tier)) return false;
  if (!hasAccess(license.status)) return true;
  if (license.expires_at > 0 && Date.now() > license.expires_at) return true;
  return false;
}

// Throws when a writer would persist an unknown status. Use at the top
// of update functions so a typo at a call site is caught at write time
// (loud) rather than silently corrupting the row (hidden until a reader
// trips over it days later).
function assertValidStatus(status) {
  if (!isValidStatus(status)) {
    const err = new Error(
      `Invalid license.status="${status}". Valid: ${[...ALL_STATUSES].join(', ')}`
    );
    err.code = 'INVALID_LICENSE_STATUS';
    throw err;
  }
}

module.exports = {
  LICENSE_STATUSES,
  ALL_STATUSES,
  ACCESS_STATUSES,
  TERMINAL_STATUSES,
  isValidStatus,
  hasAccess,
  isTerminal,
  isPlanLapsed,
  assertValidStatus,
};
