// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  PAYMENTS HARDENING (2026-07-16) — pins the fixes from the E2E audit
//
//  · Credit seeding: EVERY grant path must seed the interview clock.
//    The Razorpay paths (payment.captured, subscription.charged,
//    /verify-razorpay) granted tier-with-zero-seconds — buyers paid and
//    every usage/model gate said "time used up".
//  · Payments UNIQUE index: narrowed to status='completed'. The broad
//    index made refund/dispute/dunning rows collide with the original
//    purchase row → charge.refunded never revoked tiers, admin refunds
//    500'd after money moved, dunning retries crash-looped, and a
//    success-after-declined-attempt was charged-but-never-granted.
//  · Provider routing: Razorpay account is pending → ALL new charges
//    route to Stripe unless RAZORPAY_ROUTING_ENABLED=true.
//  · tierForRazorpayPlan knows Ultra; upgrade direction is rank-based.
//  · fetchedOrder is declared (was an undeclared identifier that threw
//    ReferenceError inside every verified top-up's grant transaction).
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.DATABASE_PATH = ':memory:';
// Ultra's 9-hour metering is behind ULTRA_METERED while un-updated desktop
// clients are still in the field (see the kill-switch note in payments.js).
// The assertions below describe the METERED product, so the flag is on here;
// the OFF default is pinned in enterprise-plan.test.js.
process.env.ULTRA_METERED = 'true';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
// Dummy Razorpay creds so payments.js initializes its client — the routing
// flag test needs a non-null client to prove flag-gating (not key-gating).
process.env.RAZORPAY_KEY_ID = 'rzp_test_dummy';
process.env.RAZORPAY_KEY_SECRET = 'dummy_secret';
process.env.RAZORPAY_PLAN_ID_PRO = 'plan_pro_test';
process.env.RAZORPAY_PLAN_ID_ULTRA = 'plan_ultra_test';

const require = createRequire(import.meta.url);
const db = require('../src/database.js');
const webhooks = require('../src/routes/webhooks.js')._test;
const payments = require('../src/routes/payments.js')._test;

const __dirname_ = path.dirname(fileURLToPath(import.meta.url));

let seq = 0;
let eventClock = Math.floor(Date.now() / 1000);
function nextCreated() { return ++eventClock; }

function makeUser(tier, { country = 'US', licensePatch = {}, customerId = null } = {}) {
  seq += 1;
  const id = `u_hard_${seq}`;
  const email = `${id}@test.example`;
  db.createUser({ id, email, name: 'Hardening Tester', password: 'pw-123456', tier, country_code: country });
  db.createLicense({
    key: `LIC-${id}`,
    user_id: id,
    email,
    tier,
    status: tier === 'free' ? 'trial' : 'active',
    country_code: country,
    expires_at: Date.now() + 30 * 86400000,
    sessions_limit: tier === 'free' ? 5 : 1,
  });
  if (customerId) {
    db.getDB().prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?').run(customerId, id);
  }
  if (Object.keys(licensePatch).length) {
    const sets = Object.keys(licensePatch).map(k => `${k} = ?`).join(', ');
    db.getDB().prepare(`UPDATE licenses SET ${sets} WHERE user_id = ?`)
      .run(...Object.values(licensePatch), id);
  }
  return { id, email };
}

function rzpPaymentCaptured({ email, id, paymentId, tier, amount = 419900, notes = {} }) {
  return webhooks.handleRazorpayEvent({
    event: 'payment.captured',
    created_at: nextCreated(),
    payload: { payment: { entity: {
      id: paymentId, order_id: `order_${paymentId}`, amount, currency: 'INR',
      notes: { user_email: email, user_id: id, tier, ...notes },
    } } },
  });
}

beforeAll(() => { db.getDB(); });

// ─── Credit seeding ────────────────────────────────────────────────────

describe('credit seeding — Razorpay one-time purchases', () => {
  it('payment.captured PRO seeds 3600s and the buyer can start an interview', async () => {
    const u = makeUser('free');
    await rzpPaymentCaptured({ ...u, paymentId: 'pay_seed_pro', tier: 'pro' });
    const lic = db.getLicenseByUserId(u.id);
    expect(lic.tier).toBe('pro');
    expect(lic.credits_remaining_seconds).toBe(3600);
    expect(lic.credits_expire_at).toBeGreaterThan(Date.now());
    expect(db.resolveTimeBucket(lic)).toEqual({ source: 'credits', remaining: 3600 });
    const started = db.startUsageSession(u.id, 'dev-1');
    expect(started.error).toBeUndefined();
    expect(started.remaining).toBe(3600);
  });

  it('payment.captured BASIC seeds 1800s, MAX seeds 10800s', async () => {
    const b = makeUser('free');
    await rzpPaymentCaptured({ ...b, paymentId: 'pay_seed_basic', tier: 'basic', amount: 249900 });
    expect(db.getLicenseByUserId(b.id).credits_remaining_seconds).toBe(1800);

    const m = makeUser('free');
    await rzpPaymentCaptured({ ...m, paymentId: 'pay_seed_max', tier: 'max', amount: 739900 });
    const lic = db.getLicenseByUserId(m.id);
    expect(lic.credits_remaining_seconds).toBe(10800);
    expect(lic.sessions_limit).toBe(3);
  });

  it('duplicate payment.captured for the same payment id is a graceful no-op (no throw, single row, no double grant)', async () => {
    const u = makeUser('free');
    await rzpPaymentCaptured({ ...u, paymentId: 'pay_dup', tier: 'pro' });
    await expect(rzpPaymentCaptured({ ...u, paymentId: 'pay_dup', tier: 'pro' })).resolves.toBeUndefined();
    const rows = db.getPaymentsByUser(u.id).filter(p => p.provider_payment_id === 'pay_dup');
    expect(rows.length).toBe(1);
    expect(db.getLicenseByUserId(u.id).credits_remaining_seconds).toBe(3600);
  });
});

describe('credit seeding — subscription lifecycle', () => {
  // 2026-08: Ultra became a METERED 9-hour monthly plan and Enterprise took
  // over "unlimited". The rule this block pins split in two at the same time
  // (see webhooks.js): a paid BILLING CYCLE re-seeds a recurring tier's
  // allowance; a mere lifecycle re-affirmation (updated/resumed/reactivate)
  // must not, or cancel→reactivate would refill Ultra's 9 hours for free.
  it('subscription.charged for ULTRA seeds the 9-hour cycle allowance', async () => {
    const u = makeUser('free');
    await webhooks.handleRazorpayEvent({
      event: 'subscription.charged',
      created_at: nextCreated(),
      payload: {
        subscription: { entity: { id: 'sub_ultra_1', plan_id: 'plan_ultra_test', notes: { user_email: u.email, tier: 'pro' /* STALE on purpose — plan_id must win */ } } },
        payment: { entity: { id: 'pay_ultra_1', amount: 1299900, currency: 'INR', notes: { user_email: u.email } } },
      },
    });
    const lic = db.getLicenseByUserId(u.id);
    expect(lic.tier).toBe('ultra'); // plan_id reverse-lookup beat the stale notes
    expect(lic.credits_remaining_seconds).toBe(9 * 3600);
    // Metered, NOT unlimited — even though the row carries expires_at -1
    // (the subscription has no end date). Conflating those two -1s is what
    // would give away the $1199 plan for $159.
    expect(db.resolveTimeBucket(lic)).toEqual({ source: 'credits', remaining: 9 * 3600 });
  });

  it('subscription.charged for a LEGACY pro sub never clobbers the migration-era -1 balance', async () => {
    const u = makeUser('pro', { licensePatch: { credits_remaining_seconds: -1, credits_expire_at: -1 } });
    await webhooks.handleRazorpayEvent({
      event: 'subscription.charged',
      created_at: nextCreated(),
      payload: {
        subscription: { entity: { id: 'sub_legacy_1', plan_id: 'plan_pro_test', notes: { user_email: u.email, tier: 'pro' } } },
        payment: { entity: { id: 'pay_legacy_1', amount: 5000_00, currency: 'INR', notes: { user_email: u.email } } },
      },
    });
    const lic = db.getLicenseByUserId(u.id);
    expect(lic.tier).toBe('pro');
    expect(lic.credits_remaining_seconds).toBe(-1); // still unlimited
    expect(db.resolveTimeBucket(lic).source).toBe('unlimited');
  });

  it('creditsForLifecycleGrant passes fields only for enterprise (constant sentinel)', () => {
    expect(webhooks.creditsForLifecycleGrant(webhooks.grantConfigForTier('enterprise')))
      .toEqual({ credits_remaining_seconds: -1, credits_expire_at: -1 });
    // Ultra is METERED now: a re-affirmation event must not touch its balance.
    // This is the cancel→reactivate refill hole, closed.
    expect(webhooks.creditsForLifecycleGrant(webhooks.grantConfigForTier('ultra'))).toEqual({});
    expect(webhooks.creditsForLifecycleGrant(webhooks.grantConfigForTier('pro'))).toEqual({});
    expect(webhooks.creditsForLifecycleGrant(webhooks.grantConfigForTier('max'))).toEqual({});
  });

  it('creditsForBillingCycle re-seeds every recurring tier — and only those', () => {
    expect(webhooks.creditsForBillingCycle(webhooks.grantConfigForTier('ultra')))
      .toEqual({ credits_remaining_seconds: 9 * 3600, credits_expire_at: 0 });
    expect(webhooks.creditsForBillingCycle(webhooks.grantConfigForTier('enterprise')))
      .toEqual({ credits_remaining_seconds: -1, credits_expire_at: -1 });
    expect(webhooks.creditsForBillingCycle(webhooks.grantConfigForTier('pro'))).toEqual({});
    expect(webhooks.creditsForBillingCycle(webhooks.grantConfigForTier('max'))).toEqual({});
    expect(webhooks.creditsForBillingCycle(webhooks.grantConfigForTier('basic'))).toEqual({});
  });

  it('grantConfigForTier: ultra is metered, enterprise is unlimited', () => {
    const ultra = webhooks.grantConfigForTier('ultra');
    expect(ultra).toEqual({
      tier: 'ultra', sessions_limit: -1, expires_at: -1,
      credits_remaining_seconds: 9 * 3600, credits_expire_at: 0,
    });
    const ent = webhooks.grantConfigForTier('enterprise');
    expect(ent).toEqual({
      tier: 'enterprise', sessions_limit: -1, expires_at: -1,
      credits_remaining_seconds: -1, credits_expire_at: -1,
    });
    // The two copies of this config (payments.js owns customer purchases,
    // webhooks.js owns grant writes) are duplicated deliberately and drift
    // silently, so they are compared directly rather than trusted.
    expect(payments.grantConfigForTier('ultra')).toEqual(ultra);
    expect(payments.grantConfigForTier('enterprise')).toEqual(ent);
  });

  it('Stripe checkout.session.completed still seeds credits (pinned control)', async () => {
    const u = makeUser('free', { customerId: null });
    await webhooks.handleStripeEvent({
      id: `evt_ctl_${seq}`, type: 'checkout.session.completed', created: nextCreated(),
      data: { object: {
        id: 'cs_ctl', payment_status: 'paid', customer: 'cus_CTL', customer_email: u.email, payment_intent: 'pi_ctl',
        amount_total: 5000, currency: 'usd', metadata: { user_email: u.email, user_id: u.id, tier: 'pro' },
      } },
    });
    expect(db.getLicenseByUserId(u.id).credits_remaining_seconds).toBe(3600);
  });
});

// ─── Payments-table coexistence (narrowed UNIQUE index) ────────────────

describe('refund / failure rows coexist with the original completed payment', () => {
  it('full charge.refunded records the refund AND revokes the tier (no UNIQUE crash)', async () => {
    const u = makeUser('free', { customerId: 'cus_REF' });
    await webhooks.handleStripeEvent({
      id: `evt_ref_a_${seq}`, type: 'checkout.session.completed', created: nextCreated(),
      data: { object: {
        id: 'cs_ref', payment_status: 'paid', customer: 'cus_REF', customer_email: u.email, payment_intent: 'pi_ref',
        amount_total: 5000, currency: 'usd', metadata: { user_email: u.email, user_id: u.id, tier: 'pro' },
      } },
    });
    await expect(webhooks.handleStripeEvent({
      id: `evt_ref_b_${seq}`, type: 'charge.refunded', created: nextCreated(),
      data: { object: {
        id: 'ch_ref', customer: 'cus_REF', payment_intent: 'pi_ref',
        amount: 5000, amount_refunded: 5000, refunded: true, currency: 'usd',
        refunds: { data: [{ reason: 'requested_by_customer' }] },
      } },
    })).resolves.toBeUndefined();
    const lic = db.getLicenseByUserId(u.id);
    expect(lic.tier).toBe('free');
    expect(lic.status).toBe('refunded');
    const rows = db.getPaymentsByUser(u.id).filter(p => p.provider_payment_id === 'pi_ref');
    expect(rows.map(r => r.status).sort()).toEqual(['completed', 'refunded']);
    expect(rows.find(r => r.status === 'refunded').amount).toBe(-5000);
  });

  it('recordAdminRefund succeeds after the provider refund (no UNIQUE crash)', async () => {
    const u = makeUser('free', { customerId: 'cus_ADM' });
    await webhooks.handleStripeEvent({
      id: `evt_adm_${seq}`, type: 'checkout.session.completed', created: nextCreated(),
      data: { object: {
        id: 'cs_adm', payment_status: 'paid', customer: 'cus_ADM', customer_email: u.email, payment_intent: 'pi_adm',
        amount_total: 3000, currency: 'usd', metadata: { user_email: u.email, user_id: u.id, tier: 'basic' },
      } },
    });
    const orig = db.getPaymentsByUser(u.id).find(p => p.status === 'completed');
    const row = db.recordAdminRefund({ originalPayment: orig, refundId: 're_adm', amount: 3000, reason: 'test', initiatedBy: 'admin@test.example' });
    expect(row).toBeTruthy();
    expect(row.amount).toBe(-3000);
  });

  it('dunning: two invoice.payment_failed on the SAME PaymentIntent, then a recovery success — all record, none throw', async () => {
    const u = makeUser('ultra', { customerId: 'cus_DUN', licensePatch: { credits_remaining_seconds: -1, credits_expire_at: -1, expires_at: -1, sessions_limit: -1 } });
    const failed = (n) => webhooks.handleStripeEvent({
      id: `evt_dun_${n}_${seq}`, type: 'invoice.payment_failed', created: nextCreated(),
      data: { object: { id: 'in_dun', customer: 'cus_DUN', payment_intent: 'pi_dun2', subscription: 'sub_dun', amount_due: 15900, currency: 'usd' } },
    });
    await expect(failed(1)).resolves.toBeUndefined();
    await expect(failed(2)).resolves.toBeUndefined();
    await expect(webhooks.handleStripeEvent({
      id: `evt_dun_ok_${seq}`, type: 'invoice.payment_succeeded', created: nextCreated(),
      data: { object: { id: 'in_dun', customer: 'cus_DUN', payment_intent: 'pi_dun2', subscription: 'sub_dun', amount_paid: 15900, currency: 'usd', billing_reason: 'subscription_cycle' } },
    })).resolves.toBeUndefined();
    const rows = db.getPaymentsByUser(u.id).filter(p => p.provider_payment_id === 'pi_dun2');
    expect(rows.filter(r => r.status === 'failed').length).toBe(2);
    expect(rows.filter(r => r.status === 'completed').length).toBe(1);
  });

  it('returning customer: declined attempt then success on the same PI — the grant LANDS', async () => {
    const u = makeUser('free', { customerId: 'cus_RTR' });
    await webhooks.handleStripeEvent({
      id: `evt_rtr_fail_${seq}`, type: 'payment_intent.payment_failed', created: nextCreated(),
      data: { object: { id: 'pi_rtr', customer: 'cus_RTR', amount: 5000, currency: 'usd', last_payment_error: { code: 'card_declined', message: 'declined' } } },
    });
    await expect(webhooks.handleStripeEvent({
      id: `evt_rtr_ok_${seq}`, type: 'checkout.session.completed', created: nextCreated(),
      data: { object: {
        id: 'cs_rtr', payment_status: 'paid', customer: 'cus_RTR', customer_email: u.email, payment_intent: 'pi_rtr',
        amount_total: 5000, currency: 'usd', metadata: { user_email: u.email, user_id: u.id, tier: 'pro' },
      } },
    })).resolves.toBeUndefined();
    const lic = db.getLicenseByUserId(u.id);
    expect(lic.tier).toBe('pro');
    expect(lic.credits_remaining_seconds).toBe(3600);
  });

  it('the double-GRANT guarantee survives the narrowing: a second completed row for the same payment id still fails', () => {
    const u = makeUser('free');
    db.recordPayment({ user_id: u.id, email: u.email, provider: 'stripe', provider_payment_id: 'pi_twice', provider_subscription_id: null, amount: 5000, currency: 'USD', status: 'completed', tier_granted: 'pro', metadata: {} });
    expect(() => db.recordPayment({ user_id: u.id, email: u.email, provider: 'stripe', provider_payment_id: 'pi_twice', provider_subscription_id: null, amount: 5000, currency: 'USD', status: 'completed', tier_granted: 'pro', metadata: {} }))
      .toThrow(/UNIQUE/);
  });
});

describe('refund rows dedup on the provider refund id (no double-count)', () => {
  it('Stripe: admin refund row + the charge.refunded webhook it triggers = exactly ONE refunded row', async () => {
    const u = makeUser('free', { customerId: 'cus_RD1' });
    await webhooks.handleStripeEvent({
      id: `evt_rd1_buy_${seq}`, type: 'checkout.session.completed', created: nextCreated(),
      data: { object: { id: 'cs_rd1', payment_status: 'paid', customer: 'cus_RD1', customer_email: u.email, payment_intent: 'pi_rd1', amount_total: 5000, currency: 'usd', metadata: { user_email: u.email, user_id: u.id, tier: 'pro' } } },
    });
    // Admin console path writes the compensating row first, stamping refund_id.
    const orig = db.getPaymentsByUser(u.id).find(p => p.status === 'completed');
    db.recordAdminRefund({ originalPayment: orig, refundId: 're_rd1', amount: 5000, reason: 'test', initiatedBy: 'admin@test.example' });
    // Stripe then fires charge.refunded for the same refund id.
    await webhooks.handleStripeEvent({
      id: `evt_rd1_ref_${seq}`, type: 'charge.refunded', created: nextCreated(),
      data: { object: { id: 'ch_rd1', customer: 'cus_RD1', payment_intent: 'pi_rd1', amount: 5000, amount_refunded: 5000, refunded: true, currency: 'usd', refunds: { data: [{ id: 're_rd1', reason: 'requested_by_customer' }] } } },
    });
    const refundRows = db.getPaymentsByUser(u.id).filter(p => p.status === 'refunded');
    expect(refundRows.length).toBe(1);
    // …and the webhook still performed the downgrade the admin path defers to it.
    expect(db.getLicenseByUserId(u.id).tier).toBe('free');
  });

  it('Razorpay: refund.created + refund.processed for one refund = exactly ONE refunded row', async () => {
    const u = makeUser('free');
    await rzpPaymentCaptured({ ...u, paymentId: 'pay_rd2', tier: 'basic', amount: 249900 });
    const refundEvt = (evt, n) => webhooks.handleRazorpayEvent({
      event: evt, created_at: nextCreated(),
      payload: { refund: { entity: { id: 'rfnd_rd2', payment_id: 'pay_rd2', amount: 249900, currency: 'INR' } } },
    });
    await refundEvt('refund.created');
    await refundEvt('refund.processed');
    const refundRows = db.getPaymentsByUser(u.id).filter(p => p.status === 'refunded');
    expect(refundRows.length).toBe(1);
    expect(db.getLicenseByUserId(u.id).tier).toBe('free');
  });

  it('two DISTINCT partial refunds (different refund ids) both record', async () => {
    const u = makeUser('free');
    await rzpPaymentCaptured({ ...u, paymentId: 'pay_rd3', tier: 'max', amount: 739900 });
    await webhooks.handleRazorpayEvent({ event: 'refund.processed', created_at: nextCreated(), payload: { refund: { entity: { id: 'rfnd_a', payment_id: 'pay_rd3', amount: 100000, currency: 'INR' } } } });
    await webhooks.handleRazorpayEvent({ event: 'refund.processed', created_at: nextCreated(), payload: { refund: { entity: { id: 'rfnd_b', payment_id: 'pay_rd3', amount: 100000, currency: 'INR' } } } });
    const refundRows = db.getPaymentsByUser(u.id).filter(p => p.status === 'refunded');
    expect(refundRows.length).toBe(2); // distinct refund ids → both legitimate
  });
});

// ─── Provider routing (Razorpay account pending → Stripe everywhere) ───

describe('getPaymentProvider — Stripe-only routing while Razorpay is pending', () => {
  it('routes India (and everywhere) to Stripe when RAZORPAY_ROUTING_ENABLED is unset', () => {
    delete process.env.RAZORPAY_ROUTING_ENABLED;
    expect(payments.getPaymentProvider('IN')).toBe('stripe');
    expect(payments.getPaymentProvider('US')).toBe('stripe');
    expect(payments.getPaymentProvider('GB')).toBe('stripe');
  });

  it('routes India back to Razorpay only when the flag is exactly "true"', () => {
    process.env.RAZORPAY_ROUTING_ENABLED = 'false';
    expect(payments.getPaymentProvider('IN')).toBe('stripe');
    process.env.RAZORPAY_ROUTING_ENABLED = 'true';
    expect(payments.getPaymentProvider('IN')).toBe('razorpay'); // dummy client initialized in this suite
    expect(payments.getPaymentProvider('US')).toBe('stripe');   // non-IN never routes to Razorpay
    delete process.env.RAZORPAY_ROUTING_ENABLED;
  });
});

// ─── Upgrade direction + Ultra plan mapping ────────────────────────────

describe('tier ladder', () => {
  it('isTierUpgrade is rank-based (pro→ultra and max→ultra are upgrades)', () => {
    expect(payments.isTierUpgrade('pro', 'max')).toBe(true);
    expect(payments.isTierUpgrade('pro', 'ultra')).toBe(true);
    expect(payments.isTierUpgrade('max', 'ultra')).toBe(true);
    expect(payments.isTierUpgrade('max', 'pro')).toBe(false);
    expect(payments.isTierUpgrade('ultra', 'pro')).toBe(false);
    expect(payments.isTierUpgrade('pro', 'pro')).toBe(false);
  });

  it('tierForRazorpayPlan resolves the Ultra plan id', () => {
    expect(webhooks.tierForRazorpayPlan('plan_ultra_test')).toBe('ultra');
    expect(webhooks.tierForRazorpayPlan('plan_pro_test')).toBe('pro');
    expect(webhooks.tierForRazorpayPlan('plan_unknown')).toBe(null);
  });
});

// ─── fetchedOrder tripwire ─────────────────────────────────────────────

describe('verify-razorpay top-up grant', () => {
  it('fetchedOrder is a declared identifier in payments.js (was ReferenceError inside the grant tx)', () => {
    const src = fs.readFileSync(path.join(__dirname_, '..', 'src', 'routes', 'payments.js'), 'utf8');
    expect(/let fetchedOrder = null/.test(src)).toBe(true);
    // Every usage is now backed by the declaration + the assignment.
    expect((src.match(/fetchedOrder/g) || []).length).toBeGreaterThanOrEqual(3);
  });
});

// ─── /subscription is_recurring — subscription vs one-time pass ────────

describe('isSubscriptionBackedTier (drives /subscription is_recurring)', () => {
  it('ultra is always subscription-backed', () => {
    const u = makeUser('ultra');
    expect(payments.isSubscriptionBackedTier(u.id, 'ultra')).toBe(true);
  });

  it('pro one-time pass (no sub id on the payment) is NOT recurring', () => {
    const u = makeUser('pro');
    db.recordPayment({
      user_id: u.id, email: u.email, provider: 'stripe',
      provider_payment_id: `pi_rec_${seq}`, provider_subscription_id: null,
      amount: 5000, currency: 'USD', status: 'completed', tier_granted: 'pro',
      metadata: { mode: 'tier' },
    });
    expect(payments.isSubscriptionBackedTier(u.id, 'pro')).toBe(false);
  });

  it('legacy pro SUBSCRIBER (sub id on the latest tier payment) IS recurring', () => {
    const u = makeUser('pro');
    db.recordPayment({
      user_id: u.id, email: u.email, provider: 'stripe',
      provider_payment_id: `pi_rec_sub_${seq}`, provider_subscription_id: 'sub_legacy_1',
      amount: 2900, currency: 'USD', status: 'completed', tier_granted: 'pro',
      metadata: { mode: 'subscription_cycle' },
    });
    expect(payments.isSubscriptionBackedTier(u.id, 'pro')).toBe(true);
  });

  it('lapsed legacy subscriber who later bought a one-time pass reads as NOT recurring (latest row wins)', () => {
    const u = makeUser('max');
    // Old subscription-cycle row…
    db.recordPayment({
      user_id: u.id, email: u.email, provider: 'stripe',
      provider_payment_id: `pi_rec_old_${seq}`, provider_subscription_id: 'sub_legacy_2',
      amount: 6900, currency: 'USD', status: 'completed', tier_granted: 'max',
      metadata: { mode: 'subscription_cycle' },
    });
    // …pushed an hour into the past so ordering is deterministic.
    db.getDB().prepare(
      "UPDATE payments SET created_at = created_at - 3600000 WHERE user_id = ? AND provider_subscription_id = 'sub_legacy_2'"
    ).run(u.id);
    // Then a fresh one-time Max pass.
    db.recordPayment({
      user_id: u.id, email: u.email, provider: 'stripe',
      provider_payment_id: `pi_rec_new_${seq}`, provider_subscription_id: null,
      amount: 8900, currency: 'USD', status: 'completed', tier_granted: 'max',
      metadata: { mode: 'tier' },
    });
    expect(payments.isSubscriptionBackedTier(u.id, 'max')).toBe(false);
  });

  it('free and basic are never recurring', () => {
    const u = makeUser('basic');
    expect(payments.isSubscriptionBackedTier(u.id, 'basic')).toBe(false);
    expect(payments.isSubscriptionBackedTier(u.id, 'free')).toBe(false);
  });
});

// ─── Cumulative partial refunds (Razorpay) + per-refund row amounts (Stripe) ───

describe('refund accounting — partial-refund correctness', () => {
  it('Razorpay: two partials that SUM to the full amount revoke the tier on the second', async () => {
    const u = makeUser('free');
    await rzpPaymentCaptured({ ...u, paymentId: 'pay_cum1', tier: 'max', amount: 739900 });
    expect(db.getLicenseByUserId(u.id).tier).toBe('max');
    // First partial — under the total, tier survives.
    await webhooks.handleRazorpayEvent({
      event: 'refund.processed', created_at: nextCreated(),
      payload: { refund: { entity: { id: 'rfnd_cum1a', payment_id: 'pay_cum1', amount: 369900, currency: 'INR' } } },
    });
    expect(db.getLicenseByUserId(u.id).tier).toBe('max');
    // Second partial — cumulative 739,900 ≥ original → full refund → revoke.
    await webhooks.handleRazorpayEvent({
      event: 'refund.processed', created_at: nextCreated(),
      payload: { refund: { entity: { id: 'rfnd_cum1b', payment_id: 'pay_cum1', amount: 370000, currency: 'INR' } } },
    });
    const lic = db.getLicenseByUserId(u.id);
    expect(lic.tier).toBe('free');
    expect(lic.status).toBe('refunded');
    const refundRows = db.getPaymentsByUser(u.id).filter(p => p.status === 'refunded');
    expect(refundRows.length).toBe(2);
  });

  it('Stripe: each charge.refunded row books THIS refund\'s amount, not the cumulative total', async () => {
    const u = makeUser('free', { customerId: 'cus_CUM2' });
    await webhooks.handleStripeEvent({
      id: `evt_cum2_buy_${seq}`, type: 'checkout.session.completed', created: nextCreated(),
      data: { object: { id: 'cs_cum2', payment_status: 'paid', customer: 'cus_CUM2', customer_email: u.email, payment_intent: 'pi_cum2', amount_total: 5000, currency: 'usd', metadata: { user_email: u.email, user_id: u.id, tier: 'pro' } } },
    });
    // Partial refund #1: $20 of $50. amount_refunded is cumulative (2000).
    await webhooks.handleStripeEvent({
      id: `evt_cum2_r1_${seq}`, type: 'charge.refunded', created: nextCreated(),
      data: { object: { id: 'ch_cum2', customer: 'cus_CUM2', payment_intent: 'pi_cum2', amount: 5000, amount_refunded: 2000, refunded: false, currency: 'usd', refunds: { data: [{ id: 're_cum2a', amount: 2000, reason: 'requested_by_customer' }] } } },
    });
    expect(db.getLicenseByUserId(u.id).tier).toBe('pro'); // partial — tier survives
    // Partial refund #2: the remaining $30. Cumulative amount_refunded=5000,
    // refunds list most-recent-first with THIS refund's amount 3000.
    await webhooks.handleStripeEvent({
      id: `evt_cum2_r2_${seq}`, type: 'charge.refunded', created: nextCreated(),
      data: { object: { id: 'ch_cum2', customer: 'cus_CUM2', payment_intent: 'pi_cum2', amount: 5000, amount_refunded: 5000, refunded: true, currency: 'usd', refunds: { data: [{ id: 're_cum2b', amount: 3000, reason: 'requested_by_customer' }, { id: 're_cum2a', amount: 2000, reason: 'requested_by_customer' }] } } },
    });
    const refundRows = db.getPaymentsByUser(u.id).filter(p => p.status === 'refunded');
    expect(refundRows.length).toBe(2);
    const amounts = refundRows.map(r => r.amount).sort((a, b) => a - b);
    expect(amounts).toEqual([-3000, -2000]); // per-refund, never [-5000, -2000]
    // Net refunded across rows equals the charge — books balance.
    expect(amounts.reduce((s, a) => s + a, 0)).toBe(-5000);
    // Full-refund semantics (cumulative) still revoke on the closing partial.
    expect(db.getLicenseByUserId(u.id).tier).toBe('free');
  });
});

// ─── /upgrade-tier in-place guard tripwire (2026-07 model) ─────────────

describe('upgrade-tier in-place swap guard', () => {
  it('rejects non-recurring in-place targets when a provider is on file (source tripwire)', () => {
    const src = fs.readFileSync(path.join(__dirname_, '..', 'src', 'routes', 'payments.js'), 'utf8');
    // The guard must sit between provider detection and the upgrade calls:
    // pro/max are one-time passes — a subscription can only swap to another
    // SUBSCRIPTION tier. The literal `!== 'ultra'` became wrong on 2026-08-22
    // when Enterprise arrived: it would have refused every Ultra→Enterprise
    // upgrade with "Enterprise is a one-time interview pass now".
    expect(src).toMatch(/\(isRazorpay \|\| isStripe\) && !isRecurringTier\(targetTier\)/);
  });

  it('isRecurringTier covers exactly the subscription plans', () => {
    // The predicate behind the guard above, the checkout `mode`, the Razorpay
    // plan requirement and the recurring price-shape validation. Anything
    // added here has to be a real monthly plan on both providers.
    expect(payments.RECURRING_TIERS).toEqual(['ultra', 'enterprise']);
  });
});

// ─── /create-checkout double-billing guard (Ultra is the heart) ─────────

describe('checkoutConflictFor — fresh checkout vs live recurring plan', () => {
  const lic = (tier, status) => ({ tier, status });

  it('active Ultra buying Ultra again → already_subscribed 409 (blocks the parallel second sub)', () => {
    const c = payments.checkoutConflictFor(lic('ultra', 'active'), true, 'ultra');
    expect(c.code).toBe('already_subscribed');
    expect(c.httpStatus).toBe(409);
    expect(c.suggested_action).toBe(null);
  });

  it('CANCELING Ultra buying Ultra → points at reactivation, never a duplicate sub', () => {
    const c = payments.checkoutConflictFor(lic('ultra', 'canceling'), true, 'ultra');
    expect(c.code).toBe('already_subscribed');
    expect(c.suggested_action).toBe('reactivate-subscription');
  });

  it('active Ultra buying a one-time pass → blocked (would pay twice AND get demoted by the grant webhook)', () => {
    for (const target of ['basic', 'pro', 'max']) {
      const c = payments.checkoutConflictFor(lic('ultra', 'active'), true, target);
      expect(c.code).toBe('subscription_active');
      expect(c.httpStatus).toBe(400);
      expect(c.suggested_action).toBe('cancel-subscription');
    }
  });

  it('past_due Ultra is still a live sub — same guards apply during dunning', () => {
    expect(payments.checkoutConflictFor(lic('ultra', 'past_due'), true, 'basic').code).toBe('subscription_active');
    // Still refused (a second subscription never fixes a declined card) —
    // but past_due gets its OWN verdict. It used to fall through to
    // 'already_subscribed', i.e. "there's nothing more to buy", told to a
    // customer whose card had just failed and whose sub is counting down to
    // cancellation. The refusal is right; that reason was actively harmful.
    const pastDue = payments.checkoutConflictFor(lic('ultra', 'past_due'), true, 'ultra');
    expect(pastDue.code).toBe('payment_method_required');
    expect(pastDue.httpStatus).toBe(409);
    expect(pastDue.suggested_action).toBe('update-payment-method');
    expect(pastDue.message).toMatch(/didn't go through/);
    expect(pastDue.message).not.toMatch(/nothing more to buy/);
  });

  it('legacy Pro SUBSCRIBER buying Ultra → upgrade_in_place (prorated swap, not a second sub)', () => {
    const c = payments.checkoutConflictFor(lic('pro', 'active'), true, 'ultra');
    expect(c.code).toBe('upgrade_in_place');
  });

  it('one-time pass holders and free users check out normally (not recurring → no conflict)', () => {
    expect(payments.checkoutConflictFor(lic('pro', 'active'), false, 'max')).toBe(null);
    expect(payments.checkoutConflictFor(lic('basic', 'active'), false, 'ultra')).toBe(null);
    expect(payments.checkoutConflictFor(lic('free', 'trial'), false, 'ultra')).toBe(null);
    expect(payments.checkoutConflictFor(null, false, 'ultra')).toBe(null);
  });

  it('a LAPSED subscription no longer blocks anything (expired/refunded → free to buy again)', () => {
    expect(payments.checkoutConflictFor(lic('ultra', 'expired'), true, 'ultra')).toBe(null);
    expect(payments.checkoutConflictFor(lic('ultra', 'refunded'), true, 'basic')).toBe(null);
  });
});
