// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  LIFECYCLE SYNC FIXES (2026-07-25) — three defects found reading the
//  payment path end-to-end. All three are silent in production: nothing
//  throws, the money moves, and the ENTITLEMENT STATE is simply wrong or
//  unreachable afterwards.
//
//   1. /license/validate answered 403 for every completed cancellation.
//      The terminal webhooks (Stripe subscription.deleted / updated→
//      canceled|unpaid, Razorpay cancelled/halted/completed) all write
//      tier='free', status='expired', and the endpoint's blanket expiry
//      check 403'd on exactly that row. licenseService.validateWithServer
//      deliberately never degrades on a non-OK response, so the client
//      kept serving the STALE PAID TIER out of cache — cancel Ultra and
//      the badge still said Ultra until the user happened to log out.
//      Same 403 hid the documented "your pass expires → tier drops to
//      Free automatically" transition, which nothing else implemented
//      (the cycle-end sweeper only scans status='canceling').
//
//   2. Train Model — sold as the Max differentiator on every pricing
//      surface — was enforced only by a client render gate, and its work
//      went to /chat/claude (Pro+, requireActiveSession). So Pro got the
//      $50→$89 upsell for free, AND the paying Max user couldn't run it
//      before an interview: 428 → swallowed into "Couldn't read resume".
//
//   3. Buying the SAME or a LOWER one-time pass while the current one
//      still has time destroyed that time. Documented as replacement for
//      the upgrade direction (TIERS.md §5) and warned about inline in
//      ManageSubscription — but the signed-in pricing cards offer every
//      tier with no such map, and a pass holder trips none of the
//      recurring-plan guards.
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
const aiRouter = require('../src/routes/ai.js');

let seq = 0;
let clock = Math.floor(Date.now() / 1000);
const nextCreated = () => ++clock;

function makeUser(tier, { status, expires_at, sessions_limit, customerId, country = 'US' } = {}) {
  seq += 1;
  const id = `u_lsf_${seq}`;
  const email = `${id}@test.example`;
  db.createUser({ id, email, name: 'Lifecycle', password: 'pw-123456', tier, country_code: country });
  db.createLicense({
    key: `LIC-${id}`, user_id: id, email, tier,
    status: status ?? (tier === 'free' ? 'trial' : 'active'),
    country_code: country,
    expires_at: expires_at ?? (tier === 'free' ? Date.now() + 30 * 86400000 : Date.now() + 30 * 86400000),
    sessions_limit: sessions_limit ?? (tier === 'free' ? 5 : 1),
  });
  if (customerId) db.getDB().prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?').run(customerId, id);
  return { id, email, key: `LIC-${id}`, customer: customerId };
}

// ━━━ 1. /license/validate must answer 200 with the FREE row ━━━━━━━━━━
//
// The route needs an HTTP harness this suite doesn't have, so we pin the
// two things the route is built out of: the exact predicate it branches
// on, and the DB transitions it calls. If either drifts, the route drifts
// with it.
const { hasAccess } = require('../src/services/subscriptionStates.js');

// Mirror of routes/license.js — kept literally in step with the source.
function lapsedPaidPlan(license) {
  return license.tier !== 'free'
    && (license.status === 'expired'
      || (hasAccess(license.status) && license.expires_at > 0 && Date.now() > license.expires_at));
}
function staleFreeRow(license) {
  return license.tier === 'free' && license.status === 'expired';
}
// The endpoint 403s only when NEITHER heal applies (plus revoked/banned,
// handled earlier in the route).
function stillRejects(license) {
  return !lapsedPaidPlan(license) && !staleFreeRow(license)
    && (license.status === 'expired'
      || (license.expires_at > 0 && Date.now() > license.expires_at && license.tier !== 'free'));
}

describe('1. cancellation → the client can actually learn about the downgrade', () => {
  it('Stripe customer.subscription.deleted leaves a row the endpoint HEALS, not 403s', async () => {
    const u = makeUser('ultra', { expires_at: -1, sessions_limit: -1, customerId: `cus_lsf_${seq + 1}` });
    db.updateLicenseOnPayment(u.id, {
      tier: 'ultra', status: 'active', expires_at: -1, sessions_limit: -1,
      credits_remaining_seconds: -1, credits_expire_at: -1,
    });
    seq += 1;
    await webhooks.handleStripeEvent({
      id: `evt_lsf_${seq}`, type: 'customer.subscription.deleted', created: nextCreated(),
      data: { object: { id: `sub_lsf_${seq}`, customer: u.customer, status: 'canceled', metadata: { tier: 'ultra' } } },
    });

    const cancelled = db.getLicenseByUserId(u.id);
    expect(cancelled.tier).toBe('free');
    expect(cancelled.status).toBe('expired'); // the row that used to 403 forever
    expect(staleFreeRow(cancelled)).toBe(true);

    // …and the heal makes it a normal, validatable free row.
    expect(db.normalizeFreeLicenseRow(u.id)).toBe(true);
    const healed = db.getLicenseByUserId(u.id);
    expect(healed.tier).toBe('free');
    expect(healed.status).toBe('active');
    expect(healed.sessions_limit).toBe(5);
    expect(healed.expires_at).toBeGreaterThan(Date.now());
    expect(stillRejects(healed)).toBe(false);
    // The paid credit bucket must not keep Ultra's -1 UNLIMITED sentinel on
    // a free row — inert only while every reader checks the tier first.
    expect(healed.credits_remaining_seconds).toBe(0);
    expect(healed.credits_expire_at).toBe(0);
    expect(db.resolveTimeBucket(healed).source).toBe('trial');
  });

  it('Razorpay subscription.cancelled lands the same row and heals the same way', async () => {
    const u = makeUser('ultra', { expires_at: -1, sessions_limit: -1, country: 'IN' });
    await webhooks.handleRazorpayEvent({
      event: 'subscription.cancelled', created_at: nextCreated(),
      payload: { subscription: { entity: { id: `sub_rzp_lsf_${seq}`, notes: { user_email: u.email, tier: 'ultra' } } } },
    });
    const cancelled = db.getLicenseByUserId(u.id);
    expect(cancelled.tier).toBe('free');
    expect(staleFreeRow(cancelled)).toBe(true);
    expect(db.normalizeFreeLicenseRow(u.id)).toBe(true);
    expect(stillRejects(db.getLicenseByUserId(u.id))).toBe(false);
  });

  it('normalizeFreeLicenseRow is idempotent and never touches a fresh free signup', () => {
    const u = makeUser('free');
    const before = db.getLicenseByUserId(u.id);
    expect(before.status).toBe('trial');
    expect(db.normalizeFreeLicenseRow(u.id)).toBe(false);   // no match — 'trial', not 'expired'
    expect(db.getLicenseByUserId(u.id).status).toBe('trial'); // free-trial contract intact
    expect(staleFreeRow(before)).toBe(false);
  });

  it('an EXPIRED one-time pass drops to Free — the transition nothing used to perform', () => {
    const u = makeUser('pro', { expires_at: Date.now() - 1000 });
    const lapsed = db.getLicenseByUserId(u.id);
    expect(lapsed.tier).toBe('pro');
    expect(lapsedPaidPlan(lapsed)).toBe(true);

    const r = db.transitionLicenseToFree(u.id, { reason: 'validate-lapsed' });
    expect(r.transitioned).toBe(true);
    expect(r.from.tier).toBe('pro'); // names the plan for the once-only access-ended email
    const after = db.getLicenseByUserId(u.id);
    expect(after.tier).toBe('free');
    expect(after.status).toBe('active');
    expect(stillRejects(after)).toBe(false);
    expect(after.credits_remaining_seconds).toBe(0); // paid bucket cleared on the way down
    // Once-only: a second pass reports nothing transitioned, so the goodbye
    // email can't double-fire from the sweeper AND the validate path.
    expect(db.transitionLicenseToFree(u.id, { reason: 'sweep' })).toBe(false);
  });

  it('a PAUSED subscription is never transitioned — resume must find its tier intact', async () => {
    const u = makeUser('ultra', { expires_at: -1, sessions_limit: -1, customerId: `cus_pause_${seq + 1}` });
    seq += 1;
    await webhooks.handleStripeEvent({
      id: `evt_pause_${seq}`, type: 'customer.subscription.paused', created: nextCreated(),
      data: { object: { id: `sub_pause_${seq}`, customer: u.customer, status: 'paused', metadata: { tier: 'ultra' } } },
    });
    const paused = db.getLicenseByUserId(u.id);
    expect(paused.status).toBe('paused');
    // The pause handler pins expires_at to now ON PURPOSE while preserving
    // the tier. A naive "past expires_at ⇒ lapsed" test would burn it.
    expect(paused.expires_at).toBeLessThanOrEqual(Date.now());
    expect(paused.tier).toBe('ultra');
    expect(lapsedPaidPlan(paused)).toBe(false);
    expect(staleFreeRow(paused)).toBe(false);
  });

  it('refunded / disputed rows keep their meaningful status (already free, already 200)', () => {
    for (const status of ['refunded', 'disputed']) {
      const u = makeUser('pro');
      db.updateLicenseOnPayment(u.id, { tier: 'free', status, expires_at: Date.now(), sessions_limit: 5 });
      const row = db.getLicenseByUserId(u.id);
      expect(lapsedPaidPlan(row)).toBe(false);
      expect(staleFreeRow(row)).toBe(false);
      expect(db.normalizeFreeLicenseRow(u.id)).toBe(false);
      expect(db.getLicenseByUserId(u.id).status).toBe(status);
    }
  });
});

// ━━━ 2. Train Model is Max+ on the SERVER and needs no live session ━━━
function layersFor(path) {
  const layer = aiRouter.stack.find(l => l.route && l.route.path === path);
  return layer ? layer.route.stack.map(s => s.handle) : null;
}
function fakeRes() {
  const out = { code: null, body: null };
  return {
    out,
    status(c) { out.code = c; return this; },
    json(b) { out.body = b; return this; },
  };
}
function runGate(handler, user) {
  const res = fakeRes();
  let passed = false;
  handler({ user, body: {} }, res, () => { passed = true; });
  return { passed, ...res.out };
}

describe('2. Train Model enforcement', () => {
  it('/chat/claude-train is registered and ends in the same Claude handler', () => {
    const train = layersFor('/chat/claude-train');
    const live = layersFor('/chat/claude');
    expect(train).toBeTruthy();
    expect(live).toBeTruthy();
    expect(train[train.length - 1]).toBe(live[live.length - 1]); // same handler, different gate
    expect(train[train.length - 1].name).toBe('claudeChatHandler');
  });

  it('the train route does NOT require a live session; the live-answer route still does', () => {
    const trainNames = layersFor('/chat/claude-train').map(h => h.name);
    const liveNames = layersFor('/chat/claude').map(h => h.name);
    expect(liveNames).toContain('requireActiveSession');
    expect(trainNames).not.toContain('requireActiveSession');
    // …but the cost guard stays: a spent pass can't farm free Claude.
    expect(trainNames).toContain('requireTimeRemaining');
  });

  it('the train route gate admits Max and Ultra, and turns Pro away', () => {
    const gate = layersFor('/chat/claude-train')[0];
    const cases = [
      ['max', true], ['ultra', true],
      ['pro', false], ['basic', false], ['free', false],
    ];
    for (const [tier, shouldPass] of cases) {
      const u = makeUser(tier);
      const r = runGate(gate, { id: u.id, email: u.email });
      expect(r.passed, `${tier} should ${shouldPass ? 'pass' : 'be denied'}`).toBe(shouldPass);
      if (!shouldPass) {
        expect(r.code).toBe(403);
        expect(r.body.error).toBe('tier_required');
      }
    }
  });

  it('the live-answer route still admits Pro (Claude access is unchanged)', () => {
    const gate = layersFor('/chat/claude')[0];
    const u = makeUser('pro');
    expect(runGate(gate, { id: u.id, email: u.email }).passed).toBe(true);
  });
});

// ━━━ 3. Same-or-lower pass repurchase is refused ━━━━━━━━━━━━━━━━━━━━━
const livePass = (tier, remaining = 7200) => ({
  tier, status: 'active',
  credits_remaining_seconds: remaining,
  credits_expire_at: Date.now() + 20 * 86400000,
  expires_at: Date.now() + 20 * 86400000,
});

describe('3. one-time pass repurchase guard', () => {
  it('re-buying the SAME pass with time left is refused (the $89-for-nothing case)', () => {
    const c = payments.checkoutConflictFor(livePass('max', 10800), false, 'max');
    expect(c).toBeTruthy();
    expect(c.code).toBe('pass_active');
    expect(c.httpStatus).toBe(409);
    expect(c.suggested_action).toBe('extend-pass');
    expect(c.message).toMatch(/reset that same clock/i);
    expect(c.message).toMatch(/extension pack/i);
  });

  it('buying a LOWER pass with time left is refused (the pay-to-lose-time case)', () => {
    const c = payments.checkoutConflictFor(livePass('max', 7200), false, 'basic');
    expect(c.code).toBe('pass_active');
    expect(c.message).toMatch(/REPLACE/);
    expect(c.message).toMatch(/120 minutes/); // names what they'd lose
  });

  it('buying UP is still allowed — documented, warned about, and strictly more time', () => {
    expect(payments.checkoutConflictFor(livePass('basic'), false, 'pro')).toBe(null);
    expect(payments.checkoutConflictFor(livePass('basic'), false, 'max')).toBe(null);
    expect(payments.checkoutConflictFor(livePass('pro'), false, 'max')).toBe(null);
    expect(payments.checkoutConflictFor(livePass('max'), false, 'ultra')).toBe(null);
  });

  it('a SPENT or LAPSED pass can re-buy anything — nothing left to destroy', () => {
    expect(payments.checkoutConflictFor(livePass('max', 0), false, 'max')).toBe(null);
    const lapsedWindow = { ...livePass('max'), credits_expire_at: Date.now() - 1000 };
    expect(payments.checkoutConflictFor(lapsedWindow, false, 'basic')).toBe(null);
    const deadStatus = { ...livePass('max'), status: 'expired' };
    expect(payments.checkoutConflictFor(deadStatus, false, 'basic')).toBe(null);
  });

  it('free users are untouched', () => {
    expect(payments.checkoutConflictFor({ tier: 'free', status: 'trial' }, false, 'basic')).toBe(null);
    expect(payments.checkoutConflictFor({ tier: 'free', status: 'trial' }, false, 'ultra')).toBe(null);
  });

  it('a LEGACY pro/max SUBSCRIBER still gets the accurate subscription verdict, not pass copy', () => {
    // Migration-era unlimited balance on a recurring pro sub: without the
    // !hasRecurringPlan gate this would have been answered with "use an
    // extension pack", which is wrong — they need to cancel first.
    const legacy = { tier: 'pro', status: 'active', credits_remaining_seconds: -1, credits_expire_at: -1, expires_at: -1 };
    expect(payments.checkoutConflictFor(legacy, true, 'basic').code).toBe('subscription_active');
    expect(payments.checkoutConflictFor(legacy, true, 'ultra').code).toBe('upgrade_in_place');
  });

  it('the existing Ultra double-billing verdicts are unchanged', () => {
    const ultra = (status) => ({ tier: 'ultra', status });
    expect(payments.checkoutConflictFor(ultra('active'), true, 'ultra').code).toBe('already_subscribed');
    expect(payments.checkoutConflictFor(ultra('canceling'), true, 'ultra').suggested_action).toBe('reactivate-subscription');
    expect(payments.checkoutConflictFor(ultra('active'), true, 'pro').code).toBe('subscription_active');
  });

  it('an unlimited legacy PASS (no recurring history) is still protected from a re-buy', () => {
    const comp = { tier: 'max', status: 'active', credits_remaining_seconds: -1, credits_expire_at: -1, expires_at: -1 };
    const c = payments.checkoutConflictFor(comp, false, 'max');
    expect(c.code).toBe('pass_active');
    expect(c.message).toMatch(/unlimited time/);
  });
});
