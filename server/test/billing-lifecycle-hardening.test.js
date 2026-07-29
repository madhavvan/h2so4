// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  BILLING LIFECYCLE HARDENING (2026-07-25, second pass)
//
//  The remaining findings from the end-to-end payment audit. None of them
//  throws; each is a state the system can reach and then never leave.
//
//   A. A 'canceling' license with no positive expires_at terminates
//      through NO path — the sweeper and /validate both filter
//      expires_at > 0, and every gate reads a non-positive value as
//      "never expires". Ultra is granted at -1, so any cancel whose
//      provider period-end lookup came back empty produced exactly that:
//      canceled at the provider, unlimited here, forever.
//   B. The interview-day rule for top-ups was enforced on /extend-now and
//      not on /create-renewal — the same grant, reachable through an
//      ungated door.
//   E. isSubscriptionBackedTier ordered by created_at alone. Milliseconds
//      tie, and the loser decides whether the client offers Cancel (which
//      404s for a pass holder) or "expires on <date>".
//   F. The webhook ENDPOINT carries its own api_version from the Stripe
//      Dashboard — the client pin does not govern it. Four fields moved in
//      2025-03-31.basil, and every symptom of reading the old shape is
//      silent: lost cancel dates, subscription-cycle rows with no ids to
//      resolve a later refund against, and double-booked refunds.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

process.env.DATABASE_PATH = ':memory:';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
process.env.ADMIN_EMAILS = 'nobody@example.invalid';

const require = createRequire(import.meta.url);
const db = require('../src/database.js');
const webhooks = require('../src/routes/webhooks.js')._test;
const payments = require('../src/routes/payments.js')._test;
const {
  resolveCancelPeriodEnd, CANCEL_FALLBACK_WINDOW_MS,
} = require('../src/services/subscriptionStates.js');
const {
  subscriptionPeriodEnd, invoicePaymentIntentId, invoiceSubscriptionId, latestRefundFor,
} = require('../src/services/stripeClient.js');

let seq = 0;
let clock = Math.floor(Date.now() / 1000);
const nextCreated = () => ++clock;

function makeUser(tier, { status, expires_at, sessions_limit, customerId, country = 'US' } = {}) {
  seq += 1;
  const id = `u_blh_${seq}`;
  const email = `${id}@test.example`;
  db.createUser({ id, email, name: 'Hardening', password: 'pw-123456', tier, country_code: country });
  db.createLicense({
    key: `LIC-${id}`, user_id: id, email, tier,
    status: status ?? (tier === 'free' ? 'trial' : 'active'),
    country_code: country,
    expires_at: expires_at ?? Date.now() + 30 * 86400000,
    sessions_limit: sessions_limit ?? 1,
  });
  if (customerId) db.getDB().prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?').run(customerId, id);
  return { id, email, key: `LIC-${id}`, customer: customerId };
}

// ━━━ A. a canceling license always carries a real cycle end ━━━━━━━━━━
describe('A. cancel window can never be "never"', () => {
  it('resolveCancelPeriodEnd prefers the provider date, then the existing expiry, then a bounded fallback', () => {
    const now = 1_700_000_000_000;
    const providerEnd = now + 5 * 86400000;
    const existing = now + 9 * 86400000;
    expect(resolveCancelPeriodEnd(providerEnd, existing, now)).toBe(providerEnd);
    expect(resolveCancelPeriodEnd(null, existing, now)).toBe(existing);
    // The Ultra case: -1 is "unlimited", which as a cancel window means
    // "this subscription never ends". Bounded instead.
    expect(resolveCancelPeriodEnd(null, -1, now)).toBe(now + CANCEL_FALLBACK_WINDOW_MS);
    expect(resolveCancelPeriodEnd(0, 0, now)).toBe(now + CANCEL_FALLBACK_WINDOW_MS);
    expect(resolveCancelPeriodEnd(undefined, undefined, now)).toBe(now + CANCEL_FALLBACK_WINDOW_MS);
    // …and the bound is a strict upper bound on a monthly cycle, so it can
    // never cut a paying customer short.
    expect(CANCEL_FALLBACK_WINDOW_MS).toBeLessThanOrEqual(31 * 86400000);
  });

  it('cancel-at-period-end on an Ultra with NO period end still lands a sweepable date', async () => {
    const u = makeUser('ultra', { expires_at: -1, sessions_limit: -1, customerId: `cus_blh_a_${seq + 1}` });
    seq += 1;
    db.updateLicenseOnPayment(u.id, {
      tier: 'ultra', status: 'active', expires_at: -1, sessions_limit: -1,
      credits_remaining_seconds: -1, credits_expire_at: -1,
    });
    await webhooks.handleStripeEvent({
      id: `evt_blh_a_${seq}`, type: 'customer.subscription.updated', created: nextCreated(),
      data: { object: {
        id: `sub_blh_a_${seq}`, customer: u.customer, status: 'active',
        cancel_at_period_end: true,
        // The Basil+ reality: no top-level current_period_end, and here not
        // even an items array — the worst case the old code turned into -1.
        metadata: { tier: 'ultra' },
      } },
    });
    const lic = db.getLicenseByUserId(u.id);
    expect(lic.status).toBe('canceling');
    expect(lic.expires_at).toBeGreaterThan(Date.now());          // NOT -1
    expect(lic.expires_at).toBeLessThanOrEqual(Date.now() + CANCEL_FALLBACK_WINDOW_MS + 1000);
    // Which means the cycle-end sweeper can actually collect it once it passes.
    db.getDB().prepare('UPDATE licenses SET expires_at = ? WHERE user_id = ?').run(Date.now() - 1, u.id);
    expect(db.getExpiredCancelingUserIds(100)).toContain(u.id);
  });

  it('a real period end is always preferred over the fallback', async () => {
    const u = makeUser('ultra', { expires_at: -1, sessions_limit: -1, customerId: `cus_blh_b_${seq + 1}` });
    seq += 1;
    const realEndSec = Math.floor(Date.now() / 1000) + 3 * 86400;
    await webhooks.handleStripeEvent({
      id: `evt_blh_b_${seq}`, type: 'customer.subscription.updated', created: nextCreated(),
      data: { object: {
        id: `sub_blh_b_${seq}`, customer: u.customer, status: 'active',
        cancel_at_period_end: true, current_period_end: realEndSec,
        metadata: { tier: 'ultra' },
      } },
    });
    expect(db.getLicenseByUserId(u.id).expires_at).toBe(realEndSec * 1000);
  });

  it('the repair heals legacy rows and refuses to touch anything else', () => {
    const stuck = makeUser('ultra', { status: 'canceling', expires_at: -1, sessions_limit: -1 });
    const healthy = makeUser('ultra', { status: 'canceling', expires_at: Date.now() + 86400000, sessions_limit: -1 });
    const comp = makeUser('ultra', { status: 'active', expires_at: -1, sessions_limit: -1 }); // lifetime grant
    const healthyBefore = db.getLicenseByUserId(healthy.id).expires_at;

    expect(db.repairCancelWindow(stuck.id)).toBe(true);
    expect(db.getLicenseByUserId(stuck.id).expires_at).toBeGreaterThan(Date.now());
    expect(db.repairCancelWindow(stuck.id)).toBe(false);            // idempotent
    expect(db.repairCancelWindow(healthy.id)).toBe(false);          // already fine
    expect(db.getLicenseByUserId(healthy.id).expires_at).toBe(healthyBefore);
    expect(db.repairCancelWindow(comp.id)).toBe(false);             // status='active' — untouchable
    expect(db.getLicenseByUserId(comp.id).expires_at).toBe(-1);     // lifetime grant intact
  });

  it('the bulk repair the sweeper runs finds them without a client check-in', () => {
    const a = makeUser('ultra', { status: 'canceling', expires_at: -1, sessions_limit: -1 });
    const b = makeUser('pro', { status: 'canceling', expires_at: 0 });
    const comp = makeUser('max', { status: 'active', expires_at: -1 });
    expect(db.repairAllCancelWindows()).toBeGreaterThanOrEqual(2);
    expect(db.getLicenseByUserId(a.id).expires_at).toBeGreaterThan(Date.now());
    expect(db.getLicenseByUserId(b.id).expires_at).toBeGreaterThan(Date.now());
    expect(db.getLicenseByUserId(comp.id).expires_at).toBe(-1);
    expect(db.repairAllCancelWindows()).toBe(0); // steady state
  });
});

// ━━━ B. one interview-day rule, both top-up routes ━━━━━━━━━━━━━━━━━━━
describe('B. interview-day eligibility is shared', () => {
  const openSession = (userId) => {
    const r = db.startUsageSession(userId, 'dev-blh');
    expect(r.error).toBeUndefined();
    return r;
  };

  it('denies a pass that is not in use, allows one with a live session', () => {
    const u = makeUser('pro');
    db.updateLicenseOnPayment(u.id, {
      tier: 'pro', status: 'active', expires_at: Date.now() + 20 * 86400000, sessions_limit: 1,
      credits_remaining_seconds: 3600, credits_expire_at: Date.now() + 20 * 86400000,
    });
    const denied = payments.interviewDayDenial(u.id);
    expect(denied).toBeTruthy();
    expect(denied.status).toBe(403);
    expect(denied.body.error).toBe('not_interview_day');

    openSession(u.id);
    expect(payments.interviewDayDenial(u.id)).toBe(null);
  });

  it('still allows a top-up hours after the session ended (the call-back-same-day case)', () => {
    const u = makeUser('max');
    db.updateLicenseOnPayment(u.id, {
      tier: 'max', status: 'active', expires_at: Date.now() + 20 * 86400000, sessions_limit: 3,
      credits_remaining_seconds: 10800, credits_expire_at: Date.now() + 20 * 86400000,
    });
    const s = openSession(u.id);
    // Close it, and backdate the last heartbeat to 6 hours ago.
    db.getDB().prepare('UPDATE usage_sessions SET ended_at = ?, last_heartbeat_at = ? WHERE id = ?')
      .run(Date.now() - 6 * 3600 * 1000, Date.now() - 6 * 3600 * 1000, s.session_id);
    expect(payments.interviewDayDenial(u.id)).toBe(null);

    // …but not a week later.
    const stale = Date.now() - (payments.EXTENSION_ELIGIBLE_WINDOW_MS + 60_000);
    db.getDB().prepare('UPDATE usage_sessions SET last_heartbeat_at = ? WHERE id = ?').run(stale, s.session_id);
    expect(payments.interviewDayDenial(u.id)?.body.error).toBe('not_interview_day');
  });
});

// ━━━ E. is_recurring must not depend on a millisecond tie ━━━━━━━━━━━━
describe('E. isSubscriptionBackedTier tiebreak', () => {
  it('a lapsed subscriber who later buys a PASS reads as one-time, even on a tied timestamp', () => {
    const u = makeUser('pro');
    const d = db.getDB();
    const sameMs = Date.now();
    // Older row (lower rowid): the legacy subscription cycle.
    d.prepare(`INSERT INTO payments (user_id, email, provider, provider_payment_id, provider_subscription_id, amount, currency, status, tier_granted, metadata, created_at)
               VALUES (?,?,'stripe','pi_sub_1','sub_legacy_1',5000,'USD','completed','pro','{}',?)`).run(u.id, u.email, sameMs);
    // Newer row (higher rowid), SAME created_at: the one-time pass.
    d.prepare(`INSERT INTO payments (user_id, email, provider, provider_payment_id, provider_subscription_id, amount, currency, status, tier_granted, metadata, created_at)
               VALUES (?,?,'stripe','pi_pass_1',NULL,5000,'USD','completed','pro','{}',?)`).run(u.id, u.email, sameMs);
    // Without the rowid tiebreak SQLite may return either row, and picking
    // the subscription would offer a pass holder a Cancel button that 404s.
    expect(payments.isSubscriptionBackedTier(u.id, 'pro')).toBe(false);
  });

  it('a genuine subscriber recorded after an old pass still reads as recurring', () => {
    const u = makeUser('max');
    const d = db.getDB();
    const sameMs = Date.now();
    d.prepare(`INSERT INTO payments (user_id, email, provider, provider_payment_id, provider_subscription_id, amount, currency, status, tier_granted, metadata, created_at)
               VALUES (?,?,'stripe','pi_pass_2',NULL,8900,'USD','completed','max','{}',?)`).run(u.id, u.email, sameMs);
    d.prepare(`INSERT INTO payments (user_id, email, provider, provider_payment_id, provider_subscription_id, amount, currency, status, tier_granted, metadata, created_at)
               VALUES (?,?,'stripe','pi_sub_2','sub_legacy_2',8900,'USD','completed','max','{}',?)`).run(u.id, u.email, sameMs);
    expect(payments.isSubscriptionBackedTier(u.id, 'max')).toBe(true);
  });

  it('ultra is always recurring regardless of the ledger', () => {
    const u = makeUser('ultra', { expires_at: -1, sessions_limit: -1 });
    expect(payments.isSubscriptionBackedTier(u.id, 'ultra')).toBe(true);
  });
});

// ━━━ F. correct under EITHER webhook API version ━━━━━━━━━━━━━━━━━━━━━
describe('F. Stripe payload compat (2023-10-16 ⇄ 2025-03-31.basil)', () => {
  it('subscriptionPeriodEnd reads both shapes', () => {
    expect(subscriptionPeriodEnd({ current_period_end: 111 })).toBe(111);
    // Basil: the field lives on each item.
    expect(subscriptionPeriodEnd({ items: { data: [{ current_period_end: 222 }] } })).toBe(222);
    // Multi-item → the furthest end is the honest "access until".
    expect(subscriptionPeriodEnd({ items: { data: [{ current_period_end: 222 }, { current_period_end: 333 }] } })).toBe(333);
    expect(subscriptionPeriodEnd({})).toBe(null);
    expect(subscriptionPeriodEnd(null)).toBe(null);
  });

  it('invoicePaymentIntentId reads both shapes', () => {
    expect(invoicePaymentIntentId({ payment_intent: 'pi_a' })).toBe('pi_a');
    expect(invoicePaymentIntentId({ payment_intent: { id: 'pi_b' } })).toBe('pi_b'); // expanded
    expect(invoicePaymentIntentId({ payments: { data: [{ payment: { payment_intent: 'pi_c' } }] } })).toBe('pi_c');
    expect(invoicePaymentIntentId({})).toBe(null);
  });

  it('invoiceSubscriptionId reads both shapes', () => {
    expect(invoiceSubscriptionId({ subscription: 'sub_a' })).toBe('sub_a');
    expect(invoiceSubscriptionId({ parent: { subscription_details: { subscription: 'sub_b' } } })).toBe('sub_b');
    expect(invoiceSubscriptionId({})).toBe(null);
  });

  it('latestRefundFor falls back to a list call when refunds are not expanded', async () => {
    const inline = { id: 're_inline', amount: 500 };
    expect(await latestRefundFor(null, { id: 'ch_1', refunds: { data: [inline] } })).toBe(inline);

    let listCalls = 0;
    const fakeStripe = { refunds: { list: async () => { listCalls++; return { data: [{ id: 're_listed', amount: 700 }] }; } } };
    const got = await latestRefundFor(fakeStripe, { id: 'ch_2' }); // Basil: no refunds field
    expect(got.id).toBe('re_listed');
    expect(listCalls).toBe(1);

    // A failing list must degrade to null, never throw inside the handler.
    const brokenStripe = { refunds: { list: async () => { throw new Error('network'); } } };
    expect(await latestRefundFor(brokenStripe, { id: 'ch_3' })).toBe(null);
  });

  it('a BASIL-shaped renewal invoice still records both ids on the payment row', async () => {
    const u = makeUser('ultra', { expires_at: -1, sessions_limit: -1, customerId: `cus_blh_f_${seq + 1}` });
    seq += 1;
    await webhooks.handleStripeEvent({
      id: `evt_blh_f_${seq}`, type: 'invoice.payment_succeeded', created: nextCreated(),
      api_version: '2025-03-31.basil',
      data: { object: {
        id: `in_blh_${seq}`, customer: u.customer, billing_reason: 'subscription_cycle',
        amount_paid: 15900, currency: 'usd',
        // No payment_intent / subscription at the top level — the Basil shape.
        payments: { data: [{ payment: { payment_intent: `pi_basil_${seq}` } }] },
        parent: { subscription_details: { subscription: `sub_basil_${seq}` } },
      } },
    });
    const rows = db.getPaymentsByUser(u.id);
    const cycle = rows.find(r => r.provider_payment_id === `pi_basil_${seq}`);
    expect(cycle, 'the renewal row must carry the PaymentIntent id').toBeTruthy();
    expect(cycle.provider_subscription_id).toBe(`sub_basil_${seq}`);
    // …which is exactly what lets a later refund/chargeback find the user.
    expect(db.getUserByProviderPaymentId('stripe', `pi_basil_${seq}`)?.id).toBe(u.id);
    expect(db.getUserByProviderSubscriptionId('stripe', `sub_basil_${seq}`)?.id).toBe(u.id);
  });

  it('a BASIL-shaped cancel-at-period-end still produces a real cycle-end date', async () => {
    const u = makeUser('ultra', { expires_at: -1, sessions_limit: -1, customerId: `cus_blh_g_${seq + 1}` });
    seq += 1;
    const endSec = Math.floor(Date.now() / 1000) + 12 * 86400;
    await webhooks.handleStripeEvent({
      id: `evt_blh_g_${seq}`, type: 'customer.subscription.updated', created: nextCreated(),
      api_version: '2025-03-31.basil',
      data: { object: {
        id: `sub_blh_g_${seq}`, customer: u.customer, status: 'active',
        cancel_at_period_end: true,
        items: { data: [{ current_period_end: endSec }] }, // Basil location
        metadata: { tier: 'ultra' },
      } },
    });
    const lic = db.getLicenseByUserId(u.id);
    expect(lic.status).toBe('canceling');
    expect(lic.expires_at).toBe(endSec * 1000); // the REAL date, not the fallback
  });
});
