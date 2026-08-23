// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ENTERPRISE + METERED ULTRA (2026-08-22)
//
//  Two changes shipped together, and every failure mode below is one of
//  them leaking into the other:
//
//   1. ENTERPRISE — $1199/mo, the Team tab's only plan. Unlimited
//      interview time that never expires, every model, Auto-Type.
//   2. ULTRA became METERED — 9 hours per billing cycle instead of
//      "unlimited", re-seeded on each paid renewal.
//
//  What makes (2) dangerous is that an Ultra license row carries
//  `expires_at: -1` — a SUBSCRIPTION sentinel meaning "no end date" — and
//  the old code read any -1 on the row as "unlimited time". Leave that
//  reading in place and every metered Ultra is silently unlimited, i.e.
//  the $1199 plan is being given away for $159. Invert it carelessly and
//  the EXISTING Ultra subscribers, whose rows carry the -1 credit
//  sentinel, get cut to a meter mid-cycle. Both directions are pinned
//  here.
//
//  The other sharp edge is refills. While Ultra's balance was the
//  constant -1, writing it again on any lifecycle event was a no-op, so
//  the webhook layer had ONE credit rule. With a real balance, that same
//  rule becomes a free refill: customer.subscription.updated fires on
//  cancel AND on reactivate, so burn-9h → cancel → reactivate would have
//  been an unlimited loop. Hence creditsForLifecycleGrant (re-affirm,
//  never re-seed a meter) vs creditsForBillingCycle (a paid cycle, which
//  re-seeds). Both are pinned, in both directions.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';

process.env.DATABASE_PATH = ':memory:';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
process.env.ADMIN_EMAILS = 'owner@minicaai.test';
// Ultra's metering is behind a kill-switch while un-updated desktop clients
// are still in the field (they read tier==='ultra' as unlimited, so metering
// them server-side shows time in the app that the server will not honour).
// This file tests the METERED product, so it turns the flag on; the OFF
// default is pinned in its own block at the bottom.
process.env.ULTRA_METERED = 'true';

const require = createRequire(import.meta.url);
const db = require('../src/database.js');
const webhooks = require('../src/routes/webhooks.js')._test;
const payments = require('../src/routes/payments.js')._test;
const { evaluateTier } = require('../src/middleware/tier.js');
const { readFileSync } = require('node:fs');
const { resolve, dirname } = require('node:path');
const { fileURLToPath } = require('node:url');
const __dirnameEnt = dirname(fileURLToPath(import.meta.url));

const HOUR = 3600;
const ULTRA_CYCLE = 9 * HOUR;

let seq = 0;
function makeUser(tier, licensePatch = {}) {
  seq += 1;
  const id = `u_ent_${seq}`;
  const email = `${id}@test.example`;
  db.createUser({ id, email, name: 'Ent Tester', password: 'pw-123456', tier, country_code: 'US' });
  db.createLicense({
    key: `LIC-${id}`,
    user_id: id,
    email,
    tier,
    status: tier === 'free' ? 'trial' : 'active',
    country_code: 'US',
    expires_at: tier === 'ultra' || tier === 'enterprise' ? -1 : Date.now() + 30 * 86400000,
    sessions_limit: tier === 'free' ? 5 : 1,
  });
  if (Object.keys(licensePatch).length) {
    const sets = Object.keys(licensePatch).map(k => `${k} = ?`).join(', ');
    db.getDB().prepare(`UPDATE licenses SET ${sets} WHERE user_id = ?`)
      .run(...Object.values(licensePatch), id);
  }
  return { id, email };
}

const lic = (id) => db.getLicenseByUserId(id);

beforeAll(() => { db.getDB(); });

// ─── The two grant configs ──────────────────────────────────────────────

describe('grant config — what each plan actually seeds', () => {
  it('ultra: 9 hours, no credit window, subscription has no end date', () => {
    const g = payments.grantConfigForTier('ultra');
    expect(g.credits_remaining_seconds).toBe(ULTRA_CYCLE);
    // 0, not -1. -1 is the UNLIMITED sentinel; using it here as "no window"
    // would make every Ultra unlimited via isUnlimitedLicenseRow.
    expect(g.credits_expire_at).toBe(0);
    expect(g.expires_at).toBe(-1);
  });

  it('enterprise: the unlimited sentinel on both credit fields', () => {
    const g = payments.grantConfigForTier('enterprise');
    expect(g.credits_remaining_seconds).toBe(-1);
    expect(g.credits_expire_at).toBe(-1);
    expect(g.expires_at).toBe(-1);
  });

  it('the passes are untouched by the change', () => {
    expect(payments.grantConfigForTier('basic').credits_remaining_seconds).toBe(1800);
    expect(payments.grantConfigForTier('pro').credits_remaining_seconds).toBe(HOUR);
    expect(payments.grantConfigForTier('max').credits_remaining_seconds).toBe(3 * HOUR);
  });

  it('payments.js and webhooks.js agree (they are duplicated on purpose)', () => {
    for (const t of ['basic', 'pro', 'max', 'ultra', 'enterprise']) {
      const a = payments.grantConfigForTier(t);
      const b = webhooks.grantConfigForTier(t);
      // The time-independent fields must match exactly.
      expect({
        tier: b.tier, sessions_limit: b.sessions_limit,
        credits_remaining_seconds: b.credits_remaining_seconds,
      }).toEqual({
        tier: a.tier, sessions_limit: a.sessions_limit,
        credits_remaining_seconds: a.credits_remaining_seconds,
      });
      // The window fields are computed from Date.now() INSIDE each function,
      // so two calls a millisecond apart legitimately differ by a
      // millisecond. Comparing them with toEqual made this test flaky under
      // full-suite load while passing in isolation — compare the shape
      // (sentinel vs real timestamp) and allow a small clock delta.
      for (const field of ['expires_at', 'credits_expire_at']) {
        if (a[field] <= 0) {
          expect(b[field], `${t}.${field} sentinel`).toBe(a[field]);
        } else {
          expect(b[field], `${t}.${field} is a real window`).toBeGreaterThan(0);
          expect(Math.abs(b[field] - a[field]), `${t}.${field} within 2s`).toBeLessThan(2000);
        }
      }
    }
  });
});

// ─── The unlimited predicate ────────────────────────────────────────────

describe('who is unlimited', () => {
  it('enterprise is, by definition', () => {
    const u = makeUser('enterprise', { credits_remaining_seconds: -1, credits_expire_at: -1 });
    expect(db.resolveTimeBucket(lic(u.id))).toEqual({ source: 'unlimited', remaining: -1 });
  });

  it('a metered ultra is NOT — despite carrying expires_at = -1', () => {
    // THE regression this file exists for. expires_at:-1 says the
    // subscription has no end date; it does not say the time is free.
    const u = makeUser('ultra', { credits_remaining_seconds: ULTRA_CYCLE, credits_expire_at: 0 });
    expect(lic(u.id).expires_at).toBe(-1);
    expect(db.resolveTimeBucket(lic(u.id))).toEqual({ source: 'credits', remaining: ULTRA_CYCLE });
  });

  it('a LEGACY ultra carrying the -1 credit sentinel still is (grandfathered)', () => {
    const u = makeUser('ultra', { credits_remaining_seconds: -1, credits_expire_at: -1 });
    expect(db.resolveTimeBucket(lic(u.id))).toEqual({ source: 'unlimited', remaining: -1 });
  });

  it('legacy pro/max subs keep their migration-era unlimited balance', () => {
    for (const t of ['pro', 'max']) {
      const u = makeUser(t, { credits_remaining_seconds: -1, credits_expire_at: -1, expires_at: -1 });
      expect(db.resolveTimeBucket(lic(u.id)).source).toBe('unlimited');
    }
  });

  it('an exhausted ultra reports 0, not unlimited', () => {
    const u = makeUser('ultra', { credits_remaining_seconds: 0, credits_expire_at: 0 });
    expect(db.resolveTimeBucket(lic(u.id))).toEqual({ source: 'credits', remaining: 0 });
  });
});

// ─── Consumption ────────────────────────────────────────────────────────

describe('the interview clock', () => {
  it('charges an ultra session against its 9 hours', () => {
    const u = makeUser('ultra', { credits_remaining_seconds: ULTRA_CYCLE, credits_expire_at: 0 });
    const started = db.startUsageSession(u.id, 'dev-1');
    expect(started.source).toBe('credits');
    expect(started.remaining).toBe(ULTRA_CYCLE);
    db.getDB().prepare('UPDATE usage_sessions SET last_heartbeat_at = ? WHERE id = ?')
      .run(Date.now() - 600 * 1000, started.session_id);
    const beat = db.heartbeatUsageSession(u.id, started.session_id);
    expect(beat.charged).toBeGreaterThan(0);
    expect(beat.remaining).toBeLessThan(ULTRA_CYCLE);
  });

  it('charges an enterprise session nothing', () => {
    const u = makeUser('enterprise', { credits_remaining_seconds: -1, credits_expire_at: -1 });
    const started = db.startUsageSession(u.id, 'dev-1');
    expect(started.source).toBe('unlimited');
    db.getDB().prepare('UPDATE usage_sessions SET last_heartbeat_at = ? WHERE id = ?')
      .run(Date.now() - 600 * 1000, started.session_id);
    const beat = db.heartbeatUsageSession(u.id, started.session_id);
    expect(beat.charged).toBe(0);
    expect(beat.remaining).toBe(-1);
  });
});

// ─── Top-ups ────────────────────────────────────────────────────────────

describe('top-ups on a subscription', () => {
  it('an ultra top-up ADDS time and leaves the subscription row intact', () => {
    // The pass arithmetic (expires_at = now + pack, sessions_limit + 1,
    // stale-window balance reset) is destructive on a subscription row in
    // three separate ways, each of which locks the subscriber out:
    //   expires_at  -1 → now+30min  → tier gate says "expired" 30 min later
    //   sessions_limit -1 → 0        → canStartSession compares used < 0
    //   credits_expire_at 0 → the stale-window test drops the 9-hour balance
    const u = makeUser('ultra', {
      credits_remaining_seconds: 600,
      credits_granted_seconds: ULTRA_CYCLE,
      credits_expire_at: 0,
      sessions_limit: -1,
    });
    const after = db.grantTimeExtension(u.id, 1800);
    expect(after.credits_remaining_seconds).toBe(600 + 1800);   // added, not replaced
    expect(after.credits_granted_seconds).toBe(ULTRA_CYCLE + 1800);
    expect(after.expires_at).toBe(-1);                          // still no end date
    expect(after.sessions_limit).toBe(-1);                      // still unlimited sessions
    expect(after.credits_expire_at).toBe(0);                    // still no window
    expect(db.resolveTimeBucket(after)).toEqual({ source: 'credits', remaining: 2400 });
  });

  it('an enterprise top-up is a no-op — there is nothing to add to', () => {
    const u = makeUser('enterprise', { credits_remaining_seconds: -1, credits_expire_at: -1 });
    const after = db.grantTimeExtension(u.id, 1800);
    expect(after.credits_remaining_seconds).toBe(-1);
    expect(db.resolveTimeBucket(after).source).toBe('unlimited');
  });

  it('a pass top-up still moves its window (unchanged behaviour)', () => {
    const windowEnd = Date.now() + 10 * 86400000;
    const u = makeUser('pro', {
      credits_remaining_seconds: 600,
      credits_granted_seconds: HOUR,
      credits_expire_at: windowEnd,
      expires_at: windowEnd,
      sessions_limit: 1,
    });
    const after = db.grantTimeExtension(u.id, 1800);
    expect(after.credits_remaining_seconds).toBe(2400);
    expect(after.expires_at).toBeGreaterThan(windowEnd);
    expect(after.sessions_limit).toBe(2);
  });
});

// ─── The refill hole ────────────────────────────────────────────────────

describe('cancel → reactivate must not refill Ultra', () => {
  it('creditsForLifecycleGrant returns nothing for a metered tier', () => {
    expect(webhooks.creditsForLifecycleGrant(webhooks.grantConfigForTier('ultra'))).toEqual({});
    expect(payments.creditsForReaffirm(payments.grantConfigForTier('ultra'))).toEqual({});
  });

  it('…but re-affirms enterprise\'s constant sentinel (idempotent)', () => {
    expect(webhooks.creditsForLifecycleGrant(webhooks.grantConfigForTier('enterprise')))
      .toEqual({ credits_remaining_seconds: -1, credits_expire_at: -1 });
    expect(payments.creditsForReaffirm(payments.grantConfigForTier('enterprise')))
      .toEqual({ credits_remaining_seconds: -1, credits_expire_at: -1 });
  });

  it('a PAID cycle does re-seed — that is what "9 hours a month" means', () => {
    expect(webhooks.creditsForBillingCycle(webhooks.grantConfigForTier('ultra')))
      .toEqual({ credits_remaining_seconds: ULTRA_CYCLE, credits_expire_at: 0 });
  });

  it('an upgrade seeds the new plan (it is a real, prorated plan change)', () => {
    expect(payments.creditsForPlanChange(payments.grantConfigForTier('ultra')))
      .toEqual({ credits_remaining_seconds: ULTRA_CYCLE, credits_expire_at: 0 });
    expect(payments.creditsForPlanChange(payments.grantConfigForTier('enterprise')))
      .toEqual({ credits_remaining_seconds: -1, credits_expire_at: -1 });
    // Never for a pass — that would clobber a legacy sub's unlimited balance.
    expect(payments.creditsForPlanChange(payments.grantConfigForTier('pro'))).toEqual({});
  });
});

// ─── The monthly re-seed, through the real webhook ──────────────────────

describe('invoice.payment_succeeded re-seeds the cycle', () => {
  it('puts an exhausted Ultra back to 9 hours', async () => {
    const u = makeUser('ultra', { credits_remaining_seconds: 0, credits_expire_at: 0 });
    db.getDB().prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?').run('cus_reseed', u.id);
    await webhooks.handleStripeEvent({
      id: 'evt_reseed_1',
      type: 'invoice.payment_succeeded',
      created: Math.floor(Date.now() / 1000),
      data: { object: {
        id: 'in_reseed_1', customer: 'cus_reseed', billing_reason: 'subscription_cycle',
        amount_paid: 15900, currency: 'usd', payment_intent: 'pi_reseed_1', subscription: 'sub_reseed_1',
      } },
    });
    const after = lic(u.id);
    expect(after.credits_remaining_seconds).toBe(ULTRA_CYCLE);
    expect(after.tier).toBe('ultra');
    expect(after.expires_at).toBe(-1);
  });

  it('does NOT roll over — 9 hours is a reset, not an addition', async () => {
    const u = makeUser('ultra', { credits_remaining_seconds: 5 * HOUR, credits_expire_at: 0 });
    db.getDB().prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?').run('cus_rollover', u.id);
    await webhooks.handleStripeEvent({
      id: 'evt_reseed_2',
      type: 'invoice.payment_succeeded',
      created: Math.floor(Date.now() / 1000),
      data: { object: {
        id: 'in_reseed_2', customer: 'cus_rollover', billing_reason: 'subscription_cycle',
        amount_paid: 15900, currency: 'usd', payment_intent: 'pi_reseed_2', subscription: 'sub_reseed_2',
      } },
    });
    expect(lic(u.id).credits_remaining_seconds).toBe(ULTRA_CYCLE);
  });

  it('leaves a one-time PASS alone (a stray invoice must not reset a pass clock)', async () => {
    const windowEnd = Date.now() + 10 * 86400000;
    const u = makeUser('pro', { credits_remaining_seconds: 900, credits_expire_at: windowEnd });
    db.getDB().prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?').run('cus_pass', u.id);
    await webhooks.handleStripeEvent({
      id: 'evt_reseed_3',
      type: 'invoice.payment_succeeded',
      created: Math.floor(Date.now() / 1000),
      data: { object: {
        id: 'in_reseed_3', customer: 'cus_pass', billing_reason: 'subscription_cycle',
        amount_paid: 5000, currency: 'usd', payment_intent: 'pi_reseed_3', subscription: 'sub_reseed_3',
      } },
    });
    expect(lic(u.id).credits_remaining_seconds).toBe(900);
    expect(lic(u.id).credits_expire_at).toBe(windowEnd);
  });

  it('skips the very first invoice (checkout.session.completed already granted it)', async () => {
    const u = makeUser('ultra', { credits_remaining_seconds: 1234, credits_expire_at: 0 });
    db.getDB().prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?').run('cus_first', u.id);
    await webhooks.handleStripeEvent({
      id: 'evt_reseed_4',
      type: 'invoice.payment_succeeded',
      created: Math.floor(Date.now() / 1000),
      data: { object: {
        id: 'in_reseed_4', customer: 'cus_first', billing_reason: 'subscription_create',
        amount_paid: 15900, currency: 'usd', payment_intent: 'pi_reseed_4', subscription: 'sub_reseed_4',
      } },
    });
    expect(lic(u.id).credits_remaining_seconds).toBe(1234);
  });
});

// ─── Checkout shape ─────────────────────────────────────────────────────

describe('enterprise checkout is a subscription at $1199', () => {
  it('is priced at 119900 cents and validated as recurring', () => {
    expect(payments.STRIPE_PRICE_DATA.enterprise.unit_amount).toBe(119900);
    expect(payments.STRIPE_PRICE_DATA.enterprise.recurring).toEqual({ interval: 'month' });
  });

  it('the price validator and the inline default agree', () => {
    // A mismatch between these two is a wrong charge: the validator refuses
    // an env-configured Price whose amount differs from the published one,
    // and the inline default is what a fresh deploy actually bills.
    expect(payments.EXPECTED_USD_CENTS.enterprise)
      .toBe(payments.STRIPE_PRICE_DATA.enterprise.unit_amount);
    expect(payments.EXPECTED_USD_CENTS.ultra)
      .toBe(payments.STRIPE_PRICE_DATA.ultra.unit_amount);
  });

  it('ranks above ultra so an ultra→enterprise move is an upgrade', () => {
    expect(payments.TIER_RANK.enterprise).toBeGreaterThan(payments.TIER_RANK.ultra);
    expect(payments.isTierUpgrade('ultra', 'enterprise')).toBe(true);
    expect(payments.isTierUpgrade('enterprise', 'ultra')).toBe(false);
  });

  it('is subscription-backed for the cancel/manage surfaces', () => {
    const u = makeUser('enterprise');
    expect(payments.isSubscriptionBackedTier(u.id, 'enterprise')).toBe(true);
  });
});

// ─── Double-billing guards ──────────────────────────────────────────────

describe('checkoutConflictFor with two subscription tiers', () => {
  const L = (tier, status) => ({ tier, status });

  it('an active Enterprise cannot buy Enterprise again', () => {
    const c = payments.checkoutConflictFor(L('enterprise', 'active'), true, 'enterprise');
    expect(c.code).toBe('already_subscribed');
    expect(c.httpStatus).toBe(409);
  });

  it('an active Ultra clicking Enterprise gets the in-place swap, not a 2nd sub', () => {
    const c = payments.checkoutConflictFor(L('ultra', 'active'), true, 'enterprise');
    expect(c).toEqual({ code: 'upgrade_in_place' });
  });

  it('an active Enterprise clicking Ultra also swaps in place', () => {
    const c = payments.checkoutConflictFor(L('enterprise', 'active'), true, 'ultra');
    expect(c).toEqual({ code: 'upgrade_in_place' });
  });

  it('a canceling Enterprise is pointed at reactivate', () => {
    const c = payments.checkoutConflictFor(L('enterprise', 'canceling'), true, 'enterprise');
    expect(c.suggested_action).toBe('reactivate-subscription');
    expect(c.message).toContain('Enterprise');
  });

  it('a past_due Enterprise is pointed at the card, not a second subscription', () => {
    const c = payments.checkoutConflictFor(L('enterprise', 'past_due'), true, 'enterprise');
    expect(c.code).toBe('payment_method_required');
    expect(c.message).toContain('Enterprise');
  });

  it('an Enterprise buying a one-time pass is told to cancel first', () => {
    const c = payments.checkoutConflictFor(L('enterprise', 'active'), true, 'pro');
    expect(c.code).toBe('subscription_active');
  });
});

// ─── Entitlements ───────────────────────────────────────────────────────

describe('server-side gates recognise enterprise', () => {
  const gate = (userId, tiers) => evaluateTier({ id: userId, email: `${userId}@test.example` }, tiers);

  it('Auto-Type is allowed for enterprise', () => {
    const u = makeUser('enterprise');
    expect(gate(u.id, ['ultra', 'enterprise']).ok).toBe(true);
  });

  it('Auto-Type is still denied below Ultra', () => {
    const u = makeUser('max');
    const d = gate(u.id, ['ultra', 'enterprise']);
    expect(d.ok).toBe(false);
    expect(d.status).toBe(403);
  });

  it('Claude and Train Model reach enterprise', () => {
    const u = makeUser('enterprise');
    expect(gate(u.id, ['pro', 'max', 'ultra', 'enterprise']).ok).toBe(true);
    expect(gate(u.id, ['max', 'ultra', 'enterprise']).ok).toBe(true);
  });

  it('an admin with no license row resolves to enterprise, not max', () => {
    // The placeholder used to be 'max', which silently denied admins every
    // gate above Max — including the Auto-Type routes they are meant to be
    // able to exercise.
    const d = evaluateTier({ id: 'admin-no-row', email: 'owner@minicaai.test' }, ['enterprise']);
    expect(d.ok).toBe(true);
    expect(d.license.tier).toBe('enterprise');
  });
});

// ─── Admin grants ───────────────────────────────────────────────────────

describe('an admin-activated plan is enterprise-equivalent, whatever tier is named', () => {
  // The owner's rule: when an admin puts a user on a plan, the credits are
  // Enterprise's and they never expire until an admin changes the plan.
  // The tier still decides which FEATURES the user sees.
  const grantLikeAdmin = (userId, tier) => {
    db.updateUserTier(userId, tier);
    db.updateLicenseOnPayment(userId, {
      tier,
      status: 'active',
      expires_at: -1,
      sessions_limit: -1,
      credits_remaining_seconds: -1,
      credits_expire_at: -1,
    });
  };

  for (const tier of ['basic', 'pro', 'max', 'ultra', 'enterprise']) {
    it(`${tier} granted by an admin has unlimited time that never expires`, () => {
      const u = makeUser('free');
      grantLikeAdmin(u.id, tier);
      const l = lic(u.id);
      expect(l.tier).toBe(tier);
      expect(db.resolveTimeBucket(l)).toEqual({ source: 'unlimited', remaining: -1 });
      expect(l.expires_at).toBe(-1);
      // And it stays that way: a session charges nothing against it.
      const started = db.startUsageSession(u.id, 'dev-admin');
      expect(started.source).toBe('unlimited');
    });
  }

  it('a comp grant does the same through recordCompPayment', () => {
    for (const tier of ['basic', 'pro', 'max', 'ultra', 'enterprise']) {
      const u = makeUser('free');
      const res = db.recordCompPayment(u.id, tier, 'test comp');
      expect(res).toBeTruthy();
      expect(res.tier).toBe(tier);
      expect(db.resolveTimeBucket(lic(u.id))).toEqual({ source: 'unlimited', remaining: -1 });
    }
  });

  it('an admin-granted ULTRA is NOT cut to 9 hours', () => {
    // The whole point: naming the tier 'ultra' must not drag in the
    // customer-purchase meter.
    const u = makeUser('free');
    grantLikeAdmin(u.id, 'ultra');
    expect(lic(u.id).credits_remaining_seconds).toBe(-1);
    expect(db.resolveTimeBucket(lic(u.id)).source).toBe('unlimited');
  });
});

// ─── Top-up affordance ──────────────────────────────────────────────────

describe('the top-up affordance follows the LICENSE, not a tier list', () => {
  // GET /payments/subscription reports can_extend so the Billing Hub can
  // disable the paid CTA instead of clicking it into a 403. The predicate
  // behind it used to be a hardcoded ['basic','pro','max'] — correct only
  // while those were the only tiers with a clock. A metered Ultra fell
  // outside it and lost the button its own top-up route now accepts.
  const isMetered = (l) =>
    ['basic', 'pro', 'max', 'ultra'].includes(l.tier)
    && db.resolveTimeBucket(l).source === 'credits';

  it('a metered ultra IS offered top-ups', () => {
    const u = makeUser('ultra', { credits_remaining_seconds: ULTRA_CYCLE, credits_expire_at: 0 });
    expect(isMetered(lic(u.id))).toBe(true);
  });

  it('an exhausted ultra still is — that is the whole point of a top-up', () => {
    const u = makeUser('ultra', { credits_remaining_seconds: 0, credits_expire_at: 0 });
    expect(isMetered(lic(u.id))).toBe(true);
  });

  it('enterprise is NOT (there is nothing to add to)', () => {
    const u = makeUser('enterprise', { credits_remaining_seconds: -1, credits_expire_at: -1 });
    expect(isMetered(lic(u.id))).toBe(false);
  });

  it('a grandfathered legacy ultra is NOT', () => {
    const u = makeUser('ultra', { credits_remaining_seconds: -1, credits_expire_at: -1 });
    expect(isMetered(lic(u.id))).toBe(false);
  });

  it('the passes are unchanged', () => {
    const u = makeUser('pro', { credits_remaining_seconds: 600, credits_expire_at: Date.now() + 86400000 });
    expect(isMetered(lic(u.id))).toBe(true);
  });

  it('the route source keeps the unlimited check BEFORE the tier check', () => {
    // Order matters: Enterprise is not on a metered tier either, so a
    // tier-first guard answers the person on the most expensive plan we sell
    // with "pick a plan to start".
    const src = readFileSync(resolve(__dirnameEnt, '..', 'src', 'routes', 'payments.js'), 'utf8');
    const unlimitedAt = src.indexOf('already includes unlimited interview time');
    const tierAt = src.indexOf('Top-ups extend the Basic, Pro, Max, and Ultra interview clocks');
    expect(unlimitedAt).toBeGreaterThan(-1);
    expect(tierAt).toBeGreaterThan(-1);
    expect(unlimitedAt).toBeLessThan(tierAt);
  });
});


// ─── The shipping default ───────────────────────────────────────────────

describe('with ULTRA_METERED unset, Ultra grants exactly what it did before', () => {
  // The deploy-safety default. Server code can go to production ahead of a
  // desktop release without any installed client discovering, mid-interview,
  // that the unlimited plan it is showing has actually been counting down.
  const withFlag = (value, fn) => {
    const prev = process.env.ULTRA_METERED;
    if (value === undefined) delete process.env.ULTRA_METERED;
    else process.env.ULTRA_METERED = value;
    try { return fn(); } finally {
      if (prev === undefined) delete process.env.ULTRA_METERED;
      else process.env.ULTRA_METERED = prev;
    }
  };

  it('payments.js falls back to the -1 unlimited sentinel', () => {
    withFlag(undefined, () => {
      const g = payments.grantConfigForTier('ultra');
      expect(g.credits_remaining_seconds).toBe(-1);
      expect(g.credits_expire_at).toBe(-1);
      expect(g.expires_at).toBe(-1);
    });
  });

  it('webhooks.js agrees — the two copies must not diverge on the flag either', () => {
    withFlag(undefined, () => {
      const g = webhooks.grantConfigForTier('ultra');
      expect(g.credits_remaining_seconds).toBe(-1);
      expect(g.credits_expire_at).toBe(-1);
    });
  });

  it('a grant written with the flag off reads as unlimited', () => {
    withFlag(undefined, () => {
      const g = payments.grantConfigForTier('ultra');
      const u = makeUser('free');
      db.updateUserTier(u.id, 'ultra');
      db.updateLicenseOnPayment(u.id, { ...g, status: 'active' });
      expect(db.resolveTimeBucket(lic(u.id)).source).toBe('unlimited');
    });
  });

  it('ENTERPRISE is unaffected by the flag — it ships now', () => {
    withFlag(undefined, () => {
      const g = payments.grantConfigForTier('enterprise');
      expect(g.tier).toBe('enterprise');
      expect(g.credits_remaining_seconds).toBe(-1);
    });
  });

  it('and turning it on meters again', () => {
    withFlag('true', () => {
      expect(payments.grantConfigForTier('ultra').credits_remaining_seconds).toBe(ULTRA_CYCLE);
    });
  });
});
