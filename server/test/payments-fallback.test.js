// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  resolveStripeLineItem fallback path
//
//  The single most expensive bug class: charging the wrong amount.
//  This function tries env-driven Price IDs first, validates them
//  against EXPECTED_USD_CENTS, and falls through to inline price_data
//  on any failure. We pin the contract: when validation succeeds, the
//  env Price is used; when it fails (mismatch, missing), price_data
//  is returned with the canonical amount. Customer is always charged
//  the right cents.
//
//  2026-07 pricing: Basic $30 / Pro $50 / Max $89 are ONE-TIME (no
//  recurring); Ultra $159 is the only monthly subscription.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Need a JWT secret before payments.js loads (it imports auth.js transitively)
process.env.JWT_SECRET = 'test-secret';

const paymentsRouter = await import('../src/routes/payments.js');
const { STRIPE_PRICE_DATA, resolveStripeLineItem, EXPECTED_USD_CENTS } = paymentsRouter.default._test;

describe('Stripe price data canonical amounts', () => {
  it('Basic is $30.00', () => {
    expect(STRIPE_PRICE_DATA.basic.unit_amount).toBe(3000);
  });
  it('Pro is $50.00', () => {
    expect(STRIPE_PRICE_DATA.pro.unit_amount).toBe(5000);
  });
  it('Max is $89.00', () => {
    expect(STRIPE_PRICE_DATA.max.unit_amount).toBe(8900);
  });
  it('Ultra is $159.00/month recurring', () => {
    expect(STRIPE_PRICE_DATA.ultra.unit_amount).toBe(15900);
    expect(STRIPE_PRICE_DATA.ultra.recurring).toMatchObject({ interval: 'month' });
  });
  it('Basic/Pro/Max are one-time (no recurring)', () => {
    expect(STRIPE_PRICE_DATA.basic.recurring).toBeUndefined();
    expect(STRIPE_PRICE_DATA.pro.recurring).toBeUndefined();
    expect(STRIPE_PRICE_DATA.max.recurring).toBeUndefined();
  });
  it('EXPECTED_USD_CENTS matches STRIPE_PRICE_DATA', () => {
    expect(EXPECTED_USD_CENTS.basic).toBe(STRIPE_PRICE_DATA.basic.unit_amount);
    expect(EXPECTED_USD_CENTS.pro).toBe(STRIPE_PRICE_DATA.pro.unit_amount);
    expect(EXPECTED_USD_CENTS.max).toBe(STRIPE_PRICE_DATA.max.unit_amount);
    expect(EXPECTED_USD_CENTS.ultra).toBe(STRIPE_PRICE_DATA.ultra.unit_amount);
  });
});

describe('resolveStripeLineItem', () => {
  beforeEach(() => {
    delete process.env.STRIPE_PRICE_BASIC_USD;
    delete process.env.STRIPE_PRICE_PRO_USD;
    delete process.env.STRIPE_PRICE_MAX_USD;
    delete process.env.STRIPE_PRICE_USD;
  });

  it('falls back to inline price_data when no env vars set', async () => {
    const fakeStripe = { prices: { retrieve: vi.fn() } };
    const result = await resolveStripeLineItem(fakeStripe, 'pro');
    expect(result.price_data).toBeDefined();
    expect(result.price_data.unit_amount).toBe(5000);
    expect(fakeStripe.prices.retrieve).not.toHaveBeenCalled();
  });

  it('uses env Price ID when validation passes (Pro = $50 one-time)', async () => {
    process.env.STRIPE_PRICE_PRO_USD = 'price_valid_pro';
    const fakeStripe = {
      prices: {
        retrieve: vi.fn().mockResolvedValue({
          id: 'price_valid_pro',
          unit_amount: 5000,
          currency: 'usd',
          // one-time — no `recurring` under 2026-07 pricing
          active: true,
        }),
      },
    };
    const result = await resolveStripeLineItem(fakeStripe, 'pro');
    expect(result.price).toBe('price_valid_pro');
    expect(result.price_data).toBeUndefined();
  });

  it('falls back to price_data when env Price has WRONG amount (legacy $29 SKU)', async () => {
    process.env.STRIPE_PRICE_PRO_USD = 'price_legacy_29';
    const fakeStripe = {
      prices: {
        retrieve: vi.fn().mockResolvedValue({
          id: 'price_legacy_29',
          unit_amount: 2900,  // wrong! customer would pay the OLD $29 instead of $50
          currency: 'usd',
          active: true,
        }),
      },
    };
    const result = await resolveStripeLineItem(fakeStripe, 'pro');
    // Critical: customer gets charged the CORRECT amount via fallback
    expect(result.price).toBeUndefined();
    expect(result.price_data.unit_amount).toBe(5000);
  });

  it('falls back to price_data when env Price is wrong MODE (recurring Pro)', async () => {
    // Pro is one-time now; a leftover monthly-recurring Pro price from the
    // old subscription model must be rejected even at the right dollar amount.
    process.env.STRIPE_PRICE_PRO_USD = 'price_recurring_pro';
    const fakeStripe = {
      prices: {
        retrieve: vi.fn().mockResolvedValue({
          id: 'price_recurring_pro',
          unit_amount: 5000,
          currency: 'usd',
          recurring: { interval: 'month' }, // wrong mode — Pro is one-time
          active: true,
        }),
      },
    };
    const result = await resolveStripeLineItem(fakeStripe, 'pro');
    expect(result.price).toBeUndefined();
    expect(result.price_data.unit_amount).toBe(5000);
    expect(result.price_data.recurring).toBeUndefined();
  });

  it('legacy STRIPE_PRICE_USD only applies to Pro tier', async () => {
    process.env.STRIPE_PRICE_USD = 'price_legacy';
    const fakeStripe = {
      prices: {
        retrieve: vi.fn().mockResolvedValue({
          id: 'price_legacy',
          unit_amount: 5000,
          currency: 'usd',
          // one-time Pro price
          active: true,
        }),
      },
    };
    const proResult = await resolveStripeLineItem(fakeStripe, 'pro');
    expect(proResult.price).toBe('price_legacy'); // legacy fallback used
    const basicResult = await resolveStripeLineItem(fakeStripe, 'basic');
    expect(basicResult.price_data).toBeDefined(); // legacy NOT used for Basic
    expect(basicResult.price_data.unit_amount).toBe(3000);
  });

  it('throws if asked for an unknown tier', async () => {
    const fakeStripe = { prices: { retrieve: vi.fn() } };
    await expect(resolveStripeLineItem(fakeStripe, 'unknown')).rejects.toThrow(/no price_data/i);
  });
});
