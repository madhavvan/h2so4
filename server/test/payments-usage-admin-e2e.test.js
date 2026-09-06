// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  PAYMENTS → LICENSE → USAGE → GATES → ADMIN — ONE WIRING HARNESS (2026-09-05)
//
//  Boots the REAL payments, usage, admin, webhooks, ai and license routers on
//  a real socket over an in-memory database, with the Stripe SDK replaced by
//  an in-process fake (seeded into require.cache before any router loads, the
//  same trick payment-ownership.test.js uses for Razorpay). Every tier is then
//  bought the way production buys it — a Checkout Session created by
//  /create-checkout, granted by the checkout.session.completed webhook — and
//  walked through the interview clock, the model gates, top-ups, the
//  subscription lifecycle, refunds/disputes and the admin console.
//
//  Environment mirrors Railway as of 2026-09: ULTRA_METERED unset (Ultra is
//  the -1 unlimited sentinel), no STRIPE_PRICE_*_USD (inline price_data),
//  Razorpay routing off, no OpenAI key (so a request that clears every gate
//  answers 503 "OpenAI not configured" — the cleanest possible "gates passed"
//  signal without spending a cent).
//
//  Tests written with it.fails pin CURRENT behaviour that is a defect: they go
//  red the day the defect is fixed, which is the reminder to delete them.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';

process.env.DATABASE_PATH = ':memory:';
process.env.JWT_SECRET = 'e2e-payments-usage-admin-secret';
process.env.ADMIN_EMAILS = 'ops.admin@minicaai.test';
process.env.STRIPE_SECRET_KEY = 'sk_test_fake_for_e2e';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_fake_for_e2e';
process.env.FRONTEND_URL = 'https://minicaai.test';
process.env.NODE_ENV = 'test';
for (const k of [
  'ULTRA_METERED', 'RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_ROUTING_ENABLED',
  'STRIPE_PRICE_BASIC_USD', 'STRIPE_PRICE_PRO_USD', 'STRIPE_PRICE_MAX_USD',
  'STRIPE_PRICE_ULTRA_USD', 'STRIPE_PRICE_ENTERPRISE_USD', 'STRIPE_PRICE_USD',
  'OPENAI_API_KEY', 'RESEND_API_KEY', 'SMTP_HOST', 'SMTP_USER', 'SMTP_PASS',
]) delete process.env[k];

const require = createRequire(import.meta.url);

const { SESSION_GATE_MIN_CLIENT } = require('../src/middleware/clientVersion.js');
// ─── Fake Stripe ─────────────────────────────────────────────────────────
// A recording fake with just enough state for the routes under test. Every
// call is appended to `calls` so a test can assert WHAT was sent to Stripe,
// not just that the route answered 200.
function makeFakeStripe() {
  const state = {
    calls: [],
    sessions: new Map(),
    subscriptions: new Map(),
    invoices: new Map(),
    charges: new Map(),
    products: new Map(),
    defaultPaymentMethod: new Map(), // customer → pm id
    nextPaymentIntentError: null,
    seq: 0,
  };
  const log = (name, args) => state.calls.push({ name, args });
  const nextId = (p) => `${p}_${++state.seq}`;
  const fake = {
    _state: state,
    checkout: {
      sessions: {
        create: async (params) => {
          log('checkout.sessions.create', params);
          const id = nextId('cs_new');
          const session = { id, url: `https://checkout.stripe.test/${id}`, payment_status: 'unpaid', ...params };
          state.sessions.set(id, session);
          return session;
        },
        retrieve: async (id) => {
          log('checkout.sessions.retrieve', id);
          const s = state.sessions.get(id);
          if (!s) throw new Error(`No such checkout session: ${id}`);
          return s;
        },
      },
    },
    customers: {
      retrieve: async (id) => {
        log('customers.retrieve', id);
        return { id, invoice_settings: { default_payment_method: state.defaultPaymentMethod.get(id) || null } };
      },
    },
    paymentMethods: {
      list: async (params) => { log('paymentMethods.list', params); return { data: [] }; },
    },
    paymentIntents: {
      create: async (params, opts) => {
        log('paymentIntents.create', { params, opts });
        if (state.nextPaymentIntentError) {
          const err = state.nextPaymentIntentError;
          state.nextPaymentIntentError = null;
          throw err;
        }
        return { id: nextId('pi_ext'), status: 'succeeded', amount: params.amount };
      },
    },
    subscriptions: {
      list: async (params) => {
        log('subscriptions.list', params);
        const all = [...state.subscriptions.values()].filter(s => !params.customer || s.customer === params.customer);
        const data = params.status && params.status !== 'all' ? all.filter(s => s.status === params.status) : all;
        return { data: data.slice(0, params.limit || 10) };
      },
      retrieve: async (id) => { log('subscriptions.retrieve', id); return state.subscriptions.get(id) || null; },
      update: async (id, params) => {
        log('subscriptions.update', { id, params });
        const s = state.subscriptions.get(id);
        if (!s) throw new Error(`No such subscription: ${id}`);
        // `items` on an update is a list of item PATCHES ({ id, price | price_data }),
        // not the subscription's items collection — keep the { data: [...] } shape
        // Stripe returns and record the new price on the patched item.
        const { items, ...rest } = params || {};
        Object.assign(s, rest);
        for (const patch of items || []) {
          const target = s.items.data.find(i => i.id === patch.id);
          if (target) Object.assign(target, { price: patch.price || null, price_data: patch.price_data || null });
        }
        return s;
      },
      cancel: async (id) => {
        log('subscriptions.cancel', id);
        const s = state.subscriptions.get(id);
        if (!s) throw new Error(`No such subscription: ${id}`);
        s.status = 'canceled';
        return s;
      },
    },
    invoices: {
      retrieve: async (id) => { log('invoices.retrieve', id); return state.invoices.get(id) || null; },
    },
    charges: {
      retrieve: async (id) => { log('charges.retrieve', id); return state.charges.get(id) || { id, customer: null }; },
    },
    refunds: {
      create: async (params, opts) => {
        log('refunds.create', { params, opts });
        return { id: nextId('re'), amount: params.amount, status: 'succeeded' };
      },
      list: async (params) => { log('refunds.list', params); return { data: [] }; },
    },
    prices: {
      retrieve: async (id) => { log('prices.retrieve', id); throw new Error('no such price'); },
    },
    products: {
      search: async (params) => {
        log('products.search', params);
        const m = /minicaai_tier'\]:'(\w+)'/.exec(params.query || '');
        const tier = m && m[1];
        const found = [...state.products.values()].find(p => p.metadata?.minicaai_tier === tier && p.active !== false);
        return { data: found ? [found] : [] };
      },
      create: async (params) => {
        log('products.create', params);
        const p = { id: nextId('prod'), active: true, ...params };
        state.products.set(p.id, p);
        return p;
      },
      retrieve: async (id) => {
        log('products.retrieve', id);
        const p = state.products.get(id);
        if (!p) throw new Error(`No such product: ${id}`);
        return p;
      },
    },
    webhooks: {
      // The route hands us the raw Buffer; the signature is a test string.
      constructEvent: (body, sig) => {
        if (sig !== 'valid-test-signature') throw new Error('bad signature');
        const text = Buffer.isBuffer(body) ? body.toString('utf8') : (typeof body === 'string' ? body : JSON.stringify(body));
        return JSON.parse(text);
      },
    },
  };
  return fake;
}

const fakeStripe = makeFakeStripe();
const stripePath = require.resolve('stripe');
require.cache[stripePath] = {
  id: stripePath,
  filename: stripePath,
  loaded: true,
  exports: function StripeFactory() { return fakeStripe; },
};

const express = require('express');
const db = require('../src/database.js');
const { generateToken } = require('../src/middleware/auth.js');
const { clientVersion } = require('../src/middleware/clientVersion.js');
const { evaluateTier } = require('../src/middleware/tier.js');
const { isPlanLapsed } = require('../src/services/subscriptionStates.js');
const paymentsRouter = require('../src/routes/payments.js');
const usageRouter = require('../src/routes/usage.js');
const adminRouter = require('../src/routes/admin.js');
const webhooksRouter = require('../src/routes/webhooks.js');
const licenseRouter = require('../src/routes/license.js');
const aiRouter = require('../src/routes/ai.js');
const botTools = require('../src/services/botTools.js');

const P = paymentsRouter._test;
const W = webhooksRouter._test;
const ADMIN = { id: 'u_admin', email: 'ops.admin@minicaai.test' };
const PRICE_CENTS = { basic: 3000, pro: 5000, max: 8900, ultra: 15900, enterprise: 119900 };
const DAY = 24 * 60 * 60 * 1000;

let server;
let base;
let lastCreated = Math.floor(Date.now() / 1000);

function nextCreated() {
  lastCreated = Math.max(Math.floor(Date.now() / 1000), lastCreated + 1);
  return lastCreated;
}

async function call(path, { method = 'GET', token, body, headers = {} } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { status: res.status, body: json, raw: text };
}

let userSeq = 0;
function mkUser(tag, { country = 'US' } = {}) {
  const id = `u_${tag}_${++userSeq}`;
  const email = `${tag}.${userSeq}@minicaai.test`;
  db.createUser({ id, email, name: tag, password: `pw-${tag}`, tier: 'free', country_code: country });
  db.ensureLicenseForUser(id);
  return { id, email };
}
function tokenFor(u, extra = {}) {
  return generateToken({ id: u.id, email: u.email, tier: 'free', ...extra }, '1h');
}
function adminToken({ stepUp = true } = {}) {
  return generateToken({ id: ADMIN.id, email: ADMIN.email, tier: 'free', ...(stepUp ? { stepUp: true, stepUpAt: Date.now() } : {}) }, '1h');
}
const lic = (u) => db.getLicenseByUserId(u.id);
const userRow = (u) => db.getUserById(u.id);
const sql = () => db.getDB();
const paymentsOf = (u) => sql().prepare('SELECT * FROM payments WHERE user_id = ? ORDER BY id ASC').all(u.id);
const openSessions = (u) => sql().prepare('SELECT * FROM usage_sessions WHERE user_id = ? AND ended_at IS NULL').all(u.id);
const allSessions = (u) => sql().prepare('SELECT * FROM usage_sessions WHERE user_id = ? ORDER BY started_at ASC').all(u.id);

async function stripeEvent(type, object, { created, id } = {}) {
  const event = {
    id: id || `evt_${type.replace(/\./g, '_')}_${++fakeStripe._state.seq}`,
    type,
    created: created ?? nextCreated(),
    api_version: '2023-10-16',
    data: { object },
  };
  const res = await fetch(`${base}/api/v1/webhooks/stripe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'stripe-signature': 'valid-test-signature' },
    body: JSON.stringify(event),
  });
  return { status: res.status, body: await res.json().catch(() => null), event };
}

// The way production buys a plan: the session Stripe would complete, granted
// by the webhook. Recurring tiers carry a subscription + first invoice and no
// PaymentIntent — exactly the shape stripeRefunds.js documents.
function checkoutSessionFor(u, tier, overrides = {}) {
  const n = ++fakeStripe._state.seq;
  const recurring = P.isRecurringTier(tier);
  const customer = overrides.customer || `cus_${u.id}`;
  const session = {
    id: `cs_${tier}_${n}`,
    customer,
    customer_email: u.email,
    payment_status: 'paid',
    payment_intent: recurring ? null : `pi_${tier}_${n}`,
    subscription: recurring ? `sub_${tier}_${n}` : null,
    invoice: recurring ? `in_${tier}_${n}` : null,
    amount_total: PRICE_CENTS[tier],
    currency: 'usd',
    metadata: { user_email: u.email, user_id: u.id, provider: 'stripe', tier },
    ...overrides,
  };
  fakeStripe._state.sessions.set(session.id, session);
  if (recurring) {
    fakeStripe._state.subscriptions.set(session.subscription, {
      id: session.subscription,
      customer,
      status: 'active',
      cancel_at_period_end: false,
      current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
      items: { data: [{ id: `si_${n}`, current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 3600 }] },
      metadata: { tier, user_email: u.email, user_id: u.id },
      latest_invoice: session.invoice,
    });
    fakeStripe._state.invoices.set(session.invoice, {
      id: session.invoice, customer, payment_intent: `pi_first_${n}`, subscription: session.subscription,
      billing_reason: 'subscription_create', amount_paid: PRICE_CENTS[tier], currency: 'usd',
    });
  } else {
    fakeStripe._state.charges.set(`ch_${tier}_${n}`, {
      id: `ch_${tier}_${n}`, customer, payment_intent: session.payment_intent, amount: PRICE_CENTS[tier], currency: 'usd',
    });
  }
  return session;
}

async function buy(u, tier, overrides = {}) {
  const session = checkoutSessionFor(u, tier, overrides);
  const hook = await stripeEvent('checkout.session.completed', session);
  expect(hook.status, `webhook for ${tier} purchase`).toBe(200);
  if (P.isRecurringTier(tier)) {
    const sub = fakeStripe._state.subscriptions.get(session.subscription);
    const upd = await stripeEvent('customer.subscription.updated', sub);
    expect(upd.status).toBe(200);
  }
  return session;
}

function subscriptionOf(session) { return fakeStripe._state.subscriptions.get(session.subscription); }
function chargeFor(session) {
  return [...fakeStripe._state.charges.values()].find(c => c.payment_intent === session.payment_intent);
}
function callsNamed(name) { return fakeStripe._state.calls.filter(c => c.name === name); }
function resetCalls() { fakeStripe._state.calls.length = 0; }

// Pull a session's heartbeat back in time — the only way to make the server
// clock "advance" without faking Date.now() under a live HTTP server.
function ageHeartbeat(sessionId, ms) {
  sql().prepare('UPDATE usage_sessions SET last_heartbeat_at = last_heartbeat_at - ? WHERE id = ?').run(ms, sessionId);
}

beforeAll(async () => {
  db.createUser({ id: ADMIN.id, email: ADMIN.email, name: 'Ops Admin', password: 'admin-pw', tier: 'free', country_code: 'US' });
  db.ensureLicenseForUser(ADMIN.id);
  const app = express();
  // Raw body for webhooks — mounted before express.json() like index.js does.
  app.use('/api/v1/webhooks', webhooksRouter);
  app.use(express.json({ limit: '2mb' }));
  app.use(clientVersion);
  app.use('/api/v1/payments', paymentsRouter);
  app.use('/api/v1/usage', usageRouter);
  app.use('/api/v1/admin', adminRouter);
  app.use('/api/v1/license', licenseRouter);
  app.use('/api/v1/ai', aiRouter);
  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

afterAll(() => { try { server.close(); } catch { /* already down */ } });

// ═══════════════════════════════════════════════════════════════════════
//  1. THE GRANT TABLE — one truth in two files, and the env it depends on
// ═══════════════════════════════════════════════════════════════════════
describe('1 · grant tables', () => {
  it('payments.js and webhooks.js grant identical rows for every paid tier (prod: ULTRA_METERED unset)', () => {
    for (const tier of ['basic', 'pro', 'max', 'ultra', 'enterprise']) {
      const a = P.grantConfigForTier(tier);
      const b = W.grantConfigForTier(tier);
      // expires_at is Date.now()-relative for passes; compare the shape and the seconds.
      expect(b.tier).toBe(a.tier);
      expect(b.sessions_limit).toBe(a.sessions_limit);
      expect(b.credits_remaining_seconds).toBe(a.credits_remaining_seconds);
      expect(Math.abs((b.expires_at || 0) - (a.expires_at || 0))).toBeLessThan(2000);
      expect(Math.abs((b.credits_expire_at || 0) - (a.credits_expire_at || 0))).toBeLessThan(2000);
    }
    expect(P.grantConfigForTier('basic').credits_remaining_seconds).toBe(1800);
    expect(P.grantConfigForTier('pro').credits_remaining_seconds).toBe(3600);
    expect(P.grantConfigForTier('max')).toMatchObject({ sessions_limit: 3, credits_remaining_seconds: 10800 });
    // Production shape: Ultra is unlimited because ULTRA_METERED is not set on Railway.
    expect(P.grantConfigForTier('ultra')).toMatchObject({ sessions_limit: -1, expires_at: -1, credits_remaining_seconds: -1, credits_expire_at: -1 });
    expect(P.grantConfigForTier('enterprise')).toMatchObject({ sessions_limit: -1, expires_at: -1, credits_remaining_seconds: -1, credits_expire_at: -1 });
  });

  it('ULTRA_METERED=true flips Ultra to a 9-hour cycle allowance in BOTH tables', () => {
    process.env.ULTRA_METERED = 'true';
    try {
      expect(P.grantConfigForTier('ultra')).toMatchObject({ credits_remaining_seconds: 32400, credits_expire_at: 0, expires_at: -1 });
      expect(W.grantConfigForTier('ultra')).toMatchObject({ credits_remaining_seconds: 32400, credits_expire_at: 0, expires_at: -1 });
    } finally {
      delete process.env.ULTRA_METERED;
    }
  });

  it('Razorpay routing is OFF: India checks out through Stripe in USD', () => {
    expect(P.getPaymentProvider('IN')).toBe('stripe');
    expect(P.getPaymentProvider('US')).toBe('stripe');
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  2. CHECKOUT CREATION — what /create-checkout actually sends to Stripe
// ═══════════════════════════════════════════════════════════════════════
describe('2 · /create-checkout payloads', () => {
  it('passes are one-time payment sessions at the marketed price, with the card saved for off-session top-ups', async () => {
    for (const tier of ['basic', 'pro', 'max']) {
      const u = mkUser(`co_${tier}`);
      resetCalls();
      const res = await call('/api/v1/payments/create-checkout', { method: 'POST', token: tokenFor(u), body: { tier } });
      expect(res.status, res.raw).toBe(200);
      expect(res.body).toMatchObject({ provider: 'stripe', tier });
      expect(res.body.checkout_url).toMatch(/^https:\/\/checkout\.stripe\.test\//);
      const [created] = callsNamed('checkout.sessions.create');
      expect(created.args.mode).toBe('payment');
      expect(created.args.line_items[0].price_data.unit_amount).toBe(PRICE_CENTS[tier]);
      expect(created.args.line_items[0].price_data.recurring).toBeUndefined();
      expect(created.args.metadata).toMatchObject({ tier, user_id: u.id, user_email: u.email });
      expect(created.args.payment_intent_data.setup_future_usage).toBe('off_session');
      expect(created.args.customer_creation).toBe('always');
      expect(created.args.customer_email).toBe(u.email);
      expect(created.args.success_url).toContain(`tier=${tier}&session_id={CHECKOUT_SESSION_ID}`);
    }
  });

  it('Ultra and Enterprise are monthly subscription sessions carrying the tier on subscription metadata', async () => {
    for (const tier of ['ultra', 'enterprise']) {
      const u = mkUser(`co_${tier}`);
      resetCalls();
      const res = await call('/api/v1/payments/create-checkout', { method: 'POST', token: tokenFor(u), body: { tier } });
      expect(res.status, res.raw).toBe(200);
      const [created] = callsNamed('checkout.sessions.create');
      expect(created.args.mode).toBe('subscription');
      expect(created.args.line_items[0].price_data.unit_amount).toBe(PRICE_CENTS[tier]);
      expect(created.args.line_items[0].price_data.recurring).toEqual({ interval: 'month' });
      expect(created.args.subscription_data.metadata).toMatchObject({ tier, user_id: u.id });
      expect(created.args.payment_intent_data).toBeUndefined();
    }
  });

  it('a returning Stripe customer is reused instead of duplicated', async () => {
    const u = mkUser('co_returning');
    await buy(u, 'basic');
    expect(userRow(u).stripe_customer_id).toBe(`cus_${u.id}`);
    // Spend the pass so the re-buy guard lets a second checkout through.
    sql().prepare('UPDATE licenses SET credits_remaining_seconds = 0 WHERE user_id = ?').run(u.id);
    resetCalls();
    const res = await call('/api/v1/payments/create-checkout', { method: 'POST', token: tokenFor(u), body: { tier: 'pro' } });
    expect(res.status, res.raw).toBe(200);
    const [created] = callsNamed('checkout.sessions.create');
    expect(created.args.customer).toBe(`cus_${u.id}`);
    expect(created.args.customer_email).toBeUndefined();
    expect(created.args.customer_creation).toBeUndefined();
  });

  it('an unknown tier normalises to Pro (normalizeTier default) rather than erroring', async () => {
    const u = mkUser('co_unknown');
    resetCalls();
    const res = await call('/api/v1/payments/create-checkout', { method: 'POST', token: tokenFor(u), body: { tier: 'platinum' } });
    expect(res.status).toBe(200);
    expect(res.body.tier).toBe('pro');
    expect(callsNamed('checkout.sessions.create')[0].args.line_items[0].price_data.unit_amount).toBe(5000);
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  3. PURCHASE → LICENSE ROW, per tier, via the real webhook route
// ═══════════════════════════════════════════════════════════════════════
describe('3 · webhook grant per tier', () => {
  it('Basic: 30 min, one session, 30-day window; ledger row; customer id saved', async () => {
    const u = mkUser('grant_basic');
    const before = Date.now();
    const session = await buy(u, 'basic');
    const L = lic(u);
    expect(L).toMatchObject({ tier: 'basic', status: 'active', sessions_limit: 1, credits_remaining_seconds: 1800, credits_granted_seconds: 1800 });
    expect(L.expires_at).toBeGreaterThan(before + 30 * DAY - 5000);
    expect(L.credits_expire_at).toBe(L.expires_at);
    expect(L.admin_granted_at || 0).toBe(0);
    expect(userRow(u).tier).toBe('basic');
    expect(userRow(u).stripe_customer_id).toBe(session.customer);
    const rows = paymentsOf(u);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: 'stripe', provider_payment_id: session.payment_intent, amount: 3000, currency: 'USD', status: 'completed', tier_granted: 'basic' });
    expect(JSON.parse(rows[0].metadata)).toMatchObject({ mode: 'tier', tier: 'basic', settled_via: 'checkout.session.completed' });
    expect(db.resolveTimeBucket(L)).toEqual({ source: 'credits', remaining: 1800 });
  });

  it('Pro: 1 hour; Max: 3 hours and 3 sessions', async () => {
    const pro = mkUser('grant_pro');
    await buy(pro, 'pro');
    expect(lic(pro)).toMatchObject({ tier: 'pro', sessions_limit: 1, credits_remaining_seconds: 3600 });
    const max = mkUser('grant_max');
    await buy(max, 'max');
    expect(lic(max)).toMatchObject({ tier: 'max', sessions_limit: 3, credits_remaining_seconds: 10800 });
    expect(paymentsOf(max)[0].amount).toBe(8900);
  });

  it('Ultra (prod, unmetered): every column is the -1 sentinel; the ledger stores the cs_ id, not a PaymentIntent', async () => {
    const u = mkUser('grant_ultra');
    const session = await buy(u, 'ultra');
    expect(lic(u)).toMatchObject({ tier: 'ultra', status: 'active', sessions_limit: -1, expires_at: -1, credits_remaining_seconds: -1, credits_expire_at: -1 });
    expect(db.resolveTimeBucket(lic(u))).toEqual({ source: 'unlimited', remaining: -1 });
    const [row] = paymentsOf(u);
    expect(row.provider_payment_id).toBe(session.id);
    expect(row.provider_subscription_id).toBe(session.subscription);
    expect(row.amount).toBe(15900);
    // subscription_create invoice is deliberately NOT recorded (would double count)
    const inv = fakeStripe._state.invoices.get(session.invoice);
    const r = await stripeEvent('invoice.payment_succeeded', inv);
    expect(r.status).toBe(200);
    expect(paymentsOf(u)).toHaveLength(1);
  });

  it('Ultra with ULTRA_METERED=true: 9 hours, no window, re-seeded by the paid renewal invoice', async () => {
    process.env.ULTRA_METERED = 'true';
    try {
      const u = mkUser('grant_ultra_metered');
      const session = await buy(u, 'ultra');
      expect(lic(u)).toMatchObject({ tier: 'ultra', credits_remaining_seconds: 32400, credits_expire_at: 0, expires_at: -1 });
      expect(db.resolveTimeBucket(lic(u))).toEqual({ source: 'credits', remaining: 32400 });
      // Burn some, then a renewal invoice lands.
      sql().prepare('UPDATE licenses SET credits_remaining_seconds = 100 WHERE user_id = ?').run(u.id);
      const renewal = { id: `in_renew_${u.id}`, customer: session.customer, payment_intent: `pi_renew_${u.id}`, subscription: session.subscription, billing_reason: 'subscription_cycle', amount_paid: 15900, currency: 'usd' };
      const r = await stripeEvent('invoice.payment_succeeded', renewal);
      expect(r.status).toBe(200);
      expect(lic(u)).toMatchObject({ credits_remaining_seconds: 32400, credits_granted_seconds: 32400 });
      const rows = paymentsOf(u);
      expect(rows).toHaveLength(2);
      expect(JSON.parse(rows[1].metadata)).toMatchObject({ mode: 'subscription_cycle', billing_reason: 'subscription_cycle' });
      expect(rows[1].provider_payment_id).toBe(`pi_renew_${u.id}`);
    } finally {
      delete process.env.ULTRA_METERED;
    }
  });

  it('Enterprise: unlimited everywhere; a renewal invoice records revenue and rewrites the same -1s', async () => {
    const u = mkUser('grant_ent');
    const session = await buy(u, 'enterprise');
    expect(lic(u)).toMatchObject({ tier: 'enterprise', status: 'active', sessions_limit: -1, expires_at: -1, credits_remaining_seconds: -1, credits_expire_at: -1 });
    expect(paymentsOf(u)[0].amount).toBe(119900);
    const renewal = { id: `in_renew_${u.id}`, customer: session.customer, payment_intent: `pi_renew_${u.id}`, subscription: session.subscription, billing_reason: 'subscription_cycle', amount_paid: 119900, currency: 'usd' };
    await stripeEvent('invoice.payment_succeeded', renewal);
    expect(lic(u)).toMatchObject({ tier: 'enterprise', credits_remaining_seconds: -1, credits_expire_at: -1 });
    expect(paymentsOf(u)).toHaveLength(2);
  });

  it('a completed-but-UNPAID session (bank debit in flight) grants nothing until async_payment_succeeded', async () => {
    const u = mkUser('grant_async');
    const session = checkoutSessionFor(u, 'pro', { payment_status: 'unpaid' });
    const r1 = await stripeEvent('checkout.session.completed', session);
    expect(r1.status).toBe(200);
    expect(lic(u).tier).toBe('free');
    expect(paymentsOf(u)[0]).toMatchObject({ status: 'pending', tier_granted: null });
    const r2 = await stripeEvent('checkout.session.async_payment_succeeded', { ...session, payment_status: 'paid' });
    expect(r2.status).toBe(200);
    expect(lic(u)).toMatchObject({ tier: 'pro', credits_remaining_seconds: 3600 });
    const completed = paymentsOf(u).filter(p => p.status === 'completed');
    expect(completed).toHaveLength(1);
    expect(JSON.parse(completed[0].metadata).settled_via).toBe('checkout.session.async_payment_succeeded');
  });

  it('async_payment_failed books a failed row and grants nothing', async () => {
    const u = mkUser('grant_async_fail');
    const session = checkoutSessionFor(u, 'basic', { payment_status: 'unpaid' });
    await stripeEvent('checkout.session.completed', session);
    const r = await stripeEvent('checkout.session.async_payment_failed', session);
    expect(r.status).toBe(200);
    expect(lic(u).tier).toBe('free');
    expect(paymentsOf(u).map(p => p.status).sort()).toEqual(['failed', 'pending']);
  });

  it('a duplicate delivery (same event id) is short-circuited; a re-fired session (new event id) is not granted twice', async () => {
    const u = mkUser('grant_dup');
    const session = checkoutSessionFor(u, 'basic');
    const first = await stripeEvent('checkout.session.completed', session, { id: 'evt_dup_1' });
    expect(first.body).toEqual({ received: true });
    const again = await stripeEvent('checkout.session.completed', session, { id: 'evt_dup_1' });
    expect(again.body).toEqual({ received: true, duplicate: true });
    const third = await stripeEvent('checkout.session.completed', session, { id: 'evt_dup_2' });
    expect(third.status).toBe(200);
    expect(paymentsOf(u).filter(p => p.status === 'completed')).toHaveLength(1);
    expect(lic(u).credits_remaining_seconds).toBe(1800);
  });

  it('a bad signature is rejected with 400 and nothing is written', async () => {
    const u = mkUser('grant_badsig');
    const session = checkoutSessionFor(u, 'max');
    const res = await fetch(`${base}/api/v1/webhooks/stripe`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'stripe-signature': 'forged' },
      body: JSON.stringify({ id: 'evt_forged', type: 'checkout.session.completed', created: nextCreated(), data: { object: session } }),
    });
    expect(res.status).toBe(400);
    expect(lic(u).tier).toBe('free');
  });

  it('a checkout for an unknown user is ignored (logged), not granted to anyone', async () => {
    const ghost = { id: 'u_ghost', email: 'nobody@minicaai.test' };
    const session = checkoutSessionFor(ghost, 'pro');
    const r = await stripeEvent('checkout.session.completed', session);
    expect(r.status).toBe(200);
    expect(sql().prepare("SELECT COUNT(*) c FROM payments WHERE email = 'nobody@minicaai.test'").get().c).toBe(0);
  });

  it('/verify-stripe (client success URL) grants once and the later webhook does not double-grant; a stranger is refused', async () => {
    const u = mkUser('verify');
    const session = checkoutSessionFor(u, 'max');
    const res = await call('/api/v1/payments/verify-stripe', { method: 'POST', token: tokenFor(u), body: { session_id: session.id } });
    expect(res.status, res.raw).toBe(200);
    expect(lic(u)).toMatchObject({ tier: 'max', credits_remaining_seconds: 10800 });
    const hook = await stripeEvent('checkout.session.completed', session);
    expect(hook.status).toBe(200);
    expect(paymentsOf(u).filter(p => p.status === 'completed')).toHaveLength(1);
    const stranger = mkUser('verify_stranger');
    const bad = await call('/api/v1/payments/verify-stripe', { method: 'POST', token: tokenFor(stranger), body: { session_id: session.id } });
    expect(bad.status).toBe(403);
    expect(lic(stranger).tier).toBe('free');
  });

  it('out-of-order: a stale checkout.session.completed after a cancellation cannot resurrect the plan', async () => {
    const u = mkUser('ooo');
    const session = await buy(u, 'ultra');
    const cancelCreated = nextCreated();
    await stripeEvent('customer.subscription.deleted', subscriptionOf(session), { created: cancelCreated });
    expect(lic(u)).toMatchObject({ tier: 'free', status: 'expired' });
    // Stripe retries the ORIGINAL purchase event, timestamped before the cancel.
    const stale = await stripeEvent('checkout.session.completed', { ...session, id: `${session.id}_retry` }, { created: cancelCreated - 100 });
    expect(stale.status).toBe(200);
    expect(lic(u).tier).toBe('free');
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  4. THE INTERVIEW CLOCK — server-authoritative metering per tier
// ═══════════════════════════════════════════════════════════════════════
describe('4 · usage metering', () => {
  it('Basic pass: start → heartbeat charges wall-clock (capped) → stop settles; the ledger matches the licence', async () => {
    const u = mkUser('meter_basic');
    await buy(u, 'basic');
    const t = tokenFor(u);
    const start = await call('/api/v1/usage/start', { method: 'POST', token: t, body: { device_id: 'dev-1' } });
    expect(start.status, start.raw).toBe(200);
    expect(start.body).toMatchObject({ source: 'credits', remaining: 1800 });
    const sid = start.body.session_id;

    const beat0 = await call('/api/v1/usage/heartbeat', { method: 'POST', token: t, body: { session_id: sid } });
    expect(beat0.body).toMatchObject({ remaining: 1800, source: 'credits', charged: 0 });

    ageHeartbeat(sid, 25_000);
    const beat1 = await call('/api/v1/usage/heartbeat', { method: 'POST', token: t, body: { session_id: sid } });
    expect(beat1.body).toMatchObject({ remaining: 1775, charged: 25 });
    expect(lic(u).credits_remaining_seconds).toBe(1775);

    // A 20-minute silent gap on a still-open session bills the per-settle cap only.
    ageHeartbeat(sid, 20 * 60_000);
    const beat2 = await call('/api/v1/usage/heartbeat', { method: 'POST', token: t, body: { session_id: sid } });
    expect(beat2.status).toBe(200);
    expect(beat2.body.charged).toBe(db.USAGE_HEARTBEAT_CAP_S);
    expect(lic(u).credits_remaining_seconds).toBe(1775 - db.USAGE_HEARTBEAT_CAP_S);

    ageHeartbeat(sid, 10_000);
    const stop = await call('/api/v1/usage/stop', { method: 'POST', token: t, body: { session_id: sid } });
    expect(stop.body).toMatchObject({ charged: 10, source: 'credits' });
    expect(openSessions(u)).toHaveLength(0);
    const [row] = allSessions(u);
    expect(row.end_reason).toBe('stopped');
    expect(row.seconds_charged).toBe(25 + db.USAGE_HEARTBEAT_CAP_S + 10);
    expect(db.getUsageTotals(u.id)).toEqual({ lifetime_used_seconds: row.seconds_charged, session_count: 1 });
    const again = await call('/api/v1/usage/stop', { method: 'POST', token: t, body: { session_id: sid } });
    expect(again.body.already_closed).toBe(true);
    const summary = await call('/api/v1/usage/summary', { token: t });
    expect(summary.body).toMatchObject({ unlimited: false, tier: 'basic', granted_seconds: 1800, remaining_seconds: 1800 - row.seconds_charged, used_seconds: row.seconds_charged });
  });

  it('exhaustion: the beat that drains the bucket closes the session; /start and the model routes then 402', async () => {
    const u = mkUser('meter_exhaust');
    await buy(u, 'basic');
    const t = tokenFor(u);
    const start = await call('/api/v1/usage/start', { method: 'POST', token: t });
    const sid = start.body.session_id;
    sql().prepare('UPDATE licenses SET credits_remaining_seconds = 30 WHERE user_id = ?').run(u.id);
    ageHeartbeat(sid, 60_000);
    const beat = await call('/api/v1/usage/heartbeat', { method: 'POST', token: t, body: { session_id: sid } });
    expect(beat.body).toMatchObject({ remaining: 0, exhausted: true, charged: 30 });
    expect(allSessions(u)[0].end_reason).toBe('exhausted');
    const dead = await call('/api/v1/usage/heartbeat', { method: 'POST', token: t, body: { session_id: sid } });
    expect(dead.status).toBe(410);
    const restart = await call('/api/v1/usage/start', { method: 'POST', token: t });
    expect(restart.status).toBe(402);
    expect(restart.body).toMatchObject({ error: 'no_time_remaining', source: 'credits' });
    const model = await call('/api/v1/ai/chat/openai', { method: 'POST', token: t, headers: { 'x-app-version': '4.0.22' }, body: { messages: [{ role: 'user', content: 'hi' }] } });
    expect(model.status).toBe(402);
    expect(model.body.error).toBe('no_time_remaining');
    // Features follow the PLAN, not the clock: the tier gate still passes.
    expect(evaluateTier({ id: u.id, email: u.email }, ['basic', 'pro']).ok).toBe(true);
  });

  it('free trial: 10 minutes from the trial bucket, then a trial-specific 402', async () => {
    const u = mkUser('meter_trial');
    const t = tokenFor(u);
    const start = await call('/api/v1/usage/start', { method: 'POST', token: t });
    expect(start.body).toMatchObject({ source: 'trial', remaining: db.FREE_TRIAL_SECONDS });
    ageHeartbeat(start.body.session_id, 40_000);
    const beat = await call('/api/v1/usage/heartbeat', { method: 'POST', token: t, body: { session_id: start.body.session_id } });
    expect(beat.body).toMatchObject({ remaining: db.FREE_TRIAL_SECONDS - 40, source: 'trial' });
    expect(lic(u).trial_remaining_seconds).toBe(db.FREE_TRIAL_SECONDS - 40);
    const summary = await call('/api/v1/usage/summary', { token: t });
    expect(summary.body).toMatchObject({ tier: 'free', source: 'trial', granted_seconds: db.FREE_TRIAL_SECONDS, used_seconds: 40 });
    sql().prepare('UPDATE licenses SET trial_remaining_seconds = 0 WHERE user_id = ?').run(u.id);
    const model = await call('/api/v1/ai/chat/openai', { method: 'POST', token: t, headers: { 'x-app-version': '4.0.22' }, body: { messages: [{ role: 'user', content: 'hi' }] } });
    expect(model.status).toBe(402);
    expect(model.body.message).toMatch(/free trial/i);
  });

  it('Ultra (prod) and Enterprise: unlimited sessions, nothing charged, always live', async () => {
    for (const tier of ['ultra', 'enterprise']) {
      const u = mkUser(`meter_${tier}`);
      await buy(u, tier);
      const t = tokenFor(u);
      const start = await call('/api/v1/usage/start', { method: 'POST', token: t });
      expect(start.body).toMatchObject({ source: 'unlimited', remaining: -1 });
      ageHeartbeat(start.body.session_id, 5 * 60_000);
      const beat = await call('/api/v1/usage/heartbeat', { method: 'POST', token: t, body: { session_id: start.body.session_id } });
      expect(beat.body).toMatchObject({ remaining: -1, source: 'unlimited', charged: 0 });
      expect(lic(u).credits_remaining_seconds).toBe(-1);
      // Silent for an hour: still live (unlimited sessions are exempt from staleness) and never swept.
      ageHeartbeat(start.body.session_id, 60 * 60_000);
      expect(db.hasLiveUsageSession(u.id)).toBe(true);
      db.sweepStaleUsageSessions();
      expect(openSessions(u)).toHaveLength(1);
      const balance = await call('/api/v1/usage/balance', { token: t });
      expect(balance.body).toMatchObject({ remaining: -1, source: 'unlimited', tier });
      const summary = await call('/api/v1/usage/summary', { token: t });
      expect(summary.body).toMatchObject({ unlimited: true, tier });
      const sub = await call('/api/v1/payments/subscription', { token: t });
      expect(sub.body).toMatchObject({ tier, status: 'active', provider: 'stripe', is_recurring: true, can_extend: false, cancel_at_period_end: false });
    }
  });

  it('metered Ultra draws from the credits bucket and its Billing Hub offers top-ups', async () => {
    process.env.ULTRA_METERED = 'true';
    try {
      const u = mkUser('meter_ultra_metered');
      await buy(u, 'ultra');
      const t = tokenFor(u);
      const start = await call('/api/v1/usage/start', { method: 'POST', token: t });
      expect(start.body).toMatchObject({ source: 'credits', remaining: 32400 });
      ageHeartbeat(start.body.session_id, 100_000);
      await call('/api/v1/usage/heartbeat', { method: 'POST', token: t, body: { session_id: start.body.session_id } });
      expect(lic(u).credits_remaining_seconds).toBe(32400 - db.USAGE_HEARTBEAT_CAP_S);
      const sub = await call('/api/v1/payments/subscription', { token: t });
      expect(sub.body).toMatchObject({ tier: 'ultra', is_recurring: true, can_extend: true });
    } finally {
      delete process.env.ULTRA_METERED;
    }
  });

  it('metered Ultra usage card anchors on the 9-hour grant (FIXED 2026-09: /summary reads db.METERED_TIERS)', async () => {
    process.env.ULTRA_METERED = 'true';
    try {
      const u = mkUser('summary_ultra_metered');
      await buy(u, 'ultra');
      sql().prepare('UPDATE licenses SET credits_remaining_seconds = 32300 WHERE user_id = ?').run(u.id);
      const summary = await call('/api/v1/usage/summary', { token: tokenFor(u) });
      expect(summary.body).toMatchObject({ tier: 'ultra', granted_seconds: 32400, remaining_seconds: 32300, used_seconds: 100 });
    } finally {
      delete process.env.ULTRA_METERED;
    }
  });

  it('a 4.0.23+ client (stops its own clock on sleep) is billed a silent gap in FULL, up to the liveness window', async () => {
    const u = mkUser('meter_fullgap');
    await buy(u, 'max');
    const t = tokenFor(u);
    const v = { 'x-app-version': '4.0.23' };
    const start = await call('/api/v1/usage/start', { method: 'POST', token: t, headers: v });
    const sid = start.body.session_id;
    ageHeartbeat(sid, 5 * 60_000);
    const beat1 = await call('/api/v1/usage/heartbeat', { method: 'POST', token: t, headers: v, body: { session_id: sid } });
    expect(beat1.body.charged).toBe(300);
    // Twenty silent minutes is more than the window: the cap is the window, not 90 s.
    ageHeartbeat(sid, 20 * 60_000);
    const beat2 = await call('/api/v1/usage/heartbeat', { method: 'POST', token: t, headers: v, body: { session_id: sid } });
    expect(beat2.body.charged).toBe(db.USAGE_FULL_GAP_CAP_S);
    expect(db.USAGE_FULL_GAP_CAP_S).toBe(db.USAGE_STALE_AFTER_MS / 1000);
    expect(lic(u).credits_remaining_seconds).toBe(10800 - 300 - db.USAGE_FULL_GAP_CAP_S);
    // /stop and a superseding /start settle with the same cap.
    ageHeartbeat(sid, 4 * 60_000);
    const stop = await call('/api/v1/usage/stop', { method: 'POST', token: t, headers: v, body: { session_id: sid } });
    expect(stop.body.charged).toBe(240);
    const again = await call('/api/v1/usage/start', { method: 'POST', token: t, headers: v });
    sql().prepare('UPDATE usage_sessions SET started_at = started_at - 200000, last_heartbeat_at = last_heartbeat_at - 200000 WHERE id = ?').run(again.body.session_id);
    await call('/api/v1/usage/start', { method: 'POST', token: t, headers: v });
    expect(allSessions(u).find(r => r.id === again.body.session_id).seconds_charged).toBe(200);
    // The same account on an old client keeps the 90-second ceiling.
    const old = await call('/api/v1/usage/start', { method: 'POST', token: t });
    ageHeartbeat(old.body.session_id, 5 * 60_000);
    const oldBeat = await call('/api/v1/usage/heartbeat', { method: 'POST', token: t, body: { session_id: old.body.session_id } });
    expect(oldBeat.body.charged).toBe(db.USAGE_HEARTBEAT_CAP_S);
  });

  it('admin: unlimited clock and balance with only a free licence row', async () => {
    const t = adminToken({ stepUp: false });
    const start = await call('/api/v1/usage/start', { method: 'POST', token: t });
    expect(start.body).toMatchObject({ source: 'unlimited', remaining: -1 });
    const balance = await call('/api/v1/usage/balance', { token: t });
    expect(balance.body).toEqual({ remaining: -1, source: 'unlimited' });
    const summary = await call('/api/v1/usage/summary', { token: t });
    expect(summary.body).toMatchObject({ unlimited: true, tier: 'admin' });
    await call('/api/v1/usage/stop', { method: 'POST', token: t, body: { session_id: start.body.session_id } });
  });

  it('a second /start within 10 s resumes the same session; later it supersedes (no double burn)', async () => {
    const u = mkUser('meter_resume');
    await buy(u, 'pro');
    const t = tokenFor(u);
    const a = await call('/api/v1/usage/start', { method: 'POST', token: t });
    const b = await call('/api/v1/usage/start', { method: 'POST', token: t });
    expect(b.body).toMatchObject({ session_id: a.body.session_id, resumed: true });
    sql().prepare('UPDATE usage_sessions SET started_at = started_at - 11000, last_heartbeat_at = last_heartbeat_at - 11000 WHERE id = ?').run(a.body.session_id);
    const c = await call('/api/v1/usage/start', { method: 'POST', token: t });
    expect(c.body.session_id).not.toBe(a.body.session_id);
    expect(c.body.resumed).toBeUndefined();
    const rows = allSessions(u);
    expect(rows.find(r => r.id === a.body.session_id).end_reason).toBe('superseded');
    // The tail of the superseded session was charged (11 s), not thrown away.
    expect(rows.find(r => r.id === a.body.session_id).seconds_charged).toBe(11);
    expect(lic(u).credits_remaining_seconds).toBe(3600 - 11);
    expect(openSessions(u)).toHaveLength(1);
  });

  it('the sweeper settles a stale metered session at its LAST beat and the session stops authorising answers', async () => {
    const u = mkUser('meter_sweep');
    await buy(u, 'pro');
    const t = tokenFor(u);
    const start = await call('/api/v1/usage/start', { method: 'POST', token: t });
    const sid = start.body.session_id;
    ageHeartbeat(sid, db.USAGE_STALE_AFTER_MS + 60_000);
    expect(db.hasLiveUsageSession(u.id)).toBe(false);
    // The dormant session gate would refuse a client at its threshold here…
    const gated = await call('/api/v1/ai/chat/openai', { method: 'POST', token: t, headers: { 'x-app-version': SESSION_GATE_MIN_CLIENT }, body: { messages: [{ role: 'user', content: 'hi' }] } });
    expect(gated.status).toBe(428);
    expect(gated.body.error).toBe('session_required');
    // …and lets a 4.0.22 client through (no key configured → 503 = every gate passed).
    const legacy = await call('/api/v1/ai/chat/openai', { method: 'POST', token: t, headers: { 'x-app-version': '4.0.22' }, body: { messages: [{ role: 'user', content: 'hi' }] } });
    expect(legacy.status).toBe(503);
    expect(legacy.body.error).toBe('OpenAI not configured');
    expect(db.sweepStaleUsageSessions()).toBe(1);
    const row = allSessions(u)[0];
    expect(row.end_reason).toBe('stale');
    expect(row.ended_at).toBe(row.last_heartbeat_at);
    expect(lic(u).credits_remaining_seconds).toBe(3600); // nothing billed for the gap
  });

  it('a live metered session satisfies the session gate for a client at its threshold', async () => {
    const u = mkUser('meter_live_gate');
    await buy(u, 'pro');
    const t = tokenFor(u);
    await call('/api/v1/usage/start', { method: 'POST', token: t });
    const res = await call('/api/v1/ai/chat/openai', { method: 'POST', token: t, headers: { 'x-app-version': SESSION_GATE_MIN_CLIENT }, body: { messages: [{ role: 'user', content: 'hi' }] } });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('OpenAI not configured');
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  5. GATES — tier ladder, lapse, region, admin bypass
// ═══════════════════════════════════════════════════════════════════════
describe('5 · gates', () => {
  it('Basic cannot reach Claude; Pro can; nobody below Ultra gets Auto-Type; Enterprise gets everything', async () => {
    const basic = mkUser('gate_basic'); await buy(basic, 'basic');
    const pro = mkUser('gate_pro'); await buy(pro, 'pro');
    const ent = mkUser('gate_ent'); await buy(ent, 'enterprise');
    const claude = await call('/api/v1/ai/chat/claude', { method: 'POST', token: tokenFor(basic), headers: { 'x-app-version': '4.0.22' }, body: { messages: [] } });
    expect(claude.status).toBe(403);
    expect(claude.body).toMatchObject({ error: 'tier_required', current: 'basic' });
    expect(evaluateTier({ id: pro.id, email: pro.email }, ['pro', 'max', 'ultra', 'enterprise']).ok).toBe(true);
    expect(evaluateTier({ id: pro.id, email: pro.email }, ['ultra', 'enterprise']).ok).toBe(false);
    expect(evaluateTier({ id: ent.id, email: ent.email }, ['ultra', 'enterprise']).ok).toBe(true);
    expect(evaluateTier({ id: ent.id, email: ent.email }, ['max', 'ultra', 'enterprise']).ok).toBe(true);
  });

  it('a lapsed pass (30 days later) is refused everywhere with the RENEW shape, and /license/validate drops it to free', async () => {
    const u = mkUser('gate_lapsed');
    await buy(u, 'pro');
    sql().prepare('UPDATE licenses SET expires_at = ?, credits_expire_at = ? WHERE user_id = ?').run(Date.now() - 1000, Date.now() - 1000, u.id);
    expect(isPlanLapsed(lic(u))).toBe(true);
    const t = tokenFor(u);
    const start = await call('/api/v1/usage/start', { method: 'POST', token: t });
    expect(start.status).toBe(403);
    expect(start.body).toMatchObject({ error: 'tier_required', current: 'pro' });
    const model = await call('/api/v1/ai/chat/openai', { method: 'POST', token: t, headers: { 'x-app-version': '4.0.22' }, body: { messages: [] } });
    expect(model.status).toBe(403);
    expect(model.body).toMatchObject({ error: 'tier_required', current_status: 'lapsed' });
    const validate = await call('/api/v1/license/validate', { method: 'POST', token: t, body: { key: lic(u).key, device_id: 'dev-lapsed', app_version: '4.0.22' } });
    expect(validate.status, validate.raw).toBe(200);
    expect(validate.body).toMatchObject({ valid: true, tier: 'free', status: 'active', credits_remaining_seconds: 0 });
    expect(userRow(u).tier).toBe('free');
  });

  it('past_due keeps access (dunning grace); canceled/unpaid removes it', async () => {
    const u = mkUser('gate_pastdue');
    const session = await buy(u, 'ultra');
    const sub = subscriptionOf(session);
    const inv = { id: `in_fail_${u.id}`, customer: session.customer, payment_intent: `pi_fail_${u.id}`, subscription: sub.id, amount_due: 15900, currency: 'usd' };
    await stripeEvent('invoice.payment_failed', inv);
    expect(lic(u)).toMatchObject({ tier: 'ultra', status: 'past_due', credits_remaining_seconds: -1 });
    expect(evaluateTier({ id: u.id, email: u.email }, ['ultra', 'enterprise']).ok).toBe(true);
    const start = await call('/api/v1/usage/start', { method: 'POST', token: tokenFor(u) });
    expect(start.status).toBe(200);
    expect(paymentsOf(u).at(-1)).toMatchObject({ status: 'failed', amount: 15900 });
    await stripeEvent('customer.subscription.updated', { ...sub, status: 'unpaid' });
    expect(lic(u)).toMatchObject({ tier: 'free', status: 'expired' });
    expect(evaluateTier({ id: u.id, email: u.email }, ['ultra', 'enterprise']).ok).toBe(false);
  });

  it('India: a free user is hard-blocked from the model routes (no trial in that region)', async () => {
    const u = mkUser('gate_in', { country: 'IN' });
    const res = await call('/api/v1/ai/chat/openai', { method: 'POST', token: tokenFor(u), headers: { 'x-app-version': '4.0.22' }, body: { messages: [] } });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'subscription_required', region: 'IN' });
    await buy(u, 'basic');
    const paid = await call('/api/v1/ai/chat/openai', { method: 'POST', token: tokenFor(u), headers: { 'x-app-version': '4.0.22' }, body: { messages: [] } });
    expect(paid.status).toBe(503); // every gate passed
  });

  it('admin bypasses tier, time and session gates with no licence at all', async () => {
    const noRow = { id: 'u_admin_norow', email: ADMIN.email };
    expect(evaluateTier(noRow, ['enterprise']).ok).toBe(true);
    const res = await call('/api/v1/ai/chat/claude', { method: 'POST', token: adminToken({ stepUp: false }), headers: { 'x-app-version': '4.0.23' }, body: { messages: [] } });
    expect(res.status).not.toBe(403);
    expect(res.status).not.toBe(428);
    expect(res.status).not.toBe(402);
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  6. EXTENSION PACKS — the off-session one-click top-up
// ═══════════════════════════════════════════════════════════════════════
describe('6 · extension packs', () => {
  it('pack table: m30 $25 / h1 $45 / h3 $80; unknown pack falls back to m30', () => {
    expect(P.EXTENSION_PACKS.m30).toMatchObject({ seconds: 1800, usd_cents: 2500 });
    expect(P.EXTENSION_PACKS.h1).toMatchObject({ seconds: 3600, usd_cents: 4500 });
    expect(P.EXTENSION_PACKS.h3).toMatchObject({ seconds: 10800, usd_cents: 8000 });
    expect(P.resolveExtensionPack('nope').id).toBe('m30');
  });

  it('on the interview day with a saved card: /extend-now charges off-session and stacks time onto the pass', async () => {
    const u = mkUser('ext_ok');
    await buy(u, 'basic');
    fakeStripe._state.defaultPaymentMethod.set(`cus_${u.id}`, 'pm_saved');
    const t = tokenFor(u);
    // Not interview day yet → refused, and the Billing Hub says so.
    const early = await call('/api/v1/payments/extend-now', { method: 'POST', token: t, body: { pack: 'h1' } });
    expect(early.status).toBe(403);
    expect(early.body.error).toBe('not_interview_day');
    const hub = await call('/api/v1/payments/subscription', { token: t });
    expect(hub.body).toMatchObject({ can_extend: false, extend_blocked_reason: 'not_interview_day' });

    // Start the interview, burn it to zero.
    const start = await call('/api/v1/usage/start', { method: 'POST', token: t });
    sql().prepare('UPDATE licenses SET credits_remaining_seconds = 0 WHERE user_id = ?').run(u.id);
    const before = lic(u);
    resetCalls();
    const ext = await call('/api/v1/payments/extend-now', { method: 'POST', token: t, body: { pack: 'h1', attempt_id: 'a1' } });
    expect(ext.status, ext.raw).toBe(200);
    expect(ext.body).toMatchObject({ success: true, flow: 'off_session', duplicate: false, charged_cents: 4500, pack: 'h1', granted_seconds: 3600, remaining: 3600, source: 'credits' });
    const [pi] = callsNamed('paymentIntents.create');
    expect(pi.args.params).toMatchObject({ amount: 4500, currency: 'usd', customer: `cus_${u.id}`, payment_method: 'pm_saved', off_session: true, confirm: true });
    expect(pi.args.params.metadata).toMatchObject({ mode: 'extension', tier: 'basic', pack: 'h1', user_id: u.id });
    expect(pi.args.opts.idempotencyKey).toMatch(new RegExp(`^extend_${u.id}_h1_basic_\\d+$`));
    const after = lic(u);
    expect(after.tier).toBe('basic');
    expect(after.credits_remaining_seconds).toBe(3600);
    expect(after.credits_granted_seconds).toBe(1800 + 3600);
    expect(after.expires_at).toBe(before.expires_at + 3600 * 1000);
    expect(after.credits_expire_at).toBe(after.expires_at);
    expect(after.sessions_limit).toBe(2);
    const row = paymentsOf(u).at(-1);
    expect(row).toMatchObject({ amount: 4500, status: 'completed', tier_granted: 'basic' });
    expect(JSON.parse(row.metadata)).toMatchObject({ mode: 'extension', off_session: true, pack: 'h1', granted_seconds: 3600 });
    // The clock can be restarted straight away.
    await call('/api/v1/usage/stop', { method: 'POST', token: t, body: { session_id: start.body.session_id } });
    const restart = await call('/api/v1/usage/start', { method: 'POST', token: t });
    expect(restart.body).toMatchObject({ source: 'credits', remaining: 3600 });

    // A second click inside two minutes is absorbed, not charged.
    resetCalls();
    const dup = await call('/api/v1/payments/extend-now', { method: 'POST', token: t, body: { pack: 'h1' } });
    expect(dup.body).toMatchObject({ success: true, duplicate: true, charged_cents: 0, granted_seconds: 0 });
    expect(callsNamed('paymentIntents.create')).toHaveLength(0);
    expect(lic(u).credits_remaining_seconds).toBe(3600);
  });

  it('a declined off-session card is a 402 and grants nothing; authentication_required falls back to a browser checkout', async () => {
    const u = mkUser('ext_decline');
    await buy(u, 'pro');
    fakeStripe._state.defaultPaymentMethod.set(`cus_${u.id}`, 'pm_saved');
    const t = tokenFor(u);
    await call('/api/v1/usage/start', { method: 'POST', token: t });
    const declined = new Error('Your card was declined.');
    declined.code = 'card_declined';
    fakeStripe._state.nextPaymentIntentError = declined;
    const res = await call('/api/v1/payments/extend-now', { method: 'POST', token: t, body: { pack: 'm30' } });
    expect(res.status).toBe(402);
    expect(res.body.error).toBe('charge_failed');
    expect(lic(u).credits_remaining_seconds).toBe(3600);
    const sca = new Error('auth needed');
    sca.code = 'authentication_required';
    fakeStripe._state.nextPaymentIntentError = sca;
    resetCalls();
    const fallback = await call('/api/v1/payments/extend-now', { method: 'POST', token: t, body: { pack: 'm30' } });
    expect(fallback.status, fallback.raw).toBe(200);
    expect(fallback.body.provider).toBe('stripe');
    expect(fallback.body.checkout_url).toBeTruthy();
    const [created] = callsNamed('checkout.sessions.create');
    expect(created.args.mode).toBe('payment');
    expect(created.args.metadata).toMatchObject({ mode: expect.stringMatching(/renewal|extension/) });
  });

  it('a webhook-delivered top-up (browser checkout with mode=renewal) grants the pack seconds and keeps the tier', async () => {
    const u = mkUser('ext_webhook');
    await buy(u, 'max');
    const before = lic(u);
    const session = checkoutSessionFor(u, 'max', { amount_total: 8000, metadata: { user_email: u.email, user_id: u.id, tier: 'max', mode: 'renewal', pack: 'h3' } });
    const r = await stripeEvent('checkout.session.completed', session);
    expect(r.status).toBe(200);
    const after = lic(u);
    expect(after.tier).toBe('max');
    expect(after.credits_remaining_seconds).toBe(before.credits_remaining_seconds + 10800);
    expect(after.sessions_limit).toBe(4);
    expect(JSON.parse(paymentsOf(u).at(-1).metadata).mode).toBe('renewal');
  });

  it('a top-up on the unlimited plans is a no-op success (nothing to add to)', async () => {
    const u = mkUser('ext_ent');
    await buy(u, 'enterprise');
    const res = await call('/api/v1/payments/extend-now', { method: 'POST', token: tokenFor(u), body: { pack: 'h3' } });
    expect(res.body).toMatchObject({ success: true, already_unlimited: true });
    const free = mkUser('ext_free');
    const nopass = await call('/api/v1/payments/extend-now', { method: 'POST', token: tokenFor(free), body: {} });
    expect(nopass.status).toBe(400);
    expect(nopass.body.error).toBe('no_pass');
  });

  it('a metered Ultra (ULTRA_METERED=true) top-up adds seconds ONLY — no window, no expiry, no session cap', async () => {
    process.env.ULTRA_METERED = 'true';
    try {
      const u = mkUser('ext_ultra_metered');
      await buy(u, 'ultra');
      fakeStripe._state.defaultPaymentMethod.set(`cus_${u.id}`, 'pm_saved');
      const t = tokenFor(u);
      await call('/api/v1/usage/start', { method: 'POST', token: t });
      const res = await call('/api/v1/payments/extend-now', { method: 'POST', token: t, body: { pack: 'm30' } });
      expect(res.status, res.raw).toBe(200);
      expect(lic(u)).toMatchObject({ tier: 'ultra', credits_remaining_seconds: 32400 + 1800, credits_expire_at: 0, expires_at: -1, sessions_limit: -1 });
    } finally {
      delete process.env.ULTRA_METERED;
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  7. RE-BUY GUARDS and PLAN CHANGES
// ═══════════════════════════════════════════════════════════════════════
describe('7 · re-buy guards and plan changes', () => {
  it('a live pass cannot be re-bought at the same or a lower tier (409 → extension), but can be upgraded', async () => {
    const u = mkUser('rebuy');
    await buy(u, 'pro');
    const t = tokenFor(u);
    const same = await call('/api/v1/payments/create-checkout', { method: 'POST', token: t, body: { tier: 'pro' } });
    expect(same.status).toBe(409);
    expect(same.body).toMatchObject({ code: 'pass_active', suggested_action: 'extend-pass' });
    const lower = await call('/api/v1/payments/create-checkout', { method: 'POST', token: t, body: { tier: 'basic' } });
    expect(lower.status).toBe(409);
    resetCalls();
    const up = await call('/api/v1/payments/create-checkout', { method: 'POST', token: t, body: { tier: 'max' } });
    expect(up.status).toBe(200);
    expect(callsNamed('checkout.sessions.create')).toHaveLength(1);
  });

  it('a subscriber cannot buy a pass on top of the subscription (400 → cancel first); re-subscribing to the same plan is a 409', async () => {
    const u = mkUser('sub_guard');
    await buy(u, 'ultra');
    const t = tokenFor(u);
    const pass = await call('/api/v1/payments/create-checkout', { method: 'POST', token: t, body: { tier: 'max' } });
    expect(pass.status).toBe(400);
    expect(pass.body).toMatchObject({ code: 'subscription_active', suggested_action: 'cancel-subscription' });
    const same = await call('/api/v1/payments/create-checkout', { method: 'POST', token: t, body: { tier: 'ultra' } });
    expect(same.status).toBe(409);
    expect(same.body.code).toBe('already_subscribed');
  });

  it('Ultra → Enterprise via /upgrade-tier (what the client calls) swaps the ONE subscription in place at $1199, prorated', async () => {
    const u = mkUser('up_client_path');
    const ultra = await buy(u, 'ultra');
    const itemIdBefore = subscriptionOf(ultra).items.data[0].id;
    resetCalls();
    const res = await call('/api/v1/payments/upgrade-tier', { method: 'POST', token: tokenFor(u), body: { tier: 'enterprise' } });
    expect(res.status, res.raw).toBe(200);
    expect(res.body).toMatchObject({ provider: 'stripe-upgrade', tier: 'enterprise', previous_tier: 'ultra', proration: 'next_invoice' });
    expect(res.body.license).toMatchObject({ tier: 'enterprise', credits_remaining_seconds: -1 });
    // Exactly one Stripe write: the existing item is re-priced on OUR
    // Enterprise product (no STRIPE_PRICE_ENTERPRISE_USD in prod), auto-renew
    // is back on, and no Checkout Session was opened.
    expect(callsNamed('checkout.sessions.create')).toHaveLength(0);
    const updates = callsNamed('subscriptions.update');
    expect(updates).toHaveLength(1);
    expect(updates[0].args.id).toBe(ultra.subscription);
    expect(updates[0].args.params).toMatchObject({ proration_behavior: 'create_prorations', cancel_at_period_end: false });
    expect(updates[0].args.params.metadata).toMatchObject({ tier: 'enterprise', user_id: u.id });
    const item = updates[0].args.params.items[0];
    expect(item.id).toBe(itemIdBefore);
    expect(subscriptionOf(ultra).items.data[0].price_data.unit_amount).toBe(119900);
    expect(item.price_data).toMatchObject({ currency: 'usd', unit_amount: 119900, recurring: { interval: 'month' } });
    expect(item.price_data.product).toMatch(/^prod_/);
    const product = fakeStripe._state.products.get(item.price_data.product);
    expect(product).toMatchObject({ name: 'minicaai Enterprise', metadata: { minicaai_tier: 'enterprise' } });
    expect(lic(u)).toMatchObject({ tier: 'enterprise', status: 'active', expires_at: -1, credits_remaining_seconds: -1, credits_expire_at: -1 });
    expect(userRow(u).tier).toBe('enterprise');
    expect(subscriptionOf(ultra).status).toBe('active');
    expect([...fakeStripe._state.subscriptions.values()].filter(s => s.customer === ultra.customer)).toHaveLength(1);
    // Stripe echoes the change with the new tier on the subscription metadata.
    await stripeEvent('customer.subscription.updated', subscriptionOf(ultra));
    expect(lic(u).tier).toBe('enterprise');
    // The product id is remembered: a second swap on any account makes no products.* create call.
    const u2 = mkUser('up_client_path_2');
    await buy(u2, 'ultra');
    resetCalls();
    const res2 = await call('/api/v1/payments/upgrade-tier', { method: 'POST', token: tokenFor(u2), body: { tier: 'enterprise' } });
    expect(res2.status).toBe(200);
    expect(callsNamed('products.create')).toHaveLength(0);
    expect(callsNamed('subscriptions.update')[0].args.params.items[0].price_data.product).toBe(item.price_data.product);
  });

  it('Ultra → Enterprise via /create-checkout takes the same in-place path — never a SECOND subscription', async () => {
    const u = mkUser('up_second_sub');
    const ultra = await buy(u, 'ultra');
    resetCalls();
    const res = await call('/api/v1/payments/create-checkout', { method: 'POST', token: tokenFor(u), body: { tier: 'enterprise' } });
    expect(res.status, res.raw).toBe(200);
    expect(res.body.provider).toBe('stripe-upgrade');
    expect(callsNamed('subscriptions.update')).toHaveLength(1);
    expect(callsNamed('checkout.sessions.create')).toHaveLength(0);
    expect(lic(u).tier).toBe('enterprise');
    expect([...fakeStripe._state.subscriptions.values()].filter(s => s.customer === ultra.customer)).toHaveLength(1);
  });

  it('Enterprise → Ultra is an in-place DOWNGRADE with a prorated credit; a canceling Ultra → Enterprise swap re-enables renewal', async () => {
    const u = mkUser('down_ent_ultra');
    const ent = await buy(u, 'enterprise');
    resetCalls();
    const res = await call('/api/v1/payments/upgrade-tier', { method: 'POST', token: tokenFor(u), body: { tier: 'ultra' } });
    expect(res.status, res.raw).toBe(200);
    expect(res.body).toMatchObject({ provider: 'stripe-upgrade', tier: 'ultra', previous_tier: 'enterprise' });
    expect(res.body.message).toMatch(/prorated credit/i);
    expect(callsNamed('subscriptions.update')[0].args.params.items[0].price_data.unit_amount).toBe(15900);
    expect(lic(u)).toMatchObject({ tier: 'ultra', credits_remaining_seconds: -1 }); // prod: Ultra unmetered
    expect(subscriptionOf(ent).metadata.tier).toBe('ultra');

    const c = mkUser('canceling_to_ent');
    const ultra = await buy(c, 'ultra');
    await call('/api/v1/payments/cancel-subscription', { method: 'POST', token: tokenFor(c), body: {} });
    expect(lic(c).status).toBe('canceling');
    expect(subscriptionOf(ultra).cancel_at_period_end).toBe(true);
    const swap = await call('/api/v1/payments/upgrade-tier', { method: 'POST', token: tokenFor(c), body: { tier: 'enterprise' } });
    expect(swap.status, swap.raw).toBe(200);
    expect(subscriptionOf(ultra).cancel_at_period_end).toBe(false);
    expect(lic(c)).toMatchObject({ tier: 'enterprise', status: 'active', expires_at: -1 });
  });

  it('a swap that cannot be priced fails CLOSED (503) instead of opening a fresh subscription', async () => {
    const u = mkUser('up_unpriceable');
    await buy(u, 'ultra');
    const realCreate = fakeStripe.products.create;
    const realSearch = fakeStripe.products.search;
    fakeStripe.products.search = async () => { throw new Error('search down'); };
    fakeStripe.products.create = async () => { throw new Error('stripe down'); };
    // Forget the cached product so the route has to talk to Stripe.
    sql().prepare("DELETE FROM app_config WHERE key = 'stripe_product_enterprise'").run();
    resetCalls();
    try {
      const res = await call('/api/v1/payments/upgrade-tier', { method: 'POST', token: tokenFor(u), body: { tier: 'enterprise' } });
      expect(res.status).toBe(503);
      expect(callsNamed('subscriptions.update')).toHaveLength(0);
      expect(callsNamed('checkout.sessions.create')).toHaveLength(0);
      expect(lic(u).tier).toBe('ultra');
    } finally {
      fakeStripe.products.create = realCreate;
      fakeStripe.products.search = realSearch;
    }
  });

  it('a Pro pass holder moving to Enterprise gets a normal subscription checkout (no double billing: passes are one-time)', async () => {
    const u = mkUser('pass_to_ent');
    await buy(u, 'pro');
    resetCalls();
    const res = await call('/api/v1/payments/upgrade-tier', { method: 'POST', token: tokenFor(u), body: { tier: 'enterprise' } });
    expect(res.status, res.raw).toBe(200);
    expect(res.body.tier).toBe('enterprise');
    expect(callsNamed('checkout.sessions.create')[0].args.mode).toBe('subscription');
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  8. SUBSCRIPTION LIFECYCLE — cancel, reactivate, cycle end, sweeper
// ═══════════════════════════════════════════════════════════════════════
describe('8 · subscription lifecycle', () => {
  it('user cancel → canceling until cycle end → Billing Hub shows it → reactivate restores active', async () => {
    const u = mkUser('life_cancel');
    const session = await buy(u, 'ultra');
    const sub = subscriptionOf(session);
    const t = tokenFor(u);
    const cancel = await call('/api/v1/payments/cancel-subscription', { method: 'POST', token: t, body: { reason: 'too_expensive' } });
    expect(cancel.status, cancel.raw).toBe(200);
    expect(sub.cancel_at_period_end).toBe(true);
    expect(lic(u)).toMatchObject({ tier: 'ultra', status: 'canceling', expires_at: sub.current_period_end * 1000, credits_remaining_seconds: -1 });
    // Stripe echoes the change; the row is unchanged by it.
    await stripeEvent('customer.subscription.updated', sub);
    expect(lic(u)).toMatchObject({ status: 'canceling', expires_at: sub.current_period_end * 1000 });
    const hub = await call('/api/v1/payments/subscription', { token: t });
    expect(hub.body).toMatchObject({ status: 'canceling', cancel_at_period_end: true, cancels_at: sub.current_period_end * 1000, is_recurring: true });
    // Still usable until then.
    expect(evaluateTier({ id: u.id, email: u.email }, ['ultra', 'enterprise']).ok).toBe(true);
    const rebuy = await call('/api/v1/payments/create-checkout', { method: 'POST', token: t, body: { tier: 'ultra' } });
    expect(rebuy.status).toBe(409);
    expect(rebuy.body.suggested_action).toBe('reactivate-subscription');
    const react = await call('/api/v1/payments/reactivate-subscription', { method: 'POST', token: t });
    expect(react.status, react.raw).toBe(200);
    expect(sub.cancel_at_period_end).toBe(false);
    expect(lic(u)).toMatchObject({ tier: 'ultra', status: 'active', expires_at: -1, credits_remaining_seconds: -1 });
  });

  it('cycle end: the sweeper (and /validate) move an expired canceling licence to free exactly once', async () => {
    const u = mkUser('life_cycle_end');
    const session = await buy(u, 'enterprise');
    const sub = subscriptionOf(session);
    sub.cancel_at_period_end = true;
    sub.current_period_end = Math.floor(Date.now() / 1000) - 60; // already past
    await stripeEvent('customer.subscription.updated', sub);
    expect(lic(u)).toMatchObject({ status: 'canceling' });
    expect(lic(u).expires_at).toBeLessThan(Date.now());
    expect(db.getExpiredCancelingUserIds(100)).toContain(u.id);
    const r = db.transitionLicenseToFree(u.id, { reason: 'sweep' });
    expect(r).toMatchObject({ transitioned: true, from: { tier: 'enterprise', status: 'canceling' } });
    expect(lic(u)).toMatchObject({ tier: 'free', status: 'active', sessions_limit: 5, credits_remaining_seconds: 0 });
    expect(userRow(u).tier).toBe('free');
    expect(db.transitionLicenseToFree(u.id, { reason: 'sweep' })).toBe(false); // idempotent → one goodbye email
    // The provider's own deletion later is harmless.
    await stripeEvent('customer.subscription.deleted', sub);
    expect(lic(u).tier).toBe('free');
  });

  it('a canceling row with no cycle-end date (legacy -1) is repaired instead of serving unlimited forever', async () => {
    const u = mkUser('life_repair');
    await buy(u, 'ultra');
    sql().prepare("UPDATE licenses SET status = 'canceling', expires_at = -1 WHERE user_id = ?").run(u.id);
    expect(db.repairAllCancelWindows()).toBeGreaterThanOrEqual(1);
    expect(lic(u).expires_at).toBeGreaterThan(Date.now());
    expect(lic(u).expires_at).toBeLessThan(Date.now() + 32 * DAY);
  });

  it('subscription.deleted → free/expired + a cancelled ledger row; /validate then normalises the free row for the client', async () => {
    const u = mkUser('life_deleted');
    const session = await buy(u, 'ultra');
    await stripeEvent('customer.subscription.deleted', subscriptionOf(session));
    expect(lic(u)).toMatchObject({ tier: 'free', status: 'expired', sessions_limit: 5 });
    expect(paymentsOf(u).at(-1)).toMatchObject({ status: 'cancelled', amount: 0, tier_granted: 'free' });
    const v = await call('/api/v1/license/validate', { method: 'POST', token: tokenFor(u), body: { key: lic(u).key, device_id: 'dev-x', app_version: '4.0.22' } });
    expect(v.status).toBe(200);
    expect(v.body).toMatchObject({ valid: true, tier: 'free', status: 'active' });
  });

  it('paused preserves the tier for resume; resumed restores the full grant', async () => {
    const u = mkUser('life_pause');
    const session = await buy(u, 'enterprise');
    const sub = subscriptionOf(session);
    await stripeEvent('customer.subscription.paused', sub);
    expect(lic(u)).toMatchObject({ tier: 'enterprise', status: 'paused' });
    expect(evaluateTier({ id: u.id, email: u.email }, ['enterprise']).ok).toBe(false);
    await stripeEvent('customer.subscription.resumed', sub);
    expect(lic(u)).toMatchObject({ tier: 'enterprise', status: 'active', expires_at: -1, credits_remaining_seconds: -1 });
  });

  it('admin cancel-subscription schedules the Stripe cancel at period end', async () => {
    const u = mkUser('life_admin_cancel');
    const session = await buy(u, 'ultra');
    const res = await call(`/api/v1/admin/users/${u.id}/cancel-subscription`, { method: 'POST', token: adminToken() });
    expect(res.status, res.raw).toBe(200);
    expect(res.body).toMatchObject({ success: true, provider: 'stripe' });
    expect(subscriptionOf(session).cancel_at_period_end).toBe(true);
    // The licence itself only changes when Stripe's subscription.updated arrives.
    expect(lic(u).status).toBe('active');
    await stripeEvent('customer.subscription.updated', subscriptionOf(session));
    expect(lic(u).status).toBe('canceling');
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  9. REFUNDS and DISPUTES — admin console + webhooks
// ═══════════════════════════════════════════════════════════════════════
describe('9 · refunds and disputes', () => {
  it('admin refund of a fresh pass: eligible, one Stripe call, one ledger row; access ends when charge.refunded lands', async () => {
    const u = mkUser('ref_basic');
    const session = await buy(u, 'basic');
    const [pay] = paymentsOf(u);
    resetCalls();
    const res = await call(`/api/v1/admin/payments/${pay.id}/refund`, { method: 'POST', token: adminToken(), body: { reason: 'requested_by_customer' } });
    expect(res.status, res.raw).toBe(200);
    expect(res.body).toMatchObject({ success: true, provider: 'stripe' });
    const [rc] = callsNamed('refunds.create');
    expect(rc.args.params).toMatchObject({ payment_intent: session.payment_intent, amount: 3000, reason: 'requested_by_customer' });
    expect(rc.args.opts.idempotencyKey).toBe(`admin-refund:${session.payment_intent}:3000`);
    const refundRow = paymentsOf(u).find(p => p.status === 'refunded');
    expect(refundRow).toMatchObject({ amount: -3000, provider_payment_id: session.payment_intent });
    expect(JSON.parse(refundRow.metadata)).toMatchObject({ mode: 'admin_refund', refund_id: res.body.provider_refund_id, initiated_by: ADMIN.email });
    // The console deliberately leaves the downgrade to the webhook.
    expect(lic(u).tier).toBe('basic');
    const second = await call(`/api/v1/admin/payments/${pay.id}/refund`, { method: 'POST', token: adminToken(), body: {} });
    expect(second.status).toBe(400);
    expect(second.body.error).toMatch(/already refunded/i);
    const charge = { ...chargeFor(session), refunded: true, amount_refunded: 3000, refunds: { data: [{ id: res.body.provider_refund_id, amount: 3000, reason: 'requested_by_customer' }] } };
    const hook = await stripeEvent('charge.refunded', charge);
    expect(hook.status).toBe(200);
    expect(lic(u)).toMatchObject({ tier: 'free', status: 'refunded' });
    expect(userRow(u).tier).toBe('free');
    expect(paymentsOf(u).filter(p => p.status === 'refunded')).toHaveLength(1); // dedup by refund id
    // A refunded customer is a FREE user again: the paid gates refuse them,
    // and whatever signup-trial minutes they never used are what they can run on.
    expect(evaluateTier({ id: u.id, email: u.email }, ['basic', 'pro']).ok).toBe(false);
    const start = await call('/api/v1/usage/start', { method: 'POST', token: tokenFor(u) });
    expect(start.status).toBe(200);
    expect(start.body).toMatchObject({ source: 'trial', remaining: db.FREE_TRIAL_SECONDS });
  });

  it('eligibility is enforced: 14-day window, 2-hour usage cap, top-ups never; override_reason ≥ 10 chars bypasses with audit', async () => {
    const u = mkUser('ref_rules');
    await buy(u, 'pro');
    const [pay] = paymentsOf(u);
    sql().prepare('UPDATE payments SET created_at = ? WHERE id = ?').run(Date.now() - 15 * DAY, pay.id);
    const old = await call(`/api/v1/admin/payments/${pay.id}/refund`, { method: 'POST', token: adminToken(), body: {} });
    expect(old.status).toBe(400);
    expect(old.body).toMatchObject({ error: 'refund_ineligible', code: 'window_expired' });
    const shortOverride = await call(`/api/v1/admin/payments/${pay.id}/refund`, { method: 'POST', token: adminToken(), body: { override_reason: 'short' } });
    expect(shortOverride.status).toBe(400);
    sql().prepare('UPDATE payments SET created_at = ? WHERE id = ?').run(Date.now(), pay.id);
    sql().prepare("INSERT INTO usage_sessions (id, user_id, license_key, device_id, source, started_at, last_heartbeat_at, ended_at, end_reason, seconds_charged) VALUES ('s_heavy', ?, ?, NULL, 'credits', ?, ?, ?, 'stopped', 7300)")
      .run(u.id, lic(u).key, Date.now() - DAY, Date.now() - DAY, Date.now() - DAY);
    const heavy = await call(`/api/v1/admin/payments/${pay.id}/refund`, { method: 'POST', token: adminToken(), body: {} });
    expect(heavy.status).toBe(400);
    expect(heavy.body.code).toBe('usage_exceeded');
    const forced = await call(`/api/v1/admin/payments/${pay.id}/refund`, { method: 'POST', token: adminToken(), body: { override_reason: 'goodwill after outage on interview day' } });
    expect(forced.status, forced.raw).toBe(200);
    const audit = sql().prepare("SELECT * FROM audit_log WHERE action = 'refund-payment' AND target_user_id = ? ORDER BY id DESC LIMIT 1").get(u.id);
    expect(audit).toBeTruthy();
    expect(JSON.parse(audit.details_json)).toMatchObject({ eligibility_eligible: false, eligibility_code: 'usage_exceeded', override_reason: 'goodwill after outage on interview day' });
  });

  it('a top-up refund is refused by policy; when forced, the plan it was added to survives the webhook', async () => {
    const u = mkUser('ref_topup');
    await buy(u, 'max');
    fakeStripe._state.defaultPaymentMethod.set(`cus_${u.id}`, 'pm_saved');
    await call('/api/v1/usage/start', { method: 'POST', token: tokenFor(u) });
    const ext = await call('/api/v1/payments/extend-now', { method: 'POST', token: tokenFor(u), body: { pack: 'm30' } });
    expect(ext.status).toBe(200);
    const topup = paymentsOf(u).find(p => p.amount === 2500);
    const refused = await call(`/api/v1/admin/payments/${topup.id}/refund`, { method: 'POST', token: adminToken(), body: {} });
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe('renewal_nonrefundable');
    const forced = await call(`/api/v1/admin/payments/${topup.id}/refund`, { method: 'POST', token: adminToken(), body: { override_reason: 'accidental double purchase' } });
    expect(forced.status, forced.raw).toBe(200);
    const charge = { id: 'ch_topup', customer: `cus_${u.id}`, payment_intent: topup.provider_payment_id, amount: 2500, amount_refunded: 2500, refunded: true, currency: 'usd', refunds: { data: [{ id: forced.body.provider_refund_id, amount: 2500 }] } };
    await stripeEvent('charge.refunded', charge);
    expect(lic(u).tier).toBe('max'); // plan intact; minutes deliberately not clawed back
    expect(lic(u).credits_remaining_seconds).toBe(10800 + 1800);
  });

  it('Ultra first-month refund resolves the cs_ row through the invoice and cancels the subscription; the webhook frees the user', async () => {
    const u = mkUser('ref_ultra');
    const session = await buy(u, 'ultra');
    const [pay] = paymentsOf(u);
    expect(pay.provider_payment_id).toBe(session.id);
    resetCalls();
    const res = await call(`/api/v1/admin/payments/${pay.id}/refund`, { method: 'POST', token: adminToken(), body: { reason: 'requested_by_customer' } });
    expect(res.status, res.raw).toBe(200);
    expect(callsNamed('refunds.create')[0].args.params.payment_intent).toBe(fakeStripe._state.invoices.get(session.invoice).payment_intent);
    expect(res.body.subscription_cancel).toMatchObject({ cancelled: true, subscription_id: session.subscription });
    expect(subscriptionOf(session).status).toBe('canceled');
    const charge = { id: 'ch_ultra_first', customer: session.customer, payment_intent: fakeStripe._state.invoices.get(session.invoice).payment_intent, amount: 15900, amount_refunded: 15900, refunded: true, currency: 'usd', refunds: { data: [{ id: res.body.provider_refund_id, amount: 15900 }] } };
    await stripeEvent('charge.refunded', charge);
    expect(lic(u)).toMatchObject({ tier: 'free', status: 'refunded' });
  });

  it('Enterprise is refundable under the same published rules as Ultra', async () => {
    const u = mkUser('ref_ent');
    const session = await buy(u, 'enterprise');
    const [pay] = paymentsOf(u);
    const res = await call(`/api/v1/admin/payments/${pay.id}/refund`, { method: 'POST', token: adminToken(), body: {} });
    expect(res.status, res.raw).toBe(200);
    expect(res.body.subscription_cancel.cancelled).toBe(true);
    expect(subscriptionOf(session).status).toBe('canceled');
  });

  it('a partial refund keeps the plan; a comp cannot be refunded', async () => {
    const u = mkUser('ref_partial');
    const session = await buy(u, 'max');
    const [pay] = paymentsOf(u);
    const res = await call(`/api/v1/admin/payments/${pay.id}/refund`, { method: 'POST', token: adminToken(), body: { amount: 2000 } });
    expect(res.status, res.raw).toBe(200);
    const charge = { ...chargeFor(session), refunded: false, amount_refunded: 2000, refunds: { data: [{ id: res.body.provider_refund_id, amount: 2000 }] } };
    await stripeEvent('charge.refunded', charge);
    expect(lic(u).tier).toBe('max');
    const comp = mkUser('ref_comp');
    const grant = await call(`/api/v1/admin/users/${comp.id}/grant-comp`, { method: 'POST', token: adminToken(), body: { tier: 'pro', note: 'creator' } });
    expect(grant.status).toBe(200);
    const compRow = paymentsOf(comp)[0];
    expect(compRow).toMatchObject({ provider: 'admin-comp', amount: 0 });
    const refuse = await call(`/api/v1/admin/payments/${compRow.id}/refund`, { method: 'POST', token: adminToken(), body: {} });
    expect(refuse.status).toBe(400);
  });

  it('chargeback: dispute.created revokes at once; dispute.closed(won) restores from the last legitimate payment', async () => {
    const u = mkUser('dispute');
    const session = await buy(u, 'max');
    const charge = chargeFor(session);
    const dispute = { id: 'dp_1', charge: charge.id, payment_intent: session.payment_intent, customer: session.customer, amount: 8900, currency: 'usd', reason: 'fraudulent', status: 'needs_response' };
    await stripeEvent('charge.dispute.created', dispute);
    expect(lic(u)).toMatchObject({ tier: 'free', status: 'disputed' });
    expect(paymentsOf(u).at(-1)).toMatchObject({ status: 'disputed', amount: -8900 });
    await stripeEvent('charge.dispute.closed', { ...dispute, status: 'lost' });
    expect(lic(u).tier).toBe('free');
    await stripeEvent('charge.dispute.closed', { ...dispute, status: 'won' });
    expect(lic(u)).toMatchObject({ tier: 'max', status: 'active', credits_remaining_seconds: 10800 });
  });

  it('a refund or chargeback on a payment made under an OLDER customer id still finds the user through the ledger', async () => {
    const u = mkUser('ref_moved_customer');
    const session = await buy(u, 'pro', { customer: 'cus_old' });
    db.setPaymentProviderMarker(u.id, 'cus_new'); // e.g. a later checkout created a fresh customer
    const charge = { id: 'ch_old', customer: 'cus_old', payment_intent: session.payment_intent, amount: 5000, amount_refunded: 5000, refunded: true, currency: 'usd', refunds: { data: [{ id: 're_old', amount: 5000 }] } };
    await stripeEvent('charge.refunded', charge);
    expect(lic(u)).toMatchObject({ tier: 'free', status: 'refunded' });
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  10. ADMIN CONSOLE — grants, their permanence, and the two no-ops
// ═══════════════════════════════════════════════════════════════════════
describe('10 · admin console', () => {
  it('step-up is required for every money-equivalent route; a non-admin is 403', async () => {
    const u = mkUser('adm_stepup');
    const noStep = await call('/api/v1/admin/users/change-tier', { method: 'POST', token: adminToken({ stepUp: false }), body: { email: u.email, tier: 'pro' } });
    expect(noStep.status).toBe(403);
    expect(noStep.body.error).toBe('step_up_required');
    const stale = generateToken({ id: ADMIN.id, email: ADMIN.email, stepUp: true, stepUpAt: Date.now() - 16 * 60_000 }, '1h');
    const expired = await call('/api/v1/admin/users/change-tier', { method: 'POST', token: stale, body: { email: u.email, tier: 'pro' } });
    expect(expired.body.error).toBe('step_up_expired');
    const civilian = await call('/api/v1/admin/users/change-tier', { method: 'POST', token: tokenFor(u, { stepUp: true, stepUpAt: Date.now() }), body: { email: u.email, tier: 'pro' } });
    expect(civilian.status).toBe(403);
    expect(lic(u).tier).toBe('free');
  });

  it('change-tier to ANY paid tier = Enterprise-equivalent unlimited time, immune to webhooks, refunds, disputes and the sweeper', async () => {
    const u = mkUser('adm_grant');
    const session = await buy(u, 'ultra'); // a real subscription first
    const res = await call('/api/v1/admin/users/change-tier', { method: 'POST', token: adminToken(), body: { email: u.email, tier: 'basic' } });
    expect(res.status, res.raw).toBe(200);
    expect(res.body).toMatchObject({ success: true, tier: 'basic', credits: 'unlimited', never_expires: true });
    const L = lic(u);
    expect(L).toMatchObject({ tier: 'basic', status: 'active', expires_at: -1, sessions_limit: -1, credits_remaining_seconds: -1, credits_expire_at: -1 });
    expect(L.admin_granted_at).toBeGreaterThan(0);
    expect(db.resolveTimeBucket(L)).toEqual({ source: 'unlimited', remaining: -1 });
    // Features still follow the NAMED tier: Basic has no Claude even as an admin grant.
    const claude = await call('/api/v1/ai/chat/claude', { method: 'POST', token: tokenFor(u), headers: { 'x-app-version': '4.0.22' }, body: { messages: [] } });
    expect(claude.status).toBe(403);
    // Their old Ultra subscription dies at Stripe → refused, plan preserved.
    await stripeEvent('customer.subscription.deleted', subscriptionOf(session));
    expect(lic(u)).toMatchObject({ tier: 'basic', credits_remaining_seconds: -1 });
    expect(userRow(u).tier).toBe('basic');
    const charge = { id: 'ch_adm', customer: session.customer, payment_intent: 'pi_adm_old', amount: 15900, amount_refunded: 15900, refunded: true, currency: 'usd', refunds: { data: [{ id: 're_adm', amount: 15900 }] } };
    await stripeEvent('charge.refunded', charge);
    expect(lic(u).tier).toBe('basic');
    expect(db.transitionLicenseToFree(u.id, { reason: 'sweep' })).toBe(false);
    // Only the deliberate admin downgrade removes it.
    const down = await call('/api/v1/admin/users/downgrade', { method: 'POST', token: adminToken(), body: { email: u.email } });
    expect(down.status).toBe(200);
    expect(lic(u)).toMatchObject({ tier: 'free', status: 'active', credits_remaining_seconds: 0 });
    expect(lic(u).admin_granted_at).toBe(0);
  });

  it('grant-comp (dashboard) mirrors change-tier: -1 everywhere, an admin-comp ledger row, unlimited clock', async () => {
    const u = mkUser('adm_comp');
    const res = await call(`/api/v1/admin/users/${u.id}/grant-comp`, { method: 'POST', token: adminToken(), body: { tier: 'enterprise', note: 'design partner' } });
    expect(res.status, res.raw).toBe(200);
    expect(lic(u)).toMatchObject({ tier: 'enterprise', status: 'active', expires_at: -1, sessions_limit: -1, credits_remaining_seconds: -1, credits_expire_at: -1 });
    expect(lic(u).admin_granted_at).toBeGreaterThan(0);
    expect(paymentsOf(u)[0]).toMatchObject({ provider: 'admin-comp', amount: 0, status: 'completed', tier_granted: 'enterprise' });
    const start = await call('/api/v1/usage/start', { method: 'POST', token: tokenFor(u) });
    expect(start.body).toMatchObject({ source: 'unlimited', remaining: -1 });
    const free = await call(`/api/v1/admin/users/${u.id}/grant-comp`, { method: 'POST', token: adminToken(), body: { tier: 'free' } });
    expect(free.status).toBe(400);
  });

  it('grant-credits { minutes } adds interview time on the bucket the customer draws from; { credits } is the legacy session count', async () => {
    const u = mkUser('adm_minutes');
    await buy(u, 'basic');
    const add = await call('/api/v1/admin/users/grant-credits', { method: 'POST', token: adminToken(), body: { email: u.email, minutes: 30 } });
    expect(add.status, add.raw).toBe(200);
    expect(add.body).toMatchObject({ success: true, remaining_seconds: 3600, source: 'credits' });
    expect(add.body.message).toMatch(/Added 30 minute/);
    expect(lic(u)).toMatchObject({ tier: 'basic', credits_remaining_seconds: 3600, credits_granted_seconds: 3600, sessions_limit: 2 });
    const balance = await call('/api/v1/usage/balance', { token: tokenFor(u) });
    expect(balance.body.remaining).toBe(3600);
    const take = await call('/api/v1/admin/users/grant-credits', { method: 'POST', token: adminToken(), body: { email: u.email, minutes: -10 } });
    expect(take.body.remaining_seconds).toBe(3000);
    expect(lic(u).credits_remaining_seconds).toBe(3000);
    const legacy = await call('/api/v1/admin/users/grant-credits', { method: 'POST', token: adminToken(), body: { email: u.email, credits: 2 } });
    expect(legacy.status).toBe(200);
    expect(legacy.body.message).toMatch(/does not add interview time/i);
    expect(lic(u).sessions_limit).toBe(4);
    expect(lic(u).credits_remaining_seconds).toBe(3000);
    // A lapsed FREE account given minutes comes back as Basic with exactly those minutes.
    const f = mkUser('adm_minutes_free');
    const gift = await call('/api/v1/admin/users/grant-credits', { method: 'POST', token: adminToken(), body: { email: f.email, minutes: 20 } });
    expect(gift.status).toBe(200);
    expect(lic(f)).toMatchObject({ tier: 'basic', status: 'active', credits_remaining_seconds: 1200 });
    expect(userRow(f).tier).toBe('basic'); // the users row follows (dashboard badge, JWT tier claim)
    const start = await call('/api/v1/usage/start', { method: 'POST', token: tokenFor(f) });
    expect(start.body).toMatchObject({ source: 'credits', remaining: 1200 });
    // Unlimited plans: nothing to add, said plainly.
    const e = mkUser('adm_minutes_ent');
    await buy(e, 'enterprise');
    const noop = await call('/api/v1/admin/users/grant-credits', { method: 'POST', token: adminToken(), body: { email: e.email, minutes: 30 } });
    expect(noop.body).toMatchObject({ success: true, remaining_seconds: -1 });
    expect(noop.body.message).toMatch(/already has unlimited/);
    const audit = sql().prepare("SELECT * FROM audit_log WHERE action = 'grant-credits' AND target_user_id = ? ORDER BY id ASC LIMIT 1").get(u.id);
    expect(JSON.parse(audit.details_json)).toMatchObject({ minutes: 30, remaining_before: 1800, remaining_after: 3600 });
  });

  it('extend-expiry moves the plan date AND the interview window, so the extended pass is usable again (FIXED 2026-09)', async () => {
    const u = mkUser('adm_extend');
    await buy(u, 'basic');
    sql().prepare('UPDATE licenses SET credits_expire_at = ?, expires_at = ? WHERE user_id = ?').run(Date.now() - 1000, Date.now() - 1000, u.id);
    const lapsed = await call('/api/v1/usage/start', { method: 'POST', token: tokenFor(u) });
    expect(lapsed.status).toBe(403); // calendar-lapsed pass
    const ext = await call('/api/v1/admin/users/extend-expiry', { method: 'POST', token: adminToken(), body: { email: u.email, days: 7 } });
    expect(ext.status, ext.raw).toBe(200);
    expect(ext.body.message).toMatch(/interview window/);
    expect(lic(u).expires_at).toBeGreaterThan(Date.now() + 6 * DAY);
    expect(lic(u).credits_expire_at).toBe(lic(u).expires_at);
    const start = await call('/api/v1/usage/start', { method: 'POST', token: tokenFor(u) });
    expect(start.status, start.raw).toBe(200);
    expect(start.body).toMatchObject({ source: 'credits', remaining: 1800 });
    // Never-expiring plans are left alone and say so.
    const e = mkUser('adm_extend_ent');
    await buy(e, 'enterprise');
    const never = await call('/api/v1/admin/users/extend-expiry', { method: 'POST', token: adminToken(), body: { email: e.email, days: 7 } });
    expect(never.body.message).toMatch(/never expires/);
    expect(lic(e).expires_at).toBe(-1);
    // A metered Ultra (no window) keeps credits_expire_at 0.
    process.env.ULTRA_METERED = 'true';
    try {
      const m = mkUser('adm_extend_ultra');
      await buy(m, 'ultra');
      sql().prepare('UPDATE licenses SET expires_at = ? WHERE user_id = ?').run(Date.now() + DAY, m.id);
      await call('/api/v1/admin/users/extend-expiry', { method: 'POST', token: adminToken(), body: { email: m.email, days: 3 } });
      expect(lic(m).credits_expire_at).toBe(0);
    } finally {
      delete process.env.ULTRA_METERED;
    }
  });

  it('a LATER real purchase clears the admin-grant marker: the paid plan\'s own lifecycle can end it (FIXED 2026-09)', async () => {
    const u = mkUser('adm_sticky');
    await call(`/api/v1/admin/users/${u.id}/grant-comp`, { method: 'POST', token: adminToken(), body: { tier: 'pro' } });
    expect(lic(u).admin_granted_at).toBeGreaterThan(0);
    const session = await buy(u, 'ultra'); // customer later pays for Ultra
    expect(lic(u)).toMatchObject({ tier: 'ultra', credits_remaining_seconds: -1 });
    expect(lic(u).admin_granted_at).toBe(0); // the purchase superseded the comp
    await stripeEvent('customer.subscription.deleted', subscriptionOf(session)); // they cancel; Stripe stops billing
    expect(lic(u)).toMatchObject({ tier: 'free', status: 'expired' });
    // Same through the client success callback and through an in-place plan change.
    const v = mkUser('adm_sticky_verify');
    await call(`/api/v1/admin/users/${v.id}/grant-comp`, { method: 'POST', token: adminToken(), body: { tier: 'basic' } });
    const s = checkoutSessionFor(v, 'max');
    await call('/api/v1/payments/verify-stripe', { method: 'POST', token: tokenFor(v), body: { session_id: s.id } });
    expect(lic(v)).toMatchObject({ tier: 'max', credits_remaining_seconds: 10800 });
    expect(lic(v).admin_granted_at).toBe(0);
    const w = mkUser('adm_sticky_swap');
    await buy(w, 'ultra');
    await call('/api/v1/admin/users/change-tier', { method: 'POST', token: adminToken(), body: { email: w.email, tier: 'ultra' } });
    expect(lic(w).admin_granted_at).toBeGreaterThan(0);
    const swap = await call('/api/v1/payments/upgrade-tier', { method: 'POST', token: tokenFor(w), body: { tier: 'enterprise' } });
    expect(swap.status, swap.raw).toBe(200);
    expect(lic(w).admin_granted_at).toBe(0);
    // A comp that was never followed by a purchase is still immune (unchanged policy).
    const c = mkUser('adm_still_immune');
    const old = await buy(c, 'ultra');
    await call('/api/v1/admin/users/change-tier', { method: 'POST', token: adminToken(), body: { email: c.email, tier: 'max' } });
    await stripeEvent('customer.subscription.deleted', subscriptionOf(old));
    expect(lic(c).tier).toBe('max');
  });

  it('an admin buying through /create-checkout self-grants the METERED customer shape, not the comp shape', async () => {
    const res = await call('/api/v1/payments/create-checkout', { method: 'POST', token: adminToken({ stepUp: false }), body: { tier: 'basic' } });
    expect(res.status).toBe(200);
    expect(res.body.provider).toBe('admin-grant');
    const L = db.getLicenseByUserId(ADMIN.id);
    expect(L).toMatchObject({ tier: 'basic', credits_remaining_seconds: 1800 });
    expect(L.admin_granted_at || 0).toBe(0);
    // Harmless: the admin email bypasses every gate anyway.
    const start = await call('/api/v1/usage/start', { method: 'POST', token: adminToken({ stepUp: false }) });
    expect(start.body.source).toBe('unlimited');
    await call('/api/v1/usage/stop', { method: 'POST', token: adminToken({ stepUp: false }), body: { session_id: start.body.session_id } });
  });

  it('/admin/stats carries per-tier revenue for basic..ultra', async () => {
    const res = await call('/api/v1/admin/stats', { token: adminToken({ stepUp: false }) });
    expect(res.status, res.raw).toBe(200);
    for (const tier of ['basic', 'pro', 'max', 'ultra']) {
      expect(res.body.revenue_by_tier[tier]).toBeGreaterThan(0);
    }
    expect(res.body.tiers).toMatchObject({ free: expect.any(Number), ultra: expect.any(Number) });
  });

  it('/admin/stats reports Enterprise revenue, payments, signups and user counts (FIXED 2026-09)', async () => {
    const res = await call('/api/v1/admin/stats', { token: adminToken({ stepUp: false }) });
    expect(res.body.revenue_by_tier.enterprise).toBeGreaterThanOrEqual(119900);
    expect(res.body.payments_by_tier.enterprise).toBeGreaterThan(0);
    expect(res.body.revenue_by_tier_by_currency.enterprise.USD).toBeGreaterThanOrEqual(119900);
    expect(res.body.tiers.enterprise).toBeGreaterThan(0);
    expect(res.body.enterprise_users).toBe(res.body.tiers.enterprise);
    expect(res.body.signups_by_tier).toHaveProperty('enterprise');
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  11. THE SUPPORT-BOT ADMIN TOOLS — the second admin console
// ═══════════════════════════════════════════════════════════════════════
describe('11 · support-bot admin tools', () => {
  const ctx = () => ({ role: 'admin', user: { id: ADMIN.id, email: ADMIN.email, stepUp: true, stepUpAt: Date.now() } });

  it('tools demand confirmation + step-up and refuse non-admins', async () => {
    const u = mkUser('bot_guard');
    const unconfirmed = await botTools.executeTool('change_user_tier', { email: u.email, tier: 'pro', confirmed: false }, ctx());
    expect(unconfirmed.ok).toBe(false);
    const noStep = await botTools.executeTool('change_user_tier', { email: u.email, tier: 'pro', confirmed: true }, { role: 'admin', user: { email: ADMIN.email } });
    expect(noStep).toMatchObject({ ok: false, code: 'needs_step_up' });
    const civilian = await botTools.executeTool('change_user_tier', { email: u.email, tier: 'pro', confirmed: true }, { role: 'user', user: { email: u.email } });
    expect(civilian.ok).toBe(false);
    expect(lic(u).tier).toBe('free');
  });

  it('bot change_user_tier grants exactly what the dashboard grants (shared services/adminGrants.js): unlimited, marked, immune', async () => {
    const u = mkUser('bot_tier');
    const session = await buy(u, 'ultra'); // an earlier real subscription
    const res = await botTools.executeTool('change_user_tier', { email: u.email, tier: 'pro', confirmed: true }, ctx());
    expect(res).toMatchObject({ ok: true, credits: 'unlimited', never_expires: true });
    expect(lic(u)).toMatchObject({ tier: 'pro', status: 'active', expires_at: -1, sessions_limit: -1, credits_remaining_seconds: -1, credits_expire_at: -1 });
    expect(lic(u).admin_granted_at).toBeGreaterThan(0);
    const start = await call('/api/v1/usage/start', { method: 'POST', token: tokenFor(u) });
    expect(start.body.source).toBe('unlimited');
    // Marker set → the old subscription's deletion is refused, exactly like a dashboard grant.
    await stripeEvent('customer.subscription.deleted', subscriptionOf(session));
    expect(lic(u).tier).toBe('pro');
    // Every tier the dashboard can name, the bot can name.
    const schema = botTools.getToolSchemasForRole('admin').find(s => s.name === 'change_user_tier');
    expect(schema.parameters.properties.tier.enum).toEqual(['free', 'basic', 'pro', 'max', 'ultra', 'enterprise']);
    const ent = await botTools.executeTool('change_user_tier', { email: u.email, tier: 'enterprise', confirmed: true }, ctx());
    expect(ent.ok).toBe(true);
    expect(lic(u).tier).toBe('enterprise');
    // …and to free, which clears the marker and the balance.
    const free = await botTools.executeTool('change_user_tier', { email: u.email, tier: 'free', confirmed: true }, ctx());
    expect(free.ok).toBe(true);
    expect(lic(u)).toMatchObject({ tier: 'free', credits_remaining_seconds: 0 });
    expect(lic(u).admin_granted_at).toBe(0);
    // The bot cannot move a user it has no row for into a 500: a fresh user gets a licence materialised.
    const fresh = { id: 'u_bot_norow', email: 'bot.norow@minicaai.test' };
    db.createUser({ id: fresh.id, email: fresh.email, name: 'norow', password: 'x', tier: 'free', country_code: 'US' });
    const r = await botTools.executeTool('change_user_tier', { email: fresh.email, tier: 'ultra', confirmed: true }, ctx());
    expect(r.ok).toBe(true);
    expect(lic(fresh)).toMatchObject({ tier: 'ultra', credits_remaining_seconds: -1 });
  });

  it('bot grant_comp_subscription matches the dashboard comp for every paid tier, Enterprise included', async () => {
    const u = mkUser('bot_comp');
    const res = await botTools.executeTool('grant_comp_subscription', { email: u.email, tier: 'max', confirmed: true }, ctx());
    expect(res.ok).toBe(true);
    expect(lic(u)).toMatchObject({ tier: 'max', credits_remaining_seconds: -1, expires_at: -1 });
    expect(lic(u).admin_granted_at).toBeGreaterThan(0);
    const ent = await botTools.executeTool('grant_comp_subscription', { email: u.email, tier: 'enterprise', confirmed: true }, ctx());
    expect(ent.ok, JSON.stringify(ent)).toBe(true);
    expect(lic(u).tier).toBe('enterprise');
    expect(paymentsOf(u).filter(p => p.provider === 'admin-comp')).toHaveLength(2);
    const schema = botTools.getToolSchemasForRole('admin').find(s => s.name === 'grant_comp_subscription');
    expect(schema.parameters.properties.tier.enum).toEqual(['basic', 'pro', 'max', 'ultra', 'enterprise']);
  });

  it('bot grant_credits with minutes adds interview time like the dashboard; legacy credits still only touch the session count', async () => {
    const u = mkUser('bot_minutes');
    await buy(u, 'basic');
    const res = await botTools.executeTool('grant_credits', { email: u.email, minutes: 45, confirmed: true }, ctx());
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(res.remaining_seconds).toBe(1800 + 2700);
    expect(lic(u).credits_remaining_seconds).toBe(4500);
    const legacy = await botTools.executeTool('grant_credits', { email: u.email, credits: 2, confirmed: true }, ctx());
    expect(legacy.ok).toBe(true);
    expect(legacy.message).toMatch(/did not add interview time/i);
    expect(lic(u).credits_remaining_seconds).toBe(4500);
    const ent = mkUser('bot_minutes_ent');
    await buy(ent, 'enterprise');
    const noop = await botTools.executeTool('grant_credits', { email: ent.email, minutes: 30, confirmed: true }, ctx());
    expect(noop).toMatchObject({ ok: true, remaining_seconds: -1 });
  });

  it('bot refund_payment enforces the same eligibility and shares the admin refund claim key', async () => {
    const u = mkUser('bot_refund');
    await buy(u, 'basic');
    const [pay] = paymentsOf(u);
    sql().prepare('UPDATE payments SET created_at = ? WHERE id = ?').run(Date.now() - 20 * DAY, pay.id);
    const refused = await botTools.executeTool('refund_payment', { payment_id: pay.id, confirmed: true }, ctx());
    expect(refused.ok).toBe(false);
    expect(refused.eligibility?.code).toBe('window_expired');
    const forced = await botTools.executeTool('refund_payment', { payment_id: pay.id, confirmed: true, override_reason: 'retention goodwill gesture' }, ctx());
    expect(forced.ok, JSON.stringify(forced)).toBe(true);
    const again = await call(`/api/v1/admin/payments/${pay.id}/refund`, { method: 'POST', token: adminToken(), body: { override_reason: 'retention goodwill gesture' } });
    expect(again.status).toBe(400); // already refunded — one ledger, two consoles
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  12. WHAT THE CLIENT SEES — /license/validate echoes the row it meters by
// ═══════════════════════════════════════════════════════════════════════
describe('12 · client view', () => {
  it('/license/validate echoes tier, status and the credit columns for a pass and for Enterprise', async () => {
    const pass = mkUser('view_pass');
    await buy(pass, 'pro');
    const v1 = await call('/api/v1/license/validate', { method: 'POST', token: tokenFor(pass), body: { key: lic(pass).key, device_id: 'd1', app_version: '4.0.22' } });
    expect(v1.status, v1.raw).toBe(200);
    expect(v1.body).toMatchObject({ valid: true, tier: 'pro', status: 'active', credits_remaining_seconds: 3600, credits_expire_at: lic(pass).credits_expire_at, is_admin: false });
    const ent = mkUser('view_ent');
    await buy(ent, 'enterprise');
    const v2 = await call('/api/v1/license/validate', { method: 'POST', token: tokenFor(ent), body: { key: lic(ent).key, device_id: 'd2', app_version: '4.0.22' } });
    expect(v2.body).toMatchObject({ tier: 'enterprise', expires_at: -1, credits_remaining_seconds: -1, credits_expire_at: -1, sessions_limit: -1 });
    const other = await call('/api/v1/license/validate', { method: 'POST', token: tokenFor(pass), body: { key: lic(ent).key, device_id: 'd3', app_version: '4.0.22' } });
    expect(other.status).toBe(403);
    expect(other.body.error).toBe('license_mismatch');
  });

  it('/payments/history and /payments/subscription agree with the ledger after a purchase and a top-up', async () => {
    const u = mkUser('view_history');
    await buy(u, 'basic');
    fakeStripe._state.defaultPaymentMethod.set(`cus_${u.id}`, 'pm_saved');
    await call('/api/v1/usage/start', { method: 'POST', token: tokenFor(u) });
    await call('/api/v1/payments/extend-now', { method: 'POST', token: tokenFor(u), body: { pack: 'm30' } });
    const hist = await call('/api/v1/payments/history', { token: tokenFor(u) });
    expect(hist.status, hist.raw).toBe(200);
    const rows = Array.isArray(hist.body) ? hist.body : (hist.body.payments || hist.body.history || []);
    expect(rows.length).toBe(2);
    const sub = await call('/api/v1/payments/subscription', { token: tokenFor(u) });
    expect(sub.body).toMatchObject({ tier: 'basic', status: 'active', is_recurring: false, can_extend: true });
  });
});
