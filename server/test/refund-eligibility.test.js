// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Refund eligibility — pin REFUND_POLICY.md as enforceable code
//
//  Each test mirrors a row of the policy table. Future policy
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
    amount: 2900,
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

describe('computeRefundEligibility — Pro tier', () => {
  it('eligible: 2 days old, 0 sessions used', () => {
    const r = computeRefundEligibility(makePayment(), makeLicense());
    expect(r.eligible).toBe(true);
  });

  it('ineligible: 8 days old (window expired)', () => {
    const r = computeRefundEligibility(makePayment({ created_at: daysAgo(8) }), makeLicense());
    expect(r.eligible).toBe(false);
    expect(r.code).toBe('window_expired');
  });

  it('ineligible: 2 sessions used (proxy for >60 min)', () => {
    const r = computeRefundEligibility(makePayment(), makeLicense({ sessions_used: 2 }));
    expect(r.eligible).toBe(false);
    expect(r.code).toBe('usage_exceeded_proxy');
  });

  it('ineligible: usageStats says 70 min used', () => {
    const r = computeRefundEligibility(
      makePayment(),
      makeLicense(),
      { totalSessionSeconds: 70 * 60 }
    );
    expect(r.eligible).toBe(false);
    expect(r.code).toBe('usage_exceeded');
  });

  it('eligible: usageStats says 30 min used (within threshold)', () => {
    const r = computeRefundEligibility(
      makePayment(),
      makeLicense({ sessions_used: 1 }),
      { totalSessionSeconds: 30 * 60 }
    );
    expect(r.eligible).toBe(true);
  });
});

describe('computeRefundEligibility — Max tier', () => {
  it('eligible: 1 day old, no usage', () => {
    const r = computeRefundEligibility(makePayment({ tier_granted: 'max', amount: 6900 }), makeLicense({ tier: 'max' }));
    expect(r.eligible).toBe(true);
  });

  it('ineligible: 14 days old', () => {
    const r = computeRefundEligibility(
      makePayment({ tier_granted: 'max', amount: 6900, created_at: daysAgo(14) }),
      makeLicense({ tier: 'max' })
    );
    expect(r.eligible).toBe(false);
    expect(r.code).toBe('window_expired');
  });
});

describe('computeRefundEligibility — Basic tier', () => {
  it('eligible: 5 days old, zero credits used', () => {
    const r = computeRefundEligibility(
      makePayment({ tier_granted: 'basic', amount: 2500 }),
      makeLicense({ tier: 'basic', credits_remaining_seconds: 30 * 60, sessions_used: 0 })
    );
    expect(r.eligible).toBe(true);
  });

  it('ineligible: 15 days old (window expired)', () => {
    const r = computeRefundEligibility(
      makePayment({ tier_granted: 'basic', amount: 2500, created_at: daysAgo(15) }),
      makeLicense({ tier: 'basic', credits_remaining_seconds: 3 * 3600 })
    );
    expect(r.eligible).toBe(false);
    expect(r.code).toBe('window_expired');
  });

  it('ineligible: 1 session used', () => {
    const r = computeRefundEligibility(
      makePayment({ tier_granted: 'basic', amount: 2500 }),
      makeLicense({ tier: 'basic', sessions_used: 1 })
    );
    expect(r.eligible).toBe(false);
    expect(r.code).toBe('usage_exceeded');
  });

  it('ineligible: credits remaining < initial 30 min (silent usage)', () => {
    const r = computeRefundEligibility(
      makePayment({ tier_granted: 'basic', amount: 2500 }),
      makeLicense({ tier: 'basic', sessions_used: 0, credits_remaining_seconds: 30 * 60 - 100 })
    );
    expect(r.eligible).toBe(false);
    expect(r.code).toBe('usage_exceeded');
  });
});

describe('computeRefundEligibility — Ultra tier (monthly subscription)', () => {
  it('eligible: 2 days old, <60 min usage', () => {
    const r = computeRefundEligibility(
      makePayment({ tier_granted: 'ultra', amount: 15900 }),
      makeLicense({ tier: 'ultra', credits_remaining_seconds: -1, sessions_used: 0 }),
      { totalSessionSeconds: 20 * 60 }
    );
    expect(r.eligible).toBe(true);
  });

  it('ineligible: 8 days old (window expired)', () => {
    const r = computeRefundEligibility(
      makePayment({ tier_granted: 'ultra', amount: 15900, created_at: daysAgo(8) }),
      makeLicense({ tier: 'ultra', credits_remaining_seconds: -1 })
    );
    expect(r.eligible).toBe(false);
    expect(r.code).toBe('window_expired');
  });

  it('ineligible: 70 min used', () => {
    const r = computeRefundEligibility(
      makePayment({ tier_granted: 'ultra', amount: 15900 }),
      makeLicense({ tier: 'ultra', credits_remaining_seconds: -1 }),
      { totalSessionSeconds: 70 * 60 }
    );
    expect(r.eligible).toBe(false);
    expect(r.code).toBe('usage_exceeded');
  });
});

describe('computeRefundEligibility — Renewal top-up', () => {
  it('ineligible: renewal mode is never refundable', () => {
    const r = computeRefundEligibility(
      makePayment({ tier_granted: 'basic', amount: 699, metadata: JSON.stringify({ mode: 'renewal' }) }),
      makeLicense({ tier: 'basic' })
    );
    expect(r.eligible).toBe(false);
    expect(r.code).toBe('renewal_nonrefundable');
  });

  it('renewal block applies even within 14-day window', () => {
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
