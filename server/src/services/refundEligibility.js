// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Refund eligibility — server-enforced version of REFUND_POLICY.md
//
//  Until now, the policy was text in REFUND_POLICY.md and the admin
//  refund endpoint trusted operators to honor it manually. That's
//  fine while the only operators are the founder, but it's a
//  compliance gap once the team grows AND a financial blast radius
//  if an admin token is compromised — a leaked admin JWT could
//  refund 100% of revenue.
//
//  This module implements the policy as enforceable code. The admin
//  refund endpoint calls computeRefundEligibility(payment, license)
//  before issuing the refund. Ineligible refunds are blocked unless
//  the admin supplies an explicit override_reason that's logged in
//  the audit trail. That keeps legitimate exceptions (support
//  goodwill, retention saves) possible while preventing accidents.
//
//  ⚠️ THE PUBLISHED POLICY GOVERNS. REFUND_POLICY.md (mirrored verbatim
//  in RefundPolicy.tsx and promised on the landing FAQ) is what users
//  agree to at purchase — enforcement here must never be STRICTER than
//  that text, or support ends up blocked from honoring the company's
//  own published terms (an earlier draft of this file enforced
//  7-day / <60-min rules the published policy never had).
//
//  Published policy (REFUND_POLICY.md, effective 2026-07-07):
//    Basic ($30 / ₹2,499 · one 30-min interview):
//      • 14 days from purchase · < 2 hours total session time
//    Pro ($50 / ₹4,199 · one 1-hour interview):
//      • 14 days from purchase · < 2 hours total session time
//    Max ($89 / ₹7,399 · three 1-hour interviews):
//      • 14 days from purchase · < 2 hours total session time
//    Ultra ($159/mo / ₹12,999/mo · unlimited subscription):
//      • 14 days from the FIRST charge · < 2 hours total session time
//      (the admin refunds the first-charge payment row, so the window
//       keys off that payment's created_at)
//    Extension top-ups ($25–$80 / ₹2,099–₹6,799):
//      • NEVER refundable once delivered
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const REFUND_WINDOW_DAYS = 14;
const USAGE_CAP_SECONDS = 2 * 60 * 60; // "< 2 hours of total session time"

// Returns:
//   { eligible: true, reason: <human-readable> }
//   { eligible: false, reason: <human-readable>, code: <machine-token> }
//
// payment: row from `payments` table (has tier_granted, amount, created_at, metadata)
// license: row from `licenses` table for the same user (has sessions_used, credits_remaining_seconds)
// usageStats: optional { totalSessionSeconds, sessionsUsed } pulled from session logs.
//             If absent, we use the license counters as a best-effort proxy.
function computeRefundEligibility(payment, license, usageStats) {
  if (!payment) {
    return { eligible: false, code: 'no_payment', reason: 'No payment row.' };
  }
  if (payment.status !== 'completed') {
    return { eligible: false, code: 'wrong_status', reason: `Cannot refund payment in status=${payment.status}.` };
  }
  if (payment.amount <= 0) {
    return { eligible: false, code: 'zero_amount', reason: 'Cannot refund a zero-amount payment.' };
  }
  if (payment.provider === 'admin-comp') {
    return { eligible: false, code: 'comp_payment', reason: 'Comp payments are not refundable.' };
  }

  const ageMs = Date.now() - (payment.created_at || 0);

  // Top-ups: never refundable once captured (per policy §2). Two metadata
  // spellings exist for the same product — 'renewal' (legacy /create-renewal
  // + all webhook-granted top-ups) and 'extension' (the one-click
  // /extend-now direct grant). Both must match or /extend-now purchases
  // slip into the ordinary per-tier refund windows.
  let isRenewal = false;
  try {
    const meta = typeof payment.metadata === 'string' ? JSON.parse(payment.metadata) : payment.metadata;
    isRenewal = meta?.mode === 'renewal' || meta?.mode === 'extension';
  } catch (_) { /* malformed metadata → treat as non-renewal */ }
  if (isRenewal) {
    return { eligible: false, code: 'renewal_nonrefundable', reason: 'Time top-ups are not refundable once delivered.' };
  }

  const tier = payment.tier_granted || license?.tier || 'unknown';

  // Every plan — Basic/Pro/Max one-time passes and the Ultra subscription —
  // shares the SAME published terms: 14 days from the payment being
  // refunded (Ultra: the first charge) + under 2 hours of total session
  // time. One rule, straight from the REFUND_POLICY.md table.
  if (tier === 'basic' || tier === 'pro' || tier === 'max' || tier === 'ultra') {
    if (ageMs > REFUND_WINDOW_DAYS * ONE_DAY_MS) {
      return { eligible: false, code: 'window_expired', reason: `The ${tier} refund window is ${REFUND_WINDOW_DAYS} days (published policy §1); this payment is ${Math.round(ageMs / ONE_DAY_MS)} days old.` };
    }
    // Use precise session-time stats when the caller has them (the admin
    // endpoint passes the usage_sessions lifetime total — the same
    // immutable log the published policy §1 says eligibility is
    // determined by). Fall back to the license sessions counter as a
    // coarse proxy only when stats are unavailable.
    if (usageStats && Number.isFinite(usageStats.totalSessionSeconds)) {
      if (usageStats.totalSessionSeconds >= USAGE_CAP_SECONDS) {
        const mins = Math.round(usageStats.totalSessionSeconds / 60);
        return { eligible: false, code: 'usage_exceeded', reason: `The published policy requires under 2 hours of total session time; user has used ${mins} min.` };
      }
    } else {
      // Coarse fallback: 3+ completed sessions strongly implies ≥2 h of
      // use on any plan (sessions run 30–60 min). 1–2 sessions could sum
      // to well under the cap, so we don't block on those — the caller
      // should pass usageStats whenever available for the precise answer.
      const sessionsUsed = (usageStats && Number.isFinite(usageStats.sessionsUsed))
        ? usageStats.sessionsUsed
        : (license?.sessions_used || 0);
      if (sessionsUsed > 2) {
        return { eligible: false, code: 'usage_exceeded_proxy', reason: `The published policy requires under 2 hours of total session time; user has run ${sessionsUsed} sessions (precise minute counter unavailable, blocking by proxy).` };
      }
    }
    return { eligible: true, reason: `Within the ${REFUND_WINDOW_DAYS}-day window with under 2 hours of use (${tier}).` };
  }

  // Unknown tier — refuse by default. Operator can use override_reason
  // for legacy / migrated rows whose tier_granted didn't normalize.
  return { eligible: false, code: 'unknown_tier', reason: `Unknown tier=${tier}; cannot evaluate eligibility automatically.` };
}

module.exports = { computeRefundEligibility };
