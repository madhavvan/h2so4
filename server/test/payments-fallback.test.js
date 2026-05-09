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
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Need a JWT secret before payments.js loads (it imports auth.js transitively)
process.env.JWT_SECRET = 'test-secret';

const paymentsRouter = await import('../src/routes/payments.js');
const { STRIPE_PRICE_DATA, resolveStripeLineItem, EXPECTED_USD_CENTS } = paymentsRouter.default._test;

describe('Stripe price data canonical amounts', () => {
  it('Basic is $25.00', () => {
    expect(STRIPE_PRICE_DATA.basic.unit_amount).toBe(2500);
  });
  it('Pro is $29.00', () => {
    expect(STRIPE_PRICE_DATA.pro.unit_amount).toBe(2900);
  });
  it('Max is $69.00', () => {
    expect(STRIPE_PRICE_DATA.max.unit_amount).toBe(6900);
  });
  it('EXPECTED_USD_CENTS matches STRIPE_PRICE_DATA', () => {
    expect(EXPECTED_USD_CENTS.basic).toBe(STRIPE_PRICE_DATA.basic.unit_amount);
    expect(EXPECTED_USD_CENTS.pro).toBe(STRIPE_PRICE_DATA.pro.unit_amount);
    expect(EXPECTED_USD_CENTS.max).toBe(STRIPE_PRICE_DATA.max.unit_amount);
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
    expect(result.price_data.unit_amount).toBe(2900);
    expect(fakeStripe.prices.retrieve).not.toHaveBeenCalled();
  });

  it('uses env Price ID when validation passes', async () => {
    process.env.STRIPE_PRICE_PRO_USD = 'price_valid_pro';
    const fakeStripe = {
      prices: {
        retrieve: vi.fn().mockResolvedValue({
          id: 'price_valid_pro',
          unit_amount: 2900,
          currency: 'usd',
          recurring: { interval: 'month' },
          active: true,
        }),
      },
    };
    const result = await resolveStripeLineItem(fakeStripe, 'pro');
    expect(result.price).toBe('price_valid_pro');
    expect(result.price_data).toBeUndefined();
  });

  it('falls back to price_data when env Price has WRONG amount (legacy $50 SKU)', async () => {
    process.env.STRIPE_PRICE_PRO_USD = 'price_legacy_50';
    const fakeStripe = {
      prices: {
        retrieve: vi.fn().mockResolvedValue({
          id: 'price_legacy_50',
          unit_amount: 5000,  // wrong! customer would pay $50 instead of $29
          currency: 'usd',
          recurring: { interval: 'month' },
          active: true,
        }),
      },
    };
    const result = await resolveStripeLineItem(fakeStripe, 'pro');
    // Critical: customer gets charged the CORRECT amount via fallback
    expect(result.price).toBeUndefined();
    expect(result.price_data.unit_amount).toBe(2900);
  });

  it('legacy STRIPE_PRICE_USD only applies to Pro tier', async () => {
    process.env.STRIPE_PRICE_USD = 'price_legacy';
    const fakeStripe = {
      prices: {
        retrieve: vi.fn().mockResolvedValue({
          id: 'price_legacy',
          unit_amount: 2900,
          currency: 'usd',
          recurring: { interval: 'month' },
          active: true,
        }),
      },
    };
    const proResult = await resolveStripeLineItem(fakeStripe, 'pro');
    expect(proResult.price).toBe('price_legacy'); // legacy fallback used
    const basicResult = await resolveStripeLineItem(fakeStripe, 'basic');
    expect(basicResult.price_data).toBeDefined(); // legacy NOT used for Basic
    expect(basicResult.price_data.unit_amount).toBe(2500);
  });

  it('throws if asked for an unknown tier', async () => {
    const fakeStripe = { prices: { retrieve: vi.fn() } };
    await expect(resolveStripeLineItem(fakeStripe, 'unknown')).rejects.toThrow(/no price_data/i);
  });
});
