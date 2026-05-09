// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  PAYMENTS — Razorpay (India) + Stripe (Global)
//  Auto-routes based on user's country_code
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const express = require('express');
const { authMiddleware } = require('../middleware/auth');
const db = require('../database');

const router = express.Router();

// Mirror of the same env var used by admin.js / license.js. Lower-cased for
// case-insensitive comparison against req.user.email. Used to short-circuit
// the payment flow for admins so they can self-grant any tier without
// burning real money against Stripe/Razorpay.
const DEVELOPER_EMAILS = (process.env.ADMIN_EMAILS || '')
  .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
function isAdminEmail(email) {
  return !!email && DEVELOPER_EMAILS.includes(String(email).toLowerCase());
}

// ── Initialize payment providers (graceful if keys missing) ──
let stripe = null;
let razorpay = null;

if (process.env.STRIPE_SECRET_KEY) {
  stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  console.log('[Payments] Stripe initialized');
}

if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
  const Razorpay = require('razorpay');
  razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });
  console.log('[Payments] Razorpay initialized');
}

// ── Route: which provider for which country ──
function getPaymentProvider(countryCode) {
  if (countryCode === 'IN') return 'razorpay';
  return 'stripe';
}

// ── Tier → license grant config ─────────────────────────────────────
// Basic is a one-time purchase: 3 credits, 14-day expiry. Pro/Max are
// recurring and unlimited (lifecycle managed by provider webhooks).
const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;
function grantConfigForTier(tier) {
  if (tier === 'basic') {
    return { tier: 'basic', sessions_limit: 3, expires_at: Date.now() + FOURTEEN_DAYS_MS };
  }
  return { tier, sessions_limit: -1, expires_at: -1 };
}

// ── Normalize/validate the tier coming in from the client ──
const VALID_TIERS = ['basic', 'pro', 'max'];
function normalizeTier(t) {
  return VALID_TIERS.includes(t) ? t : 'pro';
}

// ── Basic-tier renewal: +1 interview, +1 hour wall-clock. Cheap top-up
//    for a Basic user who ran out mid-interview. Must match the per-region
//    amounts returned by pricingService.getBasicRenewalPrice() on the
//    client so the amount shown on the checkout modal matches the pill.
const RENEWAL_USD_CENTS = 699;   // $6.99
const RENEWAL_INR_PAISE = 59900; // ₹599

// ── Pricing validation ──────────────────────────────────────────────
// Rooted bug: the client hardcoded $29/$69 in pricingService.ts but the
// server resolved Stripe price IDs from env, so a deployment with a
// stale STRIPE_PRICE_USD pointing at the old $50 SKU would show "$29"
// in-app and then charge $50 at checkout. Users who caught the mismatch
// on the Stripe page bailed and reported "can't subscribe"; the rest
// paid the wrong amount. The previous LEGACY-FALLBACK-FIRED warning
// just logged — it did not block the wrong charge.
//
// We now check the configured price ID against the published in-app
// amount BEFORE creating a checkout session. On mismatch we refuse with
// a clear 503 instead of letting Stripe charge a different amount than
// the user agreed to. Stripe.prices.retrieve is fast but we cache for
// 10 minutes so this costs ~one extra round-trip per cold env, not per
// checkout. Cache resets on restart — which is also what ops does after
// fixing env vars.
//
// EXPECTED_*_AMOUNTS must stay in sync with pricingService.ts on the
// client. If you change a price, update both sides.
const EXPECTED_USD_CENTS = {
  basic: 2500, // $25 one-time (mode=payment)
  pro:   2900, // $29/month
  max:   6900, // $69/month
};
const EXPECTED_INR_PAISE = {
  basic: 199900, // ₹1999 one-time
  pro:   249900, // ₹2499/month
  max:   599900, // ₹5999/month
};
const PRICE_VALIDATION_TTL_MS = 10 * 60 * 1000;
const stripePriceCache = new Map(); // priceId → { amount, currency, recurring, interval, validated_at }
const razorpayPlanCache = new Map(); // planId  → { amount, currency, period, validated_at }

async function assertStripePriceMatches(stripeClient, priceId, tier) {
  const expected = EXPECTED_USD_CENTS[tier];
  if (!expected) return; // unknown tier — let it through (caller already validated)
  const expectedRecurring = tier !== 'basic';

  const now = Date.now();
  let entry = stripePriceCache.get(priceId);
  if (!entry || now - entry.validated_at > PRICE_VALIDATION_TTL_MS) {
    const price = await stripeClient.prices.retrieve(priceId);
    entry = {
      amount: price.unit_amount,
      currency: price.currency,
      recurring: !!price.recurring,
      interval: price.recurring?.interval || null,
      validated_at: now,
    };
    stripePriceCache.set(priceId, entry);
  }

  const mismatches = [];
  if (entry.amount !== expected) {
    mismatches.push(`amount: expected $${(expected/100).toFixed(2)} USD, got ${(entry.currency || '?').toUpperCase()} ${(entry.amount/100).toFixed(2)}`);
  } else if (entry.currency !== 'usd') {
    mismatches.push(`currency: expected USD, got ${(entry.currency || '?').toUpperCase()}`);
  }
  if (expectedRecurring && (!entry.recurring || entry.interval !== 'month')) {
    mismatches.push(`mode: expected monthly recurring, got ${entry.recurring ? `recurring/${entry.interval}` : 'one-time'}`);
  } else if (!expectedRecurring && entry.recurring) {
    mismatches.push(`mode: expected one-time, got recurring/${entry.interval}`);
  }
  if (mismatches.length) {
    const err = new Error(`Stripe price misconfigured for tier=${tier}: ${mismatches.join('; ')}`);
    err.code = 'PRICE_MISMATCH';
    err.tier = tier;
    err.priceId = priceId;
    err.expected = expected;
    err.actual = entry;
    throw err;
  }
}

async function assertRazorpayPlanMatches(razorpayClient, planId, tier) {
  const expected = EXPECTED_INR_PAISE[tier];
  if (!expected) return;

  const now = Date.now();
  let entry = razorpayPlanCache.get(planId);
  if (!entry || now - entry.validated_at > PRICE_VALIDATION_TTL_MS) {
    const plan = await razorpayClient.plans.fetch(planId);
    entry = {
      amount: plan.item?.amount,
      currency: plan.item?.currency,
      period: plan.period,     // 'monthly', 'yearly', 'weekly', 'daily'
      interval: plan.interval, // count of `period` between charges (1 = every period)
      validated_at: now,
    };
    razorpayPlanCache.set(planId, entry);
  }

  const mismatches = [];
  if (entry.amount !== expected) {
    mismatches.push(`amount: expected ${expected} paise (₹${expected/100}), got ${entry.amount}`);
  }
  if (entry.currency !== 'INR') {
    mismatches.push(`currency: expected INR, got ${entry.currency || '<missing>'}`);
  }
  if (entry.period !== 'monthly') {
    mismatches.push(`period: expected monthly, got ${entry.period || '<missing>'}`);
  }
  // P1-H from the audit: a plan with period='monthly' and interval=3
  // would bill every quarter at the same INR amount — same total
  // revenue per year but customer charged 4× a year instead of 12×.
  // Razorpay's UI lets you set both fields independently, so a
  // dashboard misclick can ship that misconfiguration silently.
  if (entry.interval !== 1) {
    mismatches.push(`interval: expected 1 (every period), got ${entry.interval ?? '<missing>'}`);
  }
  if (mismatches.length) {
    const err = new Error(`Razorpay plan misconfigured for tier=${tier}: ${mismatches.join('; ')}`);
    err.code = 'PLAN_MISMATCH';
    err.tier = tier;
    err.planId = planId;
    err.expected = expected;
    err.actual = entry;
    throw err;
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  CREATE CHECKOUT — auto-routes
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Pre-v3.4.7 read country_code from req.body first, falling back to
// req.user.country_code. That let a US user POST `country_code: "IN"`
// and get routed to Razorpay's INR pricing (~₹2499 for Pro vs the US
// ~$30 USD) — direct revenue arbitrage. Now we use ONLY the server-
// stored country_code from the JWT (set at signup, updatable via
// /profile with proper validation). Body field is ignored.
router.post('/create-checkout', authMiddleware, async (req, res) => {
  try {
    const tier = normalizeTier(req.body.tier);

    // ── Admin bypass ──
    // Admins can self-grant any tier without going through Stripe/Razorpay.
    // Returning provider='admin-grant' tells the client to skip the
    // checkout redirect and update local state from the returned license.
    // Without this branch, an admin clicking "Start Pro" on the pricing
    // card would land on a real Stripe page and have to abort.
    if (isAdminEmail(req.user.email)) {
      return await grantAdminTier(req, res, tier);
    }

    // SECURITY: country_code is server-controlled — read from the JWT
    // (set at signup, mutable only via /profile with /^[A-Z]{2}$/ check).
    // We deliberately ignore req.body.country_code so a malicious client
    // cannot swap their billing region to whichever currency is cheapest.
    const provider = getPaymentProvider(req.user.country_code || 'US');

    if (provider === 'razorpay') {
      return await createRazorpayCheckout(req, res, tier);
    } else {
      return await createStripeCheckout(req, res, tier);
    }
  } catch (err) {
    console.error('Checkout error:', err.message, err.stack);
    res.status(500).json({ error: err.message || 'Failed to create checkout. Please try again.' });
  }
});

// ── Admin self-grant ──
// Skips the payment provider entirely. Writes the tier to the user + license
// rows directly, audit-logs the action, and returns a synthetic checkout
// response the client recognizes via provider='admin-grant'. Mirrors the
// success path of /verify-razorpay so the client's local-state update can
// reuse the same code path.
async function grantAdminTier(req, res, tier) {
  const cfg = grantConfigForTier(tier);
  db.updateUserTier(req.user.id, cfg.tier);
  db.updateLicenseOnPayment(req.user.id, {
    tier: cfg.tier,
    status: 'active',
    expires_at: cfg.expires_at,
    sessions_limit: cfg.sessions_limit,
  });
  try {
    db.logAdminAction(
      req.user.email,
      'admin-grant-tier',
      req.user.id,
      req.user.email,
      { tier: cfg.tier, self_grant: true },
    );
  } catch (auditErr) {
    console.warn('[admin-grant] audit log failed:', auditErr.message);
  }
  const license = db.getLicenseByUserId(req.user.id);
  return res.json({
    provider: 'admin-grant',
    tier: cfg.tier,
    license: license ? { ...license, last_validated: Date.now() } : null,
    message: `Admin tier granted: ${cfg.tier.toUpperCase()}`,
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  UPGRADE TIER — in-place plan swap (Pro ↔ Max)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Distinct from /create-checkout because we update the EXISTING
// subscription instead of creating a new one. Without this endpoint, a
// Pro user clicking "Upgrade to Max" would create a second subscription
// alongside the first — they'd be billed for both until they noticed.
//
// Scope: Pro ↔ Max only. Basic is a one-time purchase (no subscription
// to swap), and downgrades to Basic / cancels go through the existing
// portal/cancel routes. Anyone on free or basic who picks Pro/Max still
// goes through /create-checkout (no existing sub to update).
//
// Both providers prorate. Stripe charges the diff on the next invoice
// via proration_behavior='create_prorations'. Razorpay charges the diff
// today via schedule_change_at='now' for upgrades; downgrades wait for
// cycle_end so the user keeps the tier they paid for through the cycle.
router.post('/upgrade-tier', authMiddleware, async (req, res) => {
  try {
    const targetTier = normalizeTier(req.body.tier);

    // Admin bypass — same shape as /create-checkout. Lets admins flip
    // their own tier to test UI on a new badge without a payment round-trip.
    if (isAdminEmail(req.user.email)) {
      return await grantAdminTier(req, res, targetTier);
    }

    if (targetTier === 'basic') {
      return res.status(400).json({
        error: 'Switching to Basic from a paid subscription is not supported. Cancel your current subscription first.',
      });
    }

    const user = db.getUserById(req.user.id);
    const currentLicense = db.getLicenseByUserId(req.user.id);
    if (!user || !currentLicense) {
      return res.status(400).json({
        error: 'No active subscription found. Start a new subscription instead.',
      });
    }
    const currentTier = currentLicense.tier;
    if (currentTier === targetTier) {
      return res.status(400).json({
        error: `You're already on the ${targetTier.toUpperCase()} plan.`,
      });
    }
    if (currentTier !== 'pro' && currentTier !== 'max') {
      return res.status(400).json({
        error: 'In-place plan change is only available for Pro and Max subscribers. Use the regular checkout instead.',
      });
    }
    if (currentLicense.status !== 'active') {
      return res.status(400).json({
        error: 'Your subscription is not currently active. Renew or restart it from the billing page.',
      });
    }

    // Provider is encoded in the stripe_customer_id prefix. We don't
    // store provider explicitly — same convention as /subscription.
    const customerId = user.stripe_customer_id || '';
    const isRazorpay = customerId.startsWith('rzp_');
    const isStripe = customerId.startsWith('cus_');

    if (isRazorpay) {
      return await upgradeRazorpaySubscription(req, res, { user, currentTier, targetTier });
    }
    if (isStripe) {
      return await upgradeStripeSubscription(req, res, { user, currentTier, targetTier });
    }

    // ── No payment provider on file → fall through to fresh checkout ──
    // Happens when the user's tier was set without going through a real
    // Stripe/Razorpay sub: an admin grant in test, a webhook that never
    // landed, or legacy data migrated without customer_id. The old behavior
    // was a 400 error telling the user to "start a new subscription" —
    // technically correct but the UI couldn't act on the message. Instead
    // we route them through the actual create-checkout flow for the target
    // tier so they can pay and get their customer_id properly recorded.
    // Once the webhook lands the user has a normal sub on file and future
    // upgrades use the in-place /upgrade-tier path.
    console.warn(`[upgrade-tier] no provider on file for ${req.user.email} (tier=${currentTier}); falling through to fresh checkout for ${targetTier}`);
    const provider = getPaymentProvider(req.user.country_code || 'US');
    if (provider === 'razorpay') {
      return await createRazorpayCheckout(req, res, targetTier);
    }
    return await createStripeCheckout(req, res, targetTier);
  } catch (err) {
    console.error('Upgrade-tier error:', err.message, err.stack);
    res.status(500).json({ error: err.message || 'Failed to change plan. Please try again.' });
  }
});

async function upgradeStripeSubscription(req, res, { user, currentTier, targetTier }) {
  if (!stripe) {
    return res.status(503).json({ error: 'Stripe is not configured. Contact support.' });
  }
  // Resolve the new line item — env-driven Price ID (validated) if set,
  // else inline price_data with the hardcoded amount. Same helper as
  // createStripeCheckout so the two flows can never disagree on what
  // ${targetTier} costs.
  let newLineItem;
  try {
    newLineItem = await resolveStripeLineItem(stripe, targetTier);
  } catch (err) {
    if (err.code === 'NO_PRICE_DATA') {
      return res.status(400).json({ error: `Unknown tier: ${targetTier}` });
    }
    console.error(`[upgrade-tier] resolveStripeLineItem failed for tier=${targetTier}:`, err.message || err);
    return res.status(503).json({
      error: 'Pricing service is temporarily unavailable. Please try again in a moment.',
    });
  }

  // Stripe customers can in theory have multiple active subscriptions.
  // We pick the most recent — the upgrade flow only makes sense against
  // the current paid tier and that's what /subscription reports.
  const subs = await stripe.subscriptions.list({
    customer: user.stripe_customer_id,
    status: 'active',
    limit: 1,
  });
  if (subs.data.length === 0) {
    return res.status(404).json({
      error: 'No active Stripe subscription found. Start a new subscription instead.',
    });
  }
  const subscription = subs.data[0];
  const itemId = subscription.items.data[0]?.id;
  if (!itemId) {
    return res.status(500).json({ error: 'Subscription has no line items to update. Contact support.' });
  }

  // The metadata.tier override is critical — customer.subscription.updated
  // reads it back to grant the right tier. Without it, the webhook would
  // fall through to the existing license tier (no change), and the upgrade
  // would silently revert on the next webhook tick.
  await stripe.subscriptions.update(subscription.id, {
    // newLineItem is { price: 'price_xxx' } when an env var is set, or
    // { price_data: {...} } when we're using the inline default. Stripe
    // accepts either shape on subscription updates.
    items: [{ id: itemId, ...newLineItem }],
    proration_behavior: 'create_prorations',
    // If the subscription was scheduled to cancel at period end (status
    // 'canceling' on our side), an in-place tier swap implies the user
    // wants to keep paying — flip cancel_at_period_end back to false so
    // the sub renews after this cycle. Without this, a user who canceled
    // then upgraded would pay the prorated diff today and STILL have
    // their sub end at cycle close — a confusing tax on a clear retention
    // signal. Idempotent: if cancel_at_period_end was already false, this
    // is a no-op on Stripe's side.
    cancel_at_period_end: false,
    metadata: {
      ...(subscription.metadata || {}),
      tier: targetTier,
      user_email: user.email,
      user_id: String(user.id),
    },
  });

  // Optimistic local update so the UI flips immediately. The webhook will
  // confirm seconds later; if anything goes wrong server-side, the next
  // /subscription poll will re-sync from Stripe via the webhook history.
  const grant = grantConfigForTier(targetTier);
  db.updateUserTier(user.id, grant.tier);
  db.updateLicenseOnPayment(user.id, {
    tier: grant.tier,
    status: 'active',
    expires_at: grant.expires_at,
    sessions_limit: grant.sessions_limit,
  });
  const license = db.getLicenseByUserId(user.id);

  return res.json({
    provider: 'stripe-upgrade',
    tier: targetTier,
    previous_tier: currentTier,
    license: license ? { ...license, last_validated: Date.now() } : null,
    message: `Plan changed to ${targetTier.toUpperCase()}. The prorated difference will appear on your next invoice.`,
  });
}

async function upgradeRazorpaySubscription(req, res, { user, currentTier, targetTier }) {
  if (!razorpay) {
    return res.status(503).json({ error: 'Razorpay is not configured. Contact support.' });
  }
  const newPlanId = process.env[RAZORPAY_PLAN_ENV[targetTier]]
    || (targetTier === 'pro' ? process.env.RAZORPAY_PLAN_ID : null);
  if (!newPlanId) {
    return res.status(503).json({
      error: `Pricing for ${targetTier.toUpperCase()} is not configured yet. Contact support.`,
    });
  }

  // Same plan-mismatch guard as createRazorpayCheckout — see the comment
  // there. An in-place upgrade with a misconfigured target plan would
  // bill the user a different amount than they agreed to.
  try {
    await assertRazorpayPlanMatches(razorpay, newPlanId, targetTier);
  } catch (err) {
    if (err.code === 'PLAN_MISMATCH') {
      console.error('━'.repeat(60));
      console.error(`[upgrade-tier] RAZORPAY PLAN MISMATCH — refusing to swap`);
      console.error(`  tier:     ${err.tier}`);
      console.error(`  planId:   ${err.planId}`);
      console.error(`  expected: ${err.expected} paise (₹${err.expected/100})`);
      console.error(`  actual:   ${JSON.stringify(err.actual)}`);
      console.error(`  user:     ${req.user.email} (id ${req.user.id})`);
      console.error('━'.repeat(60));
      return res.status(503).json({
        error: `Pricing for ${targetTier.toUpperCase()} is misconfigured on the server. Please contact support — we don't want to bill you the wrong amount.`,
      });
    }
    console.error(`[upgrade-tier] Razorpay plan lookup failed for ${newPlanId}:`, err.message || err);
    return res.status(503).json({
      error: 'Pricing service is temporarily unavailable. Please try again in a moment.',
    });
  }

  const subId = db.getLatestRazorpaySubscriptionId(user.id);
  if (!subId) {
    return res.status(404).json({
      error: 'No active Razorpay subscription found. Start a new subscription instead.',
    });
  }

  // Upgrade now (charge the diff today, give Max access immediately).
  // Downgrade waits for cycle_end so the user keeps the tier they paid
  // for through the rest of the billing cycle.
  const isUpgrade = (currentTier === 'pro' && targetTier === 'max');
  await razorpay.subscriptions.update(subId, {
    plan_id: newPlanId,
    schedule_change_at: isUpgrade ? 'now' : 'cycle_end',
    customer_notify: 1,
  });

  // For upgrades we apply optimistically; subscription.charged webhook
  // will reconcile the next billing cycle. For downgrades we keep the
  // current tier in DB — webhook will downgrade when the new cycle starts.
  if (isUpgrade) {
    const grant = grantConfigForTier(targetTier);
    db.updateUserTier(user.id, grant.tier);
    db.updateLicenseOnPayment(user.id, {
      tier: grant.tier,
      status: 'active',
      expires_at: grant.expires_at,
      sessions_limit: grant.sessions_limit,
    });
  }
  const license = db.getLicenseByUserId(user.id);

  return res.json({
    provider: 'razorpay-upgrade',
    tier: isUpgrade ? targetTier : currentTier,
    previous_tier: currentTier,
    pending_tier: isUpgrade ? null : targetTier,
    license: license ? { ...license, last_validated: Date.now() } : null,
    message: isUpgrade
      ? `Plan upgraded to ${targetTier.toUpperCase()}. The prorated difference has been charged today.`
      : `Plan will switch to ${targetTier.toUpperCase()} at the end of your current billing cycle. You keep ${currentTier.toUpperCase()} access until then.`,
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  CREATE RENEWAL — Basic top-up only
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Separate route from /create-checkout because the semantics differ: this
// charges the renewal price (a fraction of the Basic price) and the
// webhook/verify flow grants +1 session / +1 hour instead of resetting
// to the full 3-sessions / 14-days Basic grant. metadata.mode === 'renewal'
// is the signal the webhook reads to branch into the renewal grant.
router.post('/create-renewal', authMiddleware, async (req, res) => {
  try {
    // ── Tier gate ──
    // Renewal is the Basic +1h top-up. ONLY Basic-tier subscribers should
    // be able to buy it. Without this gate the endpoint accepted any
    // authenticated user and:
    //   • Free user → bumped to tier='basic' with 1h credit (confusing
    //     partial Basic grant for someone who wanted Pro/Max instead)
    //   • Pro/Max user → grantBasicRenewal preserved unlimited values so
    //     the user paid $6.99/₹599 for nothing — pure money waste
    // We allow ANY Basic license through (active, expired, exhausted)
    // because the explicit user intent is "I want more time on my Basic
    // plan." An expired-Basic user renewing is the most common case.
    const license = db.getLicenseByUserId(req.user.id);
    if (!license || license.tier !== 'basic') {
      return res.status(400).json({
        error: 'Renewal is only available to Basic plan subscribers. Buy the Basic plan to start.',
      });
    }
    // SECURITY: Same currency-injection mitigation as /create-checkout.
    // country_code is server-controlled (JWT, set at signup) — body is
    // ignored. Without this, a US user could POST country_code:"IN" and
    // pay the INR renewal (~₹599) instead of USD (~$6.99).
    const provider = getPaymentProvider(req.user.country_code || 'US');
    if (provider === 'razorpay') {
      return await createRazorpayRenewal(req, res);
    }
    return await createStripeRenewal(req, res);
  } catch (err) {
    console.error('Renewal checkout error:', err.message, err.stack);
    res.status(500).json({ error: err.message || 'Failed to start renewal. Please try again.' });
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  STRIPE — per-tier checkout (USA + Global)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Price ID env per tier. Honored when set so operators who want to manage
// prices in the Stripe Dashboard can. When NOT set we fall through to
// inline price_data with the hardcoded amounts in STRIPE_PRICE_DATA below
// — no env-var configuration required for a working checkout. Legacy
// STRIPE_PRICE_USD is still recognized as a Pro-only fallback so existing
// deployments don't break while Basic/Max are migrated.
const STRIPE_PRICE_ENV = {
  basic: 'STRIPE_PRICE_BASIC_USD',
  pro:   'STRIPE_PRICE_PRO_USD',
  max:   'STRIPE_PRICE_MAX_USD',
};

// Inline-Price defaults — used when the per-tier STRIPE_PRICE_*_USD env
// var isn't set. Stripe's `price_data` parameter creates an inline Price
// at session-create time (no pre-existing Price ID needed). This lets the
// server be the single source of truth for pricing without requiring any
// Stripe Dashboard setup. Renewals already use this pattern (createStripeRenewal
// below) — extending it to /create-checkout means a fresh deploy works
// out-of-the-box with no STRIPE_PRICE_*_USD env vars at all.
//
// Must stay in sync with EXPECTED_USD_CENTS above and the client's
// pricingService.ts USD_PRICES — that's what the price-mismatch validator
// checks when an env-driven Price IS configured.
const STRIPE_PRICE_DATA = {
  basic: {
    currency: 'usd',
    product_data: {
      name: 'minicaai Basic',
      description: '3 interview credits · 14-day expiry · GPT-5.5 · Grok · Llama',
    },
    unit_amount: 2500,
    // No `recurring` — Basic is a one-time payment.
  },
  pro: {
    currency: 'usd',
    product_data: {
      name: 'minicaai Pro',
      description: 'Unlimited sessions · 4 AI models · Pop-out · Auto-Solve',
    },
    unit_amount: 2900,
    recurring: { interval: 'month' },
  },
  max: {
    currency: 'usd',
    product_data: {
      name: 'minicaai Max',
      description: 'Pro + Claude Sonnet 4.6 + Auto-Type + Train Model',
    },
    unit_amount: 6900,
    recurring: { interval: 'month' },
  },
};

// Resolve a Stripe line_item entry for the given tier. Tries env-driven
// Price IDs first (validating against the in-app amount before use); on
// any failure, falls back to inline price_data with the canonical hard-
// coded amount instead of refusing. The fall-back is the load-bearing
// change: a stale env var (e.g. STRIPE_PRICE_USD pointing at the old
// $50 Pro SKU) used to silently charge the wrong amount. With strict
// validation it would 503 instead, breaking the click. Falling through
// to price_data gives the user the correct charge AND surfaces a loud
// warning in the server logs so the operator can clean up the env var
// at their leisure — no hard-break, no wrong charge.
async function resolveStripeLineItem(stripe, tier) {
  const envVar = STRIPE_PRICE_ENV[tier];
  const primary = envVar ? process.env[envVar] : null;
  const legacyFallback = (tier === 'pro' && !primary)
    ? process.env.STRIPE_PRICE_USD
    : null;
  const priceId = primary || legacyFallback;

  if (priceId) {
    try {
      await assertStripePriceMatches(stripe, priceId, tier);
      return { price: priceId };
    } catch (err) {
      // Validation failed (mismatch, deleted price, Stripe API blip, etc).
      // Fall through to inline price_data with the canonical amount —
      // user gets charged correctly, operator sees the warning. We log
      // the actual vs expected so it's obvious what to fix in the env.
      console.warn('━'.repeat(60));
      console.warn(`[checkout] Stripe Price ID validation FAILED — falling back to inline price_data`);
      console.warn(`  tier:     ${tier}`);
      console.warn(`  priceId:  ${priceId}`);
      console.warn(`  source:   ${primary ? envVar : 'STRIPE_PRICE_USD (legacy)'}`);
      console.warn(`  reason:   ${err.message}`);
      if (err.expected != null) console.warn(`  expected: $${(err.expected/100).toFixed(2)} USD`);
      if (err.actual) console.warn(`  actual:   ${JSON.stringify(err.actual)}`);
      console.warn(`  Action:   align ${primary ? envVar : 'STRIPE_PRICE_USD'} with the in-app price`);
      console.warn(`            OR unset it to silence this warning (price_data default will continue to work).`);
      console.warn('━'.repeat(60));
      // fall through to price_data
    }
  }

  // Default path: inline price_data. No env vars required, server is the
  // single source of truth for the price.
  const priceData = STRIPE_PRICE_DATA[tier];
  if (!priceData) {
    const err = new Error(`No price_data default for tier=${tier}`);
    err.code = 'NO_PRICE_DATA';
    throw err;
  }
  return { price_data: priceData };
}

async function createStripeCheckout(req, res, tier) {
  if (!stripe) {
    return res.status(503).json({ error: 'Stripe is not configured. Contact support.' });
  }

  let lineItem;
  try {
    lineItem = await resolveStripeLineItem(stripe, tier);
  } catch (err) {
    if (err.code === 'NO_PRICE_DATA') {
      return res.status(400).json({ error: `Unknown tier: ${tier}` });
    }
    // resolveStripeLineItem swallows price-validation failures and falls
    // back to price_data, so the only errors that propagate here are
    // structural (unknown tier) or unexpected programming bugs. Surface
    // them as 503 — Stripe-API outages would manifest later in
    // sessions.create() and 5xx anyway.
    console.error(`[checkout] resolveStripeLineItem failed for tier=${tier}:`, err.message || err);
    return res.status(503).json({
      error: 'Pricing service is temporarily unavailable. Please try again in a moment.',
    });
  }

  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3005';
  // Basic is a one-time purchase (3 credits, 14-day expiry). Pro/Max are
  // recurring subscriptions with provider-managed lifecycle.
  const mode = tier === 'basic' ? 'payment' : 'subscription';

  // Reuse the existing Stripe customer when we have one. Stripe creates a
  // brand-new cus_* if you pass `customer_email` instead of `customer`,
  // and we'd then overwrite users.stripe_customer_id on every checkout
  // — fragmenting the same human across N customer rows. With reuse, the
  // user keeps a single stable customer_id across renewals, plan swaps,
  // disputes, and reactivations. (P2-S3 from the audit.)
  const existingUser = db.getUserById(req.user.id);
  const reuseCustomerId = existingUser?.stripe_customer_id?.startsWith('cus_')
    ? existingUser.stripe_customer_id
    : null;

  const sessionParams = {
    mode,
    // Omitting payment_method_types lets the Stripe Dashboard control
    // which methods are offered. With Dashboard config, EU users get
    // SEPA + iDEAL + Bancontact, UK users get BACS + card, AU users get
    // BPAY, AND Apple/Google Pay light up automatically on supported
    // devices for all card-eligible regions. Explicit ['card'] disabled
    // every one of those. (P2-S1 from the audit.)
    line_items: [{ ...lineItem, quantity: 1 }],
    // `tier` rides in the URL so the frontend can show a welcome banner
    // even if the webhook hasn't landed by the time the user returns.
    success_url: `${frontendUrl}?payment=success&tier=${tier}&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${frontendUrl}?payment=cancelled`,
    metadata: {
      user_email: req.user.email,
      user_id: String(req.user.id),
      provider: 'stripe',
      tier,
    },
    billing_address_collection: 'required',
    // Stripe Tax — automatic VAT/GST/sales tax calculation per the
    // customer's billing address. Required for EU/UK/AU compliance once
    // we cross local registration thresholds. Tax is added on top of
    // the listed price; the user sees the breakdown on the Checkout
    // page. Requires Stripe Tax enabled in the Dashboard + the merchant
    // having registered tax IDs in jurisdictions where they collect.
    // (P2-S2 from the audit.) Safe-default if not configured: Stripe
    // returns 0 tax and the flow proceeds, so this is non-breaking.
    automatic_tax: { enabled: true },
    // Allow Stripe to update the customer's stored address based on
    // the address collected at checkout — needed for Tax to recompute
    // jurisdiction on subsequent invoices.
    customer_update: reuseCustomerId ? { address: 'auto' } : undefined,
  };

  if (reuseCustomerId) {
    sessionParams.customer = reuseCustomerId;
  } else {
    sessionParams.customer_email = req.user.email;
  }

  // For subscriptions, also stamp tier onto the subscription itself so
  // customer.subscription.updated/.deleted webhooks know which tier to keep
  // or revoke.
  if (mode === 'subscription') {
    sessionParams.subscription_data = {
      metadata: {
        user_email: req.user.email,
        user_id: String(req.user.id),
        tier,
      },
    };
  }

  const session = await stripe.checkout.sessions.create(sessionParams);

  res.json({
    provider: 'stripe',
    checkout_url: session.url,
    session_id: session.id,
    tier,
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  RAZORPAY — per-tier checkout (India)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// INR amounts & copy per tier. Must match the pricingService table on the
// client for the amount shown on the Razorpay checkout modal to match
// what the user clicked. Amount is in paise.
const RAZORPAY_TIER_CONFIG = {
  basic: {
    amountPaise: 199900, // ₹1999 one-time
    name: 'minicaai Basic',
    description: '3 interview credits · 14-day expiry',
  },
  pro: {
    amountPaise: 249900, // ₹2499/month
    name: 'minicaai Pro',
    description: 'Pro Plan — ₹2499/month · unlimited sessions',
  },
  max: {
    amountPaise: 599900, // ₹5999/month
    name: 'minicaai Max',
    description: 'Max Plan — ₹5999/month · Auto-Type unlocked',
  },
};
// Plan-ID env per tier. Legacy RAZORPAY_PLAN_ID stays valid for Pro so
// existing deployments don't break while Max is being set up.
const RAZORPAY_PLAN_ENV = {
  pro: 'RAZORPAY_PLAN_ID_PRO',
  max: 'RAZORPAY_PLAN_ID_MAX',
};

async function createRazorpayCheckout(req, res, tier) {
  if (!razorpay) {
    return res.status(503).json({ error: 'Razorpay is not configured. Contact support.' });
  }

  const cfg = RAZORPAY_TIER_CONFIG[tier];
  if (!cfg) {
    return res.status(400).json({ error: `Unknown tier: ${tier}` });
  }

  // Pro/Max → recurring subscription (if a plan is configured).
  // Basic → always one-time order (no recurring semantics).
  if (tier !== 'basic') {
    const planId = process.env[RAZORPAY_PLAN_ENV[tier]]
      || (tier === 'pro' ? process.env.RAZORPAY_PLAN_ID : null);

    if (planId) {
      // Verify the plan's amount/currency/period match the published in-app
      // amount before creating the subscription. The Razorpay equivalent of
      // the Stripe price-mismatch check — see assertStripePriceMatches for
      // the rationale. Without this, an out-of-sync RAZORPAY_PLAN_ID_* env
      // var would charge a different amount than the user agreed to.
      try {
        await assertRazorpayPlanMatches(razorpay, planId, tier);
      } catch (err) {
        if (err.code === 'PLAN_MISMATCH') {
          console.error('━'.repeat(60));
          console.error(`[checkout] RAZORPAY PLAN MISMATCH — refusing to charge`);
          console.error(`  tier:     ${err.tier}`);
          console.error(`  planId:   ${err.planId}`);
          console.error(`  expected: ${err.expected} paise (₹${err.expected/100})`);
          console.error(`  actual:   ${JSON.stringify(err.actual)}`);
          console.error(`  user:     ${req.user.email} (id ${req.user.id})`);
          console.error(`  Action:   align ${RAZORPAY_PLAN_ENV[tier] || 'RAZORPAY_PLAN_ID'} on Railway with the in-app price.`);
          console.error('━'.repeat(60));
          return res.status(503).json({
            error: `Pricing for ${tier.toUpperCase()} is misconfigured on the server. Please contact support — we don't want to charge you the wrong amount.`,
          });
        }
        console.error(`[checkout] Razorpay plan lookup failed for ${planId}:`, err.message || err);
        return res.status(503).json({
          error: 'Pricing service is temporarily unavailable. Please try again in a moment.',
        });
      }

      const subscription = await razorpay.subscriptions.create({
        plan_id: planId,
        total_count: 12, // 12 months max
        quantity: 1,
        notes: {
          user_email: req.user.email,
          user_id: String(req.user.id),
          tier, // CRITICAL: verify-razorpay + webhooks read this back
        },
      });

      return res.json({
        provider: 'razorpay',
        subscription_id: subscription.id,
        key_id: process.env.RAZORPAY_KEY_ID,
        amount: cfg.amountPaise,
        currency: 'INR',
        name: cfg.name,
        description: cfg.description,
        user_email: req.user.email,
        user_name: req.user.name || '',
        tier,
      });
    }
    // Falls through to one-time order when the plan isn't configured yet
    // — lets Max be exercised in test mode before creating the recurring
    // plan in the Razorpay dashboard.
  }

  const order = await razorpay.orders.create({
    amount: cfg.amountPaise,
    currency: 'INR',
    receipt: `${tier}_${req.user.id}_${Date.now()}`,
    notes: {
      user_email: req.user.email,
      user_id: String(req.user.id),
      tier,
    },
  });

  res.json({
    provider: 'razorpay',
    order_id: order.id,
    key_id: process.env.RAZORPAY_KEY_ID,
    amount: order.amount,
    currency: order.currency,
    name: cfg.name,
    description: cfg.description,
    user_email: req.user.email,
    user_name: req.user.name || '',
    tier,
  });
}

// ── STRIPE RENEWAL ─────────────────────────────────────────────────
// Uses `price_data` inline (not a pre-created price ID) so we don't have
// to make the user configure yet another env var for the renewal amount.
// mode: 'payment' — one-time charge, no recurring semantics.
async function createStripeRenewal(req, res) {
  if (!stripe) {
    return res.status(503).json({ error: 'Stripe is not configured. Contact support.' });
  }
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3005';
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    customer_email: req.user.email,
    line_items: [{
      price_data: {
        currency: 'usd',
        product_data: {
          name: 'minicaai Basic — Renewal (+1 interview)',
          description: 'Adds 1 interview credit and extends your Basic plan by 1 hour.',
        },
        unit_amount: RENEWAL_USD_CENTS,
      },
      quantity: 1,
    }],
    // `mode=renewal` in the success URL lets the frontend pick the right
    // welcome banner ("renewed" vs "3 credits unlocked") even before the
    // webhook lands.
    success_url: `${frontendUrl}?payment=success&mode=renewal&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${frontendUrl}?payment=cancelled`,
    metadata: {
      user_email: req.user.email,
      user_id: String(req.user.id),
      provider: 'stripe',
      mode: 'renewal',  // CRITICAL: webhook branches on this
    },
    billing_address_collection: 'required',
  });
  res.json({
    provider: 'stripe',
    checkout_url: session.url,
    session_id: session.id,
    mode: 'renewal',
  });
}

// ── RAZORPAY RENEWAL ───────────────────────────────────────────────
// One-time order at the renewal price. notes.mode === 'renewal' is the
// signal webhook + verify read to call grantBasicRenewal instead of the
// full tier grant. notes.tier='basic' is kept for any legacy guard that
// still requires a valid tier string.
async function createRazorpayRenewal(req, res) {
  if (!razorpay) {
    return res.status(503).json({ error: 'Razorpay is not configured. Contact support.' });
  }
  const order = await razorpay.orders.create({
    amount: RENEWAL_INR_PAISE,
    currency: 'INR',
    receipt: `renew_${req.user.id}_${Date.now()}`,
    notes: {
      user_email: req.user.email,
      user_id: String(req.user.id),
      mode: 'renewal',
      tier: 'basic',
    },
  });
  res.json({
    provider: 'razorpay',
    order_id: order.id,
    key_id: process.env.RAZORPAY_KEY_ID,
    amount: order.amount,
    currency: order.currency,
    name: 'minicaai Basic — Renewal',
    description: '+1 interview (1 hour)',
    user_email: req.user.email,
    user_name: req.user.name || '',
    mode: 'renewal',
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  VERIFY RAZORPAY PAYMENT (client-side callback)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.post('/verify-razorpay', authMiddleware, async (req, res) => {
  try {
    const { razorpay_payment_id, razorpay_order_id, razorpay_signature, razorpay_subscription_id } = req.body;

    if (!razorpay_payment_id) {
      return res.status(400).json({ error: 'Payment ID required' });
    }

    // Verify signature. CRITICAL: both branches must run — if neither
    // razorpay_subscription_id nor razorpay_order_id is sent, we must refuse
    // the upgrade. An earlier version accepted just `razorpay_payment_id`
    // and silently fell through to the upgrade block, which is a free-pro
    // bypass for any authenticated user.
    const crypto = require('crypto');
    const secret = process.env.RAZORPAY_KEY_SECRET;
    if (!secret) {
      return res.status(503).json({ error: 'Razorpay not configured on server' });
    }
    if (!razorpay_signature) {
      return res.status(400).json({ error: 'Payment verification failed. Missing signature.' });
    }

    let expectedSignature;
    if (razorpay_subscription_id) {
      // Subscription verification
      expectedSignature = crypto
        .createHmac('sha256', secret)
        .update(`${razorpay_payment_id}|${razorpay_subscription_id}`)
        .digest('hex');
    } else if (razorpay_order_id) {
      // Order verification
      expectedSignature = crypto
        .createHmac('sha256', secret)
        .update(`${razorpay_order_id}|${razorpay_payment_id}`)
        .digest('hex');
    } else {
      return res.status(400).json({ error: 'Payment verification failed. Missing subscription_id or order_id.' });
    }

    // Constant-time compare — avoids a (theoretical) timing oracle on the HMAC.
    const sigBuf = Buffer.from(razorpay_signature, 'utf8');
    const expBuf = Buffer.from(expectedSignature, 'utf8');
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      return res.status(400).json({ error: 'Payment verification failed. Invalid signature.' });
    }

    // Idempotency: the client calls /verify-razorpay on success, AND the
    // webhook handler independently processes the same payment. Both paths
    // race, and a double-click / client retry can trigger /verify twice for
    // the same payment. If we already recorded a completed payment with
    // this provider_payment_id, short-circuit and return the current
    // license state — re-running grantBasicRenewal adds +1 credit +1h on
    // every duplicate call (verified: grantBasicRenewal is additive).
    {
      const d = db.getDB();
      const existing = d.prepare(`
        SELECT * FROM payments
        WHERE user_id = ? AND provider = 'razorpay'
          AND provider_payment_id = ? AND status = 'completed'
        LIMIT 1
      `).get(req.user.id, razorpay_payment_id);
      if (existing) {
        const license = db.getLicenseByUserId(req.user.id);
        const existingMeta = (() => { try { return JSON.parse(existing.metadata || '{}'); } catch { return {}; } })();
        return res.json({
          success: true,
          duplicate: true,
          message: existingMeta.mode === 'renewal'
            ? 'Renewal already applied.'
            : 'Payment already verified.',
          tier: existing.tier_granted,
          mode: existingMeta.mode || 'tier',
          license: license ? { ...license, last_validated: Date.now() } : null,
        });
      }
    }

    // Signature verified — resolve which tier (or renewal) was actually
    // purchased by fetching the original subscription/order from Razorpay
    // and reading the `notes` we stamped at create time. Trusting client-
    // sent values is unsafe (a free user could POST tier=max).
    //
    // CRITICAL: do NOT default to 'pro' on fetch failure — that silently
    // grants Pro to anyone whose verify lands during a Razorpay outage,
    // including someone who paid for Max (downgrade) or Basic (upgrade).
    // If the fetch fails we surface a "verification pending" response and
    // let the signature-verified webhook (which carries the full payload)
    // reconcile the tier authoritatively. The client polls /subscription,
    // so the upgrade lands within seconds either way.
    let grantedTier = null;
    let grantedAmount = null;
    let isRenewal = false;
    let lookupFailed = false;
    try {
      if (razorpay_subscription_id) {
        const sub = await razorpay.subscriptions.fetch(razorpay_subscription_id);
        const t = sub && sub.notes && sub.notes.tier;
        if (VALID_TIERS.includes(t)) grantedTier = t;
        // Subscriptions are never renewals — skip the notes.mode check.
      } else if (razorpay_order_id) {
        const order = await razorpay.orders.fetch(razorpay_order_id);
        const t = order && order.notes && order.notes.tier;
        if (VALID_TIERS.includes(t)) grantedTier = t;
        if (typeof order?.amount === 'number') grantedAmount = order.amount;
        // Renewal orders carry notes.mode === 'renewal'. Flag it so the
        // grant below branches to +1/+1h instead of full Basic.
        if (order && order.notes && order.notes.mode === 'renewal') {
          isRenewal = true;
        }
      }
      if (!isRenewal && grantedTier && RAZORPAY_TIER_CONFIG[grantedTier]) {
        grantedAmount = RAZORPAY_TIER_CONFIG[grantedTier].amountPaise;
      }
    } catch (fetchErr) {
      lookupFailed = true;
      console.error('━'.repeat(60));
      console.error('[verify-razorpay] CRITICAL: tier lookup failed for verified payment');
      console.error('  payment_id:     ', razorpay_payment_id);
      console.error('  subscription_id:', razorpay_subscription_id || '(none)');
      console.error('  order_id:       ', razorpay_order_id || '(none)');
      console.error('  user_email:     ', req.user.email);
      console.error('  error:          ', fetchErr.message);
      console.error('  → returning pending; webhook will reconcile authoritatively');
      console.error('━'.repeat(60));
    }

    // If we couldn't determine the tier, the safe move is to NOT touch the
    // license/tier in the DB. We record the payment as 'pending' (audit
    // trail) and return success-with-pending so the client shows a friendly
    // message. The signature-verified webhook will land within seconds and
    // grant the right tier from the full payload.
    if (lookupFailed || !grantedTier) {
      try {
        db.recordPayment({
          user_id: req.user.id,
          email: req.user.email,
          provider: 'razorpay',
          provider_payment_id: razorpay_payment_id,
          provider_subscription_id: razorpay_subscription_id || null,
          amount: 0,
          currency: 'INR',
          status: 'pending',
          tier_granted: null,
          metadata: {
            order_id: razorpay_order_id || null,
            verified_client_side: true,
            tier_lookup_failed: lookupFailed,
            note: 'Awaiting webhook reconciliation',
          },
        });
      } catch (recErr) {
        console.warn('[verify-razorpay] failed to record pending payment:', recErr.message);
      }
      const license = db.getLicenseByUserId(req.user.id);
      return res.status(202).json({
        success: true,
        pending: true,
        message: 'Payment received. Your account will activate momentarily.',
        tier: license ? license.tier : null,
        license: license ? { ...license, last_validated: Date.now() } : null,
      });
    }

    // Payment verified — grant the tier (or renewal top-up). Wrapped in a
    // SQLite transaction so a partial failure (grant succeeds, recordPayment
    // throws) can't leave the user paid-but-not-recorded or, on a client
    // retry, double-apply the additive renewal top-up.
    const user = db.getUserById(req.user.id);
    let grantedTierLabel = grantedTier;
    let alreadyGranted = false;
    if (user) {
      const sqlite = db.getDB();
      const applyGrant = sqlite.transaction(() => {
        // Re-check WITHIN the transaction. The pre-tx check at the top of
        // this handler can race with payment.captured: this handler does
        // an `await razorpay.orders.fetch()` between the pre-check and the
        // transaction, and during that await the webhook can run end-to-end
        // and INSERT the payment row. Without this in-tx re-check, both
        // paths would each call grantBasicRenewal (additive +1h) and the
        // user would get +2h for one payment. The UNIQUE index on
        // (provider, provider_payment_id) is the DB-layer backstop.
        const dup = sqlite.prepare(
          "SELECT id FROM payments WHERE user_id = ? AND provider = 'razorpay' AND provider_payment_id = ? AND status = 'completed' LIMIT 1"
        ).get(user.id, razorpay_payment_id);
        if (dup) { alreadyGranted = true; return; }

        if (isRenewal) {
          // Renewal: +1 session, +1 hour — no tier reset, no expiry overwrite.
          db.grantBasicRenewal(user.id);
          const post = db.getLicenseByUserId(user.id);
          grantedTierLabel = (post && post.tier) || 'basic';
        } else {
          const grant = grantConfigForTier(grantedTier);
          grantedTierLabel = grant.tier;
          db.updateUserTier(user.id, grant.tier);
          db.updateLicenseOnPayment(user.id, {
            tier: grant.tier,
            status: 'active',
            expires_at: grant.expires_at,
            sessions_limit: grant.sessions_limit,
          });
        }

        // Store payment reference. Legacy prefix-marker in stripe_customer_id
        // for provider detection; new dedicated column razorpay_subscription_id
        // for the actual stable subscription pointer (only set when this is
        // a recurring sub, not a one-time order).
        sqlite.prepare('UPDATE users SET stripe_customer_id = ?, updated_at = ? WHERE id = ?')
          .run(`rzp_${razorpay_subscription_id || razorpay_payment_id}`, Date.now(), user.id);
        if (razorpay_subscription_id) {
          db.setRazorpaySubscriptionId(user.id, razorpay_subscription_id);
        }

        // Record payment in history
        db.recordPayment({
          user_id: user.id,
          email: user.email,
          provider: 'razorpay',
          provider_payment_id: razorpay_payment_id,
          provider_subscription_id: razorpay_subscription_id || null,
          amount: isRenewal ? RENEWAL_INR_PAISE : grantedAmount,
          currency: 'INR',
          status: 'completed',
          tier_granted: grantedTierLabel,
          metadata: {
            order_id: razorpay_order_id,
            verified_client_side: true,
            tier: grantedTierLabel,
            mode: isRenewal ? 'renewal' : 'tier',
          },
        });
      });
      applyGrant();
    }

    const license = db.getLicenseByUserId(req.user.id);

    // If the in-tx re-check found the webhook had already granted, return
    // the same friendly "duplicate" shape the pre-tx check uses, so the
    // client UI still shows success but knows not to double-celebrate.
    if (alreadyGranted) {
      return res.json({
        success: true,
        duplicate: true,
        message: isRenewal ? 'Renewal already applied.' : 'Payment already verified.',
        tier: license ? license.tier : grantedTierLabel,
        mode: isRenewal ? 'renewal' : 'tier',
        license: license ? { ...license, last_validated: Date.now() } : null,
      });
    }

    res.json({
      success: true,
      message: isRenewal
        ? 'Renewal successful — 1 extra interview unlocked (1 hour).'
        : `Payment verified. Account upgraded to ${grantedTierLabel.toUpperCase()}!`,
      tier: grantedTierLabel,
      mode: isRenewal ? 'renewal' : 'tier',
      license: license ? { ...license, last_validated: Date.now() } : null,
    });
  } catch (err) {
    console.error('Razorpay verification error:', err.message);
    res.status(500).json({ error: 'Payment verification failed' });
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  GET SUBSCRIPTION STATUS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.get('/subscription', authMiddleware, async (req, res) => {
  try {
    const user = db.getUserById(req.user.id);
    const license = db.getLicenseByUserId(req.user.id);

    if (!user || !license) {
      return res.json({ status: 'none', tier: 'free', provider: null });
    }

    // Check if paid via Razorpay or Stripe
    const customerId = user.stripe_customer_id || '';
    const provider = customerId.startsWith('rzp_') ? 'razorpay' : customerId.startsWith('cus_') ? 'stripe' : null;

    // Derive cancel-pending state from the canonical license.status the
    // webhook handler sets ('canceling' = cancel_at_period_end=true and
    // we're still inside the paid window). Surfacing the boolean and
    // cycle-end timestamp lets the client render an explicit "Cancellation
    // scheduled — access until <date>" banner and a Reactivate CTA without
    // having to round-trip Stripe on every page load.
    const isCancelPending = license.status === 'canceling';

    res.json({
      status: license.status,
      tier: license.tier,
      provider,
      expires_at: license.expires_at,
      sessions_used: license.sessions_used,
      sessions_limit: license.sessions_limit,
      cancel_at_period_end: isCancelPending,
      cancels_at: isCancelPending ? license.expires_at : null,
    });
  } catch (err) {
    console.error('Subscription status error:', err.message);
    res.status(500).json({ error: 'Failed to check subscription' });
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  REACTIVATE — un-cancel a Stripe subscription before period end
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Counterpart to the Cancel-via-portal flow. Stripe lets us reverse a
// pending cancellation by setting cancel_at_period_end=false on a sub
// that's still inside its paid window. We mirror the local license back
// to status='active' so the chat-header tier badge and ManageSubscription
// UI flip immediately without waiting for the next webhook tick.
router.post('/reactivate-subscription', authMiddleware, async (req, res) => {
  try {
    if (!stripe) return res.status(503).json({ error: 'Stripe is not configured. Contact support.' });

    const user = db.getUserById(req.user.id);
    if (!user || !user.stripe_customer_id || !user.stripe_customer_id.startsWith('cus_')) {
      return res.status(400).json({ error: 'No Stripe subscription on file. If you canceled and the period has ended, start a new subscription instead.' });
    }

    // Pick the most recent sub. If multiple are active (shouldn't happen
    // with /upgrade-tier doing in-place swaps, but defensively), the
    // newest is the one the user is currently being billed for.
    const subs = await stripe.subscriptions.list({ customer: user.stripe_customer_id, status: 'all', limit: 5 });
    const candidate = subs.data.find(s => s.status === 'active' && s.cancel_at_period_end === true);
    if (!candidate) {
      // Either nothing is canceling, or the period already ended.
      return res.status(400).json({ error: 'No active subscription is scheduled to cancel. Nothing to reactivate.' });
    }

    const updated = await stripe.subscriptions.update(candidate.id, { cancel_at_period_end: false });

    // Mirror local license back to 'active'. expires_at goes back to the
    // grant default (-1 unlimited) since the sub will renew normally now.
    // Strict tier resolution — never default to 'pro' on a missing
    // metadata.tier (a stripe quirk could otherwise silently upgrade a
    // Basic buyer). Fall through to the existing license tier if metadata
    // is missing.
    const safeTier = (t) => VALID_TIERS.includes(t) ? t : null;
    const tier = safeTier(candidate.metadata?.tier) || safeTier(db.getLicenseByUserId(user.id)?.tier);
    if (tier) {
      const grant = grantConfigForTier(tier);
      db.updateLicenseOnPayment(user.id, {
        tier: grant.tier,
        status: 'active',
        expires_at: grant.expires_at,
        sessions_limit: grant.sessions_limit,
      });
    }

    const license = db.getLicenseByUserId(user.id);
    res.json({
      provider: 'stripe-reactivate',
      tier,
      license: license ? { ...license, last_validated: Date.now() } : null,
      message: 'Subscription reactivated — your plan will continue to renew normally.',
      stripe_subscription_id: updated.id,
    });
  } catch (err) {
    console.error('[reactivate-subscription] error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to reactivate. Please try again.' });
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  STRIPE CUSTOMER PORTAL (manage/cancel)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.post('/portal', authMiddleware, async (req, res) => {
  try {
    if (!stripe) return res.status(503).json({ error: 'Stripe not configured' });

    // Prefer the customer_id stored on the user row. customers.list({email})
    // can return multiple cus_* if the user re-signed up — Stripe's order
    // is undocumented for tie-breaks, so we'd nondeterministically land
    // the user in the wrong portal session (showing someone else's
    // billing history). Use the stored id as the source of truth, falling
    // back to email lookup ONLY when no stored id exists (legacy users).
    // (P0-S3 from the audit.)
    const user = db.getUserById(req.user.id);
    let customerId = (user?.stripe_customer_id?.startsWith('cus_'))
      ? user.stripe_customer_id
      : null;
    if (!customerId) {
      const customers = await stripe.customers.list({ email: req.user.email, limit: 1 });
      if (customers.data.length === 0) {
        return res.status(404).json({ error: 'No Stripe subscription found' });
      }
      customerId = customers.data[0].id;
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: process.env.FRONTEND_URL || 'http://localhost:3005',
    });

    res.json({ portal_url: session.url });
  } catch (err) {
    console.error('Portal error:', err.message);
    res.status(500).json({ error: 'Failed to create portal session' });
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  RAZORPAY SELF-SERVICE CANCEL
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Razorpay has no Customer Portal equivalent, so Pro/Max Indian users
// need a dedicated cancel endpoint. We look up the user's most recent
// Razorpay subscription id from the payments table (we don't store it
// on the user row) and call subscriptions.cancel(subId, false) — the
// second arg tells Razorpay to honor the current billing cycle instead
// of refunding the prorated remainder. Webhook `subscription.cancelled`
// handles the actual tier downgrade when the period ends.
router.post('/cancel-razorpay', authMiddleware, async (req, res) => {
  try {
    if (!razorpay) return res.status(503).json({ error: 'Razorpay not configured' });

    const subId = db.getLatestRazorpaySubscriptionId(req.user.id);
    if (!subId) {
      return res.status(404).json({ error: 'No active Razorpay subscription found.' });
    }

    // cancel_at_cycle_end = false tells Razorpay to cancel at the end of
    // the current billing period (not immediately). Counter-intuitive
    // naming — Razorpay's API treats `false` here as "cancel at next
    // cycle boundary", `true` as "cancel immediately".
    // See: https://razorpay.com/docs/api/payments/subscriptions/cancel-subscription/
    await razorpay.subscriptions.cancel(subId, false);

    // Mirror Stripe's `cancel_at_period_end` behavior locally: keep the
    // tier active but pin expires_at to the actual cycle-end so the UI
    // can render "Pro until <date>" and the gate auto-locks the user
    // out at the right moment even if subscription.cancelled is delayed.
    // Without this the UI shows an indefinite "Pro Active" badge with no
    // signal that billing has been cancelled, and the user is left
    // wondering whether they're still being charged.
    let periodEndMs = null;
    let updatedLicense = null;
    try {
      const sub = await razorpay.subscriptions.fetch(subId);
      if (sub && typeof sub.current_end === 'number' && sub.current_end > 0) {
        periodEndMs = sub.current_end * 1000;
      }
    } catch (fetchErr) {
      // Fetch is best-effort — if it fails the webhook still reconciles.
      console.warn('[cancel-razorpay] subscription.fetch failed:', fetchErr.message);
    }
    // Always flip status='canceling' once Razorpay has accepted the
    // cancel call, even if the secondary fetch for current_end failed.
    // Without this, a fetch blip (network, Razorpay 5xx) leaves the UI
    // showing "Pro Active" with no Reactivate button — the user assumes
    // they're still being charged and either clicks Cancel again or
    // contacts support. (P0-A + P1-E from the audit.) When periodEndMs
    // is unavailable we keep the existing expires_at — the webhook will
    // correct it on its own tick.
    const license = db.getLicenseByUserId(req.user.id);
    if (license) {
      db.updateLicenseOnPayment(req.user.id, {
        tier: license.tier,                              // unchanged — user keeps access through cycle
        status: 'canceling',                             // matches /cancel-subscription unified route
        expires_at: periodEndMs || license.expires_at,   // preserve existing if fetch blipped
        sessions_limit: license.sessions_limit,
      });
      updatedLicense = db.getLicenseByUserId(req.user.id);
    }
    // Advance the out-of-order gate so any stray pre-cancel events
    // (subscription.charged, payment.captured) that arrive AFTER the
    // server-initiated cancel are rejected. Without this anchor a stale
    // charge event could resurrect the subscription. (P1-G from the audit.)
    db.gateAndRecordEventForUser(req.user.id, Math.floor(Date.now() / 1000));

    res.json({
      success: true,
      message: 'Your subscription will be cancelled at the end of the current billing period. You keep full access until then.',
      subscription_id: subId,
      cancels_at: periodEndMs,
      license: updatedLicense ? { ...updatedLicense, last_validated: Date.now() } : null,
    });
  } catch (err) {
    console.error('Razorpay cancel error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to cancel subscription' });
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  UNIFIED CANCEL — Stripe + Razorpay
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Self-service cancel that works for both providers. Mirrors the
// admin-initiated /admin/users/:id/cancel-subscription pattern (provider
// auto-detected from stripe_customer_id prefix).
//
// Why this exists alongside /cancel-razorpay: the legacy /cancel-razorpay
// route still works for older client builds, but new clients hit this
// endpoint regardless of provider so we don't duplicate the cancel UI
// per-provider on the client. For Stripe users, we previously delegated
// the cancel itself to the Customer Portal (one-click but takes them out
// of the app); a 2026 in-app cancel button matches what Claude/Cursor/
// Spotify all do and recovers the ~30% of cancelers who change their
// mind via the in-app Reactivate flow before the cycle ends.
//
// Both providers preserve access until the current billing period ends.
// The license is flipped to status='canceling' here so the chat-header
// tier badge and ManageSubscription banner update immediately, without
// waiting for the webhook to land. The webhook will confirm/reconcile
// on its own tick.
router.post('/cancel-subscription', authMiddleware, async (req, res) => {
  try {
    const user = db.getUserById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const customerId = user.stripe_customer_id || '';
    const isRazorpay = customerId.startsWith('rzp_');
    const isStripe = customerId.startsWith('cus_');
    if (!isRazorpay && !isStripe) {
      return res.status(400).json({
        error: 'No active subscription on file. If you signed up but never paid, there is nothing to cancel.',
      });
    }

    let periodEndMs = null;
    let providerLabel = null;
    let subscriptionId = null;

    if (isStripe) {
      if (!stripe) return res.status(503).json({ error: 'Stripe not configured' });
      providerLabel = 'stripe';
      // Pick the most recent active sub. With /upgrade-tier doing in-place
      // swaps (instead of creating parallel subs) there should only be
      // one — but defensively cancel them all if multiple exist.
      const subs = await stripe.subscriptions.list({ customer: customerId, status: 'active', limit: 5 });
      if (!subs.data.length) {
        return res.status(404).json({ error: 'No active Stripe subscription found.' });
      }
      let latestPeriodEnd = 0;
      for (const sub of subs.data) {
        const updated = await stripe.subscriptions.update(sub.id, { cancel_at_period_end: true });
        if (updated.current_period_end && updated.current_period_end > latestPeriodEnd) {
          latestPeriodEnd = updated.current_period_end;
        }
        subscriptionId = sub.id; // last one wins, used purely for receipt/log
      }
      periodEndMs = latestPeriodEnd > 0 ? latestPeriodEnd * 1000 : null;
    } else {
      if (!razorpay) return res.status(503).json({ error: 'Razorpay not configured' });
      providerLabel = 'razorpay';
      subscriptionId = db.getLatestRazorpaySubscriptionId(user.id);
      if (!subscriptionId) {
        return res.status(404).json({ error: 'No active Razorpay subscription found.' });
      }
      // cancel_at_cycle_end=false in Razorpay's API means "cancel at next
      // cycle boundary" (counter-intuitive — true would cancel immediately).
      await razorpay.subscriptions.cancel(subscriptionId, false);
      try {
        const sub = await razorpay.subscriptions.fetch(subscriptionId);
        if (sub && typeof sub.current_end === 'number' && sub.current_end > 0) {
          periodEndMs = sub.current_end * 1000;
        }
      } catch (fetchErr) {
        console.warn('[cancel-subscription] razorpay fetch failed:', fetchErr.message);
      }
    }

    // Mirror the webhook's canceling-state mutation locally so the in-app
    // UI flips immediately instead of waiting for the webhook tick. The
    // webhook will reconcile if anything diverges.
    let updatedLicense = null;
    const license = db.getLicenseByUserId(user.id);
    if (license) {
      db.updateLicenseOnPayment(user.id, {
        tier: license.tier,
        status: 'canceling',
        expires_at: periodEndMs || license.expires_at,
        sessions_limit: license.sessions_limit,
      });
      updatedLicense = db.getLicenseByUserId(user.id);
    }
    // Anchor the out-of-order gate to the cancel moment — same reasoning
    // as the legacy /cancel-razorpay route. (P1-G from the audit.)
    db.gateAndRecordEventForUser(user.id, Math.floor(Date.now() / 1000));

    res.json({
      success: true,
      provider: providerLabel,
      subscription_id: subscriptionId,
      cancels_at: periodEndMs,
      message: 'Your subscription will be cancelled at the end of the current billing period. You keep full access until then — and you can reactivate any time before that date from the Manage subscription screen.',
      license: updatedLicense ? { ...updatedLicense, last_validated: Date.now() } : null,
    });
  } catch (err) {
    console.error('[cancel-subscription] error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to cancel subscription' });
  }
});

module.exports = router;
// Internals exposed for unit tests only. Not consumed by other route files
// — callers should always use the router. See test/payments.test.js.
module.exports._test = {
  STRIPE_PRICE_DATA,
  resolveStripeLineItem,
  EXPECTED_USD_CENTS,
  // Razorpay test surfaces — used by razorpay-plan-validation.test.js
  assertRazorpayPlanMatches,
  EXPECTED_INR_PAISE,
  razorpayPlanCache,
  PRICE_VALIDATION_TTL_MS,
};
