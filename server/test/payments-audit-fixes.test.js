// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  PAYMENTS AUDIT FIXES (2026-07-24) — pins the E2E audit remediation
//
//  Each describe block below corresponds to a defect found reading the
//  payment path end-to-end. They are pinned here because every one of
//  them is silent in production: nothing throws, the money moves, and the
//  entitlement is simply wrong.
//
//   1. Grant-before-payment. checkout.session.completed granted without
//      checking payment_status, so any delayed-notification method (SEPA,
//      Bacs, boleto, OXXO, konbini — all reachable because the checkout
//      deliberately lets the Dashboard pick methods) handed out a full
//      pass on an unpaid session, and checkout.session.async_payment_failed
//      had no handler to take it back.
//   2. Ultra's first charge was unrefundable — a subscription-mode session
//      has no PaymentIntent, so the row stores `cs_…` and all three refund
//      call sites passed Stripe two undefineds.
//   3. Stripe webhooks resolved users ONLY by stripe_customer_id, so a
//      refund or chargeback on a payment made under a customer id we no
//      longer store silently did nothing: money back, tier retained.
//   4. Refunding a $25 top-up revoked the $89 pass it was added to.
//   5. Duplicate failure rows — payment_intent.payment_failed and
//      charge.failed both fire for one decline.
//   6. Razorpay grants clobbered a live Stripe `cus_…` marker (the India
//      re-enable hazard).
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

process.env.DATABASE_PATH = ':memory:';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
process.env.RAZORPAY_KEY_ID = 'rzp_test_dummy';
process.env.RAZORPAY_KEY_SECRET = 'dummy_secret';

const require = createRequire(import.meta.url);
const db = require('../src/database.js');
const webhooks = require('../src/routes/webhooks.js')._test;
const payments = require('../src/routes/payments.js')._test;
const { resolveStripeRefundTarget, cancelSubscriptionAfterFullRefund } = require('../src/services/stripeRefunds.js');
const { STRIPE_API_VERSION } = require('../src/services/stripeClient.js');

let seq = 0;
let clock = Math.floor(Date.now() / 1000);
const nextCreated = () => ++clock;

function makeUser(tier = 'free', { customerId = null, country = 'US' } = {}) {
  seq += 1;
  const id = `u_fix_${seq}`;
  const email = `${id}@test.example`;
  db.createUser({ id, email, name: 'Audit Fixes', password: 'pw-123456', tier, country_code: country });
  db.createLicense({
    key: `LIC-${id}`, user_id: id, email, tier,
    status: tier === 'free' ? 'trial' : 'active', country_code: country,
    expires_at: Date.now() + 30 * 86400000, sessions_limit: tier === 'free' ? 5 : 1,
  });
  if (customerId) {
    db.getDB().prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?').run(customerId, id);
  }
  return { id, email };
}

function checkoutSession(u, over = {}) {
  return {
    id: `cs_${++seq}`,
    customer: `cus_${u.id}`,
    customer_email: u.email,
    payment_intent: `pi_${seq}`,
    payment_status: 'paid',
    amount_total: 5000,
    currency: 'usd',
    metadata: { user_email: u.email, user_id: u.id, tier: 'pro' },
    ...over,
  };
}

const paymentsFor = (userId) => db.getPaymentsByUser(userId);

// ─────────────────────────────────────────────────────────────
// 1. The money check
// ─────────────────────────────────────────────────────────────
describe('checkout.session.completed only grants once the money is real', () => {
  it('UNPAID session grants nothing and books a pending row', async () => {
    const u = makeUser('free');
    await webhooks.handleStripeEvent({
      id: `evt_unpaid_${seq}`, type: 'checkout.session.completed', created: nextCreated(),
      data: { object: checkoutSession(u, { payment_status: 'unpaid' }) },
    });
    const lic = db.getLicenseByUserId(u.id);
    expect(lic.tier).toBe('free');
    expect(lic.credits_remaining_seconds || 0).toBe(0);
    const rows = paymentsFor(u.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('pending');
  });

  it('async_payment_succeeded settles the deferred session and grants', async () => {
    const u = makeUser('free');
    const session = checkoutSession(u, { payment_status: 'unpaid' });
    await webhooks.handleStripeEvent({
      id: `evt_defer_${seq}`, type: 'checkout.session.completed', created: nextCreated(),
      data: { object: session },
    });
    expect(db.getLicenseByUserId(u.id).tier).toBe('free');

    await webhooks.handleStripeEvent({
      id: `evt_settle_${seq}`, type: 'checkout.session.async_payment_succeeded', created: nextCreated(),
      data: { object: { ...session, payment_status: 'paid' } },
    });
    const lic = db.getLicenseByUserId(u.id);
    expect(lic.tier).toBe('pro');
    expect(lic.credits_remaining_seconds).toBe(3600);
    expect(paymentsFor(u.id).some(p => p.status === 'completed' && p.tier_granted === 'pro')).toBe(true);
  });

  it('async_payment_failed leaves the user on free and books a failure', async () => {
    const u = makeUser('free');
    const session = checkoutSession(u, { payment_status: 'unpaid' });
    await webhooks.handleStripeEvent({
      id: `evt_defer2_${seq}`, type: 'checkout.session.completed', created: nextCreated(),
      data: { object: session },
    });
    await webhooks.handleStripeEvent({
      id: `evt_asyncfail_${seq}`, type: 'checkout.session.async_payment_failed', created: nextCreated(),
      data: { object: session },
    });
    expect(db.getLicenseByUserId(u.id).tier).toBe('free');
    expect(paymentsFor(u.id).some(p => p.status === 'failed')).toBe(true);
    expect(paymentsFor(u.id).some(p => p.status === 'completed')).toBe(false);
  });

  it('paid session still grants (control) and a replay is a no-op, not a crash', async () => {
    const u = makeUser('free');
    const session = checkoutSession(u);
    await webhooks.handleStripeEvent({
      id: `evt_paid_a_${seq}`, type: 'checkout.session.completed', created: nextCreated(),
      data: { object: session },
    });
    // Same session arriving again as an async settlement (belt-and-braces:
    // whatever Stripe sends, we must not double-book or throw on the
    // UNIQUE(provider, provider_payment_id) index).
    await webhooks.handleStripeEvent({
      id: `evt_paid_b_${seq}`, type: 'checkout.session.async_payment_succeeded', created: nextCreated(),
      data: { object: session },
    });
    expect(db.getLicenseByUserId(u.id).tier).toBe('pro');
    expect(paymentsFor(u.id).filter(p => p.status === 'completed')).toHaveLength(1);
  });

  it('incomplete_expired revokes a tier that WAS granted off that subscription', async () => {
    const u = makeUser('free', { customerId: 'cus_incomp' });
    await webhooks.handleStripeEvent({
      id: `evt_sub_grant_${seq}`, type: 'checkout.session.completed', created: nextCreated(),
      data: { object: checkoutSession(u, {
        customer: 'cus_incomp', subscription: 'sub_incomp', payment_intent: null,
        metadata: { user_email: u.email, user_id: u.id, tier: 'ultra' },
      }) },
    });
    expect(db.getLicenseByUserId(u.id).tier).toBe('ultra');

    await webhooks.handleStripeEvent({
      id: `evt_incomp_exp_${seq}`, type: 'customer.subscription.updated', created: nextCreated(),
      data: { object: {
        id: 'sub_incomp', customer: 'cus_incomp', status: 'incomplete_expired',
        metadata: { tier: 'ultra' },
      } },
    });
    expect(db.getLicenseByUserId(u.id).tier).toBe('free');
  });
});

// ─────────────────────────────────────────────────────────────
// 2. Refund targeting
// ─────────────────────────────────────────────────────────────
describe('Stripe refund targeting resolves what the API will accept', () => {
  const fakeStripe = {
    checkout: { sessions: { retrieve: async (id) => ({
      id, payment_intent: id === 'cs_sub' ? null : 'pi_from_session',
      invoice: id === 'cs_sub' ? 'in_first' : null,
      subscription: id === 'cs_sub' ? 'sub_x' : null,
    }) } },
    invoices: { retrieve: async (id) => ({ id, payment_intent: 'pi_from_invoice' }) },
    subscriptions: {
      retrieve: async (id) => ({ id, latest_invoice: 'in_latest' }),
      cancel: async (id) => ({ id, status: 'canceled' }),
    },
  };

  it('pi_ and ch_ pass straight through', async () => {
    expect(await resolveStripeRefundTarget(fakeStripe, { provider_payment_id: 'pi_direct' }))
      .toEqual({ payment_intent: 'pi_direct' });
    expect(await resolveStripeRefundTarget(fakeStripe, { provider_payment_id: 'ch_direct' }))
      .toEqual({ charge: 'ch_direct' });
  });

  it('one-time checkout session resolves via the session PaymentIntent', async () => {
    expect(await resolveStripeRefundTarget(fakeStripe, { provider_payment_id: 'cs_onetime' }))
      .toEqual({ payment_intent: 'pi_from_session' });
  });

  it('ULTRA first charge (cs_ with no PaymentIntent) resolves via the invoice', async () => {
    // This is the case that used to hand Stripe two undefineds → 400 →
    // admin console 500 → "Ultra cannot be refunded in-app".
    expect(await resolveStripeRefundTarget(fakeStripe, { provider_payment_id: 'cs_sub' }))
      .toEqual({ payment_intent: 'pi_from_invoice' });
  });

  it('falls back to the subscription latest_invoice', async () => {
    expect(await resolveStripeRefundTarget(fakeStripe, {
      provider_payment_id: 'evt_unknown_shape', provider_subscription_id: 'sub_x',
    })).toEqual({ payment_intent: 'pi_from_invoice' });
  });

  it('throws a typed error rather than letting Stripe 400', async () => {
    await expect(resolveStripeRefundTarget(fakeStripe, { provider_payment_id: 'weird_id' }))
      .rejects.toMatchObject({ code: 'NO_REFUND_TARGET' });
  });

  it('a FULL refund of a subscription charge cancels the subscription', async () => {
    const res = await cancelSubscriptionAfterFullRefund(fakeStripe,
      { provider_payment_id: 'pi_x', provider_subscription_id: 'sub_x' }, { isFullRefund: true });
    expect(res).toMatchObject({ cancelled: true, subscription_id: 'sub_x' });
  });

  it('a PARTIAL refund never cancels', async () => {
    const res = await cancelSubscriptionAfterFullRefund(fakeStripe,
      { provider_payment_id: 'pi_x', provider_subscription_id: 'sub_x' }, { isFullRefund: false });
    expect(res.cancelled).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────
// 3. Ledger-based user resolution
// ─────────────────────────────────────────────────────────────
describe('refunds and disputes still find the user when the customer id moved', () => {
  it('charge.refunded resolves via the payments ledger and revokes', async () => {
    const u = makeUser('free', { customerId: 'cus_OLD' });
    await webhooks.handleStripeEvent({
      id: `evt_buy_moved_${seq}`, type: 'checkout.session.completed', created: nextCreated(),
      data: { object: checkoutSession(u, { customer: 'cus_OLD', payment_intent: 'pi_moved' }) },
    });
    expect(db.getLicenseByUserId(u.id).tier).toBe('pro');

    // The customer id we store is later replaced (second checkout, or a
    // Razorpay grant on a legacy account). The refund still carries the
    // OLD customer.
    db.getDB().prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?').run('cus_NEW', u.id);

    await webhooks.handleStripeEvent({
      id: `evt_ref_moved_${seq}`, type: 'charge.refunded', created: nextCreated(),
      data: { object: {
        id: 'ch_moved', customer: 'cus_OLD', payment_intent: 'pi_moved',
        amount: 5000, amount_refunded: 5000, refunded: true, currency: 'usd',
        refunds: { data: [{ id: 're_moved', amount: 5000 }] },
      } },
    });
    const lic = db.getLicenseByUserId(u.id);
    expect(lic.tier).toBe('free');
    expect(lic.status).toBe('refunded');
  });

  it('chargeback on a moved customer id still revokes access', async () => {
    const u = makeUser('free', { customerId: 'cus_OLD2' });
    await webhooks.handleStripeEvent({
      id: `evt_buy_disp_${seq}`, type: 'checkout.session.completed', created: nextCreated(),
      data: { object: checkoutSession(u, { customer: 'cus_OLD2', payment_intent: 'pi_disp' }) },
    });
    db.getDB().prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?').run('cus_NEW2', u.id);

    await webhooks.handleStripeEvent({
      id: `evt_disp_${seq}`, type: 'charge.dispute.created', created: nextCreated(),
      data: { object: {
        id: 'dp_1', charge: 'ch_disp', payment_intent: 'pi_disp',
        amount: 5000, currency: 'usd', reason: 'fraudulent', status: 'needs_response',
      } },
    });
    expect(db.getLicenseByUserId(u.id).status).toBe('disputed');
  });
});

// ─────────────────────────────────────────────────────────────
// 4. Top-up refunds must not destroy the plan
// ─────────────────────────────────────────────────────────────
describe('refunding a time top-up leaves the plan intact', () => {
  it('Stripe: full refund of an extension records money, keeps the pass', async () => {
    const u = makeUser('free', { customerId: 'cus_topup' });
    // Buy Max…
    await webhooks.handleStripeEvent({
      id: `evt_max_${seq}`, type: 'checkout.session.completed', created: nextCreated(),
      data: { object: checkoutSession(u, {
        customer: 'cus_topup', payment_intent: 'pi_max', amount_total: 8900,
        metadata: { user_email: u.email, user_id: u.id, tier: 'max' },
      }) },
    });
    // …then top it up.
    await webhooks.handleStripeEvent({
      id: `evt_top_${seq}`, type: 'checkout.session.completed', created: nextCreated(),
      data: { object: checkoutSession(u, {
        customer: 'cus_topup', payment_intent: 'pi_top', amount_total: 2500,
        metadata: { user_email: u.email, user_id: u.id, mode: 'renewal', pack: 'm30' },
      }) },
    });
    expect(db.getLicenseByUserId(u.id).tier).toBe('max');

    // Refund ONLY the top-up, in full.
    await webhooks.handleStripeEvent({
      id: `evt_topref_${seq}`, type: 'charge.refunded', created: nextCreated(),
      data: { object: {
        id: 'ch_top', customer: 'cus_topup', payment_intent: 'pi_top',
        amount: 2500, amount_refunded: 2500, refunded: true, currency: 'usd',
        refunds: { data: [{ id: 're_top', amount: 2500 }] },
      } },
    });

    const lic = db.getLicenseByUserId(u.id);
    expect(lic.tier).toBe('max');          // the $89 pass survives
    expect(lic.status).toBe('active');
    expect(paymentsFor(u.id).some(p => p.status === 'refunded' && p.amount === -2500)).toBe(true);
  });

  it('Stripe: refunding the PLAN charge still revokes (control)', async () => {
    const u = makeUser('free', { customerId: 'cus_plan' });
    await webhooks.handleStripeEvent({
      id: `evt_plan_${seq}`, type: 'checkout.session.completed', created: nextCreated(),
      data: { object: checkoutSession(u, { customer: 'cus_plan', payment_intent: 'pi_plan' }) },
    });
    await webhooks.handleStripeEvent({
      id: `evt_planref_${seq}`, type: 'charge.refunded', created: nextCreated(),
      data: { object: {
        id: 'ch_plan', customer: 'cus_plan', payment_intent: 'pi_plan',
        amount: 5000, amount_refunded: 5000, refunded: true, currency: 'usd',
        refunds: { data: [{ id: 're_plan', amount: 5000 }] },
      } },
    });
    expect(db.getLicenseByUserId(u.id).tier).toBe('free');
  });

  it('Razorpay: full refund of an extension keeps the pass, books the money', async () => {
    const u = makeUser('free');
    await webhooks.handleRazorpayEvent({
      event: 'payment.captured', created_at: nextCreated(),
      payload: { payment: { entity: {
        id: 'pay_rzp_max', order_id: 'order_max', amount: 739900, currency: 'INR',
        notes: { user_email: u.email, user_id: u.id, tier: 'max' },
      } } },
    });
    await webhooks.handleRazorpayEvent({
      event: 'payment.captured', created_at: nextCreated(),
      payload: { payment: { entity: {
        id: 'pay_rzp_top', order_id: 'order_top', amount: 209900, currency: 'INR',
        notes: { user_email: u.email, user_id: u.id, mode: 'extension', tier: 'max', pack: 'm30' },
      } } },
    });
    expect(db.getLicenseByUserId(u.id).tier).toBe('max');

    await webhooks.handleRazorpayEvent({
      event: 'refund.processed', created_at: nextCreated(),
      payload: {
        refund: { entity: { id: 'rfnd_top', payment_id: 'pay_rzp_top', amount: 209900, currency: 'INR' } },
        payment: { entity: { id: 'pay_rzp_top' } },
      },
    });
    expect(db.getLicenseByUserId(u.id).tier).toBe('max');
    expect(paymentsFor(u.id).some(p => p.status === 'refunded' && p.amount === -209900)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// 5. One decline, one row
// ─────────────────────────────────────────────────────────────
describe('a single decline books a single failure row', () => {
  it('payment_intent.payment_failed + charge.failed dedup on the PaymentIntent', async () => {
    const u = makeUser('pro', { customerId: 'cus_decline' });
    await webhooks.handleStripeEvent({
      id: `evt_pif_${seq}`, type: 'payment_intent.payment_failed', created: nextCreated(),
      data: { object: {
        id: 'pi_decline', object: 'payment_intent', customer: 'cus_decline',
        amount: 5000, currency: 'usd',
        last_payment_error: { code: 'card_declined', message: 'Your card was declined.' },
      } },
    });
    await webhooks.handleStripeEvent({
      id: `evt_chf_${seq}`, type: 'charge.failed', created: nextCreated(),
      data: { object: {
        id: 'ch_decline', object: 'charge', payment_intent: 'pi_decline', customer: 'cus_decline',
        amount: 5000, currency: 'usd', failure_code: 'card_declined', failure_message: 'Your card was declined.',
      } },
    });
    expect(paymentsFor(u.id).filter(p => p.status === 'failed')).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────
// 6. India re-enable: don't destroy the Stripe link
// ─────────────────────────────────────────────────────────────
describe('Razorpay grants never clobber a live Stripe customer id', () => {
  it('a Razorpay capture keeps cus_ and records the sub pointer separately', async () => {
    const u = makeUser('free', { customerId: 'cus_KEEPME', country: 'IN' });
    await webhooks.handleRazorpayEvent({
      event: 'payment.captured', created_at: nextCreated(),
      payload: { payment: { entity: {
        id: 'pay_keep', order_id: 'order_keep', amount: 419900, currency: 'INR',
        notes: { user_email: u.email, user_id: u.id, tier: 'pro' },
      } } },
    });
    const row = db.getUserById(u.id);
    expect(row.stripe_customer_id).toBe('cus_KEEPME');   // saved card / portal survive
    expect(db.getLicenseByUserId(u.id).tier).toBe('pro'); // grant still landed
  });

  it('a user with no Stripe marker still gets the rzp_ marker', async () => {
    const u = makeUser('free', { country: 'IN' });
    await webhooks.handleRazorpayEvent({
      event: 'payment.captured', created_at: nextCreated(),
      payload: { payment: { entity: {
        id: 'pay_mark', order_id: 'order_mark', amount: 419900, currency: 'INR',
        notes: { user_email: u.email, user_id: u.id, tier: 'pro' },
      } } },
    });
    expect(db.getUserById(u.id).stripe_customer_id).toBe('rzp_pay_mark');
  });

  it('resolveUserProvider picks the provider that granted the current tier', () => {
    const u = makeUser('free', { customerId: 'cus_BOTH' });
    // Stripe grant first…
    db.recordPayment({
      user_id: u.id, email: u.email, provider: 'stripe', provider_payment_id: 'pi_both',
      amount: 5000, currency: 'USD', status: 'completed', tier_granted: 'pro', metadata: {},
    });
    expect(payments.resolveUserProvider(db.getUserById(u.id))).toBe('stripe');

    // …then a Razorpay purchase becomes the live plan.
    db.setRazorpaySubscriptionId(u.id, 'sub_rzp_both');
    db.recordPayment({
      user_id: u.id, email: u.email, provider: 'razorpay', provider_payment_id: 'pay_both',
      provider_subscription_id: 'sub_rzp_both',
      amount: 419900, currency: 'INR', status: 'completed', tier_granted: 'ultra', metadata: {},
    });
    expect(payments.resolveUserProvider(db.getUserById(u.id))).toBe('razorpay');
  });
});

// ─────────────────────────────────────────────────────────────
// Version pin
// ─────────────────────────────────────────────────────────────
describe('Stripe API version is pinned', () => {
  it('matches the version the field reads in this codebase were written for', () => {
    // Bumping this constant is a deliberate act: subscription.current_period_end,
    // invoice.payment_intent, invoice.subscription and charge.refunds all
    // changed shape in 2025-03-31.basil. Update the readers first.
    expect(STRIPE_API_VERSION).toBe('2023-10-16');
  });
});
