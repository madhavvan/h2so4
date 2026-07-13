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
//  Policy (2026-07 pricing):
//    Basic ($30 / ₹2,499 · one 30-min interview):
//      • 14 days from purchase
//      • Zero of the interview credit used
//    Pro ($50 / ₹4,199 · one 1-hour interview):
//      • 7 days from purchase
//      • < 60 min total session time
//    Max ($89 / ₹7,399 · three 1-hour interviews):
//      • 7 days from purchase
//      • < 60 min total session time
//    Ultra ($159/mo / ₹12,999/mo · unlimited subscription):
//      • 7 days from first charge
//      • < 60 min total session time
//    +30 min extension ($25 / ₹2,099):
//      • NEVER refundable once delivered
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const SIXTY_MIN_SECONDS = 60 * 60;

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

  // Renewal top-ups: never refundable once captured (per policy §2).
  let isRenewal = false;
  try {
    const meta = typeof payment.metadata === 'string' ? JSON.parse(payment.metadata) : payment.metadata;
    isRenewal = meta?.mode === 'renewal';
  } catch (_) { /* malformed metadata → treat as non-renewal */ }
  if (isRenewal) {
    return { eligible: false, code: 'renewal_nonrefundable', reason: 'Renewal credits are not refundable once delivered.' };
  }

  const tier = payment.tier_granted || license?.tier || 'unknown';

  // Basic: 14-day window + zero credit usage
  if (tier === 'basic') {
    if (ageMs > 14 * ONE_DAY_MS) {
      return { eligible: false, code: 'window_expired', reason: `Basic refund window is 14 days; this payment is ${Math.round(ageMs / ONE_DAY_MS)} days old.` };
    }
    // Initial Basic grant = one 30-min interview = 1800 s (2026-07). If
    // credits_remaining_seconds is less than that (or sessions_used > 0),
    // they have used some. MUST match grantConfigForTier('basic') in
    // payments.js / webhooks.js — a stale value here silently blocks
    // legitimate refunds (this was 3*3600 from the pre-2026-07 3-credit model).
    const initialSeconds = 30 * 60;
    const remaining = license?.credits_remaining_seconds;
    const sessionsUsed = (usageStats && Number.isFinite(usageStats.sessionsUsed))
      ? usageStats.sessionsUsed
      : (license?.sessions_used || 0);
    if (sessionsUsed > 0) {
      return { eligible: false, code: 'usage_exceeded', reason: `Basic refund requires zero credits used; user has used ${sessionsUsed} session(s).` };
    }
    if (Number.isFinite(remaining) && remaining < initialSeconds) {
      return { eligible: false, code: 'usage_exceeded', reason: `Basic refund requires zero credits used; user has consumed ${initialSeconds - remaining} seconds.` };
    }
    return { eligible: true, reason: 'Within 14-day window with zero usage.' };
  }

  // Pro / Max / Ultra: 7-day window + < 60 min total session time.
  // (Pro/Max are one-time interviews; Ultra is the monthly subscription —
  // same satisfaction window and usage cap apply.)
  if (tier === 'pro' || tier === 'max' || tier === 'ultra') {
    if (ageMs > 7 * ONE_DAY_MS) {
      return { eligible: false, code: 'window_expired', reason: `${tier} refund window is 7 days from first charge; this payment is ${Math.round(ageMs / ONE_DAY_MS)} days old.` };
    }
    // Use precise session-time stats if we have them; fall back to the
    // license sessions_used counter as a coarse proxy (each session is
    // capped at typical interview length, ~45-60 min, so 1 session
    // approximately equals the threshold — be conservative).
    if (usageStats && Number.isFinite(usageStats.totalSessionSeconds)) {
      if (usageStats.totalSessionSeconds >= SIXTY_MIN_SECONDS) {
        const mins = Math.round(usageStats.totalSessionSeconds / 60);
        return { eligible: false, code: 'usage_exceeded', reason: `${tier} refund requires <60 min total session time; user has used ${mins} min.` };
      }
    } else {
      // Coarse fallback: more than 1 completed session is a strong signal
      // they've used >60 min. We don't reject on 1 session — it could be
      // any length. Caller should pass usageStats whenever available.
      const sessionsUsed = license?.sessions_used || 0;
      if (sessionsUsed > 1) {
        return { eligible: false, code: 'usage_exceeded_proxy', reason: `${tier} refund requires <60 min total session time; user has run ${sessionsUsed} sessions (precise minute counter unavailable, blocking by proxy).` };
      }
    }
    return { eligible: true, reason: `Within 7-day window with <60 min usage (${tier}).` };
  }

  // Unknown tier — refuse by default. Operator can use override_reason
  // for legacy / migrated rows whose tier_granted didn't normalize.
  return { eligible: false, code: 'unknown_tier', reason: `Unknown tier=${tier}; cannot evaluate eligibility automatically.` };
}

module.exports = { computeRefundEligibility };
