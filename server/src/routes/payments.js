// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  PAYMENTS — Razorpay (India) + Stripe (Global)
//  Auto-routes based on user's country_code
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const express = require('express');
const { authMiddleware } = require('../middleware/auth');
const { writeAudit } = require('../middleware/admin');
const db = require('../database');
// A 'canceling' license must always carry a positive expires_at — it is
// the only lifecycle state whose termination is driven by a timestamp
// rather than an event. See subscriptionStates.resolveCancelPeriodEnd.
const { resolveCancelPeriodEnd } = require('../services/subscriptionStates');

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
const { createStripeClient, STRIPE_API_VERSION, subscriptionPeriodEnd } = require('../services/stripeClient');
let stripe = null;
let razorpay = null;

// Pinned API version — an unpinned client follows the ACCOUNT's default,
// and several fields this file reads (subscription.current_period_end on
// the cancel path, charge/invoice shapes) were removed in 2025-03-31.basil.
// See services/stripeClient.js.
stripe = createStripeClient();
if (stripe) {
  console.log(`[Payments] Stripe initialized (API ${STRIPE_API_VERSION})`);
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
// 2026-07-16: the Razorpay merchant account is PENDING approval, so ALL new
// charges — India included — route to Stripe. Razorpay code (verify, webhooks,
// cancel, legacy subscriptions) stays intact so in-flight/legacy Razorpay
// state keeps reconciling. When the account clears, set
// RAZORPAY_ROUTING_ENABLED=true on the server and India routes back to
// Razorpay INR with no code change. Read at CALL time (not module load) so
// ops can flip the flag with a restart and tests can toggle it.
//
// NOTE for re-enable: the client currently DISPLAYS USD for every region
// (services/pricingService.ts INR_CHECKOUT_ENABLED=false) so the pill always
// matches the Stripe charge. Flip that flag together with this one.
function getPaymentProvider(countryCode) {
  const razorpayRoutingEnabled = process.env.RAZORPAY_ROUTING_ENABLED === 'true';
  if (razorpayRoutingEnabled && razorpay && countryCode === 'IN') return 'razorpay';
  return 'stripe';
}

// ── Tier → license grant config (CUSTOMER purchase) ─────────────────
// 2026-07 pricing: Basic/Pro/Max are ONE-TIME, time-limited interviews;
// Ultra is the monthly unlimited subscription. Each customer grant seeds the
// interview clock (credits_remaining_seconds) with a 30-day window to use it:
//   Basic  = one 30-minute interview      (1 session, 1800s)
//   Pro    = one 1-hour interview          (1 session, 3600s)
//   Max    = three 1-hour interviews       (marketed as 3×1h; enforced as a
//            single 10,800s pool — NOTHING implements a per-session 60-min
//            cutoff, and sessions_limit=3 is bookkeeping no gate reads. A
//            Max buyer can run one 3-hour interview; deliberately more
//            generous than the copy, never less.)
//   Ultra  = NINE HOURS per billing cycle  (32,400s; subscription, re-seeded
//            on every renewal by webhooks.js creditsForLifecycleGrant.
//            Metered since 2026-08-22 — it was unlimited before that, and
//            unlimited moved up to Enterprise.)
//   Enterprise = unlimited, never expires  (-1 sentinels; subscription)
// NOTE: this is the CUSTOMER config. Admin grants are unlimited-until-revoked
// and use grantAdminTier() / recordCompPayment() instead (never this).
const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;
const INTERVIEW_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
// Ultra's monthly allowance. Mirrored in webhooks.js grantConfigForTier and
// in the client's services/licenseService.ts ULTRA_MONTHLY_SECONDS.
const ULTRA_CYCLE_SECONDS = 9 * 60 * 60;

// ── ULTRA METERING KILL-SWITCH (2026-08-22) ────────────────────────────
// Ultra's 9-hour allowance is a SERVER-side change, and the desktop fleet
// updates on its own schedule. A client older than this change still reads
// `tier === 'ultra'` as unlimited (services/licenseService.ts before the
// isUnlimitedLicense refactor), so if the server starts metering while that
// client is installed, the app shows unlimited time while the server counts
// down — and the subscriber discovers the difference as a 402 in the middle
// of an interview. That is the exact client/server age skew that forced the
// 2026-07-29 revert.
//
// So metering is OFF until turned on. With the flag unset, Ultra grants the
// -1 unlimited sentinel exactly as it did before, which is what every
// installed client already believes; Enterprise, the admin-grant permanence
// work and the cover fixes are unaffected and ship immediately.
//
// TO TURN IT ON: ship a desktop release containing isUnlimitedLicense, wait
// for the fleet, then set ULTRA_METERED=true on the server. Same flag-pair
// discipline as RAZORPAY_ROUTING_ENABLED + INR_CHECKOUT_ENABLED.
function ultraMeteringEnabled() {
  return process.env.ULTRA_METERED === 'true';
}

function grantConfigForTier(tier) {
  const now = Date.now();
  if (tier === 'free') {
    return { tier: 'free', sessions_limit: 5, expires_at: now + INTERVIEW_WINDOW_MS, credits_remaining_seconds: 0, credits_expire_at: 0 };
  }
  if (tier === 'basic') {
    const exp = now + INTERVIEW_WINDOW_MS;
    return { tier: 'basic', sessions_limit: 1, expires_at: exp, credits_remaining_seconds: 30 * 60, credits_expire_at: exp };
  }
  if (tier === 'pro') {
    const exp = now + INTERVIEW_WINDOW_MS;
    return { tier: 'pro', sessions_limit: 1, expires_at: exp, credits_remaining_seconds: 60 * 60, credits_expire_at: exp };
  }
  if (tier === 'max') {
    const exp = now + INTERVIEW_WINDOW_MS;
    return { tier: 'max', sessions_limit: 3, expires_at: exp, credits_remaining_seconds: 3 * 60 * 60, credits_expire_at: exp };
  }
  if (tier === 'ultra') {
    // Metering is flag-gated while older clients are still in the field —
    // see ultraMeteringEnabled. Unset = the pre-2026-08 unlimited grant.
    if (!ultraMeteringEnabled()) {
      return { tier: 'ultra', sessions_limit: -1, expires_at: -1, credits_remaining_seconds: -1, credits_expire_at: -1 };
    }
    // Monthly subscription, METERED: 9 hours per billing cycle.
    //   expires_at: -1        — the SUBSCRIPTION has no end date. This is not
    //                           a time sentinel; db.resolveTimeBucket must not
    //                           read it as "unlimited" for ultra, or the $1199
    //                           plan is being handed out for $159.
    //   credits_expire_at: 0  — no calendar window on the balance; the next
    //                           renewal REPLACES it (no rollover). Deliberately
    //                           0 and not -1: -1 is the unlimited sentinel.
    return { tier: 'ultra', sessions_limit: -1, expires_at: -1, credits_remaining_seconds: ULTRA_CYCLE_SECONDS, credits_expire_at: 0 };
  }
  // enterprise — monthly subscription, unlimited and never expiring.
  return { tier: 'enterprise', sessions_limit: -1, expires_at: -1, credits_remaining_seconds: -1, credits_expire_at: -1 };
}

// ── Normalize/validate the tier coming in from the client ──
// `free` is included for admin grants (testing the downgrade-to-free
// path without going through cancel-and-wait-for-cycle-end). For
// non-admin callers, /upgrade-tier rejects `free` (they should cancel
// the subscription instead — that triggers the proper webhook + email
// chain at cycle end).
const VALID_TIERS = ['free', 'basic', 'pro', 'max', 'ultra', 'enterprise'];
function normalizeTier(t) {
  return VALID_TIERS.includes(t) ? t : 'pro';
}

// ── Which provider owns this user's EXISTING subscription? ────────────
// Provider used to be read straight off the `stripe_customer_id` prefix
// (`cus_` → Stripe, `rzp_` → Razorpay), which worked only because the
// Razorpay grant paths clobbered the column. Now that a Stripe `cus_…`
// survives a later Razorpay grant (database.js setPaymentProviderMarker —
// it has to, or the saved card, /portal and /payment-method all break), a
// user can legitimately carry BOTH markers. The tie-break is "who granted
// the tier they're on right now", because that's whose subscription the
// cancel/reactivate/swap actions are about.
//
// Single-provider users resolve exactly as before. Returns null when
// there's nothing on file at all.
function resolveUserProvider(user) {
  if (!user) return null;
  const marker = user.stripe_customer_id || '';
  const hasStripe = marker.startsWith('cus_');
  const hasRazorpay = marker.startsWith('rzp_') || !!db.getLatestRazorpaySubscriptionId(user.id);
  if (hasStripe && hasRazorpay) {
    // rowid breaks the tie, and it has to. created_at is milliseconds, so
    // two grants recorded in the same millisecond — a webhook and a
    // verify landing together, an upgrade applied in one transaction —
    // leave the ORDER BY undefined, and SQLite is then free to return the
    // OLDER provider as "the one that granted the current tier". That
    // decides which provider's cancel/upgrade endpoints the user is sent
    // to, so getting it wrong points a paying customer at the wrong
    // billing system. rowid is monotonic per insert, so it is exactly the
    // "which came second" the timestamp cannot express.
    const row = db.getDB().prepare(`
      SELECT provider FROM payments
      WHERE user_id = ? AND status = 'completed'
        AND tier_granted IS NOT NULL AND tier_granted != 'free'
      ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get(user.id);
    return row?.provider === 'razorpay' ? 'razorpay' : 'stripe';
  }
  if (hasStripe) return 'stripe';
  if (hasRazorpay) return 'razorpay';
  return null;
}

// Ladder order for upgrade/downgrade direction decisions (in-place plan
// swaps). Higher rank = more expensive/more access.
const TIER_RANK = { free: 0, basic: 1, pro: 2, max: 3, ultra: 4, enterprise: 5 };

// The RECURRING tiers — the ones sold as a monthly subscription rather than a
// one-time pass. Everything that used to be spelled `tier === 'ultra'` around
// subscriptions (price shape validation, Razorpay plan requirement, in-place
// swap eligibility, "is this subscription-backed") means THIS now that
// Enterprise exists. A missed call site is a real bug in both directions: an
// Enterprise checkout created as a one-time charge bills $1199 exactly once
// for a plan sold monthly, and a one-time pass validated as recurring is
// rejected outright.
const RECURRING_TIERS = ['ultra', 'enterprise'];
function isRecurringTier(t) { return RECURRING_TIERS.includes(t); }

// Tiers that draw live time from the credit-seconds bucket, i.e. the ones a
// top-up can meaningfully extend. Ultra joined in 2026-08 with its 9-hour
// monthly allowance; Enterprise is never here (unlimited by definition), and
// free draws from the trial bucket instead.
const METERED_TIERS = ['basic', 'pro', 'max', 'ultra'];

// ── Credit-write policy — mirrors webhooks.js, same two rules ───────────
// creditsForPlanChange: an UPGRADE is a real plan change with a prorated
//   charge behind it, so the new plan's allowance is seeded (Ultra 9 h,
//   Enterprise -1). A legacy Pro/Max subscriber's migration-era unlimited
//   balance is left alone — the one-time config would shrink it.
// creditsForReaffirm: reactivation is NOT a purchase. It only un-sets
//   cancel_at_period_end on a subscription the user is already inside. It
//   may write a CONSTANT sentinel (Enterprise's -1, idempotent) but must
//   never re-seed a metered balance, or cancel→reactivate becomes a free
//   refill of Ultra's 9 hours, repeatable for as long as the cycle lasts.
function creditsForPlanChange(grant) {
  return isRecurringTier(grant.tier)
    ? { credits_remaining_seconds: grant.credits_remaining_seconds, credits_expire_at: grant.credits_expire_at }
    : {};
}
function creditsForReaffirm(grant) {
  return grant.tier === 'enterprise'
    ? { credits_remaining_seconds: grant.credits_remaining_seconds, credits_expire_at: grant.credits_expire_at }
    : {};
}
function isTierUpgrade(fromTier, toTier) {
  return (TIER_RANK[toTier] ?? -1) > (TIER_RANK[fromTier] ?? -1);
}

// ── GRADUATED TOP-UP PACKS — SINGLE SOURCE OF TRUTH (2026-07) ──────────
// ── Mid-interview top-up: +30 minutes on the existing pass ──────────
// A flat single SKU — $25 / ₹2099 for +30 min — offered to Basic/Pro/Max
// (Ultra is unlimited and exempt). Tier is PRESERVED (a Max top-up stays
// Max); the granted time is the same 30 minutes for every tier. Must match
// the per-region amount pricingService.getBasicRenewalPrice() shows on the
// client so the charge sheet matches the pill. (Constant names kept as
// RENEWAL_* for call-site compatibility; semantically this is the "+30 min"
// extension top-up.)
const RENEWAL_USD_CENTS = 2500;   // $25
const RENEWAL_INR_PAISE = 209900; // ₹2099
// ── GRADUATED TOP-UP PACKS — 2026-07 ───────────────────────────────────
// Three packs the user picks; the SERVER re-derives amount+seconds from the
// pack id. Client sends only the id — any client-sent price is ignored.
// Unknown / absent pack id defaults to m30.
const EXTENSION_PACKS = {
  m30: { id: 'm30', seconds: 1800,  usd_cents: 2500,  inr_paise: 209900, label: '+30 min' },
  h1:  { id: 'h1',  seconds: 3600,  usd_cents: 4500,  inr_paise: 379900, label: '+1 hour' },
  h3:  { id: 'h3',  seconds: 10800, usd_cents: 8000,  inr_paise: 679900, label: '+3 hours' },
};
const DEFAULT_EXTENSION_PACK = 'm30';
function resolveExtensionPack(packId) {
  return EXTENSION_PACKS[packId] || EXTENSION_PACKS[DEFAULT_EXTENSION_PACK];
}

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
  basic:      3000,   // $30 one-time · 30-min interview
  pro:        5000,   // $50 one-time · 1-hour interview
  max:        8900,   // $89 one-time · 3× 1-hour interviews
  ultra:      15900,  // $159/month · 9 hours of interview time + Auto-Type
  enterprise: 119900, // $1199/month · unlimited, never expires
};
const EXPECTED_INR_PAISE = {
  basic:      249900,   // ₹2499 one-time
  pro:        419900,   // ₹4199 one-time
  max:        739900,   // ₹7399 one-time
  ultra:      1299900,  // ₹12999/month
  enterprise: 9999900,  // ₹99999/month
};
const PRICE_VALIDATION_TTL_MS = 10 * 60 * 1000;
const stripePriceCache = new Map(); // priceId → { amount, currency, recurring, interval, validated_at }
const razorpayPlanCache = new Map(); // planId  → { amount, currency, period, validated_at }

async function assertStripePriceMatches(stripeClient, priceId, tier) {
  const expected = EXPECTED_USD_CENTS[tier];
  if (!expected) return; // unknown tier — let it through (caller already validated)
  // 2026-07 model, extended 2026-08: Ultra AND Enterprise are recurring
  // subscriptions. Basic/Pro/Max are one-time interview purchases.
  // (Pre-2026-07 this was `tier !== 'basic'`, which wrongly expected Pro/Max
  // to be monthly recurring and would reject a correctly-configured one-time
  // Pro/Max Price ID.)
  const expectedRecurring = isRecurringTier(tier);

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
// ── Live-subscription checkout conflict (2026-07-16) ──────────────────
// A FRESH checkout while a recurring plan is live is never what the user
// wants, and Stripe will happily oblige into real money harm:
//   · active Ultra buying Ultra again → a SECOND $159/mo subscription
//     billing in parallel (Stripe allows N subs per customer);
//   · active Ultra buying a one-time pass → pays for the pass AND the
//     grant webhook overwrites tier ultra→basic/pro/max while the $159
//     subscription keeps billing — paying twice, downgraded;
//   · CANCELING Ultra re-buying before cycle end → a duplicate sub when a
//     free reactivation was the right move;
//   · legacy Pro/Max SUBSCRIBER buying Ultra → second sub instead of the
//     in-place proration upgrade (/upgrade-tier).
// Every one of these is reachable from the signed-in web landing, whose
// tier cards call /create-checkout directly. Pure decision function so
// the matrix is unit-testable; the route wires the verdicts.
//
// `hasRecurringPlan` = isSubscriptionBackedTier(...) — Ultra always, legacy
// Pro/Max subs by payment history. Pass holders and free users return null
// here and check out normally. Comp'd Ultra (admin gift) also lands in
// 'already_subscribed' — correct: there is genuinely nothing to buy.
// ── Live one-time pass: refuse a SAME-or-LOWER repurchase (2026-07) ───
// A pass grant is a REPLACEMENT, not an addition — updateLicenseOnPayment
// sets credits_remaining_seconds absolutely. That is the documented rule
// (TIERS.md §5) and it is fine in the direction it was designed for:
// buying UP, which ManageSubscription warns about inline before the click
// and whose UPGRADE_TARGETS map only ever offers higher tiers.
//
// The signed-in PRICING CARDS have no such map. They call
// initiateCheckout(tier) for every tier including the one the user is
// already on, and a pass holder never trips the recurring-plan guards
// below (a pass is not subscription-backed), so the checkout went
// straight through:
//   · Max with 3h left buys Max again → charged $89, balance reset to
//     10,800s. The second $89 buys literally nothing.
//   · Max with 2h left buys Basic     → charged $30, balance overwritten
//     to 1,800s. They pay to destroy 1.5 hours they already own.
// Both are pure loss, and both are the natural "I need more interview
// time" click. Extensions are the product that actually stacks, so that
// is where this points them.
//
// Upgrades are deliberately left alone: they are documented, warned about
// at the point of sale, and the user gets strictly more time than they
// gave up. Pure function, like its caller — the license row carries
// everything the decision needs.
const PASS_TIERS = ['basic', 'pro', 'max'];
function passRepurchaseConflictFor(license, targetTier) {
  if (!PASS_TIERS.includes(license.tier)) return null;
  if (!['active', 'canceling', 'past_due'].includes(license.status)) return null;
  if (!PASS_TIERS.includes(targetTier) && targetTier !== 'free') return null; // Ultra is a real upgrade

  // "Has time left" with the same semantics as db.resolveTimeBucket:
  // -1 anywhere is the legacy unlimited sentinel; otherwise a positive
  // balance inside an unexpired window.
  const remaining = Number(license.credits_remaining_seconds ?? 0);
  const windowEnd = Number(license.credits_expire_at ?? 0);
  const unlimited = remaining === -1 || windowEnd === -1 || license.expires_at === -1;
  const windowOpen = windowEnd <= 0 || Date.now() < windowEnd;
  if (!unlimited && !(remaining > 0 && windowOpen)) return null; // spent or lapsed — let them re-buy anything

  if (isTierUpgrade(license.tier, targetTier)) return null; // buying UP is allowed (and warned about client-side)

  const label = String(license.tier).toUpperCase();
  const leftLabel = unlimited
    ? 'unlimited time'
    : `${Math.max(1, Math.round(remaining / 60))} minutes`;
  return {
    code: 'pass_active',
    httpStatus: 409,
    suggested_action: 'extend-pass',
    message: license.tier === targetTier
      ? `You're already on the ${label} pass with ${leftLabel} left, and buying it again would just reset that same clock — not add to it. Use an extension pack instead (+30 min / +1 h / +3 h); those stack onto the time you already have.`
      : `Buying the ${String(targetTier).toUpperCase()} pass would REPLACE the ${leftLabel} left on your ${label} pass with a smaller one — you'd pay and end up with less time. Use an extension pack instead (+30 min / +1 h / +3 h); those stack onto your existing clock.`,
  };
}

function checkoutConflictFor(license, hasRecurringPlan, targetTier) {
  if (!license) return null;
  // Pass holders are not subscription-backed, so they fall through every
  // guard below — their case is decided first. Gated on !hasRecurringPlan
  // so a LEGACY Pro/Max subscriber (who also sits on a pro/max tier, with a
  // migration-era unlimited balance) still gets the accurate
  // 'subscription_active' verdict below instead of pass copy.
  if (!hasRecurringPlan) {
    const passConflict = passRepurchaseConflictFor(license, targetTier);
    if (passConflict) return passConflict;
    return null;
  }
  if (!['active', 'canceling', 'past_due'].includes(license.status)) return null;
  // Any RECURRING target (Ultra, Enterprise). Pre-2026-08 this read
  // `targetTier === 'ultra'` because Ultra was the only subscription; with
  // Enterprise on the Team tab, a bare 'ultra' test would let an Enterprise
  // customer click "Go Ultra" and open a SECOND parallel subscription.
  if (isRecurringTier(targetTier)) {
    const targetLabel = targetTier === 'enterprise' ? 'Enterprise' : 'Ultra';
    // Same plan they already hold → never a second subscription.
    if (license.tier === targetTier) {
      const heldLabel = targetLabel;
      if (license.status === 'canceling') {
        return {
          code: 'already_subscribed',
          httpStatus: 409,
          suggested_action: 'reactivate-subscription',
          message: `You're still on ${heldLabel} — your cancellation only takes effect at the end of the billing cycle. Reactivate it from Manage subscription (no new charge today) instead of starting a second subscription.`,
        };
      }
      // past_due is a DEAD CARD, not a healthy subscription. Answering it
      // with "nothing more to buy" was the worst possible copy: this user
      // is trying to pay us, dunning is counting down to cancellation, and
      // we told them everything was fine and gave them no next step. What
      // they need is the card-update flow — starting a second subscription
      // still isn't the answer, so the refusal stands; only the reason and
      // the action change.
      if (license.status === 'past_due') {
        return {
          code: 'payment_method_required',
          httpStatus: 409,
          suggested_action: 'update-payment-method',
          message: `Your ${heldLabel} subscription is still active, but the last payment didn't go through — starting a second subscription won't fix that. Update your card from Manage subscription and we'll retry the outstanding charge automatically.`,
        };
      }
      return {
        code: 'already_subscribed',
        httpStatus: 409,
        suggested_action: null,
        message: targetTier === 'enterprise'
          ? "You're already on the Enterprise subscription — unlimited interview time, every model, Auto-Type. There's nothing above it to buy."
          : "You're already on the Ultra subscription — switching plans is done from Manage subscription, not by starting a second one.",
      };
    }
    // A DIFFERENT subscription on file — a legacy Pro/Max subscriber going
    // Ultra, an Ultra subscriber going Enterprise, or an Enterprise
    // customer moving down to Ultra. All three are the same operation:
    // rewire the existing subscription in place (Stripe prorates an
    // upgrade; a downgrade is scheduled for cycle end). Never a parallel
    // subscription — that is how a customer ends up paying twice.
    return { code: 'upgrade_in_place' };
  }
  return {
    code: 'subscription_active',
    httpStatus: 400,
    suggested_action: 'cancel-subscription',
    message: `You're on the ${String(license.tier).toUpperCase()} subscription — buying a one-time pass now would leave you paying for both at once. Cancel the subscription first (you keep full access until the end of the billing cycle), then buy passes whenever an interview comes up.`,
  };
}

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

    // ── Live-subscription conflict guard — see checkoutConflictFor ──
    const currentLicense = db.getLicenseByUserId(req.user.id);
    const conflict = checkoutConflictFor(
      currentLicense,
      currentLicense ? isSubscriptionBackedTier(req.user.id, currentLicense.tier) : false,
      tier,
    );
    if (conflict) {
      if (conflict.code === 'upgrade_in_place') {
        // Delegate a legacy subscriber's Ultra purchase to the in-place
        // swap so the landing's "Go Ultra" click Just Works as a prorated
        // upgrade. Provider from the customer-id prefix, same convention
        // as /upgrade-tier; no provider on file → fall through to a fresh
        // checkout (nothing live to double-bill).
        const user = db.getUserById(req.user.id);
        const inPlaceProvider = resolveUserProvider(user);
        if (inPlaceProvider === 'razorpay') {
          return await upgradeRazorpaySubscription(req, res, { user, currentTier: currentLicense.tier, targetTier: tier });
        }
        if (inPlaceProvider === 'stripe') {
          return await upgradeStripeSubscription(req, res, { user, currentTier: currentLicense.tier, targetTier: tier });
        }
      } else {
        return res.status(conflict.httpStatus).json({
          error: conflict.message,
          code: conflict.code,
          suggested_action: conflict.suggested_action,
        });
      }
    }

    // SECURITY: country_code is server-controlled — read from the user's
    // DB row (set at signup; /profile can no longer change it). The JWT
    // does NOT carry a country_code claim, so the old `req.user.country_code`
    // was ALWAYS undefined and every user silently fell through to Stripe —
    // making the Razorpay/UPI path unreachable for India (RBI e-mandate
    // failures on USD recurring cards = "can't subscribe"). We deliberately
    // ignore req.body.country_code so a malicious client cannot swap their
    // billing region to whichever currency is cheapest.
    const country = db.getUserById(req.user.id)?.country_code || 'US';
    const provider = getPaymentProvider(country);

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
    // Seed the interview clock like a real purchase would (Basic 30 min /
    // Pro 1 h / Max 3 h / Ultra -1). Admins bypass the time gate by email
    // anyway, but the self-grant exists to TEST the customer experience —
    // without the seed the granted tier shows 0 seconds remaining.
    credits_remaining_seconds: cfg.credits_remaining_seconds,
    credits_expire_at: cfg.credits_expire_at,
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
        error: 'Switching to Basic from a paid subscription is not supported. Cancel your current subscription first — at cycle end you\'ll be on Free, and you can then purchase Basic ($30 one-time) from the Manage Subscription screen.',
        suggested_action: 'cancel-subscription',
      });
    }
    if (targetTier === 'free') {
      return res.status(400).json({
        error: 'Switching directly to Free isn\'t supported via /upgrade-tier. Cancel your subscription instead — you\'ll keep paid access until the end of your billing cycle, then drop to Free automatically.',
        suggested_action: 'cancel-subscription',
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
    // Only an account that HOLDS A SUBSCRIPTION has anything to swap in
    // place: the recurring tiers (Ultra, Enterprise) and the legacy Pro/Max
    // subscribers from before the passes. Until 2026-09 this read
    // `pro || max` — precisely the two tiers that had stopped being
    // subscriptions — so every Ultra → Enterprise request (the one upgrade
    // the client actually offers) died here with a 400, and the checkout
    // fallback further down opened a SECOND subscription instead.
    const holdsSubscription = isRecurringTier(currentTier) || isSubscriptionBackedTier(req.user.id, currentTier);
    if (!holdsSubscription) {
      // A pass holder (or a free account) buying a plan is a plain new
      // purchase — the same guards as /create-checkout, then the same
      // checkout. Passes are one-time, so there is nothing to double-bill.
      const passConflict = checkoutConflictFor(currentLicense, false, targetTier);
      if (passConflict && passConflict.code !== 'upgrade_in_place') {
        return res.status(passConflict.httpStatus).json({
          error: passConflict.message,
          code: passConflict.code,
          suggested_action: passConflict.suggested_action,
        });
      }
      const passCountry = db.getUserById(req.user.id)?.country_code || 'US';
      if (getPaymentProvider(passCountry) === 'razorpay') {
        return await createRazorpayCheckout(req, res, targetTier);
      }
      return await createStripeCheckout(req, res, targetTier);
    }
    // 'canceling' is allowed on purpose: the swap re-enables auto-renewal
    // (cancel_at_period_end: false), which is what a customer who cancelled
    // Ultra and then chose Enterprise means. past_due is not — a plan change
    // never fixes a declined card; the Billing Hub points at the card.
    if (currentLicense.status !== 'active' && currentLicense.status !== 'canceling') {
      return res.status(400).json({
        error: 'Your subscription is not currently active. Renew or restart it from the billing page.',
      });
    }

    // Which provider owns the live subscription — see resolveUserProvider.
    // (Was a bare prefix test on stripe_customer_id, which mis-answers for
    // users who now legitimately carry both markers.)
    const customerId = user.stripe_customer_id || '';
    const subProvider = resolveUserProvider(user);
    const isRazorpay = subProvider === 'razorpay';
    const isStripe = subProvider === 'stripe';

    // ── Subscription plans only (Ultra, Enterprise) ──
    // An in-place swap rewires an EXISTING subscription, so the target must
    // itself be a recurring plan. Pro/Max are one-time passes now: putting a
    // one-time Price on a Stripe subscription item is rejected by Stripe's
    // API (the old code 500'd mid-flow), and "swapping" a sub to a pass is
    // the wrong billing shape anyway. Legacy Pro/Max SUBSCRIBERS who want a
    // pass instead: cancel (access continues to cycle end), then buy the
    // pass from the plans screen. Checked only when a provider is on file —
    // the no-provider fall-through below still routes pro/max targets to a
    // fresh checkout, and admins were already granted above.
    if ((isRazorpay || isStripe) && !isRecurringTier(targetTier)) {
      return res.status(400).json({
        error: `${targetTier.toUpperCase()} is a one-time interview pass now, not a subscription plan — so there's nothing to swap in place. Cancel your current subscription first (you keep access until the end of the billing cycle), then buy the ${targetTier.toUpperCase()} pass from the plans screen.`,
        suggested_action: 'cancel-subscription',
      });
    }

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
    // country from the user's DB row, not the JWT (which carries no
    // country_code claim — see /create-checkout). Server-controlled and
    // /profile can't edit it.
    const country = db.getUserById(req.user.id)?.country_code || 'US';
    const provider = getPaymentProvider(country);
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
  // Resolve the new line item. An in-place swap rewires a SUBSCRIPTION ITEM,
  // and Stripe only lets a subscription item reference a real Price — the
  // inline `price_data.product_data` shape resolveStripeLineItem returns for
  // Checkout is rejected outright there, which is why every in-place Ultra
  // upgrade used to 500 on the update call below.
  //
  // When no usable Price is configured we neither guess an id nor error: we
  // degrade to a fresh Checkout Session (which DOES accept price_data), so
  // the user always has a path to Ultra. The client already handles a
  // checkout_url response from this route — it is the same fall-through the
  // no-provider-on-file case uses.
  // The new subscription item: the configured recurring Price when one is set
  // and validated, otherwise inline price_data on our own Product for the
  // tier. This used to fall back to a FRESH Checkout Session when no Price
  // env var was set — which is production's configuration — so the "in-place
  // upgrade" quietly became a second parallel subscription while the first
  // kept billing. An in-place swap that cannot price itself now fails
  // closed (503) rather than double-billing.
  let newLineItem;
  try {
    newLineItem = await resolveStripeSubscriptionItem(stripe, targetTier);
  } catch (err) {
    console.error(`[upgrade-tier] could not price an in-place ${targetTier} swap for ${user.email}:`, err.message || err);
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
    // newLineItem is ALWAYS { price: 'price_xxx' } — a subscription item can
    // only reference a real Price. (The inline { price_data: { product_data } }
    // shape Checkout accepts is INVALID here; resolveStripeSubscriptionPrice
    // returns null in that case and we degraded to Checkout above.)
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
  // Credits: pass the sentinel ONLY for Ultra (-1 unlimited). Legacy Pro/Max
  // SUBSCRIBERS keep their migration-era -1 balance — re-seeding them with
  // the 2026-07 one-time config (3600s) would shrink an unlimited legacy
  // sub to a 1-hour clock mid-cycle.
  const grant = grantConfigForTier(targetTier);
  db.updateUserTier(user.id, grant.tier);
  db.updateLicenseOnPayment(user.id, {
    tier: grant.tier,
    status: 'active',
    expires_at: grant.expires_at,
    sessions_limit: grant.sessions_limit,
    ...creditsForPlanChange(grant),
    // A paid plan change is the customer's own money on the line: from here
    // the subscription's lifecycle governs the row, not an older admin comp.
    admin_granted_at: 0,
  });
  const license = db.getLicenseByUserId(user.id);
  const isDowngrade = (TIER_RANK[targetTier] ?? 0) < (TIER_RANK[currentTier] ?? 0);

  // Audit trail — every tier change writes a row so compliance/support
  // can answer "when did this user go Pro → Max + who initiated it".
  try {
    writeAudit(req, 'user-change-tier', { id: user.id, email: user.email }, {
      provider: 'stripe',
      from_tier: currentTier,
      to_tier: targetTier,
      proration: 'next_invoice',
    });
  } catch (auditErr) {
    console.warn('[upgrade-tier:stripe] audit log failed:', auditErr.message);
  }

  // Tier-transition email — fire-and-forget so a transient email
  // outage doesn't fail the upgrade. The render function lives in
  // server/src/email.js; if it's not exported, we just skip.
  try {
    const { sendMail, renderTierChangeEmail } = require('../email');
    if (typeof renderTierChangeEmail === 'function') {
      const { subject, html, text } = renderTierChangeEmail({
        name: user.name, fromTier: currentTier, toTier: targetTier,
        provider: 'stripe', effectiveDate: 'now (prorated on next invoice)',
      });
      sendMail({ to: user.email, subject, html, text }).catch(() => { /* mail outage */ });
    }
  } catch { /* email module missing or threw — non-fatal */ }

  return res.json({
    provider: 'stripe-upgrade',
    tier: targetTier,
    previous_tier: currentTier,
    effective_date: Date.now(),
    effective_date_label: 'now',
    proration: 'next_invoice',
    license: license ? { ...license, last_validated: Date.now() } : null,
    message: isDowngrade
      ? `Plan changed to ${targetTier.toUpperCase()}. The prorated credit for the rest of this cycle will appear on your next invoice.`
      : `Plan changed to ${targetTier.toUpperCase()}. The prorated difference will appear on your next invoice.`,
  });
}

// ── Pricing an in-place subscription swap without a configured Price ──────
// Stripe's subscription-item update accepts inline `price_data`, but unlike a
// Checkout Session it needs a real Product id (no product_data). We keep one
// Product per tier, tagged metadata.minicaai_tier, found by search or created
// on first use and remembered in the config table so the swap costs one
// Stripe call after the first.
async function ensureStripeProductForTier(stripeClient, tier) {
  const data = STRIPE_PRICE_DATA[tier];
  if (!data) {
    const err = new Error(`No price_data default for tier=${tier}`);
    err.code = 'NO_PRICE_DATA';
    throw err;
  }
  const cacheKey = `stripe_product_${tier}`;
  const cached = db.getConfig(cacheKey, null);
  if (cached) {
    try {
      const existing = await stripeClient.products.retrieve(String(cached));
      if (existing && existing.id && existing.active !== false) return existing.id;
    } catch (err) {
      console.warn(`[upgrade-tier] cached Stripe product ${cached} for ${tier} is unusable (${err.message}) — re-resolving`);
    }
  }
  let productId = null;
  try {
    const found = await stripeClient.products.search({
      query: `active:'true' AND metadata['minicaai_tier']:'${tier}'`,
      limit: 1,
    });
    productId = found?.data?.[0]?.id || null;
  } catch (err) {
    console.warn(`[upgrade-tier] products.search failed for ${tier}: ${err.message} — creating`);
  }
  if (!productId) {
    const created = await stripeClient.products.create({
      name: data.product_data.name,
      description: data.product_data.description,
      metadata: { minicaai_tier: tier },
    });
    productId = created.id;
  }
  try { db.setConfig(cacheKey, productId); } catch (cfgErr) {
    console.warn('[upgrade-tier] could not cache Stripe product id:', cfgErr.message);
  }
  return productId;
}

async function resolveStripeSubscriptionItem(stripeClient, tier) {
  const configured = await resolveStripeSubscriptionPrice(stripeClient, tier);
  if (configured) return configured;
  const data = STRIPE_PRICE_DATA[tier];
  if (!data || !data.recurring) {
    const err = new Error(`${tier} is not a recurring tier — nothing to swap a subscription to`);
    err.code = 'NO_PRICE_DATA';
    throw err;
  }
  const product = await ensureStripeProductForTier(stripeClient, tier);
  return {
    price_data: {
      currency: data.currency,
      product,
      unit_amount: data.unit_amount,
      recurring: data.recurring,
    },
  };
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

  // Upgrade now (charge the diff today, give the higher tier immediately).
  // Downgrade waits for cycle_end so the user keeps the tier they paid
  // for through the rest of the billing cycle. Rank-based so EVERY
  // higher-tier move counts as an upgrade — the old `pro→max` equality
  // check silently treated pro→ultra / max→ultra as cycle-end downgrades,
  // deferring the user's paid Ultra access by up to a month.
  const isUpgrade = isTierUpgrade(currentTier, targetTier);
  await razorpay.subscriptions.update(subId, {
    plan_id: newPlanId,
    schedule_change_at: isUpgrade ? 'now' : 'cycle_end',
    customer_notify: 1,
  });

  // For upgrades we apply optimistically; subscription.charged webhook
  // will reconcile the next billing cycle. For downgrades we keep the
  // current tier in DB — webhook will downgrade when the new cycle starts.
  if (isUpgrade) {
    // Same rule as the Stripe upgrade path (creditsForPlanChange): seed the
    // target plan's allowance for a recurring tier; never clobber a legacy
    // Pro/Max sub's migration-era unlimited balance with the one-time config.
    const grant = grantConfigForTier(targetTier);
    db.updateUserTier(user.id, grant.tier);
    db.updateLicenseOnPayment(user.id, {
      tier: grant.tier,
      status: 'active',
      expires_at: grant.expires_at,
      sessions_limit: grant.sessions_limit,
      ...creditsForPlanChange(grant),
      admin_granted_at: 0, // a paid plan change supersedes any older admin comp
    });
  }
  const license = db.getLicenseByUserId(user.id);

  // Effective date: upgrades are immediate; downgrades wait for cycle end
  // (Razorpay's schedule_change_at='cycle_end' semantics). license.expires_at
  // is the current period end for an active sub, so that's the right
  // moment for a scheduled downgrade.
  const effectiveAt = isUpgrade ? Date.now() : (license?.expires_at || null);

  // Audit trail
  try {
    writeAudit(req, 'user-change-tier', { id: user.id, email: user.email }, {
      provider: 'razorpay',
      from_tier: currentTier,
      to_tier: targetTier,
      direction: isUpgrade ? 'upgrade' : 'downgrade',
      effective_at: effectiveAt,
    });
  } catch (auditErr) {
    console.warn('[upgrade-tier:razorpay] audit log failed:', auditErr.message);
  }

  // Tier-transition email
  try {
    const { sendMail, renderTierChangeEmail } = require('../email');
    if (typeof renderTierChangeEmail === 'function') {
      const dateLabel = effectiveAt && effectiveAt > 0
        ? new Date(effectiveAt).toISOString().slice(0, 10)
        : (isUpgrade ? 'now' : 'end of current cycle');
      const { subject, html, text } = renderTierChangeEmail({
        name: user.name, fromTier: currentTier, toTier: targetTier,
        provider: 'razorpay', effectiveDate: dateLabel,
      });
      sendMail({ to: user.email, subject, html, text }).catch(() => { /* mail outage */ });
    }
  } catch { /* non-fatal */ }

  return res.json({
    provider: 'razorpay-upgrade',
    tier: isUpgrade ? targetTier : currentTier,
    previous_tier: currentTier,
    pending_tier: isUpgrade ? null : targetTier,
    effective_date: effectiveAt,
    effective_date_label: effectiveAt
      ? new Date(effectiveAt).toISOString().slice(0, 10)
      : (isUpgrade ? 'now' : 'end of current cycle'),
    license: license ? { ...license, last_validated: Date.now() } : null,
    message: isUpgrade
      ? `Plan upgraded to ${targetTier.toUpperCase()}. The prorated difference has been charged today.`
      : `Plan will switch to ${targetTier.toUpperCase()} at the end of your current billing cycle (${effectiveAt ? new Date(effectiveAt).toISOString().slice(0, 10) : 'end of cycle'}). You keep ${currentTier.toUpperCase()} access until then.`,
  });
}

// ── Interview-day eligibility — ONE rule, both top-up routes ──────────
// The product rule (owner-confirmed) is that top-ups repeat without limit
// but only while the pass is actually in use: an open usage session
// (mid-interview, the primary case) or activity within the last 12 hours
// (the interviewer called back for another round the same day). A
// week-old pass can't be topped up — buy a fresh interview instead.
//
// This lived inline in /extend-now only, so /create-renewal — a public,
// authenticated route that reaches the very same grant — enforced nothing.
// Any client could top up on any day by calling the older endpoint. It
// leaked in the revenue-POSITIVE direction, which is exactly why it could
// sit there unnoticed: nobody complains about being allowed to pay. But a
// rule enforced on one of two doors is not a rule, and the day the policy
// changes to something restrictive the second door is still open.
//
// Returns null when eligible, or the {status, body} to send when not.
// Admins are exempt (they are unlimited and never charged).
const EXTENSION_ELIGIBLE_WINDOW_MS = 12 * 60 * 60 * 1000;
function interviewDayDenial(userId) {
  const recentActivity = db.getDB().prepare(`
    SELECT id FROM usage_sessions
    WHERE user_id = ? AND (ended_at IS NULL OR last_heartbeat_at > ?)
    LIMIT 1
  `).get(userId, Date.now() - EXTENSION_ELIGIBLE_WINDOW_MS);
  if (recentActivity) return null;
  return {
    status: 403,
    body: {
      error: 'not_interview_day',
      message: 'Top-ups are available during your interview day. Start your interview first, or buy a new interview pass.',
    },
  };
}

// ── Off-session top-up dedup window ───────────────────────────────────
// A completed `mode: 'extension'` payment row for the SAME pack inside this
// window means the user's last click already charged the card AND already
// granted the time. A second click inside it is a double-click, an app
// retry, or a response the client never saw — never a genuine second
// purchase (nobody burns a 30-minute pack in two minutes). Scoping it to the
// same pack keeps the product rule intact: a deliberate different-size
// top-up seconds later still goes through.
//
// Metadata is parsed in JS rather than with SQL json_extract so a legacy or
// malformed metadata blob can only be skipped, never throw inside the money
// path. The time bound keeps the scanned set to a handful of rows.
const EXTEND_DEDUP_WINDOW_MS = 2 * 60 * 1000;
function recentOffSessionExtension(userId, packId, windowMs = EXTEND_DEDUP_WINDOW_MS) {
  const rows = db.getDB().prepare(`
    SELECT id, provider_payment_id, created_at, metadata FROM payments
    WHERE user_id = ? AND provider = 'stripe' AND status = 'completed'
      AND created_at > ?
    ORDER BY created_at DESC, rowid DESC LIMIT 20
  `).all(userId, Date.now() - windowMs);
  for (const row of rows) {
    let meta;
    try { meta = JSON.parse(row.metadata || '{}'); } catch { continue; }
    if (meta && meta.mode === 'extension' && (!packId || meta.pack === packId)) return row;
  }
  return null;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  CREATE RENEWAL — +30 min top-up (browser-checkout fallback)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Separate route from /create-checkout because the semantics differ: this
// charges the flat top-up price ($25 / ₹2099) and the webhook/verify flow
// grants +30 min via grantTimeExtension instead of resetting to the full
// plan grant. metadata.mode === 'renewal' is the signal the webhook reads
// to branch into the top-up grant. This route is the browser-checkout
// fallback used when /extend-now can't charge silently (no card / 3DS).
router.post('/create-renewal', authMiddleware, async (req, res) => {
  try {
    // ── Tier gate ──
    // Top-ups are for the METERED tiers only (Basic/Pro/Max, and Ultra since
    // 2026-08 — a 9-hour monthly allowance can run dry mid-interview, and the
    // whole point of a top-up is that it is the thing you buy when it does):
    //   • Free user → rejected (a top-up would silently bump them to a
    //     partial Basic grant — confusing for someone comparing plans)
    //   • Enterprise → unlimited, nothing to top up (also caught by the
    //     unlimited no-op in grantTimeExtension as defense-in-depth)
    //   • Anyone carrying the -1 unlimited sentinel (admin comp, legacy sub)
    //     → same: refuse rather than charge for time they already have.
    // We allow ANY metered license through (active, expired, exhausted)
    // because the explicit user intent is "I want more time."
    // ORDER MATTERS. The unlimited check runs FIRST because an Enterprise
    // customer is not on a metered tier either, and answering them with
    // "pick a plan to start" tells the person on the most expensive plan we
    // sell that they do not have one. Both are refusals; only one of them is
    // true for them.
    const license = db.getLicenseByUserId(req.user.id);
    if (license && db.resolveTimeBucket(license).source === 'unlimited') {
      return res.status(400).json({
        error: 'Your plan already includes unlimited interview time — there is nothing to top up.',
      });
    }
    if (!license || !METERED_TIERS.includes(license.tier)) {
      return res.status(400).json({
        error: 'Top-ups extend the Basic, Pro, Max, and Ultra interview clocks. Pick a plan to start.',
      });
    }
    // ── Interview-day gate — the SAME rule /extend-now applies ──
    // This route is /extend-now's browser fallback, but it is also a live
    // endpoint any client can call directly, and it used to enforce
    // nothing. Note /extend-now's degraded paths call createStripeRenewal
    // as a FUNCTION, not through this route, so they are gated once (at
    // /extend-now) and never double-gated here.
    if (!isAdminEmail(req.user.email)) {
      const denial = interviewDayDenial(req.user.id);
      if (denial) return res.status(denial.status).json(denial.body);
    }

    // SECURITY: Same currency-injection mitigation as /create-checkout.
    // country_code is server-controlled — read from the user's DB row (set
    // at signup; /profile can't change it). The JWT carries no country_code
    // claim, so the old req.user.country_code was always undefined. Body is
    // ignored. Without this a US user could pay the INR renewal (~₹599)
    // instead of USD (~$6.99) — and, as happened, every IN user wrongly got
    // Stripe USD because the claim never existed.
    const country = db.getUserById(req.user.id)?.country_code || 'US';
    const provider = getPaymentProvider(country);
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
//  EXTEND NOW — one-click +30 min on the card on file (2026-07)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// The mid-interview top-up. Business rules (owner-confirmed):
//   · $25 / ₹2099 per +30 minutes (flat — RENEWAL_* constants)
//   · repeatable WITHOUT limit
//   · but only while the pass is live on its interview day (an open
//     usage session, or session activity within the last 12 hours)
//   · tier preserved (a Pro top-up must never relabel the user Basic)
//   · Ultra/admin exempt — unlimited, never offered, never charged
//
// Stripe path: charge the saved card off-session — the user clicks one
// button in the app and the time lands; NO checkout redirect. Degrades
// to a normal checkout session when there's no card on file yet or the
// bank demands 3DS (both rare after the first purchase, since every
// checkout now saves the card via setup_future_usage).
//
// Razorpay path: RBI rules forbid silent off-session charges on one-time
// payments, so India gets an instant IN-APP payment sheet (order payload
// returned; client opens the Razorpay modal and verifies through the
// existing /verify-razorpay flow with notes.mode='extension').
//
// Grant safety: the direct grant here races only with itself (no webhook
// grants bare PaymentIntents — checkout.session.completed never fires for
// them), and the UNIQUE(provider, provider_payment_id) index plus the
// in-tx dedup make client retries idempotent. The Stripe idempotencyKey is
// derived from SERVER-side, STABLE inputs (user + pack + tier + a coarse
// time bucket) — NOT from the client's attempt_id, which is a fresh UUID on
// every click and so produced a second key, a second PaymentIntent and a
// second REAL charge for one double-click. A repeat inside the window now
// collapses onto the same PaymentIntent, and recentOffSessionExtension
// refuses a second off-session charge before we ever call Stripe.
// (Eligibility windowing now lives in interviewDayDenial above, shared with
// /create-renewal so the rule can't hold on one route and not the other.)

router.post('/extend-now', authMiddleware, async (req, res) => {
  try {
    // Admins are unlimited — nothing to extend.
    if (isAdminEmail(req.user.email)) {
      return res.json({ success: true, already_unlimited: true, message: 'Admin accounts have unlimited time.' });
    }

    // Same ordering rule as /create-renewal: answer "you already have
    // unlimited time" before "you have no plan", or Enterprise (and any
    // admin-comped account) gets told it has no plan.
    const license = db.getLicenseByUserId(req.user.id);
    if (license && db.resolveTimeBucket(license).source === 'unlimited') {
      return res.json({ success: true, already_unlimited: true });
    }
    if (!license || !METERED_TIERS.includes(license.tier)) {
      return res.status(400).json({
        error: 'no_pass',
        message: 'Top-ups extend the Basic, Pro, Max, and Ultra interview clocks. Pick a plan to start.',
      });
    }

    // ── Interview-day gate — shared with /create-renewal ──
    const denial = interviewDayDenial(req.user.id);
    if (denial) return res.status(denial.status).json(denial.body);

    const attemptId = String(req.body?.attempt_id || '').slice(0, 64);
    const extPack = resolveExtensionPack(req.body?.pack);
    const country = db.getUserById(req.user.id)?.country_code || 'US';

    // ── India → instant in-app Razorpay sheet ──
    if (getPaymentProvider(country) === 'razorpay') {
      if (!razorpay) return res.status(503).json({ error: 'Razorpay is not configured. Contact support.' });
      const order = await razorpay.orders.create({
        amount: extPack.inr_paise,
        currency: 'INR',
        receipt: `ext_${req.user.id}_${Date.now()}`,
        notes: {
          user_email: req.user.email,
          user_id: String(req.user.id),
          mode: 'extension',
          tier: license.tier,
          pack: extPack.id,
        },
      });
      return res.json({
        provider: 'razorpay',
        flow: 'in_app_sheet',
        order_id: order.id,
        key_id: process.env.RAZORPAY_KEY_ID,
        amount: order.amount,
        currency: order.currency,
        name: `minicaai — ${extPack.label}`,
        description: `Adds ${extPack.label.replace('+','')} to your interview time.`,
        pack: extPack.id,
        user_email: req.user.email,
        user_name: req.user.name || '',
        mode: 'extension',
      });
    }

    // ── Global → off-session charge on the saved card ──
    if (!stripe) return res.status(503).json({ error: 'Stripe is not configured. Contact support.' });
    const user = db.getUserById(req.user.id);
    const customerId = user?.stripe_customer_id?.startsWith('cus_') ? user.stripe_customer_id : null;
    // No customer / no saved card yet → normal checkout (which saves the
    // card via setup_future_usage, so the NEXT top-up is one-click).
    if (!customerId) return await createStripeRenewal(req, res);

    let paymentMethodId = null;
    try {
      const customer = await stripe.customers.retrieve(customerId);
      paymentMethodId = customer?.invoice_settings?.default_payment_method || null;
      if (!paymentMethodId) {
        const pms = await stripe.paymentMethods.list({ customer: customerId, type: 'card', limit: 1 });
        paymentMethodId = pms.data[0]?.id || null;
      }
    } catch (lookupErr) {
      console.warn('[extend-now] customer/PM lookup failed:', lookupErr.message);
    }
    if (!paymentMethodId) return await createStripeRenewal(req, res);

    // ── Second-click guard: never charge the same top-up twice ──
    // The idempotency key below collapses repeats that land in the same time
    // bucket; this closes the two cases it cannot — two clicks straddling a
    // bucket boundary, and a first attempt whose response never reached the
    // client. That first charge already put the time on the clock, so we
    // answer with the SAME success shape (duplicate: true, nothing charged)
    // rather than billing the card a second time.
    const priorExtension = recentOffSessionExtension(req.user.id, extPack.id);
    if (priorExtension) {
      console.warn(`[extend-now] duplicate top-up suppressed for ${req.user.email} (pack=${extPack.id}, prior_payment=${priorExtension.provider_payment_id || 'n/a'})`);
      const priorLicense = db.getLicenseByUserId(req.user.id);
      const priorBucket = db.resolveTimeBucket(priorLicense);
      return res.json({
        success: true,
        provider: 'stripe',
        flow: 'off_session',
        duplicate: true,
        charged_cents: 0,
        pack: extPack.id,
        granted_seconds: 0,
        remaining: priorBucket.remaining,
        source: priorBucket.source,
        license: priorLicense ? { ...priorLicense, last_validated: Date.now() } : null,
        message: `${extPack.label} is already on your clock — you weren't charged again.`,
      });
    }

    let intent;
    try {
      intent = await stripe.paymentIntents.create({
        amount: extPack.usd_cents,
        currency: 'usd',
        customer: customerId,
        payment_method: paymentMethodId,
        off_session: true,
        confirm: true,
        description: `minicaai — ${extPack.label} interview time`,
        metadata: {
          user_email: req.user.email,
          user_id: String(req.user.id),
          mode: 'extension',
          tier: license.tier,
          pack: extPack.id,
        },
      },
      // Idempotency key from SERVER-side, STABLE inputs ONLY. It used to be
      // `extend_<user>_<attemptId>`, where attempt_id is a fresh client
      // crypto.randomUUID() per click — two clicks meant two keys, two
      // PaymentIntents and two real charges (the in-tx dedup below keys on
      // intent.id, which also differed, so the second charge granted a second
      // pack as well). pack + tier ride in the key because Stripe rejects a
      // reused key carrying different params. attempt_id is still recorded on
      // the payment row for support forensics — it just no longer decides
      // billing. Window-aligned with recentOffSessionExtension so any repeat
      // that guard lets through is guaranteed a distinct bucket (a genuine
      // second purchase still charges).
      { idempotencyKey: `extend_${req.user.id}_${extPack.id}_${license.tier}_${Math.floor(Date.now() / EXTEND_DEDUP_WINDOW_MS)}` });
    } catch (chargeErr) {
      const code = chargeErr?.code || chargeErr?.raw?.code;
      if (code === 'authentication_required') {
        // Bank demands 3DS — impossible silently. Degrade to checkout so
        // the user can complete it in the browser without losing the flow.
        return await createStripeRenewal(req, res);
      }
      const msg = chargeErr?.raw?.message || chargeErr?.message || 'Your card was declined.';
      console.warn('[extend-now] off-session charge failed:', req.user.email, code, msg);
      return res.status(402).json({
        error: 'charge_failed',
        message: `${msg} You can update your card from Manage Subscription, or complete the top-up in the browser.`,
      });
    }
    if (!intent || intent.status !== 'succeeded') {
      return await createStripeRenewal(req, res);
    }

    // Charge landed — grant + record atomically. In-tx dedup + the UNIQUE
    // payment index make a duplicate (idempotent Stripe retry returning
    // the same intent id) a no-op instead of a double grant.
    const sqlite = db.getDB();
    let alreadyGranted = false;
    sqlite.transaction(() => {
      const dup = sqlite.prepare(
        "SELECT id FROM payments WHERE provider = 'stripe' AND provider_payment_id = ? AND status = 'completed' LIMIT 1"
      ).get(intent.id);
      if (dup) { alreadyGranted = true; return; }
      db.grantTimeExtension(req.user.id, extPack.seconds);
      db.recordPayment({
        user_id: req.user.id,
        email: req.user.email,
        provider: 'stripe',
        provider_payment_id: intent.id,
        provider_subscription_id: null,
        amount: extPack.usd_cents,
        currency: 'USD',
        status: 'completed',
        tier_granted: license.tier,
        metadata: { mode: 'extension', off_session: true, pack: extPack.id, granted_seconds: extPack.seconds, attempt_id: attemptId || null },
      });
    })();

    try {
      writeAudit(req, 'user-extend-time', { id: req.user.id, email: req.user.email }, {
        provider: 'stripe', off_session: true, amount_cents: extPack.usd_cents, pack: extPack.id, duplicate: alreadyGranted,
      });
    } catch (auditErr) {
      console.warn('[extend-now] audit log failed:', auditErr.message);
    }

    const updated = db.getLicenseByUserId(req.user.id);
    const bucket = db.resolveTimeBucket(updated);
    return res.json({
      success: true,
      provider: 'stripe',
      flow: 'off_session',
      duplicate: alreadyGranted,
      charged_cents: extPack.usd_cents,
      pack: extPack.id,
      granted_seconds: extPack.seconds,
      remaining: bucket.remaining,
      source: bucket.source,
      license: updated ? { ...updated, last_validated: Date.now() } : null,
      message: `${extPack.label} added. Keep going.`,
    });
  } catch (err) {
    console.error('[extend-now] error:', err.message, err.stack);
    res.status(500).json({ error: err.message || 'Top-up failed. Please try again.' });
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
  // Ultra is the only RECURRING plan, and the only tier whose Price ID is
  // load-bearing beyond Checkout: an in-place subscription swap can ONLY
  // point a subscription item at a real Price — Stripe rejects the inline
  // price_data/product_data shape there. Leaving it unset is safe (Checkout
  // keeps using the inline default); it costs only the prorated in-place
  // Ultra upgrade, which then degrades to a fresh Checkout Session. See
  // resolveStripeSubscriptionPrice.
  ultra: 'STRIPE_PRICE_ULTRA_USD',
  // Enterprise is recurring too, and carries the same in-place-swap caveat
  // as Ultra: a subscription item can only point at a REAL Price, so an
  // Ultra→Enterprise upgrade needs STRIPE_PRICE_ENTERPRISE_USD set to do
  // the prorated swap. Unset is safe — Checkout falls back to the inline
  // price_data default below and the upgrade degrades to a fresh Session.
  enterprise: 'STRIPE_PRICE_ENTERPRISE_USD',
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
      description: 'One 30-minute interview · Gemini · GPT-5.6 · Grok · Groq',
    },
    unit_amount: 3000,
    // No `recurring` — one-time interview.
  },
  pro: {
    currency: 'usd',
    product_data: {
      name: 'minicaai Pro',
      description: 'One 1-hour interview · all 5 models incl. Claude Sonnet 5',
    },
    unit_amount: 5000,
    // No `recurring` — one-time interview.
  },
  max: {
    currency: 'usd',
    product_data: {
      name: 'minicaai Max',
      description: 'Three 1-hour interviews · all 5 models incl. Claude Sonnet 5',
    },
    unit_amount: 8900,
    // No `recurring` — one-time 3-interview pack.
  },
  ultra: {
    currency: 'usd',
    product_data: {
      name: 'minicaai Ultra',
      description: '9 hours of interview time per month · all models · Auto-Type · Train Model',
    },
    unit_amount: 15900,
    recurring: { interval: 'month' },
  },
  enterprise: {
    currency: 'usd',
    product_data: {
      name: 'minicaai Enterprise',
      description: 'Unlimited interview time · every model · Auto-Type for coding rounds · Train Model',
    },
    unit_amount: 119900,
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

// ── Subscription-ITEM price resolution (in-place plan swaps) ──────────
// Checkout accepts inline `price_data.product_data` — it creates the Product
// for you. A SUBSCRIPTION ITEM does not: there `price_data` requires an
// existing `product` id, so posting the Checkout shape at
// subscriptions.update fails ('Received unknown parameter:
// items[0][price_data][product_data]') and every in-place Ultra upgrade 500'd
// after the user clicked Go Ultra.
//
// So an in-place swap is only possible against a REAL Price ID. Returns
// { price: 'price_…' } when one is configured AND validates against the
// published in-app amount, or null when there is nothing safe to swap to —
// the caller then degrades to a fresh Checkout Session instead of erroring,
// so the user always has a way to buy. We never fabricate a Price id here:
// create a real recurring $159/mo Ultra Price in Stripe and set
// STRIPE_PRICE_ULTRA_USD to restore the prorated in-place path.
async function resolveStripeSubscriptionPrice(stripeClient, tier) {
  const envVar = STRIPE_PRICE_ENV[tier];
  const priceId = envVar ? process.env[envVar] : null;
  if (!priceId) return null;
  try {
    await assertStripePriceMatches(stripeClient, priceId, tier);
    return { price: priceId };
  } catch (err) {
    console.warn(`[upgrade-tier] ${envVar} is unusable for an in-place ${tier} swap (${err.message}) — degrading to a fresh Checkout Session.`);
    return null;
  }
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
  // 2026-07 pricing, extended 2026-08: Basic/Pro/Max are ONE-TIME interview
  // purchases; Ultra and Enterprise are recurring subscriptions with
  // provider-managed lifecycle.
  const mode = isRecurringTier(tier) ? 'subscription' : 'payment';

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
  } else {
    // ── Card on file (2026-07) ──
    // One-time interview purchases SAVE the payment method for off-session
    // reuse — this is what powers the mid-interview "+30 min, one click"
    // top-up (/extend-now) without ever sending the user back through a
    // checkout page. setup_future_usage requires the PM to attach to a
    // durable Customer, so when we don't have one on file yet we tell
    // Checkout to always create one; the checkout.session.completed
    // webhook persists session.customer → users.stripe_customer_id.
    // (Subscriptions save their PM automatically — no flag needed.)
    sessionParams.payment_intent_data = {
      setup_future_usage: 'off_session',
      metadata: {
        user_email: req.user.email,
        user_id: String(req.user.id),
        tier,
      },
    };
    if (!reuseCustomerId) {
      sessionParams.customer_creation = 'always';
    }
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
// 2026-07 INR pricing — must match pricingService.ts (IN block) and
// EXPECTED_INR_PAISE above. Basic/Pro/Max are ONE-TIME interview orders; Ultra
// is the monthly subscription. Amount is in paise.
const RAZORPAY_TIER_CONFIG = {
  basic: {
    amountPaise: 249900, // ₹2499 one-time · one 30-min interview
    name: 'minicaai Basic',
    description: 'One 30-minute interview · Gemini · GPT-5.6 · Grok · Groq',
  },
  pro: {
    amountPaise: 419900, // ₹4199 one-time · one 1-hour interview
    name: 'minicaai Pro',
    description: 'One 1-hour interview · all 5 models incl. Claude Sonnet 5',
  },
  max: {
    amountPaise: 739900, // ₹7399 one-time · three 1-hour interviews
    name: 'minicaai Max',
    description: 'Three 1-hour interviews · all 5 models incl. Claude Sonnet 5',
  },
  ultra: {
    amountPaise: 1299900, // ₹12999/month · 9 hours of interview time + Auto-Type
    name: 'minicaai Ultra',
    description: '9 hours of interview time per month · all models · Auto-Type · Train Model',
  },
  enterprise: {
    amountPaise: 9999900, // ₹99999/month · unlimited, never expires
    name: 'minicaai Enterprise',
    description: 'Unlimited interview time · every model · Auto-Type for coding rounds · Train Model',
  },
};
// Plan-ID env per tier. Ultra and Enterprise recur; legacy Pro/Max plan envs
// are still recognized so any historical subscriptions keep resolving, but new
// Pro/Max checkouts are one-time orders (no plan needed).
const RAZORPAY_PLAN_ENV = {
  ultra: 'RAZORPAY_PLAN_ID_ULTRA',
  enterprise: 'RAZORPAY_PLAN_ID_ENTERPRISE',
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

  // Ultra and Enterprise are the recurring subscriptions. Basic/Pro/Max are
  // one-time interview orders (they fall through to razorpay.orders.create below).
  if (isRecurringTier(tier)) {
    const planId = process.env[RAZORPAY_PLAN_ENV[tier]];
    if (!planId) {
      // No recurring plan configured for India yet. Refuse rather than sell a
      // subscription tier as a one-time order — the webhook grants these with
      // expires_at:-1 (no end date), so a single charge that never recurs
      // would hand out permanent access for one month of money.
      const planLabel = tier === 'enterprise' ? 'Enterprise' : 'Ultra';
      return res.status(503).json({
        error: `${planLabel} isn't available as a subscription in your region yet. Please choose Basic, Pro, or Max, or contact support.`,
      });
    }

    {
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
        // 120 monthly cycles (~10 years) ≈ "until cancelled". The old value
        // of 12 made Razorpay auto-COMPLETE the subscription after 12 months,
        // silently churning the subscriber at month 13 with no renewal prompt
        // (subscription.completed webhook flips them to free). 120 is
        // Razorpay's documented monthly max — VERIFY in sandbox before this
        // path serves live traffic (it was unreachable until the country_code
        // checkout fix, so it has never run against real subscribers).
        total_count: 120,
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
  }

  // Basic/Pro/Max → one-time order at the tier's INR price.
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
// mode: 'payment' — one-time charge, no recurring semantics. Flat +30 min
// top-up ($25 — RENEWAL_USD_CENTS). Serves both /create-renewal and
// /extend-now's degraded paths (no card on file / 3DS challenge).
async function createStripeRenewal(req, res) {
  if (!stripe) {
    return res.status(503).json({ error: 'Stripe is not configured. Contact support.' });
  }
  const renewalPack = resolveExtensionPack(req.body?.pack);
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3005';
  // Reuse the stored customer so the saved card powers future one-click
  // top-ups; create one when this is the user's first Stripe touch.
  const existingUser = db.getUserById(req.user.id);
  const reuseCustomerId = existingUser?.stripe_customer_id?.startsWith('cus_')
    ? existingUser.stripe_customer_id
    : null;
  const sessionParams = {
    mode: 'payment',
    // No explicit payment_method_types — same reasoning as /create-checkout:
    // pinning ['card'] here silently disabled Apple Pay, Google Pay and every
    // local method the Dashboard offers, on the surface users hit MID-INTERVIEW
    // where friction costs the most. Stripe filters the list down to methods
    // compatible with setup_future_usage on its own, so the saved-card path
    // that powers one-click top-ups still works.
    line_items: [{
      price_data: {
        currency: 'usd',
        product_data: {
          name: `minicaai — ${renewalPack.label}`,
          description: `Adds ${renewalPack.label.replace('+','')} to your interview time.`,
        },
        unit_amount: renewalPack.usd_cents,
      },
      quantity: 1,
    }],
    // `mode=renewal` in the success URL lets the frontend pick the right
    // welcome banner ("renewed" vs "3 credits unlocked") even before the
    // webhook lands.
    success_url: `${frontendUrl}?payment=success&mode=renewal&pack=${renewalPack.id}&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${frontendUrl}?payment=cancelled`,
    metadata: {
      user_email: req.user.email,
      user_id: String(req.user.id),
      provider: 'stripe',
      mode: 'renewal',  // CRITICAL: webhook branches on this
      pack: renewalPack.id,
    },
    billing_address_collection: 'required',
    // Tax parity with /create-checkout. Without this the $30–$159 plans
    // were taxed and the $25–$80 top-ups were not — so in any jurisdiction
    // where the merchant is registered, VAT/GST/sales tax on the entire
    // top-up revenue line went uncollected and the liability fell on us.
    // Same safe default as the plan checkout: if Stripe Tax isn't set up,
    // tax computes to zero and the session still completes.
    automatic_tax: { enabled: true },
    customer_update: reuseCustomerId ? { address: 'auto' } : undefined,
    // Save the card for off-session reuse (the one-click /extend-now path).
    payment_intent_data: { setup_future_usage: 'off_session', metadata: { pack: renewalPack.id } },
  };
  if (reuseCustomerId) {
    sessionParams.customer = reuseCustomerId;
  } else {
    sessionParams.customer_email = req.user.email;
    sessionParams.customer_creation = 'always';
  }
  const session = await stripe.checkout.sessions.create(sessionParams);
  res.json({
    provider: 'stripe',
    checkout_url: session.url,
    session_id: session.id,
    mode: 'renewal',
    pack: renewalPack.id,
  });
}

// ── RAZORPAY RENEWAL ───────────────────────────────────────────────
// One-time order at the flat top-up price (RENEWAL_INR_PAISE). notes.mode
// === 'renewal' is the signal webhook + verify read to call
// grantTimeExtension (flat +30 min) instead of the full tier grant.
async function createRazorpayRenewal(req, res) {
  if (!razorpay) {
    return res.status(503).json({ error: 'Razorpay is not configured. Contact support.' });
  }
  const renewalPack = resolveExtensionPack(req.body?.pack);
  const renewalLicense = db.getLicenseByUserId(req.user.id);
  const renewalTier = ['basic', 'pro', 'max'].includes(renewalLicense?.tier)
    ? renewalLicense.tier : 'basic';
  const order = await razorpay.orders.create({
    amount: renewalPack.inr_paise,
    currency: 'INR',
    receipt: `renew_${req.user.id}_${Date.now()}`,
    notes: {
      user_email: req.user.email,
      user_id: String(req.user.id),
      mode: 'renewal',
      tier: renewalTier,
      pack: renewalPack.id,
    },
  });
  res.json({
    provider: 'razorpay',
    order_id: order.id,
    key_id: process.env.RAZORPAY_KEY_ID,
    amount: order.amount,
    currency: order.currency,
    name: `minicaai — ${renewalPack.label}`,
    description: `Adds ${renewalPack.label.replace('+','')} to your interview time`,
    user_email: req.user.email,
    user_name: req.user.name || '',
    mode: 'renewal',
    pack: renewalPack.id,
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
    // Hoisted so the grant transaction below can read the top-up pack /
    // amount off the fetched order. This was previously an UNDECLARED
    // identifier at the two read sites — every verified top-up threw
    // ReferenceError inside the transaction and the route 500'd AFTER the
    // user had already paid in the Razorpay sheet.
    let fetchedOrder = null;
    // Who this order/subscription was actually created FOR. Read from the
    // same `notes` block the tier comes from, and stamped at all four
    // create sites in this file.
    let ownerUserId = null;
    let ownerEmail = null;
    try {
      if (razorpay_subscription_id) {
        const sub = await razorpay.subscriptions.fetch(razorpay_subscription_id);
        const t = sub && sub.notes && sub.notes.tier;
        if (VALID_TIERS.includes(t)) grantedTier = t;
        ownerUserId = sub?.notes?.user_id || null;
        ownerEmail = sub?.notes?.user_email || null;
        // Subscriptions are never renewals — skip the notes.mode check.
      } else if (razorpay_order_id) {
        const order = await razorpay.orders.fetch(razorpay_order_id);
        fetchedOrder = order;
        const t = order && order.notes && order.notes.tier;
        if (VALID_TIERS.includes(t)) grantedTier = t;
        ownerUserId = order?.notes?.user_id || null;
        ownerEmail = order?.notes?.user_email || null;
        if (typeof order?.amount === 'number') grantedAmount = order.amount;
        // Top-up orders carry notes.mode 'renewal' (legacy) or 'extension'
        // (2026-07 one-click). Flag them so the grant below branches to
        // the +30-min top-up instead of a full tier reset.
        if (order && order.notes && (order.notes.mode === 'renewal' || order.notes.mode === 'extension')) {
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

    // ── The payment has to be THIS caller's ──
    // A valid signature proves Razorpay issued the payment. It says
    // nothing about who it was issued to — the HMAC is over
    // order_id|payment_id with OUR secret, so it verifies identically no
    // matter which signed-in account presents it. Without this check one
    // real purchase upgrades every account the triple is handed to:
    // pay once, share {order_id, payment_id, signature}, and each
    // recipient's /verify-razorpay grants them the tier (the dedup above
    // is keyed per user_id, so it does not stop the second account).
    //
    // All four create sites in this file stamp notes.user_id +
    // notes.user_email, which is what makes the binding available here.
    // An order carrying NEITHER was not created by this server, so the
    // safe answer is to refuse rather than to grant on a tier we read out
    // of a stranger's notes.
    if (!lookupFailed) {
      const callerId = String(req.user.id);
      const callerEmail = String(req.user.email || '').toLowerCase();
      const stampedId = ownerUserId ? String(ownerUserId) : null;
      const stampedEmail = ownerEmail ? String(ownerEmail).toLowerCase() : null;

      const identified = !!(stampedId || stampedEmail);
      const mine = (stampedId && stampedId === callerId)
        || (!stampedId && stampedEmail && stampedEmail === callerEmail);

      if (!identified || !mine) {
        console.warn('━'.repeat(60));
        console.warn('[verify-razorpay] REFUSED — payment does not belong to the caller');
        console.warn('  caller:        ', callerId, callerEmail);
        console.warn('  stamped owner: ', stampedId || '(none)', stampedEmail || '(none)');
        console.warn('  payment_id:    ', razorpay_payment_id);
        console.warn('  order_id:      ', razorpay_order_id || '(none)');
        console.warn('  subscription:  ', razorpay_subscription_id || '(none)');
        console.warn('━'.repeat(60));
        try {
          db.logAdminAction(callerEmail, 'razorpay-verify-ownership-refused', req.user.id, callerEmail, {
            payment_id: razorpay_payment_id,
            order_id: razorpay_order_id || null,
            subscription_id: razorpay_subscription_id || null,
            stamped_user_id: stampedId,
            stamped_email: stampedEmail,
            ip: req.ip || null,
          });
        } catch { /* audit is best-effort; the refusal above is the control */ }
        return res.status(403).json({ error: 'This payment belongs to a different account.' });
      }
    }

    // If we couldn't determine the tier, the safe move is to NOT touch the
    // license/tier in the DB. We record the payment as 'pending' (audit
    // trail) and return success-with-pending so the client shows a friendly
    // message. The signature-verified webhook will land within seconds and
    // grant the right tier from the full payload.
    // A verified top-up (isRenewal) doesn't need a resolved TIER to grant —
    // it preserves whatever tier the license already has and adds +30 min.
    // Only fall into the pending/reconcile branch when the LOOKUP
    // itself failed (can't trust the order at all). A first-time tier
    // PURCHASE still requires a resolved tier (never default-grant a tier).
    if (lookupFailed || (!grantedTier && !isRenewal)) {
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
          // Top-up: tier preserved. Pack determines seconds — re-derived from order notes.
          const verifyPack = resolveExtensionPack(fetchedOrder?.notes?.pack);
          db.grantTimeExtension(user.id, verifyPack.seconds);
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
            // Seed the interview clock (Basic 30 min / Pro 1 h / Max 3 h /
            // Ultra -1). Omitting these left every Razorpay-verified buyer
            // with tier=X and credits_remaining_seconds=0 — paid, but every
            // usage/model gate said "time used up" and they could never
            // start an interview.
            credits_remaining_seconds: grant.credits_remaining_seconds,
            credits_expire_at: grant.credits_expire_at,
            admin_granted_at: 0, // a real purchase supersedes any earlier admin comp
          });
        }

        // Store payment reference. Legacy prefix-marker in stripe_customer_id
        // for provider detection; new dedicated column razorpay_subscription_id
        // for the actual stable subscription pointer (only set when this is
        // a recurring sub, not a one-time order).
        // Never clobbers an existing Stripe `cus_…` marker (the saved card,
        // /portal and provider detection all hang off it) — the Razorpay
        // pointer lives in users.razorpay_subscription_id below.
        db.setPaymentProviderMarker(user.id, `rzp_${razorpay_subscription_id || razorpay_payment_id}`);
        if (razorpay_subscription_id) {
          db.setRazorpaySubscriptionId(user.id, razorpay_subscription_id);
        }

        // Record payment in history. For a renewal, use the flat top-up
        // price (RENEWAL_INR_PAISE) unless the fetched order amount is known.
        db.recordPayment({
          user_id: user.id,
          email: user.email,
          provider: 'razorpay',
          provider_payment_id: razorpay_payment_id,
          provider_subscription_id: razorpay_subscription_id || null,
          amount: isRenewal ? (typeof fetchedOrder?.amount === 'number' ? fetchedOrder.amount : resolveExtensionPack(fetchedOrder?.notes?.pack).inr_paise) : grantedAmount,
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
        ? 'Top-up successful — 30 extra minutes added to your interview time.'
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
//  VERIFY STRIPE CHECKOUT (client-side callback — webhook fallback)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Razorpay always had /verify-razorpay: the client confirms the payment
// and the grant lands even if the webhook never arrives. Stripe had
// NOTHING equivalent — the webhook was the single path from "customer
// paid" to "customer provisioned". If STRIPE_WEBHOOK_SECRET is rotated,
// the dashboard endpoint is misconfigured, or delivery fails past
// Stripe's 3-day retry window, the money is taken and the account is
// never upgraded, with no automatic recovery. Since Stripe now carries
// 100% of traffic (India included, while Razorpay is pending), that was
// the largest single point of failure in the payment system.
//
// This closes it. The client already holds `session_id` — /create-checkout
// returns it, and it also rides on the success URL — so it can ask the
// server to confirm at any point.
//
// Safety properties, all of which mirror the webhook:
//   · Stripe is the source of truth — we retrieve the session server-side
//     and read payment_status; a client can't assert that it paid.
//   · Ownership is checked against the metadata WE stamped at creation,
//     so one user can't redeem another's session id.
//   · The tier comes from that same server-stamped metadata, never the
//     request body.
//   · The grant is idempotent: in-transaction dedup on the payment id,
//     backed by the UNIQUE(provider, provider_payment_id) index. Racing
//     the webhook is a no-op, not a double grant.
router.post('/verify-stripe', authMiddleware, async (req, res) => {
  try {
    if (!stripe) {
      return res.status(503).json({ error: 'Stripe is not configured. Contact support.' });
    }
    const sessionId = String(req.body?.session_id || '').trim().slice(0, 128);
    if (!sessionId.startsWith('cs_')) {
      return res.status(400).json({ error: 'A Stripe checkout session id is required.' });
    }

    let session;
    try {
      session = await stripe.checkout.sessions.retrieve(sessionId);
    } catch (lookupErr) {
      console.warn('[verify-stripe] session lookup failed:', sessionId, lookupErr.message);
      return res.status(404).json({ error: 'Checkout session not found.' });
    }

    // ── Ownership ──
    // metadata.user_id / user_email are stamped server-side at session
    // creation and can't be influenced by the client. Without this check
    // any authenticated user who learned a session id could redeem
    // someone else's purchase onto their own account.
    const ownerId = String(session.metadata?.user_id || '');
    const ownerEmail = String(session.metadata?.user_email || '').toLowerCase();
    const callerEmail = String(req.user.email || '').toLowerCase();
    if (ownerId !== String(req.user.id) && (!ownerEmail || ownerEmail !== callerEmail)) {
      console.warn('[verify-stripe] ownership mismatch — session', sessionId, 'belongs to', ownerId || ownerEmail, 'caller', req.user.id);
      return res.status(403).json({ error: 'This checkout session belongs to a different account.' });
    }

    // ── Did the money actually land? ──
    // Same gate the webhook applies. A delayed-notification method (SEPA,
    // boleto, OXXO…) reports 'unpaid' here for days — tell the client to
    // keep waiting rather than granting on an unsettled payment.
    const paid = session.payment_status === 'paid' || session.payment_status === 'no_payment_required';
    if (!paid) {
      return res.status(202).json({
        success: true,
        pending: true,
        payment_status: session.payment_status || 'unknown',
        message: 'Payment is still processing with your bank. Your plan activates automatically as soon as it clears.',
      });
    }

    const isRenewal = session.metadata?.mode === 'renewal' || session.metadata?.mode === 'extension';
    const rawTier = session.metadata?.tier;
    const tier = VALID_TIERS.includes(rawTier) && rawTier !== 'free' ? rawTier : null;
    if (!isRenewal && !tier) {
      // A paid session with no resolvable tier is a configuration bug, not
      // a customer problem. Never guess a tier — the webhook records the
      // same case as 'failed' for triage.
      console.error('[verify-stripe] paid session with no resolvable tier:', sessionId, session.metadata);
      return res.status(202).json({
        success: true,
        pending: true,
        message: 'Payment received. Your account will activate momentarily.',
      });
    }

    const user = db.getUserById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const paymentRef = session.payment_intent || session.id;
    const sqlite = db.getDB();
    let grantedTier = null;
    let alreadyGranted = false;

    sqlite.transaction(() => {
      const dup = sqlite.prepare(
        "SELECT id, tier_granted FROM payments WHERE provider = 'stripe' AND provider_payment_id = ? AND status = 'completed' LIMIT 1"
      ).get(paymentRef);
      if (dup) {
        alreadyGranted = true;
        grantedTier = dup.tier_granted;
        return;
      }

      if (isRenewal) {
        const pack = resolveExtensionPack(session.metadata?.pack);
        const updated = db.grantTimeExtension(user.id, pack.seconds);
        grantedTier = (updated && updated.tier) || 'basic';
      } else {
        const grant = grantConfigForTier(tier);
        grantedTier = grant.tier;
        db.updateUserTier(user.id, grant.tier);
        db.updateLicenseOnPayment(user.id, {
          tier: grant.tier,
          status: 'active',
          expires_at: grant.expires_at,
          sessions_limit: grant.sessions_limit,
          credits_remaining_seconds: grant.credits_remaining_seconds,
          credits_expire_at: grant.credits_expire_at,
          // A real purchase supersedes any earlier admin comp: the paid plan's
          // own lifecycle (cancel, refund, dispute) must be able to end it.
          admin_granted_at: 0,
        });
      }

      if (session.customer) {
        db.setPaymentProviderMarker(user.id, session.customer);
      }
      db.recordPayment({
        user_id: user.id,
        email: user.email,
        provider: 'stripe',
        provider_payment_id: paymentRef,
        provider_subscription_id: session.subscription || null,
        amount: session.amount_total || 0,
        currency: (session.currency || 'usd').toUpperCase(),
        status: 'completed',
        tier_granted: grantedTier,
        metadata: {
          checkout_session_id: session.id,
          customer_id: session.customer,
          tier: grantedTier,
          mode: isRenewal ? 'renewal' : 'tier',
          settled_via: 'verify-stripe',
          verified_client_side: true,
        },
      });
    })();

    const license = db.getLicenseByUserId(req.user.id);
    if (!alreadyGranted) {
      console.log('[verify-stripe] grant applied (webhook had not landed):', user.email, grantedTier, paymentRef);
      // Receipt only on the path that actually granted — the webhook sends
      // its own when it wins the race.
      try {
        const { sendMail, renderPurchaseReceiptEmail } = require('../email');
        if (typeof renderPurchaseReceiptEmail === 'function') {
          const { subject, html, text } = renderPurchaseReceiptEmail({
            name: user.name || user.email,
            tier: grantedTier,
            isTopUp: isRenewal,
            amount: session.amount_total || 0,
            currency: (session.currency || 'usd').toUpperCase(),
            manageUrl: process.env.FRONTEND_URL || 'https://minicaai.com',
          });
          sendMail({ to: user.email, subject, html, text }).catch(() => { /* mail outage */ });
        }
      } catch { /* email module unavailable — non-fatal */ }
    }

    return res.json({
      success: true,
      duplicate: alreadyGranted,
      tier: grantedTier,
      mode: isRenewal ? 'renewal' : 'tier',
      license: license ? { ...license, last_validated: Date.now() } : null,
      message: alreadyGranted
        ? 'Payment already applied.'
        : (isRenewal
            ? 'Top-up confirmed — the extra time is on your clock.'
            : `Payment confirmed. Your ${String(grantedTier).toUpperCase()} plan is active.`),
    });
  } catch (err) {
    console.error('[verify-stripe] error:', err.message, err.stack);
    res.status(500).json({ error: 'Could not verify the payment. If you were charged, it will land automatically.' });
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  GET SUBSCRIPTION STATUS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// Is the user's CURRENT paid tier subscription-backed (recurring), as
// opposed to a one-time interview pass? Drives which billing actions the
// client renders: cancel/reactivate only make sense against a subscription
// (/cancel-subscription 404s for a pass holder — there is no sub to cancel);
// a pass instead shows "expires on <date>, no cancellation needed".
//   · Ultra is ALWAYS a subscription (2026-07 model; the Razorpay checkout
//     refuses to sell Ultra as a one-time order for exactly this reason).
//   · Pro/Max are one-time passes UNLESS the user is a legacy subscriber.
//     Detectable from the payments ledger: subscription-cycle rows
//     (checkout subscription mode, invoice.payment_succeeded,
//     subscription.charged) always carry provider_subscription_id; one-time
//     orders never do. We look at the LATEST tier-granting row so a legacy
//     subscriber who lapsed and later bought a pass reads as one-time.
//
// The `rowid DESC` tiebreak is the same one resolveUserProvider needs and
// for the same reason: created_at is milliseconds, so a lapsed subscriber
// who re-buys a pass — or any two grants landing in the same millisecond
// (a webhook and a /verify racing, an upgrade applied in one transaction)
// — leaves the ordering undefined, and SQLite is then free to return the
// OLDER row. Getting it wrong flips is_recurring, which decides whether
// the client offers Cancel (404s for a pass holder) or "expires on <date>".
// rowid is monotonic per insert, so it expresses the "which came second"
// that the timestamp cannot.
function isSubscriptionBackedTier(userId, tier) {
  if (isRecurringTier(tier)) return true;
  if (tier !== 'pro' && tier !== 'max') return false;
  const row = db.getDB().prepare(`
    SELECT provider_subscription_id FROM payments
    WHERE user_id = ? AND status = 'completed' AND tier_granted IN ('pro', 'max')
    ORDER BY created_at DESC, rowid DESC LIMIT 1
  `).get(userId);
  return !!(row && row.provider_subscription_id);
}

router.get('/subscription', authMiddleware, async (req, res) => {
  try {
    const user = db.getUserById(req.user.id);
    const license = db.getLicenseByUserId(req.user.id);

    if (!user || !license) {
      return res.json({ status: 'none', tier: 'free', provider: null });
    }

    // Which provider owns the live subscription (resolveUserProvider —
    // handles users carrying both a Stripe cus_ and a Razorpay pointer).
    const provider = resolveUserProvider(user);

    // Derive cancel-pending state from the canonical license.status the
    // webhook handler sets ('canceling' = cancel_at_period_end=true and
    // we're still inside the paid window). Surfacing the boolean and
    // cycle-end timestamp lets the client render an explicit "Cancellation
    // scheduled — access until <date>" banner and a Reactivate CTA without
    // having to round-trip Stripe on every page load.
    const isCancelPending = license.status === 'canceling';

    // ── Can this account top up RIGHT NOW? ──
    // The interview-day rule is enforced server-side on both top-up routes,
    // but the Billing Hub rendered an inviting "Add 30 minutes · $25" button
    // unconditionally — so opening Manage Subscription on a non-interview
    // day offered a purchase that could only ever fail. Surfacing the same
    // predicate the routes use lets the button disable itself and say why,
    // instead of the user clicking a paid CTA into a 403. One source of
    // truth: this reads interviewDayDenial, so the affordance can never
    // disagree with the gate.
    // "Metered" is a property of the LICENSE, not a hardcoded tier list. The
    // list used to be ['basic','pro','max'] because those were the only tiers
    // with a clock; since 2026-08 Ultra has one too, and a hardcoded list left
    // a metered Ultra with can_extend:false — the Billing Hub hiding the very
    // button whose route now accepts them, which is the same
    // affordance-disagrees-with-the-gate bug the comment above describes, just
    // pointing the other way. Unlimited licenses (Enterprise, admin comps,
    // grandfathered legacy subs) resolve to 'unlimited' and correctly get no
    // control: there is nothing to add to.
    const isMetered = METERED_TIERS.includes(license.tier)
      && db.resolveTimeBucket(license).source === 'credits';
    const isAdmin = isAdminEmail(req.user.email);
    const extendDenial = (isMetered && !isAdmin) ? interviewDayDenial(user.id) : null;

    res.json({
      status: license.status,
      tier: license.tier,
      provider,
      expires_at: license.expires_at,
      sessions_used: license.sessions_used,
      sessions_limit: license.sessions_limit,
      cancel_at_period_end: isCancelPending,
      cancels_at: isCancelPending ? license.expires_at : null,
      // Whether the current tier is a recurring subscription (Ultra,
      // Enterprise, or a legacy Pro/Max sub) vs a one-time pass — see
      // isSubscriptionBackedTier.
      is_recurring: isSubscriptionBackedTier(user.id, license.tier),
      // Top-up affordance state. can_extend is false for a metered plan
      // outside its interview day; free and the unlimited plans simply don't
      // show the control, and admins are unlimited.
      can_extend: isMetered ? !extendDenial : false,
      extend_blocked_reason: extendDenial ? extendDenial.body.error : null,
      extend_blocked_message: extendDenial ? extendDenial.body.message : null,
    });
  } catch (err) {
    console.error('Subscription status error:', err.message);
    res.status(500).json({ error: 'Failed to check subscription' });
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  PAYMENT HISTORY — the Billing Hub's invoice list
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Reads the payments table we already write on every grant/refund/failure.
// Client-safe projection only — provider ids are included (they're the
// user's own receipts) but internal metadata is parsed and reduced.
router.get('/history', authMiddleware, (req, res) => {
  try {
    const rows = db.getPaymentsByUser(req.user.id) || [];
    const items = rows.slice(0, 50).map((p) => {
      let mode = 'purchase';
      try {
        const meta = JSON.parse(p.metadata || '{}');
        if (meta.mode === 'renewal' || meta.mode === 'extension') mode = 'top-up';
        else if (meta.mode) mode = meta.mode;
      } catch { /* metadata unparseable — keep default */ }
      return {
        id: p.id,
        created_at: p.created_at,
        provider: p.provider,
        amount: p.amount,
        currency: p.currency,
        status: p.status,
        tier: p.tier_granted,
        mode,
        reference: p.provider_payment_id || null,
      };
    });
    res.json({ payments: items });
  } catch (err) {
    console.error('[payments/history] error:', err.message);
    res.status(500).json({ error: 'Failed to load payment history' });
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  PAYMENT METHOD — what card is on file (Billing Hub)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Stripe only — Razorpay one-time flows don't retain a chargeable
// instrument (RBI), so India reports none and the UI explains that
// top-ups go through the instant UPI/card sheet instead.
router.get('/payment-method', authMiddleware, async (req, res) => {
  try {
    const user = db.getUserById(req.user.id);
    const customerId = user?.stripe_customer_id?.startsWith('cus_') ? user.stripe_customer_id : null;
    if (!customerId || !stripe) {
      const isIndia = (user?.country_code || 'US') === 'IN';
      return res.json({ has_card: false, provider: isIndia ? 'razorpay' : 'stripe' });
    }
    let pm = null;
    const customer = await stripe.customers.retrieve(customerId);
    const defaultId = customer?.invoice_settings?.default_payment_method || null;
    if (defaultId) {
      pm = await stripe.paymentMethods.retrieve(defaultId);
    } else {
      const pms = await stripe.paymentMethods.list({ customer: customerId, type: 'card', limit: 1 });
      pm = pms.data[0] || null;
    }
    if (!pm?.card) return res.json({ has_card: false, provider: 'stripe' });
    res.json({
      has_card: true,
      provider: 'stripe',
      brand: pm.card.brand,
      last4: pm.card.last4,
      exp_month: pm.card.exp_month,
      exp_year: pm.card.exp_year,
    });
  } catch (err) {
    console.error('[payments/payment-method] error:', err.message);
    // Non-fatal for the Billing Hub — render the "no card" state.
    res.json({ has_card: false, provider: 'stripe', lookup_failed: true });
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
    const user = db.getUserById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const customerId = user.stripe_customer_id || '';
    const provider = resolveUserProvider(user);
    const isRazorpay = provider === 'razorpay';
    const isStripe = provider === 'stripe';

    if (!isRazorpay && !isStripe) {
      return res.status(400).json({
        error: 'No subscription on file to reactivate. If your billing cycle already ended, start a new subscription from the Manage Subscription screen.',
      });
    }

    // ── Stripe path: native un-cancel via cancel_at_period_end=false ──
    if (isStripe) {
      if (!stripe) return res.status(503).json({ error: 'Stripe is not configured. Contact support.' });
      const subs = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 5 });
      const candidate = subs.data.find(s => s.status === 'active' && s.cancel_at_period_end === true);
      if (!candidate) {
        return res.status(400).json({ error: 'No active subscription is scheduled to cancel. Nothing to reactivate.' });
      }
      const updated = await stripe.subscriptions.update(candidate.id, { cancel_at_period_end: false });
      const safeTier = (t) => VALID_TIERS.includes(t) ? t : null;
      const tier = safeTier(candidate.metadata?.tier) || safeTier(db.getLicenseByUserId(user.id)?.tier);
      if (tier) {
        // Re-affirm only (creditsForReaffirm): reactivation isn't a fresh
        // purchase — it un-sets cancel_at_period_end inside a cycle the user
        // already paid for. Enterprise's constant -1 is safe to rewrite;
        // Ultra's metered balance and a legacy Pro/Max sub's migration-era
        // unlimited balance are both left exactly as they are.
        const grant = grantConfigForTier(tier);
        db.updateLicenseOnPayment(user.id, {
          tier: grant.tier,
          status: 'active',
          expires_at: grant.expires_at,
          sessions_limit: grant.sessions_limit,
          ...creditsForReaffirm(grant),
        });
      }
      // Audit trail
      try {
        writeAudit(req, 'user-reactivate-subscription', { id: user.id, email: user.email }, {
          provider: 'stripe',
          subscription_id: updated.id,
          tier_restored: tier,
        });
      } catch (auditErr) {
        console.warn('[reactivate] audit log failed:', auditErr.message);
      }
      const license = db.getLicenseByUserId(user.id);
      return res.json({
        provider: 'stripe-reactivate',
        tier,
        effective_date: Date.now(),
        effective_date_label: 'now',
        license: license ? { ...license, last_validated: Date.now() } : null,
        message: 'Subscription reactivated — your plan will continue to renew normally.',
        stripe_subscription_id: updated.id,
      });
    }

    // ── Razorpay path: Razorpay's REST API has no direct un-cancel for
    //    a sub that was scheduled with cancel_at_cycle_end=false. The
    //    cycle still completes (user has access until current_end), but
    //    no renewal will fire. To restore renewal we have to mirror the
    //    user's intent in our DB and ALSO try the Razorpay update API
    //    in case Razorpay has flipped on a reactivate endpoint we
    //    haven't seen yet. Worst case we fall through with a clear
    //    "contact support" message so the user isn't stranded.
    if (isRazorpay) {
      if (!razorpay) return res.status(503).json({ error: 'Razorpay is not configured. Contact support.' });

      const subscriptionId = db.getLatestRazorpaySubscriptionId(user.id);
      if (!subscriptionId) {
        return res.status(404).json({ error: 'No Razorpay subscription on file to reactivate.' });
      }

      // Best-effort: try the Razorpay update API. If they've enabled a
      // resume/reactivate API on the sub object, this will succeed.
      let razorpayResumed = false;
      let razorpayErr = null;
      try {
        // The update API accepts schedule_change_at to swap a plan; it
        // doesn't directly clear a scheduled cancellation. Fetching the
        // subscription tells us whether it's still active.
        const sub = await razorpay.subscriptions.fetch(subscriptionId);
        if (sub && sub.status === 'active') {
          // Razorpay sub is still active — we can't programmatically
          // clear `cancel_at_cycle_end`. The user has access until
          // `current_end`; after that the sub stops renewing. We mark
          // the license back to 'active' locally so the UI doesn't
          // show "canceling" anymore, but we surface the limitation in
          // the response so the user knows the cycle still ends.
          razorpayResumed = true;
        } else {
          razorpayErr = `Razorpay subscription is in '${sub?.status || 'unknown'}' state; needs a new subscription, not a reactivation.`;
        }
      } catch (rpErr) {
        razorpayErr = rpErr.message || String(rpErr);
      }

      if (!razorpayResumed) {
        return res.status(400).json({
          provider: 'razorpay',
          error: razorpayErr || 'Razorpay subscriptions can\'t be reactivated programmatically once the cycle ends. Start a new subscription from the Manage Subscription screen.',
          fallback: 'start_new_subscription',
        });
      }

      // Local mirror: flip status back to 'active'. expires_at stays
      // anchored to the original cycle_end (Razorpay won't renew past
      // it without a new subscription, so we don't lie about lifetime).
      const license = db.getLicenseByUserId(user.id);
      if (license) {
        db.updateLicenseOnPayment(user.id, {
          tier: license.tier,
          status: 'active',
          expires_at: license.expires_at,
          sessions_limit: license.sessions_limit,
        });
      }
      try {
        writeAudit(req, 'user-reactivate-subscription', { id: user.id, email: user.email }, {
          provider: 'razorpay',
          subscription_id: subscriptionId,
          razorpay_note: 'sub still active in current cycle; renewal stays cancelled (Razorpay API limitation)',
        });
      } catch (auditErr) {
        console.warn('[reactivate] razorpay audit log failed:', auditErr.message);
      }

      const refreshed = db.getLicenseByUserId(user.id);
      return res.json({
        provider: 'razorpay-reactivate',
        tier: refreshed?.tier || null,
        effective_date: Date.now(),
        effective_date_label: 'now',
        license: refreshed ? { ...refreshed, last_validated: Date.now() } : null,
        message: 'Reactivated within the current cycle. Heads-up: Razorpay can\'t resume the auto-renewal once it\'s been scheduled to stop — to renew past your current cycle end, start a new subscription from Manage Subscription before then.',
        razorpay_subscription_id: subscriptionId,
        renewal_caveat: true,
      });
    }
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
// on the user row) and call subscriptions.cancel with
// { cancel_at_cycle_end: true } so access continues to the cycle end.
// Webhook `subscription.cancelled` handles the actual tier downgrade when
// the period ends.
router.post('/cancel-razorpay', authMiddleware, async (req, res) => {
  try {
    if (!razorpay) return res.status(503).json({ error: 'Razorpay not configured' });

    const subId = db.getLatestRazorpaySubscriptionId(req.user.id);
    if (!subId) {
      return res.status(404).json({ error: 'No active Razorpay subscription found.' });
    }

    // Keep access until the END of the current billing cycle — matches the
    // Stripe path's cancel_at_period_end:true and the "Pro until <date>" UI
    // below. Razorpay's actual semantics (verified against the official docs
    // + razorpay-node ^2.9.6): cancel_at_cycle_end:true = cancel at cycle
    // end; false / 0 / omitted = cancel IMMEDIATELY. The prior code passed a
    // bare positional `false` — wrong SHAPE (the SDK takes an options object,
    // not a positional bool) AND wrong VALUE — so it cancelled immediately,
    // and the subscription.cancelled webhook then flipped the user to free
    // within minutes, contradicting the optimistic 'canceling' status set
    // below ("you keep access until <date>").
    // See: https://razorpay.com/docs/api/payments/subscriptions/cancel-subscription/
    // ⚠ VERIFY IN RAZORPAY SANDBOX before this serves live traffic — this
    // path was unreachable until the country_code checkout fix, so it has
    // never actually run against a real Razorpay subscription.
    await razorpay.subscriptions.cancel(subId, { cancel_at_cycle_end: true });

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
      // resolveCancelPeriodEnd, not `periodEndMs || license.expires_at`:
      // that fallback pinned a canceled Ultra at expires_at = -1 whenever
      // the fetch above blipped, and -1 is invisible to BOTH the cycle-end
      // sweeper and /validate's auto-transition. See subscriptionStates.
      const cancelEnd = resolveCancelPeriodEnd(periodEndMs, license.expires_at);
      db.updateLicenseOnPayment(req.user.id, {
        tier: license.tier,                              // unchanged — user keeps access through cycle
        status: 'canceling',                             // matches /cancel-subscription unified route
        expires_at: cancelEnd,
        sessions_limit: license.sessions_limit,
      });
      updatedLicense = db.getLicenseByUserId(req.user.id);
      if (!periodEndMs) periodEndMs = cancelEnd; // report the window we actually persisted
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

    // Capture an OPTIONAL cancellation reason. The ManageSubscription UI
    // now asks "why are you leaving?" before submit (Too expensive / Not
    // using / Switching tools / Other + free-form). We persist it to the
    // audit trail for churn analysis. Server doesn't gate on the reason
    // — leaving it blank still cancels — so users who skip the dropdown
    // aren't trapped.
    const reasonRaw = String(req.body?.reason || '').trim().slice(0, 200);
    const reasonDetail = String(req.body?.reason_detail || '').trim().slice(0, 500);

    const customerId = user.stripe_customer_id || '';
    const provider = resolveUserProvider(user);
    const isRazorpay = provider === 'razorpay';
    const isStripe = provider === 'stripe';
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
        // Compat read: current_period_end moved onto subscription items in
        // 2025-03-31.basil. This client is pinned to 2023-10-16 so the direct
        // field is normally present — but reading it through the accessor
        // means the cancel date survives an unpinning too, and that date is
        // what the whole canceling→free lifecycle hangs on.
        const subEnd = subscriptionPeriodEnd(updated);
        if (subEnd && subEnd > latestPeriodEnd) {
          latestPeriodEnd = subEnd;
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
      // Keep access until cycle end — same as the Stripe branch's
      // cancel_at_period_end:true. Razorpay: cancel_at_cycle_end:true =
      // cycle end; false / omitted = cancel IMMEDIATELY. Prior code passed a
      // bare positional `false` (wrong shape + wrong value) → immediate
      // cancel, contradicting the 'canceling' status set below. The SDK
      // takes an options object. ⚠ VERIFY IN RAZORPAY SANDBOX before live.
      await razorpay.subscriptions.cancel(subscriptionId, { cancel_at_cycle_end: true });
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
      // Same guarantee as /cancel-razorpay: a 'canceling' row without a
      // positive expires_at terminates through no path at all. Ultra is
      // granted at -1, so the old `periodEndMs || license.expires_at`
      // produced exactly that whenever the provider lookup came back
      // empty. See resolveCancelPeriodEnd in subscriptionStates.
      const cancelEnd = resolveCancelPeriodEnd(periodEndMs, license.expires_at);
      db.updateLicenseOnPayment(user.id, {
        tier: license.tier,
        status: 'canceling',
        expires_at: cancelEnd,
        sessions_limit: license.sessions_limit,
      });
      updatedLicense = db.getLicenseByUserId(user.id);
      if (!periodEndMs) periodEndMs = cancelEnd; // the response must name the window we persisted
    }
    // Anchor the out-of-order gate to the cancel moment — same reasoning
    // as the legacy /cancel-razorpay route. (P1-G from the audit.)
    db.gateAndRecordEventForUser(user.id, Math.floor(Date.now() / 1000));

    // Audit trail — captures who canceled, when, on which provider, and
    // the optional reason the user gave. Critical for churn analysis +
    // for support to honor "I canceled by mistake" claims. The audit row
    // is best-effort: if it fails, the cancellation still succeeds.
    try {
      writeAudit(req, 'user-cancel-subscription', { id: user.id, email: user.email }, {
        provider: providerLabel,
        subscription_id: subscriptionId,
        tier_at_cancel: license?.tier || null,
        cancels_at: periodEndMs,
        reason: reasonRaw || null,
        reason_detail: reasonDetail || null,
      });
    } catch (auditErr) {
      console.warn('[cancel-subscription] audit log failed:', auditErr.message);
    }

    // Confirmation email — receipt + one-click reactivate link. Best
    // effort: if the email transport isn't configured (Resend/SMTP both
    // unset in dev), the function logs and returns rather than throws,
    // so the cancellation still completes.
    try {
      const { sendMail, renderCancellationEmail } = require('../email');
      if (typeof renderCancellationEmail === 'function') {
        const effectiveLabel = periodEndMs
          ? new Date(periodEndMs).toISOString().slice(0, 10)
          : 'end of current cycle';
        const manageUrl = `${process.env.FRONTEND_URL || 'https://minicaai.com'}/manage`;
        const { subject, html, text } = renderCancellationEmail({
          name: user.name,
          tier: license?.tier || 'subscription',
          effectiveDate: effectiveLabel,
          manageUrl,
        });
        sendMail({ to: user.email, subject, html, text }).catch(() => { /* email outage non-fatal */ });
      }
    } catch { /* email module missing or threw — non-fatal */ }

    res.json({
      success: true,
      provider: providerLabel,
      subscription_id: subscriptionId,
      cancels_at: periodEndMs,
      // ISO label for the UI — avoids re-formatting client-side.
      effective_date: periodEndMs ? new Date(periodEndMs).toISOString() : null,
      effective_date_label: periodEndMs
        ? new Date(periodEndMs).toISOString().slice(0, 10)
        : 'end of current period',
      reason_recorded: !!reasonRaw,
      message: periodEndMs
        ? `Your subscription will be cancelled on ${new Date(periodEndMs).toISOString().slice(0, 10)}. You keep full access until then — and you can reactivate any time before that date from Manage subscription.`
        : 'Your subscription will be cancelled at the end of the current billing period. You keep full access until then — and you can reactivate any time before that date from Manage subscription.',
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
  // Extension pack tests
  EXTENSION_PACKS,
  resolveExtensionPack,
  // Provider routing + upgrade-direction tests
  getPaymentProvider,
  isTierUpgrade,
  TIER_RANK,
  RECURRING_TIERS,
  isRecurringTier,
  METERED_TIERS,
  creditsForPlanChange,
  creditsForReaffirm,
  grantConfigForTier,
  // Subscription-vs-pass detection (/subscription is_recurring)
  isSubscriptionBackedTier,
  // Double-billing guard on /create-checkout
  checkoutConflictFor,
  // Same-or-lower pass repurchase guard (value-destroying re-buys)
  passRepurchaseConflictFor,
  // Interview-day eligibility, shared by /extend-now and /create-renewal
  interviewDayDenial,
  EXTENSION_ELIGIBLE_WINDOW_MS,
  // Off-session top-up duplicate-charge guard (/extend-now)
  recentOffSessionExtension,
  EXTEND_DEDUP_WINDOW_MS,
  // Subscription-item price resolution for in-place plan swaps
  resolveStripeSubscriptionPrice,
  // Provider ownership for existing subscriptions (cancel/reactivate/swap)
  resolveUserProvider,
};
