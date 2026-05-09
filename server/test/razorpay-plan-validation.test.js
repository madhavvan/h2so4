// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  assertRazorpayPlanMatches — plan validation
//
//  Mirrors payments-fallback.test.js for the Razorpay side. The single
//  most expensive misconfiguration here is a Razorpay plan that bills
//  the wrong cadence at the right amount — same INR per charge but
//  charged quarterly instead of monthly. P1-H from the audit.
//
//  This test pins the contract: any of {amount, currency, period,
//  interval} mismatches throws PLAN_MISMATCH and prevents the user
//  being routed to a misconfigured plan.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { describe, it, expect, beforeEach, vi } from 'vitest';

process.env.JWT_SECRET = 'test-secret';

const paymentsRouter = await import('../src/routes/payments.js');
const { assertRazorpayPlanMatches, EXPECTED_INR_PAISE, razorpayPlanCache, PRICE_VALIDATION_TTL_MS } = paymentsRouter.default._test;

function makeFakeRazorpay(planResponse) {
  return {
    plans: {
      fetch: vi.fn().mockResolvedValue(planResponse),
    },
  };
}

describe('EXPECTED_INR_PAISE canonical amounts', () => {
  it('Pro is ₹2499 (Razorpay paise)', () => {
    expect(EXPECTED_INR_PAISE.pro).toBe(249900);
  });
  it('Max is set and integer paise', () => {
    expect(EXPECTED_INR_PAISE.max).toBeGreaterThan(0);
    expect(Number.isInteger(EXPECTED_INR_PAISE.max)).toBe(true);
  });
});

describe('assertRazorpayPlanMatches', () => {
  beforeEach(() => {
    razorpayPlanCache.clear();
  });

  it('passes when plan matches exactly (monthly, INR, expected amount, interval=1)', async () => {
    const expected = EXPECTED_INR_PAISE.pro;
    const fakeRzp = makeFakeRazorpay({
      item: { amount: expected, currency: 'INR' },
      period: 'monthly',
      interval: 1,
    });
    await expect(assertRazorpayPlanMatches(fakeRzp, 'plan_test_pro', 'pro')).resolves.toBeUndefined();
  });

  it('throws PLAN_MISMATCH when amount is wrong', async () => {
    const fakeRzp = makeFakeRazorpay({
      item: { amount: 99900, currency: 'INR' },  // ₹999 instead of ₹2499
      period: 'monthly',
      interval: 1,
    });
    await expect(assertRazorpayPlanMatches(fakeRzp, 'plan_wrong_amount', 'pro'))
      .rejects.toMatchObject({ code: 'PLAN_MISMATCH', tier: 'pro' });
  });

  it('throws PLAN_MISMATCH when currency is not INR', async () => {
    const fakeRzp = makeFakeRazorpay({
      item: { amount: EXPECTED_INR_PAISE.pro, currency: 'USD' },
      period: 'monthly',
      interval: 1,
    });
    await expect(assertRazorpayPlanMatches(fakeRzp, 'plan_wrong_currency', 'pro'))
      .rejects.toMatchObject({ code: 'PLAN_MISMATCH' });
  });

  it('throws PLAN_MISMATCH when period is not monthly', async () => {
    const fakeRzp = makeFakeRazorpay({
      item: { amount: EXPECTED_INR_PAISE.pro, currency: 'INR' },
      period: 'yearly',
      interval: 1,
    });
    await expect(assertRazorpayPlanMatches(fakeRzp, 'plan_wrong_period', 'pro'))
      .rejects.toMatchObject({ code: 'PLAN_MISMATCH' });
  });

  it('throws PLAN_MISMATCH when interval !== 1 (e.g. quarterly billing) — P1-H', async () => {
    // This is the bug from the audit: a plan with period='monthly' and
    // interval=3 would bill every 3 months at the same INR amount,
    // silently quartering the customer's billing frequency.
    const fakeRzp = makeFakeRazorpay({
      item: { amount: EXPECTED_INR_PAISE.pro, currency: 'INR' },
      period: 'monthly',
      interval: 3,  // every 3 months — not what we want
    });
    const promise = assertRazorpayPlanMatches(fakeRzp, 'plan_quarterly_oopsie', 'pro');
    await expect(promise).rejects.toMatchObject({ code: 'PLAN_MISMATCH' });
    await expect(promise).rejects.toThrow(/interval/);
  });

  it('throws PLAN_MISMATCH when interval is missing', async () => {
    const fakeRzp = makeFakeRazorpay({
      item: { amount: EXPECTED_INR_PAISE.pro, currency: 'INR' },
      period: 'monthly',
      // interval intentionally omitted
    });
    await expect(assertRazorpayPlanMatches(fakeRzp, 'plan_no_interval', 'pro'))
      .rejects.toMatchObject({ code: 'PLAN_MISMATCH' });
  });

  it('caches plan validation per planId — second call within TTL skips fetch', async () => {
    const fakeRzp = makeFakeRazorpay({
      item: { amount: EXPECTED_INR_PAISE.pro, currency: 'INR' },
      period: 'monthly',
      interval: 1,
    });
    await assertRazorpayPlanMatches(fakeRzp, 'plan_cached', 'pro');
    expect(fakeRzp.plans.fetch).toHaveBeenCalledTimes(1);
    await assertRazorpayPlanMatches(fakeRzp, 'plan_cached', 'pro');
    expect(fakeRzp.plans.fetch).toHaveBeenCalledTimes(1);  // still 1
  });

  it('re-fetches after TTL expires', async () => {
    const fakeRzp = makeFakeRazorpay({
      item: { amount: EXPECTED_INR_PAISE.pro, currency: 'INR' },
      period: 'monthly',
      interval: 1,
    });
    await assertRazorpayPlanMatches(fakeRzp, 'plan_ttl', 'pro');
    // Manually expire the cache entry
    const entry = razorpayPlanCache.get('plan_ttl');
    entry.validated_at = Date.now() - PRICE_VALIDATION_TTL_MS - 1000;
    await assertRazorpayPlanMatches(fakeRzp, 'plan_ttl', 'pro');
    expect(fakeRzp.plans.fetch).toHaveBeenCalledTimes(2);
  });

  it('no-op when tier has no expected amount (e.g. legacy free)', async () => {
    const fakeRzp = makeFakeRazorpay({});
    await expect(assertRazorpayPlanMatches(fakeRzp, 'plan_irrelevant', 'free'))
      .resolves.toBeUndefined();
    expect(fakeRzp.plans.fetch).not.toHaveBeenCalled();
  });

  it('error.actual carries the cached entry for diagnostics', async () => {
    const fakeRzp = makeFakeRazorpay({
      item: { amount: 999, currency: 'EUR' },
      period: 'weekly',
      interval: 7,
    });
    try {
      await assertRazorpayPlanMatches(fakeRzp, 'plan_all_wrong', 'pro');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err.code).toBe('PLAN_MISMATCH');
      expect(err.actual).toMatchObject({
        amount: 999,
        currency: 'EUR',
        period: 'weekly',
        interval: 7,
      });
      expect(err.expected).toBe(EXPECTED_INR_PAISE.pro);
    }
  });
});
