// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ADMIN GRANTS NEVER EXPIRE (2026-08 owner rule)
//
//  "If an admin activates any plan for a user, their credits are equal to
//   Enterprise, so they never expire, until the admin updates their plan."
//
//  The sentinels alone could not express that, and the gap was REAL, not
//  theoretical — reproduced before the fix:
//
//    user once had a Stripe subscription
//      → admin comps them onto Ultra (expires_at -1, credits -1)
//      → that OLD subscription finally reports canceled at the provider
//      → customer.subscription.updated(canceled) writes tier='free',
//        status='expired' unconditionally
//      → the comp is gone, and the person an admin deliberately gave
//        access to is locked out of the product.
//
//  Same for customer.subscription.deleted, a Razorpay halt, a refund or a
//  dispute on an old charge, and the 5-minute cycle-end sweeper.
//
//  Why an explicit column and not a sentinel check: an admin comp and a
//  migration-era legacy Pro/Max SUBSCRIBER look identical on the row (both
//  carry expires_at = -1 and credits_remaining_seconds = -1). Downgrading
//  the legacy subscriber when their subscription really ends is CORRECT.
//  Only `admin_granted_at` tells the two apart.
//
//  The guard lives at the two chokepoints every downgrade funnels through —
//  db.updateUserTier (which writes licenses.tier directly) and
//  db.updateLicenseOnPayment — plus db.transitionLicenseToFree for the
//  sweeper. These tests drive the REAL webhook handlers, not the guards.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';

process.env.DATABASE_PATH = ':memory:';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const require = createRequire(import.meta.url);
const db = require('../src/database.js');
const webhooks = require('../src/routes/webhooks.js')._test;

let seq = 0;
let clock = Math.floor(Date.now() / 1000);
const nextCreated = () => ++clock;

// Grants exactly the way routes/admin.js handleChangeTier does.
function adminGrant(tier, { customerId = null, razorpaySub = null } = {}) {
  seq += 1;
  const id = `u_ag_${seq}`;
  const email = `${id}@test.example`;
  db.createUser({ id, email, name: 'AG', password: 'pw-123456', tier: 'free', country_code: 'US' });
  db.createLicense({
    key: `LIC-${id}`, user_id: id, email, tier: 'free', status: 'trial',
    country_code: 'US', expires_at: Date.now() + 30 * 86400000, sessions_limit: 5,
  });
  if (customerId) {
    db.getDB().prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?').run(customerId, id);
  }
  if (razorpaySub) {
    db.setRazorpaySubscriptionId(id, razorpaySub);
  }
  db.updateUserTier(id, tier, { adminOverride: true });
  db.updateLicenseOnPayment(id, {
    tier, status: 'active', expires_at: -1, sessions_limit: -1,
    credits_remaining_seconds: -1, credits_expire_at: -1,
    admin_granted_at: Date.now(), admin_override: true,
  });
  return { id, email };
}

const lic = (id) => db.getLicenseByUserId(id);
const stillGranted = (id, tier) => {
  const l = lic(id);
  return l.tier === tier
    && l.status === 'active'
    && l.expires_at === -1
    && l.credits_remaining_seconds === -1
    && db.resolveTimeBucket(l).source === 'unlimited';
};

beforeAll(() => { db.getDB(); });

describe('the marker itself', () => {
  it('an admin grant is stamped, on every tier', () => {
    for (const tier of ['basic', 'pro', 'max', 'ultra', 'enterprise']) {
      const u = adminGrant(tier);
      expect(lic(u.id).admin_granted_at).toBeGreaterThan(0);
      expect(stillGranted(u.id, tier)).toBe(true);
    }
  });

  it('a comp through recordCompPayment is stamped too', () => {
    seq += 1;
    const id = `u_ag_comp_${seq}`;
    db.createUser({ id, email: `${id}@test.example`, name: 'C', password: 'pw-123456', tier: 'free', country_code: 'US' });
    db.createLicense({ key: `LIC-${id}`, user_id: id, email: `${id}@test.example`, tier: 'free',
      status: 'trial', country_code: 'US', expires_at: Date.now() + 30 * 86400000, sessions_limit: 5 });
    db.recordCompPayment(id, 'ultra', 'test comp');
    expect(lic(id).admin_granted_at).toBeGreaterThan(0);
  });

  it('an ordinary customer purchase is NOT stamped', () => {
    seq += 1;
    const id = `u_ag_cust_${seq}`;
    db.createUser({ id, email: `${id}@test.example`, name: 'P', password: 'pw-123456', tier: 'free', country_code: 'US' });
    db.createLicense({ key: `LIC-${id}`, user_id: id, email: `${id}@test.example`, tier: 'free',
      status: 'trial', country_code: 'US', expires_at: Date.now() + 30 * 86400000, sessions_limit: 5 });
    const grant = webhooks.grantConfigForTier('pro');
    db.updateUserTier(id, 'pro');
    db.updateLicenseOnPayment(id, { ...grant, status: 'active' });
    expect(lic(id).admin_granted_at || 0).toBe(0);
  });
});

describe('provider lifecycle events cannot take an admin grant away', () => {
  it('Stripe customer.subscription.updated → canceled', async () => {
    const u = adminGrant('ultra', { customerId: 'cus_ag_1' });
    await webhooks.handleStripeEvent({
      id: 'evt_ag_1', type: 'customer.subscription.updated', created: nextCreated(),
      data: { object: { id: 'sub_ag_old_1', customer: 'cus_ag_1', status: 'canceled',
        cancel_at_period_end: false, metadata: { tier: 'pro' } } },
    });
    expect(stillGranted(u.id, 'ultra')).toBe(true);
  });

  it('Stripe customer.subscription.deleted', async () => {
    const u = adminGrant('enterprise', { customerId: 'cus_ag_2' });
    await webhooks.handleStripeEvent({
      id: 'evt_ag_2', type: 'customer.subscription.deleted', created: nextCreated(),
      data: { object: { id: 'sub_ag_old_2', customer: 'cus_ag_2', status: 'canceled', metadata: { tier: 'pro' } } },
    });
    expect(stillGranted(u.id, 'enterprise')).toBe(true);
  });

  it('Stripe customer.subscription.updated → unpaid (dunning exhausted)', async () => {
    const u = adminGrant('max', { customerId: 'cus_ag_3' });
    await webhooks.handleStripeEvent({
      id: 'evt_ag_3', type: 'customer.subscription.updated', created: nextCreated(),
      data: { object: { id: 'sub_ag_old_3', customer: 'cus_ag_3', status: 'unpaid',
        cancel_at_period_end: false, metadata: { tier: 'pro' } } },
    });
    expect(stillGranted(u.id, 'max')).toBe(true);
  });

  it('Razorpay subscription.cancelled', async () => {
    const u = adminGrant('ultra', { razorpaySub: 'sub_rzp_ag_1' });
    await webhooks.handleRazorpayEvent({
      event: 'subscription.cancelled', created_at: nextCreated(),
      payload: { subscription: { entity: { id: 'sub_rzp_ag_1', notes: { user_email: u.email } } } },
    });
    expect(stillGranted(u.id, 'ultra')).toBe(true);
  });

  it('Razorpay subscription.halted', async () => {
    const u = adminGrant('pro', { razorpaySub: 'sub_rzp_ag_2' });
    await webhooks.handleRazorpayEvent({
      event: 'subscription.halted', created_at: nextCreated(),
      payload: { subscription: { entity: { id: 'sub_rzp_ag_2', notes: { user_email: u.email } } } },
    });
    expect(stillGranted(u.id, 'pro')).toBe(true);
  });
});

describe('the sweeper and the validate-lapse repair cannot either', () => {
  it('transitionLicenseToFree refuses an admin-granted plan', () => {
    const u = adminGrant('ultra');
    const res = db.transitionLicenseToFree(u.id, { reason: 'sweep' });
    expect(res).toBe(false);
    expect(stillGranted(u.id, 'ultra')).toBe(true);
  });

  it('…but still transitions an ORDINARY lapsed plan (no collateral damage)', () => {
    seq += 1;
    const id = `u_ag_ord_${seq}`;
    db.createUser({ id, email: `${id}@test.example`, name: 'O', password: 'pw-123456', tier: 'pro', country_code: 'US' });
    db.createLicense({ key: `LIC-${id}`, user_id: id, email: `${id}@test.example`, tier: 'pro',
      status: 'canceling', country_code: 'US', expires_at: Date.now() - 1000, sessions_limit: 1 });
    const res = db.transitionLicenseToFree(id, { reason: 'sweep' });
    expect(res && res.transitioned).toBe(true);
    expect(lic(id).tier).toBe('free');
  });

  it('the sweeper query never selects an admin grant anyway (status is active)', () => {
    const u = adminGrant('enterprise');
    expect(db.getExpiredCancelingUserIds(500)).not.toContain(u.id);
  });
});

describe('an admin can still change the plan — that is the whole carve-out', () => {
  it('admin moves a granted user down to free', () => {
    const u = adminGrant('enterprise');
    // Exactly what routes/admin.js handleChangeTier does for tier='free'.
    db.updateUserTier(u.id, 'free', { adminOverride: true });
    db.updateLicenseOnPayment(u.id, {
      tier: 'free', status: 'active', expires_at: Date.now() + 30 * 86400000, sessions_limit: 5,
      credits_remaining_seconds: 0, credits_expire_at: 0,
      admin_granted_at: 0, admin_override: true,
    });
    const l = lic(u.id);
    expect(l.tier).toBe('free');
    expect(l.admin_granted_at).toBe(0);
  });

  it('admin moves a granted user to a DIFFERENT paid plan', () => {
    const u = adminGrant('basic');
    db.updateUserTier(u.id, 'enterprise', { adminOverride: true });
    db.updateLicenseOnPayment(u.id, {
      tier: 'enterprise', status: 'active', expires_at: -1, sessions_limit: -1,
      credits_remaining_seconds: -1, credits_expire_at: -1,
      admin_granted_at: Date.now(), admin_override: true,
    });
    expect(stillGranted(u.id, 'enterprise')).toBe(true);
  });

  it('once cleared, the account downgrades normally again', () => {
    const u = adminGrant('ultra');
    db.updateLicenseOnPayment(u.id, {
      tier: 'free', status: 'active', expires_at: Date.now() + 30 * 86400000, sessions_limit: 5,
      credits_remaining_seconds: 0, credits_expire_at: 0,
      admin_granted_at: 0, admin_override: true,
    });
    db.updateUserTier(u.id, 'pro');
    db.updateLicenseOnPayment(u.id, { ...webhooks.grantConfigForTier('pro'), status: 'active' });
    expect(lic(u.id).admin_granted_at || 0).toBe(0);
    // No marker → an ordinary revocation lands as it always did.
    db.updateUserTier(u.id, 'free');
    expect(lic(u.id).tier).toBe('free');
  });
});

describe('ordinary customers are unaffected — the guard is not a blanket block', () => {
  it('a real canceled subscription still downgrades', async () => {
    seq += 1;
    const id = `u_ag_real_${seq}`;
    const email = `${id}@test.example`;
    db.createUser({ id, email, name: 'R', password: 'pw-123456', tier: 'ultra', country_code: 'US' });
    db.createLicense({ key: `LIC-${id}`, user_id: id, email, tier: 'ultra', status: 'active',
      country_code: 'US', expires_at: -1, sessions_limit: -1 });
    db.getDB().prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?').run('cus_ag_real', id);
    await webhooks.handleStripeEvent({
      id: `evt_ag_real_${seq}`, type: 'customer.subscription.deleted', created: nextCreated(),
      data: { object: { id: 'sub_ag_real', customer: 'cus_ag_real', status: 'canceled', metadata: { tier: 'ultra' } } },
    });
    expect(lic(id).tier).toBe('free');
  });

  it('a legacy pro sub carrying the -1 sentinels still downgrades', async () => {
    // The exact row an admin comp is indistinguishable from WITHOUT the
    // marker. It must keep downgrading, or the guard has quietly made every
    // legacy subscriber un-cancellable.
    seq += 1;
    const id = `u_ag_legacy_${seq}`;
    const email = `${id}@test.example`;
    db.createUser({ id, email, name: 'L', password: 'pw-123456', tier: 'pro', country_code: 'US' });
    db.createLicense({ key: `LIC-${id}`, user_id: id, email, tier: 'pro', status: 'active',
      country_code: 'US', expires_at: -1, sessions_limit: -1 });
    db.getDB().prepare('UPDATE licenses SET credits_remaining_seconds = -1, credits_expire_at = -1 WHERE user_id = ?').run(id);
    db.getDB().prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?').run('cus_ag_legacy', id);
    expect(lic(id).admin_granted_at || 0).toBe(0);
    await webhooks.handleStripeEvent({
      id: `evt_ag_legacy_${seq}`, type: 'customer.subscription.deleted', created: nextCreated(),
      data: { object: { id: 'sub_ag_legacy', customer: 'cus_ag_legacy', status: 'canceled', metadata: { tier: 'pro' } } },
    });
    expect(lic(id).tier).toBe('free');
  });
});

describe('refunds and disputes on OLD charges cannot take a grant away', () => {
  it('Stripe charge.refunded (full) leaves an admin grant intact', async () => {
    const u = adminGrant('ultra', { customerId: 'cus_ag_ref' });
    // A completed plan purchase from BEFORE the comp — refunding it is
    // exactly the "old charge, unrelated to the comp" case.
    db.recordPayment({
      user_id: u.id, email: u.email, provider: 'stripe',
      provider_payment_id: 'pi_ag_ref', provider_subscription_id: null,
      amount: 5000, currency: 'USD', status: 'completed', tier_granted: 'pro',
      metadata: {},
    });
    await webhooks.handleStripeEvent({
      id: 'evt_ag_ref', type: 'charge.refunded', created: nextCreated(),
      data: { object: {
        id: 'ch_ag_ref', payment_intent: 'pi_ag_ref', customer: 'cus_ag_ref',
        amount: 5000, amount_refunded: 5000, currency: 'usd',
        refunds: { data: [{ id: 're_ag_ref', amount: 5000, reason: 'requested_by_customer' }] },
      } },
    });
    expect(stillGranted(u.id, 'ultra')).toBe(true);
  });

  it('Stripe charge.dispute.created leaves an admin grant intact', async () => {
    const u = adminGrant('enterprise', { customerId: 'cus_ag_dis' });
    db.recordPayment({
      user_id: u.id, email: u.email, provider: 'stripe',
      provider_payment_id: 'pi_ag_dis', provider_subscription_id: null,
      amount: 8900, currency: 'USD', status: 'completed', tier_granted: 'max',
      metadata: {},
    });
    await webhooks.handleStripeEvent({
      id: 'evt_ag_dis', type: 'charge.dispute.created', created: nextCreated(),
      data: { object: {
        id: 'dp_ag_dis', charge: 'ch_ag_dis', payment_intent: 'pi_ag_dis',
        amount: 8900, currency: 'usd', reason: 'fraudulent', status: 'warning_needs_response',
      } },
    });
    expect(stillGranted(u.id, 'enterprise')).toBe(true);
  });
});
