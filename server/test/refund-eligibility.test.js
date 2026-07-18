// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Refund eligibility — pin REFUND_POLICY.md as enforceable code
//
//  Each test mirrors a row of the PUBLISHED policy table (effective
//  2026-07-07): every plan gets 14 days from the refunded payment
//  (Ultra: the first charge) + under 2 hours of total session time;
//  extension top-ups are never refundable. An earlier draft of the
//  service enforced 7-day / <60-min rules the published policy never
//  had — these tests exist so enforcement can never drift STRICTER
//  than the text users agreed to at purchase again. Future policy
//  revisions update the tests AND REFUND_POLICY.md in the same
//  commit (per the markdown's own "keep these in sync" comment).
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { describe, it, expect } from 'vitest';
import { computeRefundEligibility } from '../src/services/refundEligibility.js';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const now = Date.now();
const daysAgo = (n) => now - n * ONE_DAY_MS;

function makePayment(overrides = {}) {
  return {
    id: 1,
    user_id: 'u',
    email: 'u@test',
    provider: 'stripe',
    provider_payment_id: 'pi_test_1',
    amount: 5000,
    currency: 'USD',
    status: 'completed',
    tier_granted: 'pro',
    created_at: daysAgo(2),
    metadata: '{}',
    ...overrides,
  };
}

function makeLicense(overrides = {}) {
  return {
    user_id: 'u',
    tier: 'pro',
    status: 'active',
    sessions_used: 0,
    credits_remaining_seconds: -1,
    ...overrides,
  };
}

describe('computeRefundEligibility — Pro tier (14 days · <2 h, per published policy)', () => {
  it('eligible: 2 days old, 0 sessions used', () => {
    const r = computeRefundEligibility(makePayment(), makeLicense());
    expect(r.eligible).toBe(true);
  });

  it('eligible: 8 days old — INSIDE the published 14-day window (the old 7-day draft wrongly blocked this)', () => {
    const r = computeRefundEligibility(makePayment({ created_at: daysAgo(8) }), makeLicense());
    expect(r.eligible).toBe(true);
  });

  it('ineligible: 15 days old (window expired)', () => {
    const r = computeRefundEligibility(makePayment({ created_at: daysAgo(15) }), makeLicense());
    expect(r.eligible).toBe(false);
    expect(r.code).toBe('window_expired');
  });

  it('eligible: 90 min used — under the published 2-hour cap (the old 60-min draft wrongly blocked this)', () => {
    const r = computeRefundEligibility(
      makePayment(),
      makeLicense({ sessions_used: 2 }),
      { totalSessionSeconds: 90 * 60 }
    );
    expect(r.eligible).toBe(true);
  });

  it('ineligible: usageStats says 130 min used (over the 2-hour cap)', () => {
    const r = computeRefundEligibility(
      makePayment(),
      makeLicense(),
      { totalSessionSeconds: 130 * 60 }
    );
    expect(r.eligible).toBe(false);
    expect(r.code).toBe('usage_exceeded');
  });

  it('proxy fallback (no usageStats): 2 sessions do NOT block; 3 sessions block', () => {
    const two = computeRefundEligibility(makePayment(), makeLicense({ sessions_used: 2 }));
    expect(two.eligible).toBe(true);
    const three = computeRefundEligibility(makePayment(), makeLicense({ sessions_used: 3 }));
    expect(three.eligible).toBe(false);
    expect(three.code).toBe('usage_exceeded_proxy');
  });
});

describe('computeRefundEligibility — Max tier', () => {
  it('eligible: 1 day old, no usage', () => {
    const r = computeRefundEligibility(makePayment({ tier_granted: 'max', amount: 8900 }), makeLicense({ tier: 'max' }));
    expect(r.eligible).toBe(true);
  });

  it('eligible: one minute inside the 14-day boundary', () => {
    const r = computeRefundEligibility(
      makePayment({ tier_granted: 'max', amount: 8900, created_at: daysAgo(14) + 60 * 1000 }),
      makeLicense({ tier: 'max' })
    );
    expect(r.eligible).toBe(true);
  });

  it('ineligible: 15 days old', () => {
    const r = computeRefundEligibility(
      makePayment({ tier_granted: 'max', amount: 8900, created_at: daysAgo(15) }),
      makeLicense({ tier: 'max' })
    );
    expect(r.eligible).toBe(false);
    expect(r.code).toBe('window_expired');
  });
});

describe('computeRefundEligibility — Basic tier (same published rule as every plan)', () => {
  it('eligible: 5 days old, pass untouched', () => {
    const r = computeRefundEligibility(
      makePayment({ tier_granted: 'basic', amount: 3000 }),
      makeLicense({ tier: 'basic', credits_remaining_seconds: 30 * 60, sessions_used: 0 })
    );
    expect(r.eligible).toBe(true);
  });

  it('eligible: pass partially used but under 2 h — the published policy has no zero-usage rule for Basic', () => {
    const r = computeRefundEligibility(
      makePayment({ tier_granted: 'basic', amount: 3000 }),
      makeLicense({ tier: 'basic', sessions_used: 1, credits_remaining_seconds: 30 * 60 - 100 }),
      { totalSessionSeconds: 100 }
    );
    expect(r.eligible).toBe(true);
  });

  it('ineligible: 15 days old (window expired)', () => {
    const r = computeRefundEligibility(
      makePayment({ tier_granted: 'basic', amount: 3000, created_at: daysAgo(15) }),
      makeLicense({ tier: 'basic', credits_remaining_seconds: 30 * 60 })
    );
    expect(r.eligible).toBe(false);
    expect(r.code).toBe('window_expired');
  });

  it('ineligible: over 2 h of session time (heavy extension use)', () => {
    const r = computeRefundEligibility(
      makePayment({ tier_granted: 'basic', amount: 3000 }),
      makeLicense({ tier: 'basic', sessions_used: 2 }),
      { totalSessionSeconds: 125 * 60 }
    );
    expect(r.eligible).toBe(false);
    expect(r.code).toBe('usage_exceeded');
  });
});

describe('computeRefundEligibility — Ultra tier (monthly subscription)', () => {
  it('eligible: 2 days after first charge, 20 min used', () => {
    const r = computeRefundEligibility(
      makePayment({ tier_granted: 'ultra', amount: 15900 }),
      makeLicense({ tier: 'ultra', credits_remaining_seconds: -1, sessions_used: 0 }),
      { totalSessionSeconds: 20 * 60 }
    );
    expect(r.eligible).toBe(true);
  });

  it('eligible: 10 days after first charge — inside the published 14-day window', () => {
    const r = computeRefundEligibility(
      makePayment({ tier_granted: 'ultra', amount: 15900, created_at: daysAgo(10) }),
      makeLicense({ tier: 'ultra', credits_remaining_seconds: -1 }),
      { totalSessionSeconds: 45 * 60 }
    );
    expect(r.eligible).toBe(true);
  });

  it('ineligible: 16 days after first charge (window expired)', () => {
    const r = computeRefundEligibility(
      makePayment({ tier_granted: 'ultra', amount: 15900, created_at: daysAgo(16) }),
      makeLicense({ tier: 'ultra', credits_remaining_seconds: -1 })
    );
    expect(r.eligible).toBe(false);
    expect(r.code).toBe('window_expired');
  });

  it('ineligible: 3 h used', () => {
    const r = computeRefundEligibility(
      makePayment({ tier_granted: 'ultra', amount: 15900 }),
      makeLicense({ tier: 'ultra', credits_remaining_seconds: -1 }),
      { totalSessionSeconds: 180 * 60 }
    );
    expect(r.eligible).toBe(false);
    expect(r.code).toBe('usage_exceeded');
  });
});

describe('computeRefundEligibility — Extension top-ups (never refundable, policy §2)', () => {
  it('ineligible: renewal mode is never refundable', () => {
    const r = computeRefundEligibility(
      makePayment({ tier_granted: 'basic', amount: 2500, metadata: JSON.stringify({ mode: 'renewal' }) }),
      makeLicense({ tier: 'basic' })
    );
    expect(r.eligible).toBe(false);
    expect(r.code).toBe('renewal_nonrefundable');
  });

  it("extension mode (the one-click /extend-now spelling) is equally non-refundable", () => {
    const r = computeRefundEligibility(
      makePayment({ tier_granted: 'pro', amount: 4500, metadata: JSON.stringify({ mode: 'extension' }) }),
      makeLicense({ tier: 'pro' })
    );
    expect(r.eligible).toBe(false);
    expect(r.code).toBe('renewal_nonrefundable');
  });

  it('renewal block applies even within the 14-day window with zero usage', () => {
    const r = computeRefundEligibility(
      makePayment({ tier_granted: 'basic', metadata: JSON.stringify({ mode: 'renewal' }), created_at: daysAgo(1) }),
      makeLicense({ tier: 'basic', sessions_used: 0 })
    );
    expect(r.eligible).toBe(false);
    expect(r.code).toBe('renewal_nonrefundable');
  });
});

describe('computeRefundEligibility — guardrails', () => {
  it('ineligible: status not completed', () => {
    const r = computeRefundEligibility(makePayment({ status: 'pending' }), makeLicense());
    expect(r.eligible).toBe(false);
    expect(r.code).toBe('wrong_status');
  });

  it('ineligible: zero amount', () => {
    const r = computeRefundEligibility(makePayment({ amount: 0 }), makeLicense());
    expect(r.eligible).toBe(false);
    expect(r.code).toBe('zero_amount');
  });

  it('ineligible: comp payment', () => {
    const r = computeRefundEligibility(makePayment({ provider: 'admin-comp' }), makeLicense());
    expect(r.eligible).toBe(false);
    expect(r.code).toBe('comp_payment');
  });

  it('ineligible: unknown tier without override', () => {
    const r = computeRefundEligibility(makePayment({ tier_granted: 'enterprise' }), makeLicense({ tier: 'enterprise' }));
    expect(r.eligible).toBe(false);
    expect(r.code).toBe('unknown_tier');
  });

  it('handles malformed metadata (treats as non-renewal)', () => {
    const r = computeRefundEligibility(makePayment({ metadata: 'not json' }), makeLicense());
    expect(r.eligible).toBe(true);  // falls through normally
  });
});
