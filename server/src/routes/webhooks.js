const express = require('express');
const crypto = require('crypto');
const db = require('../database');

// ── Extension pack seconds — duplicated here for worker isolation ──
// (Same duplication pattern as grantConfigForTier: webhooks may run in a
// separate process that doesn't import payments.js.)
const EXTENSION_PACK_SECONDS = { m30: 1800, h1: 3600, h3: 10800 };
function packSecondsFor(id) { return EXTENSION_PACK_SECONDS[id] || 1800; }
const { sendMail, renderPaymentFailedEmail } = require('../email');
// Guarantees a canceling license carries a real cycle-end date — see the
// long note on resolveCancelPeriodEnd.
const { resolveCancelPeriodEnd } = require('../services/subscriptionStates');

const router = express.Router();

// Build the "manage your billing" URL we point users to in failure mails.
// Always the public app URL — the SubscriptionGate UI on that page already
// renders the right portal/cancel/upgrade button for the user's provider.
function billingManageUrl() {
  return process.env.FRONTEND_URL || 'https://minicaai.com';
}

// Fire-and-forget payment-failure email. Wrapped so a transport hiccup
// (Resend down, SMTP timeout) can't take down the webhook handler — that
// would cause the provider to retry the webhook on a 500, which would
// re-fire all the bookkeeping above this call. The DB has already been
// updated by the caller; the email is best-effort.
async function notifyPaymentFailed({ user, tier, reason }) {
  try {
    const { subject, html, text } = renderPaymentFailedEmail({
      name: user.name || user.email,
      tier: tier || 'your plan',
      manageUrl: billingManageUrl(),
      reason,
    });
    const result = await sendMail({ to: user.email, subject, html, text });
    if (!result || !result.ok) {
      console.warn('[webhook:notify] payment-failed mail not sent:', result && result.reason);
    }
  } catch (err) {
    console.error('[webhook:notify] payment-failed mail threw:', err && err.message);
  }
}

// Purchase confirmation. Until now the app emailed on FAILURE, cancel,
// tier change and pass expiry — but never on a successful charge, leaving
// Stripe's own receipt (which is off by default in test mode and easy to
// forget in live) as the only confirmation a customer ever got. Fire-and-
// forget for the same reason as notifyPaymentFailed: the money and the
// grant are already committed, so a mail outage must not fail the webhook
// and trigger a retry of the whole handler.
async function notifyPurchaseReceipt({ user, tier, isTopUp, amount, currency }) {
  try {
    const { renderPurchaseReceiptEmail } = require('../email');
    if (typeof renderPurchaseReceiptEmail !== 'function') return;
    const { subject, html, text } = renderPurchaseReceiptEmail({
      name: user.name || user.email,
      tier,
      isTopUp: !!isTopUp,
      amount,
      currency,
      manageUrl: billingManageUrl(),
    });
    const result = await sendMail({ to: user.email, subject, html, text });
    if (!result || !result.ok) {
      console.warn('[webhook:notify] receipt mail not sent:', result && result.reason);
    }
  } catch (err) {
    console.error('[webhook:notify] receipt mail threw:', err && err.message);
  }
}

const {
  createStripeClient,
  // Read both the pinned (2023-10-16) and Basil+ shapes for the four
  // fields that moved. The webhook ENDPOINT carries its own api_version
  // from the Dashboard — the client pin doesn't govern it — and every
  // drift symptom is silent. See services/stripeClient.js.
  warnOnApiVersionDrift,
  subscriptionPeriodEnd,
  invoicePaymentIntentId,
  invoiceSubscriptionId,
  latestRefundFor,
} = require('../services/stripeClient');
// Pinned API version — see services/stripeClient.js for why an unpinned
// client silently returns `undefined` for the fields this file reads.
const stripe = createStripeClient();

// ── Tier helpers (mirror of payments.js — kept local to avoid a cross-file
//    dependency; webhooks may run in a separate worker in the future). ──
//
// 2026-07 PRICING MODEL. Basic/Pro/Max are ONE-TIME, time-limited interviews
// with a 30-day window to use them; Ultra is the monthly UNLIMITED subscription.
// This MUST stay byte-for-byte in step with payments.js grantConfigForTier (the
// customer-purchase config) — the two were duplicated deliberately, and drift
// between them silently grants paying customers the WRONG plan. The pre-2026-07
// version of this file still granted Pro/Max as `expires_at:-1` (unlimited) and
// omitted 'ultra' entirely, so a real Ultra purchase recorded as "failed / no
// tier" and Pro/Max buyers got unlimited time for a one-time price.
const VALID_TIERS = ['basic', 'pro', 'max', 'ultra', 'enterprise'];
const INTERVIEW_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // window to USE a one-time interview
// Ultra's per-cycle allowance (2026-08). Mirrors ULTRA_CYCLE_SECONDS in
// routes/payments.js and ULTRA_MONTHLY_SECONDS in the client's
// services/licenseService.ts.
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

// The RECURRING (subscription) tiers, as opposed to the one-time passes.
const RECURRING_TIERS = ['ultra', 'enterprise'];

// Strict: returns null for unknown/missing. Every money-granting path uses
// this — the prior version defaulted to 'pro', which silently upgraded a
// Basic buyer to Pro if their checkout metadata was ever dropped.
function resolveTier(t) {
  return VALID_TIERS.includes(t) ? t : null;
}

// Initial license values for a fresh tier grant. Includes the credits fields so
// the server row is coherent even before the client re-seeds its ledger:
//   Basic = one 30-min interview  (1 session, 1800s, 30-day window)
//   Pro   = one 1-hour interview  (1 session, 3600s, 30-day window)
//   Max   = three 1-hour interviews (3 sessions, 10800s, 30-day window)
//   Ultra = 9 hours per BILLING CYCLE (32,400s; metered since 2026-08-22,
//           re-seeded by the paid-invoice / subscription.charged handlers;
//           lifecycle managed by customer.subscription.updated/.deleted).
//   Enterprise = unlimited, never expires (-1 sentinels; subscription).
function grantConfigForTier(tier) {
  const now = Date.now();
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
    // Flag-gated while older clients are in the field — see
    // ultraMeteringEnabled. Unset = the pre-2026-08 unlimited grant, which
    // is what an un-updated desktop client already believes it has.
    if (!ultraMeteringEnabled()) {
      return { tier: 'ultra', sessions_limit: -1, expires_at: -1, credits_remaining_seconds: -1, credits_expire_at: -1 };
    }
    // Metered monthly subscription. expires_at:-1 says the SUBSCRIPTION has
    // no end date — it is NOT a time sentinel (db.resolveTimeBucket must not
    // read it as unlimited for ultra). credits_expire_at:0 = no calendar
    // window; the next cycle replaces the balance. See payments.js.
    return { tier: 'ultra', sessions_limit: -1, expires_at: -1, credits_remaining_seconds: ULTRA_CYCLE_SECONDS, credits_expire_at: 0 };
  }
  // enterprise — monthly subscription, unlimited and never expiring.
  return { tier: 'enterprise', sessions_limit: -1, expires_at: -1, credits_remaining_seconds: -1, credits_expire_at: -1 };
}

// Reverse-lookup: given a Razorpay plan_id, return the tier it represents.
// Needed because /upgrade-tier swaps a subscription's plan_id but Razorpay
// has no API to update notes.tier — so subsequent subscription.charged
// webhooks would read stale notes and re-grant the old tier without this.
// Built lazily so missing env vars at import time don't crash the module.
function tierForRazorpayPlan(planId) {
  if (!planId) return null;
  // Ultra FIRST — it was missing entirely, so after an /upgrade-tier plan
  // swap to Ultra every subsequent subscription.charged fell back to the
  // stale creation-time notes.tier and re-granted the OLD tier while
  // billing the Ultra price.
  if (planId === process.env.RAZORPAY_PLAN_ID_ENTERPRISE) return 'enterprise';
  if (planId === process.env.RAZORPAY_PLAN_ID_ULTRA) return 'ultra';
  if (planId === process.env.RAZORPAY_PLAN_ID_MAX) return 'max';
  if (planId === process.env.RAZORPAY_PLAN_ID_PRO) return 'pro';
  if (planId === process.env.RAZORPAY_PLAN_ID) return 'pro'; // legacy alias
  return null;
}

// ── Credits policy for grant writes (2026-07, split 2026-08) ────────────
// One-time PURCHASES (checkout.session.completed non-renewal, Razorpay
// payment.captured non-renewal, /verify-razorpay tier grants) seed the full
// per-tier interview clock — a purchase starts a fresh plan window.
//
// Everything else splits into two rules, and the split is load-bearing money
// logic. Until 2026-08 there was one rule ("pass credits only for Ultra"),
// which was safe precisely BECAUSE Ultra's balance was the constant -1: you
// can write -1 on top of -1 as many times as Stripe cares to fire an event
// and nothing changes. The moment Ultra became a metered 9-hour allowance
// that stopped being true, and the old rule became a refill exploit:
// customer.subscription.updated fires on cancel AND on reactivate, so
//   burn 9 h → cancel → reactivate → 9 h again, repeat forever
// would have been a supported flow costing us nothing but our own money.
// Same for pause/resume, and for any metadata edit Stripe echoes back.
//
// So:
//   creditsForLifecycleGrant — for events that merely RE-AFFIRM a plan
//     (updated / resumed / reactivate / dispute-won). Passes credits ONLY
//     when the tier's balance is a constant sentinel, i.e. Enterprise's -1.
//     Metered tiers are left strictly alone: their balance is whatever the
//     user has actually spent down to. Legacy Pro/Max SUBSCRIBERS also carry
//     a migration-era -1 that must never be clobbered by the one-time config.
//   creditsForBillingCycle — for events that ARE a paid billing cycle
//     (Stripe invoice.payment_succeeded with billing_reason=subscription_cycle,
//     Razorpay subscription.charged). This is the ONLY thing that re-seeds a
//     metered subscription, which is exactly what "9 hours a month" means.
function creditsForLifecycleGrant(grant) {
  return grant.tier === 'enterprise'
    ? { credits_remaining_seconds: grant.credits_remaining_seconds, credits_expire_at: grant.credits_expire_at }
    : {};
}

function creditsForBillingCycle(grant) {
  return RECURRING_TIERS.includes(grant.tier)
    ? { credits_remaining_seconds: grant.credits_remaining_seconds, credits_expire_at: grant.credits_expire_at }
    : {};
}

// ─── Out-of-order delivery gate helper ───────────────────────────────
// Wraps gateAndRecordEventForUser with consistent logging. Stripe sends
// event.created in seconds; Razorpay sends body.created_at in seconds.
// The audit-traced bug: a subscription.updated arriving AFTER
// subscription.deleted resurrected canceled users (status flipped back
// to 'active'). Now any handler whose event is older than the latest
// already-applied event for that user short-circuits silently.
//
// Returns true if the handler should proceed, false if it should skip.
// The gate also UPDATES the per-user last_provider_event_at on accept,
// so subsequent stale events for the same user are blocked.
function gateOutOfOrder(userId, eventCreatedSec, eventLabel) {
  const result = db.gateAndRecordEventForUser(userId, eventCreatedSec);
  if (!result.accept) {
    console.log(
      `[WEBHOOK] Skipping out-of-order ${eventLabel} for user=${userId}: ` +
      `event.created=${result.eventCreatedSec} < lastSeen=${result.lastSeen}`
    );
    return false;
  }
  return true;
}

// ─── Stripe user resolution ──────────────────────────────────────────
// Customer-id lookup FIRST (fast, and correct for the overwhelming
// majority), then the payments ledger as a fallback.
//
// Why the fallback matters: `users.stripe_customer_id` stores exactly one
// id and it moves — the Razorpay grant paths stamp `rzp_…` over it, and
// users who signed up before the customer-reuse fix have several `cus_`
// ids from separate checkouts. When a refund or chargeback lands for a
// payment made under a customer id we no longer store, the old code
// logged "for unknown customer" and returned: money refunded, paid tier
// retained; chargeback filed, access never revoked. The ledger row for
// that exact payment still knows who paid, so we ask it.
//
// `hints` may carry any of: paymentIds[] (PaymentIntent / charge ids),
// subscriptionId.
function resolveStripeUser(customerId, hints = {}) {
  const d = db.getDB();
  if (customerId) {
    const byCustomer = d.prepare('SELECT * FROM users WHERE stripe_customer_id = ?').get(customerId);
    if (byCustomer) return byCustomer;
  }
  for (const pid of (hints.paymentIds || []).filter(Boolean)) {
    const byPayment = db.getUserByProviderPaymentId('stripe', pid);
    if (byPayment) {
      console.log('[WEBHOOK] Resolved user via payments ledger (customer id moved):', byPayment.email, 'payment:', pid);
      return byPayment;
    }
  }
  if (hints.subscriptionId) {
    const bySub = db.getUserByProviderSubscriptionId('stripe', hints.subscriptionId);
    if (bySub) {
      console.log('[WEBHOOK] Resolved user via subscription id (customer id moved):', bySub.email, 'sub:', hints.subscriptionId);
      return bySub;
    }
  }
  return null;
}

// ─── Did this Checkout Session actually collect the money? ────────────
// `checkout.session.completed` fires when the SESSION completes, which is
// NOT the same as "paid". Delayed-notification methods (SEPA Direct Debit,
// Bacs, ACSS, boleto, OXXO, konbini, Multibanco…) complete the session
// immediately with payment_status='unpaid' and settle days later — and
// /create-checkout deliberately omits payment_method_types so the Stripe
// Dashboard decides which of those are on. Granting on the unpaid session
// hands out a full pass (or an Ultra month) before any money moves, and
// if the payment later fails the settlement event is
// checkout.session.async_payment_failed — which nothing handled.
//
// So: grant only on a paid session, and let the async_* events drive the
// delayed case. 'no_payment_required' is a legitimately-paid state (100%
// discount / trial with no charge).
function sessionIsPaid(session) {
  return session?.payment_status === 'paid' || session?.payment_status === 'no_payment_required';
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  STRIPE WEBHOOK
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.post('/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Stripe not configured' });

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    // Without a secret we cannot verify the origin. Accepting unsigned
    // events would let anyone on the internet grant themselves Pro with
    // a crafted POST. Fail closed.
    console.error('[WEBHOOK] STRIPE_WEBHOOK_SECRET not set — refusing to process events');
    return res.status(503).json({ error: 'Stripe webhook not configured' });
  }

  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  // Surface a Dashboard/code version mismatch once per process. The compat
  // accessors below keep the handlers correct either way; this just stops
  // the drift from being invisible.
  warnOnApiVersionDrift(event);

  // Idempotency: Stripe retries on any non-2xx (and occasionally on 2xx
  // if the TCP ack is lost). Record event.id before running the handler;
  // if the handler throws we clear the row so the retry can reprocess.
  // Any duplicate delivery within the retention window short-circuits.
  if (!db.recordWebhookEventOnce(event.id, 'stripe', event.type)) {
    console.log('[WEBHOOK] Duplicate event skipped:', event.id, event.type);
    return res.json({ received: true, duplicate: true });
  }

  try {
    await handleStripeEvent(event);
    return res.json({ received: true });
  } catch (err) {
    console.error('[WEBHOOK] Handler threw for', event.type, event.id, '—', err && err.message);
    db.clearWebhookEvent(event.id);
    return res.status(500).json({ error: 'Handler failed' });
  }
});

async function handleStripeEvent(event) {
  switch (event.type) {
    // Both events mean "this Checkout Session's money is ours". The
    // difference is timing: `completed` fires the moment the session ends
    // (paid instantly for cards/wallets, UNPAID for delayed-notification
    // methods), while `async_payment_succeeded` is the settlement signal
    // for the delayed ones. The paid-check below is what keeps the two
    // apart — see sessionIsPaid().
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      const session = event.data.object;
      const email = session.customer_email || session.metadata?.user_email;
      // 'renewal' (legacy) and 'extension' (2026-07 one-click top-up) both
      // mean "+30 minutes on the existing pass" — grant the top-up instead
      // of resetting to a full tier. grantTimeExtension preserves the
      // buyer's tier (a Pro top-up must not relabel them Basic) and adds a
      // flat 30 minutes.
      const isRenewal = session.metadata?.mode === 'renewal'
        || session.metadata?.mode === 'extension';
      const tier = resolveTier(session.metadata?.tier);
      console.log('[WEBHOOK] Payment completed:', email, isRenewal ? '(renewal)' : `tier: ${tier || 'UNKNOWN'}`);

      if (!email) {
        console.error('[WEBHOOK] No email on checkout.session.completed:', session.id);
        return;
      }
      const user = db.getUserByEmail(email);
      if (!user) {
        console.error('[WEBHOOK] Unknown user for checkout session:', email, session.id);
        return;
      }
      // ── Money check BEFORE any grant ──
      // A completed-but-unpaid session is a delayed-notification payment
      // still in flight (SEPA/Bacs/boleto/OXXO/konbini…). Record it as
      // pending for the audit trail and wait for
      // checkout.session.async_payment_succeeded, which re-enters this
      // same case with the money actually collected. Do NOT advance the
      // out-of-order gate here — the settlement event that follows is
      // what must be allowed to grant.
      if (event.type === 'checkout.session.completed' && !sessionIsPaid(session)) {
        console.log('[WEBHOOK] Session completed but payment_status=' + session.payment_status
          + ' — deferring grant to async settlement:', session.id);
        try {
          db.recordPayment({
            user_id: user.id,
            email: user.email,
            provider: 'stripe',
            provider_payment_id: session.payment_intent || session.id,
            provider_subscription_id: session.subscription || null,
            amount: session.amount_total || 0,
            currency: (session.currency || 'usd').toUpperCase(),
            status: 'pending',
            tier_granted: null,
            metadata: {
              checkout_session_id: session.id,
              payment_status: session.payment_status,
              tier: tier || null,
              mode: isRenewal ? 'renewal' : 'tier',
              reason: 'awaiting_async_settlement',
            },
          });
        } catch (recErr) {
          console.warn('[WEBHOOK] could not record pending session row:', recErr.message);
        }
        return;
      }

      // Out-of-order gate — symmetric with the Razorpay payment.captured
      // handler. Without this, a stale checkout.session.completed retried
      // by Stripe after a customer.subscription.deleted would resurrect a
      // canceled customer's paid tier. (P0-S1 from the global audit.)
      if (!gateOutOfOrder(user.id, event.created, `stripe.${event.type}`)) return;

      // Every non-renewal checkout MUST carry a valid tier in metadata.
      // If neither flag is present, this is a config bug — record it as
      // failed and bail rather than fall through to a default. The old
      // default-to-'pro' behavior is how a Basic buyer could end up with
      // unlimited sessions forever.
      if (!isRenewal && !tier) {
        console.error('[WEBHOOK] checkout.session.completed with no resolvable tier:', session.id, 'meta:', session.metadata);
        db.recordPayment({
          user_id: user.id,
          email: user.email,
          provider: 'stripe',
          provider_payment_id: session.payment_intent || session.id,
          provider_subscription_id: session.subscription || null,
          amount: session.amount_total || 0,
          currency: (session.currency || 'usd').toUpperCase(),
          status: 'failed',
          tier_granted: null,
          metadata: { checkout_session_id: session.id, reason: 'no_tier_in_metadata' },
        });
        return;
      }

      // Atomicity: grant + record in one SQLite transaction. If any step
      // throws (disk full, constraint violation, locked DB), all writes
      // roll back. The outer route handler then clears the webhook_events
      // row so Stripe's retry reprocesses cleanly — without this, a retry
      // after a partial failure would double-apply grantBasicRenewal (an
      // additive +1/+1h) or leave the user with a paid tier but no
      // matching payment row.
      const sqlite = db.getDB();
      let grantedTier;
      let alreadyGranted = false;
      const paymentRef = session.payment_intent || session.id;
      const apply = sqlite.transaction(() => {
        // In-tx dedup — mirrors the Razorpay handlers. Two events can now
        // reach this grant for one session (`completed` when it was paid
        // instantly, `async_payment_succeeded` on the delayed path) and
        // /verify-stripe can beat both to it from the client. Without the
        // check the second writer trips the UNIQUE(provider,
        // provider_payment_id) WHERE status='completed' index, the handler
        // 500s, and Stripe retries it forever.
        const dup = sqlite.prepare(
          "SELECT id FROM payments WHERE provider = 'stripe' AND provider_payment_id = ? AND status = 'completed' LIMIT 1"
        ).get(paymentRef);
        if (dup) { alreadyGranted = true; return; }

        if (isRenewal) {
          const packSeconds = packSecondsFor(session.metadata?.pack);
          const updated = db.grantTimeExtension(user.id, packSeconds);
          grantedTier = (updated && updated.tier) || 'basic';
        } else {
          const grant = grantConfigForTier(tier);
          grantedTier = grant.tier;
          db.updateUserTier(user.id, grant.tier);
          db.updateLicenseOnPayment(user.id, {
            tier: grant.tier,
            status: 'active',
            // Basic/Pro/Max: now+30d one-time interview window. Ultra: -1 (unlimited,
            // Stripe-managed). Passing credits keeps the server row coherent with
            // the client ledger for the time-limited tiers.
            expires_at: grant.expires_at,
            sessions_limit: grant.sessions_limit,
            credits_remaining_seconds: grant.credits_remaining_seconds,
            credits_expire_at: grant.credits_expire_at,
            // A REAL purchase supersedes any earlier admin comp. Without this
            // the marker outlived the comp: a customer comped once, who later
            // paid for Ultra and then cancelled, kept Ultra for free forever —
            // customer.subscription.deleted was refused as "admin-granted".
            // The marker exists to protect a comp from an OLD subscription's
            // lifecycle, never to make a NEW paid plan irrevocable.
            admin_granted_at: 0,
          });
        }
        // Save Stripe customer ID (even on renewal — may be the first
        // time we see this customer if they renewed via a different
        // email / guest flow).
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
            settled_via: event.type,
          },
        });
      });
      apply();
      if (alreadyGranted) {
        console.log('[WEBHOOK] Checkout session already granted — skipping duplicate:', paymentRef);
        return;
      }
      console.log('[WEBHOOK]', isRenewal ? 'Renewal applied for:' : `User upgraded to ${grantedTier.toUpperCase()}:`, email);
      await notifyPurchaseReceipt({
        user,
        tier: grantedTier,
        isTopUp: isRenewal,
        amount: session.amount_total || 0,
        currency: (session.currency || 'usd').toUpperCase(),
      });
      return;
    }

    case 'checkout.session.async_payment_failed': {
      // The delayed-notification payment we deferred on
      // checkout.session.completed never settled (insufficient funds,
      // mandate revoked, voucher expired). Nothing was granted — the
      // paid-check above saw to that — so this is bookkeeping plus telling
      // the user, who otherwise waits for a pass that will never arrive.
      const session = event.data.object;
      const email = session.customer_email || session.metadata?.user_email;
      const user = email
        ? db.getUserByEmail(email)
        : resolveStripeUser(session.customer, { paymentIds: [session.payment_intent, session.id] });
      if (!user) {
        console.log('[WEBHOOK] async_payment_failed for unknown user:', session.id);
        return;
      }
      db.recordPayment({
        user_id: user.id,
        email: user.email,
        provider: 'stripe',
        provider_payment_id: session.payment_intent || session.id,
        provider_subscription_id: session.subscription || null,
        amount: session.amount_total || 0,
        currency: (session.currency || 'usd').toUpperCase(),
        status: 'failed',
        tier_granted: null,
        metadata: { checkout_session_id: session.id, reason: 'async_payment_failed' },
      });
      await notifyPaymentFailed({
        user,
        tier: resolveTier(session.metadata?.tier) || undefined,
        reason: 'Your bank did not complete the payment (this can happen with bank debits and voucher payments). Nothing was charged — you can try again with a card.',
      });
      console.log('[WEBHOOK] Async payment failed — no grant:', user.email, session.id);
      return;
    }

    case 'invoice.payment_succeeded': {
      // Recurring charge on an existing subscription. The tier is owned
      // by customer.subscription.updated — we only log the payment here
      // so it appears in billing history and lifetime revenue. Skip the
      // invoice that accompanies the very first charge (billing_reason
      // === 'subscription_create') because checkout.session.completed
      // already recorded that one. Recording it again would double-count.
      const invoice = event.data.object;
      if (invoice.billing_reason === 'subscription_create') return;

      const d = db.getDB();
      // Compat reads — these two ids are what tie a RENEWAL charge back to
      // a user. On a Basil+ endpoint the direct fields are undefined, so
      // every recurring payment row lost both, and a later refund or
      // chargeback on that renewal could not be resolved to an account.
      const invPaymentIntent = invoicePaymentIntentId(invoice);
      const invSubscription = invoiceSubscriptionId(invoice);
      const user = resolveStripeUser(invoice.customer, { paymentIds: [invPaymentIntent], subscriptionId: invSubscription });
      if (!user) {
        console.log('[WEBHOOK] invoice.payment_succeeded for unknown customer:', invoice.customer);
        return;
      }
      const license = db.getLicenseByUserId(user.id);
      db.recordPayment({
        user_id: user.id,
        email: user.email,
        provider: 'stripe',
        provider_payment_id: invPaymentIntent,
        provider_subscription_id: invSubscription,
        amount: invoice.amount_paid || 0,
        currency: (invoice.currency || 'usd').toUpperCase(),
        status: 'completed',
        tier_granted: license?.tier || null,
        metadata: {
          invoice_id: invoice.id,
          billing_reason: invoice.billing_reason,
          mode: 'subscription_cycle',
        },
      });
      // ── Monthly allowance re-seed (2026-08) ──────────────────────────
      // This handler used to ONLY record the payment: the tier is owned by
      // customer.subscription.updated, and back when the only subscription
      // was unlimited-Ultra there was no balance to reset. Now Ultra sells
      // 9 hours PER CYCLE, so the paid renewal invoice is the event that
      // has to put those 9 hours back — without this, an Ultra subscriber
      // burns their first month and is billed $159/month forever for a
      // plan that never refills.
      //
      // Deliberately scoped to the license's CURRENT tier rather than
      // anything on the invoice: whatever the subscription is actually on
      // right now is what got billed. Non-recurring tiers return {} from
      // creditsForBillingCycle and are untouched, so a stray invoice on a
      // legacy pass account can't reset a pass clock.
      if (license && RECURRING_TIERS.includes(license.tier)) {
        const grant = grantConfigForTier(license.tier);
        const cycleCredits = creditsForBillingCycle(grant);
        if (Object.keys(cycleCredits).length > 0) {
          db.updateLicenseOnPayment(user.id, {
            tier: license.tier,
            status: 'active',
            expires_at: grant.expires_at,
            sessions_limit: grant.sessions_limit,
            ...cycleCredits,
          });
          console.log('[WEBHOOK] Re-seeded', license.tier, 'cycle allowance for:', user.email,
            '→', cycleCredits.credits_remaining_seconds, 'seconds');
        }
      }
      console.log('[WEBHOOK] Recurring charge recorded for:', user.email, 'amount:', invoice.amount_paid);
      return;
    }

    case 'customer.subscription.updated': {
      const subscription = event.data.object;
      const customerId = subscription.customer;
      // Tier rides on subscription_data.metadata set at checkout creation.
      const subTier = resolveTier(subscription.metadata?.tier);

      const d = db.getDB();
      const user = resolveStripeUser(customerId, { subscriptionId: subscription.id });
      if (!user) return;
      // Out-of-order guard: a stale subscription.updated arriving AFTER
      // subscription.deleted (or after a more recent .updated) used to
      // resurrect canceled users.
      if (!gateOutOfOrder(user.id, event.created, 'customer.subscription.updated')) return;

      const currentLicense = db.getLicenseByUserId(user.id);
      // If the update event doesn't carry a tier (raw status flips
      // sometimes omit it), keep the user on whatever tier their license
      // currently shows. Never hard-code 'pro' here — that caused silent
      // Max → Pro downgrades on past_due transitions in the old code.
      const tier = subTier || resolveTier(currentLicense?.tier);
      if (!tier) {
        console.error('[WEBHOOK] subscription.updated: cannot resolve tier for', user.email, 'sub:', subscription.id);
        return;
      }
      const grant = grantConfigForTier(tier);

      const isActiveOrTrialing = ['active', 'trialing'].includes(subscription.status);
      const isCanceling = subscription.cancel_at_period_end;
      // current_period_end moved onto subscription ITEMS in 2025-03-31.basil.
      // Read straight off the object and a Basil+ endpoint yields 0 here on
      // EVERY cancel — which is exactly how a canceling license ends up with
      // no cycle-end date at all.
      const periodEndSec = subscriptionPeriodEnd(subscription);
      const periodEndMs = (periodEndSec || 0) * 1000;

      console.log('[WEBHOOK] Subscription updated:', customerId, 'tier:', tier, 'status:', subscription.status, 'cancel_at_period_end:', isCanceling);

      // Wrap each multi-step mutation in a SQLite transaction so that a
      // crash mid-handler (DB lock, disk full, constraint trip) leaves
      // the user's tier/license rows in a consistent state. Without this,
      // a partial failure could ship `users.tier='pro'` but `licenses.tier`
      // unchanged, and the next event would operate on inconsistent state.
      const sqlite = d;
      if (isActiveOrTrialing && isCanceling) {
        // Cancel-at-period-end: user clicked Cancel but cycle hasn't ended.
        // Status flips to 'canceling' so the client can render an explicit
        // "Cancellation scheduled — access until <date>" banner and offer a
        // Reactivate button. expires_at = current_period_end so the timer
        // is honest about when access actually ends.
        sqlite.transaction(() => {
          db.updateUserTier(user.id, grant.tier);
          db.updateLicenseOnPayment(user.id, {
            tier: grant.tier,
            status: 'canceling',
            // NOT `grant.expires_at` as the fallback: for Ultra that is the
            // -1 unlimited sentinel, and a canceling row at -1 is invisible
            // to the cycle-end sweeper AND to /validate's auto-transition —
            // the subscription would be canceled at Stripe and unlimited
            // here, forever. current_period_end is precisely the field that
            // moved off the Subscription object in 2025-03-31.basil, so an
            // account whose webhook endpoint runs a newer version hits this
            // on EVERY cancel, silently. See resolveCancelPeriodEnd.
            expires_at: resolveCancelPeriodEnd(periodEndMs, grant.expires_at),
            sessions_limit: grant.sessions_limit,
            ...creditsForLifecycleGrant(grant),
          });
        })();
      } else if (isActiveOrTrialing) {
        // Normal active sub — full grant. Also clears any prior 'canceling'
        // state (covers the case where the user cancels then reactivates
        // via the portal — Stripe flips cancel_at_period_end back to false
        // and we should reflect that locally).
        sqlite.transaction(() => {
          db.updateUserTier(user.id, grant.tier);
          db.updateLicenseOnPayment(user.id, {
            tier: grant.tier,
            status: 'active',
            expires_at: grant.expires_at,
            sessions_limit: grant.sessions_limit,
            // Ultra-only (-1 sentinel); legacy Pro/Max subs keep their
            // migration-era unlimited balance untouched on renewal ticks.
            ...creditsForLifecycleGrant(grant),
          });
        })();
      } else if (subscription.status === 'past_due') {
        // Grace period — Stripe's dunning will retry. Surface the past_due
        // status to the license so the in-app banner can render. The tier
        // stays the same so the user keeps access during retries (Stripe
        // dunning runs ~7 days). On retry success or canceled/unpaid we
        // exit past_due via the corresponding branches above. (P0-S2.)
        sqlite.transaction(() => {
          db.updateUserTier(user.id, grant.tier);
          db.updateLicenseOnPayment(user.id, {
            tier: grant.tier,
            status: 'past_due',
            expires_at: grant.expires_at,
            sessions_limit: grant.sessions_limit,
          });
        })();
        console.log('[WEBHOOK] Subscription past_due for:', user.email);
      } else if (subscription.status === 'paused') {
        // Stripe collection paused (manual pause via portal/API). Mirrors
        // Razorpay paused: keep the tier on the license so resume can
        // restore from the same row, but mark status='paused' so the
        // region/access gates deny while paused. customer.subscription.resumed
        // flips status back to 'active'. (P1-S6 — fixed asymmetry.)
        sqlite.transaction(() => {
          db.updateLicenseOnPayment(user.id, {
            tier: grant.tier,
            status: 'paused',
            expires_at: Date.now(),
            sessions_limit: grant.sessions_limit,
          });
        })();
        console.log('[WEBHOOK] Subscription paused for:', user.email, '— tier preserved as', grant.tier);
      } else if (['canceled', 'unpaid'].includes(subscription.status)) {
        sqlite.transaction(() => {
          db.updateUserTier(user.id, 'free');
          db.updateLicenseOnPayment(user.id, {
            tier: 'free',
            status: 'expired',
            expires_at: Date.now(),
            sessions_limit: 5,
          });
        })();
      } else if (subscription.status === 'incomplete_expired') {
        // First payment never succeeded; the subscription is dead.
        //
        // The old comment here asserted "never granted, no-op" — that was
        // only true if nothing granted off the Checkout Session, which is
        // exactly the assumption the payment_status gate now enforces. It
        // was NOT true before that gate, and it stops being true again the
        // moment any other path grants optimistically. So rather than
        // trust the invariant, verify it: if a completed row exists for
        // this subscription, we DID grant, and an expired-incomplete sub
        // means that money never arrived — revoke.
        const grantedRow = db.getUserByProviderSubscriptionId('stripe', subscription.id)
          ? d.prepare(`
              SELECT id, tier_granted FROM payments
              WHERE provider = 'stripe' AND provider_subscription_id = ? AND status = 'completed'
              ORDER BY created_at DESC LIMIT 1
            `).get(subscription.id)
          : null;
        if (grantedRow) {
          console.warn('[WEBHOOK] incomplete_expired but a completed grant exists for sub', subscription.id, '— revoking:', user.email);
          sqlite.transaction(() => {
            db.updateUserTier(user.id, 'free');
            db.updateLicenseOnPayment(user.id, {
              tier: 'free',
              status: 'expired',
              expires_at: Date.now(),
              sessions_limit: 5,
            });
            db.recordPayment({
              user_id: user.id,
              email: user.email,
              provider: 'stripe',
              provider_payment_id: null,
              provider_subscription_id: subscription.id,
              amount: 0,
              currency: 'USD',
              status: 'cancelled',
              tier_granted: 'free',
              metadata: { reason: 'incomplete_expired_after_grant', reversed_payment_id: grantedRow.id },
            });
          })();
        } else {
          console.log('[WEBHOOK] Subscription incomplete_expired for:', user.email, '— nothing was granted, no-op');
        }
      } else if (subscription.status === 'incomplete') {
        // Initial sub state, before first payment confirms. We don't grant
        // anything from this event (checkout.session.completed is the
        // grant trigger). Just log so we can correlate failed signups.
        console.log('[WEBHOOK] Subscription incomplete for:', user.email);
      }
      return;
    }

    case 'customer.subscription.paused': {
      // Dedicated event some Stripe configs send instead of (or alongside)
      // subscription.updated with status='paused'. Mirror the .updated
      // path: preserve the tier on the license so resume restores from
      // the same row without losing tier metadata. (P1-S6.)
      const subscription = event.data.object;
      const tier = resolveTier(subscription.metadata?.tier);
      const d = db.getDB();
      const user = resolveStripeUser(subscription.customer, { subscriptionId: subscription.id });
      if (!user) return;
      if (!gateOutOfOrder(user.id, event.created, 'customer.subscription.paused')) return;
      const license = db.getLicenseByUserId(user.id);
      if (!license) return;
      const preservedTier = tier || license.tier;
      const grant = grantConfigForTier(preservedTier);
      d.transaction(() => {
        db.updateLicenseOnPayment(user.id, {
          tier: preservedTier,
          status: 'paused',
          expires_at: Date.now(),
          sessions_limit: grant.sessions_limit,
        });
      })();
      console.log('[WEBHOOK] customer.subscription.paused for:', user.email, '— tier preserved as', preservedTier);
      return;
    }

    case 'customer.subscription.resumed': {
      // Counterpart to .paused — restore the tier the metadata says this
      // sub was for. Mirrors the active branch in subscription.updated.
      const subscription = event.data.object;
      const tier = resolveTier(subscription.metadata?.tier);
      const d = db.getDB();
      const user = resolveStripeUser(subscription.customer, { subscriptionId: subscription.id });
      if (!user || !tier) return;
      if (!gateOutOfOrder(user.id, event.created, 'customer.subscription.resumed')) return;
      const grant = grantConfigForTier(tier);
      d.transaction(() => {
        db.updateUserTier(user.id, grant.tier);
        db.updateLicenseOnPayment(user.id, {
          tier: grant.tier,
          status: 'active',
          expires_at: grant.expires_at,
          sessions_limit: grant.sessions_limit,
          ...creditsForLifecycleGrant(grant),
        });
      })();
      console.log('[WEBHOOK] customer.subscription.resumed for:', user.email, 'restored tier:', grant.tier);
      return;
    }

    case 'invoice.payment_action_required': {
      // 3DS / SCA challenge needed before Stripe can collect. The retry
      // window is short (Stripe typically gives a few hours). Notify the
      // user immediately so they can complete the challenge in time.
      const invoice = event.data.object;
      const d = db.getDB();
      const user = resolveStripeUser(invoice.customer, {
        paymentIds: [invoicePaymentIntentId(invoice)],
        subscriptionId: invoiceSubscriptionId(invoice),
      });
      if (!user) return;
      const license = db.getLicenseByUserId(user.id);
      await notifyPaymentFailed({
        user,
        tier: license?.tier,
        reason: 'Your card requires extra verification (3D Secure). Please open your billing portal and confirm the charge to keep your subscription active.',
      });
      console.log('[WEBHOOK] payment_action_required notified:', user.email);
      return;
    }

    case 'customer.subscription.deleted': {
      const subscription = event.data.object;
      const customerId = subscription.customer;
      console.log('[WEBHOOK] Subscription cancelled:', customerId);

      const d = db.getDB();
      const user = resolveStripeUser(customerId, { subscriptionId: subscription.id });
      if (!user) return;
      if (!gateOutOfOrder(user.id, event.created, 'customer.subscription.deleted')) return;
      d.transaction(() => {
        db.updateUserTier(user.id, 'free');
        db.updateLicenseOnPayment(user.id, {
          tier: 'free',
          status: 'expired',
          expires_at: Date.now(),
          sessions_limit: 5,
        });
        db.recordPayment({
          user_id: user.id,
          email: user.email,
          provider: 'stripe',
          provider_payment_id: null,
          provider_subscription_id: subscription.id,
          amount: 0,
          currency: 'USD',
          status: 'cancelled',
          tier_granted: 'free',
          metadata: { reason: 'subscription_deleted' },
        });
      })();
      // Report what ACTUALLY happened. The downgrade writes are refused for an
      // admin-granted plan (db.updateUserTier / db.updateLicenseOnPayment log
      // their own REFUSED line), and an operator reading "User downgraded to
      // free" for an account that is still on Ultra would be chasing a ghost.
      const afterCancel = db.getLicenseByUserId(user.id);
      if (afterCancel && afterCancel.tier !== 'free') {
        console.log('[WEBHOOK] subscription.deleted for', user.email,
          '— plan PRESERVED at', afterCancel.tier, '(admin-granted; not downgraded)');
      } else {
        console.log('[WEBHOOK] User downgraded to free:', user.email);
      }
      return;
    }

    case 'invoice.payment_failed': {
      const invoice = event.data.object;
      const customerId = invoice.customer;
      console.log('[WEBHOOK] Payment failed for:', customerId);

      const d = db.getDB();
      const failedPaymentIntent = invoicePaymentIntentId(invoice);
      const failedSubscription = invoiceSubscriptionId(invoice);
      const user = resolveStripeUser(customerId, { paymentIds: [failedPaymentIntent], subscriptionId: failedSubscription });
      if (!user) return;
      // Out-of-order gate, mirrors Razorpay payment.failed (P0-S1 / P0-S2).
      if (!gateOutOfOrder(user.id, event.created, 'stripe.invoice.payment_failed')) return;
      db.recordPayment({
        user_id: user.id,
        email: user.email,
        provider: 'stripe',
        provider_payment_id: failedPaymentIntent,
        provider_subscription_id: failedSubscription,
        amount: invoice.amount_due || 0,
        currency: (invoice.currency || 'usd').toUpperCase(),
        status: 'failed',
        tier_granted: null,
        metadata: { invoice_id: invoice.id },
      });
      // Flip license to past_due so the in-app dunning banner can fire.
      // Stripe will auto-retry over the dunning window; a successful
      // invoice.payment_succeeded or subscription.updated 'active' will
      // move us back to 'active'. Mirrors the Razorpay payment.failed
      // handler. (P0-S2 from the global audit.) Only flip if currently
      // active — never resurrect a canceling/expired/refunded sub.
      const license = db.getLicenseByUserId(user.id);
      if (license && license.status === 'active') {
        db.updateLicenseOnPayment(user.id, {
          tier: license.tier,
          status: 'past_due',
          expires_at: license.expires_at,
          sessions_limit: license.sessions_limit,
        });
      }
      // Best-effort notification — the user's card was declined and
      // Stripe will retry over the dunning window. Telling them now
      // gives them a chance to fix the card before the sub lapses.
      // Stripe doesn't always populate last_finalization_error on the
      // invoice. When it's absent we fall through to a generic message
      // — the email already explains the common causes.
      const reason = invoice.last_finalization_error?.message
        || invoice.last_payment_error?.message
        || null;
      await notifyPaymentFailed({ user, tier: license?.tier, reason });
      return;
    }

    case 'charge.refunded': {
      // A refund was issued. Full refund = revoke the paid tier and free
      // them. Partial refund = keep tier, record for bookkeeping.
      const charge = event.data.object;
      // amount_refunded is CUMULATIVE across every refund on the charge —
      // right for the full-refund decision, wrong for the row amount: on a
      // second partial refund it would re-book the first refund's money too.
      // charge.refunds.data is most-recent-first, so [0] is THIS refund.
      const refundAmount = charge.amount_refunded || 0;
      const fullRefund = charge.refunded === true && refundAmount >= charge.amount;
      // The provider refund id is the dedup key (see hasRefundBeenRecorded).
      // An admin-initiated refund already wrote a compensating row before
      // Stripe fired this event; without the guard we'd double-record.
      //
      // charge.refunds stopped being expanded by default in 2025-03-31.basil,
      // so on a Basil+ endpoint this key is simply absent and the dedup
      // silently degrades to "record it" — the admin row and the webhook row
      // both book the same refund and the ledger double-counts. latestRefundFor
      // falls back to a single refunds.list call only in that case.
      const latestRefund = await latestRefundFor(stripe, charge);
      const refundId = latestRefund?.id || null;
      const rowAmount = (typeof latestRefund?.amount === 'number') ? latestRefund.amount : refundAmount;

      const d = db.getDB();
      const user = resolveStripeUser(charge.customer, { paymentIds: [charge.payment_intent, charge.id] });
      if (!user) {
        console.log('[WEBHOOK] charge.refunded — could not map to a user by customer OR payment ledger:', charge.customer, charge.payment_intent || charge.id);
        return;
      }

      // Record the refund row only if no writer (admin console or a prior
      // delivery) already logged this refund id. The tier downgrade below
      // still runs either way — it's idempotent, and the admin path
      // deliberately does NOT downgrade, leaving that to this handler.
      if (!refundId || !db.hasRefundBeenRecorded('stripe', refundId)) {
        db.recordPayment({
          user_id: user.id,
          email: user.email,
          provider: 'stripe',
          provider_payment_id: charge.payment_intent || charge.id,
          provider_subscription_id: null,
          amount: -rowAmount, // THIS refund only, negative so revenue sums stay correct
          currency: (charge.currency || 'usd').toUpperCase(),
          status: 'refunded',
          tier_granted: null,
          metadata: {
            charge_id: charge.id,
            refund_id: refundId,       // dedup key — also stamped by recordAdminRefund
            original_amount: charge.amount,
            total_refunded: refundAmount, // cumulative, for support triage
            full_refund: fullRefund,
            reason: latestRefund?.reason || null,
          },
        });
      } else {
        console.log('[WEBHOOK] charge.refunded already recorded (admin/prior) — skipping duplicate row:', refundId);
      }

      // ── Is this a refund of a TIME TOP-UP rather than a plan purchase? ──
      // "Full refund" is measured against THIS charge, so refunding a $25
      // extension in full satisfied the condition and dropped the user to
      // free — destroying the $89 pass the top-up was added to. The buyer
      // loses a plan they still own because we handed back $25.
      //
      // The published policy says top-ups are never refundable
      // (services/refundEligibility.js), so this only fires via a Stripe
      // Dashboard refund or an admin override — i.e. precisely the
      // goodwill gesture where nuking the plan is the worst outcome.
      // Record the money, leave the plan alone.
      //
      // The granted minutes are deliberately NOT clawed back: the seconds
      // may be mid-interview, and a clamped subtraction could just as
      // easily eat time from a DIFFERENT pass bought since. An operator
      // who wants them removed can adjust from the admin console.
      const originalRow = db.getCompletedPaymentByProviderId('stripe', charge.payment_intent || charge.id);
      const wasTopUp = db.isTopUpPayment(originalRow);

      if (fullRefund && wasTopUp) {
        console.log('[WEBHOOK] Full refund of a TIME TOP-UP — recording only, plan left intact for:', user.email);
        return;
      }

      if (fullRefund) {
        if (!gateOutOfOrder(user.id, event.created, 'charge.refunded.full')) return;
        d.transaction(() => {
          db.updateUserTier(user.id, 'free');
          db.updateLicenseOnPayment(user.id, {
            tier: 'free',
            status: 'refunded',
            expires_at: Date.now(),
            sessions_limit: 5,
          });
        })();
        console.log('[WEBHOOK] Full refund — user downgraded to free:', user.email);
      } else {
        console.log('[WEBHOOK] Partial refund recorded for:', user.email, 'amount:', refundAmount);
      }
      return;
    }

    case 'charge.dispute.created': {
      // Customer filed a chargeback. Stripe debits the charge back +
      // a dispute fee. Revoke the paid tier immediately — leaving them
      // on Pro while the dispute resolves is how fraudsters get free
      // service. Admin can follow up from the payments audit log.
      const dispute = event.data.object;
      const d = db.getDB();
      // The dispute object itself doesn't always carry customer. Resolve
      // via the charge when needed.
      let user = resolveStripeUser(dispute.customer, { paymentIds: [dispute.charge, dispute.payment_intent] });
      if (!user && dispute.charge && stripe) {
        try {
          const charge = await stripe.charges.retrieve(dispute.charge);
          if (charge) {
            user = resolveStripeUser(charge.customer, { paymentIds: [charge.payment_intent, charge.id] });
          }
        } catch (err) {
          console.error('[WEBHOOK] dispute.created: could not resolve charge', dispute.charge, err.message);
        }
      }
      if (!user) {
        console.log('[WEBHOOK] charge.dispute.created — could not map to user:', dispute.id);
        return;
      }
      if (!gateOutOfOrder(user.id, event.created, 'charge.dispute.created')) return;
      d.transaction(() => {
        db.recordPayment({
          user_id: user.id,
          email: user.email,
          provider: 'stripe',
          provider_payment_id: dispute.charge,
          provider_subscription_id: null,
          amount: -(dispute.amount || 0),
          currency: (dispute.currency || 'usd').toUpperCase(),
          status: 'disputed',
          tier_granted: null,
          metadata: {
            dispute_id: dispute.id,
            reason: dispute.reason,
            status: dispute.status,
          },
        });
        db.updateUserTier(user.id, 'free');
        db.updateLicenseOnPayment(user.id, {
          tier: 'free',
          status: 'disputed',
          expires_at: Date.now(),
          sessions_limit: 5,
        });
      })();
      console.log('[WEBHOOK] Dispute — user downgraded to free:', user.email, 'reason:', dispute.reason);
      return;
    }

    case 'charge.dispute.closed': {
      // Dispute resolved. If WE won (status='won'), the user filed
      // illegitimately — keep them on free, no restoration. If we LOST
      // ('lost'), we already revoked in .created, no extra action.
      // If status='warning_closed' or the merchant accepted the dispute,
      // also no restoration needed. The interesting case is when a
      // dispute is REVERSED in our favor after we'd already revoked —
      // that's still 'won', and we restore the user's tier so they don't
      // lose access from a malicious chargeback that they later withdrew.
      const dispute = event.data.object;
      if (dispute.status !== 'won') {
        console.log('[WEBHOOK] charge.dispute.closed not won — no action:', dispute.id, dispute.status);
        return;
      }
      const d = db.getDB();
      let user = resolveStripeUser(dispute.customer, { paymentIds: [dispute.charge, dispute.payment_intent] });
      if (!user && dispute.charge && stripe) {
        try {
          const charge = await stripe.charges.retrieve(dispute.charge);
          if (charge) {
            user = resolveStripeUser(charge.customer, { paymentIds: [charge.payment_intent, charge.id] });
          }
        } catch (err) {
          console.error('[WEBHOOK] dispute.closed: could not resolve charge', dispute.charge, err.message);
        }
      }
      if (!user) return;
      if (!gateOutOfOrder(user.id, event.created, 'charge.dispute.closed')) return;
      // Restore the tier from the user's most recent paid subscription
      // OR Basic one-time purchase. Pre-2026-05 we only checked active
      // subs — Basic dispute-won users got no restoration even though
      // their one-time payment was legitimate. (P1-S3 from the audit.)
      let restoredTier = null;
      try {
        const subs = await stripe.subscriptions.list({ customer: dispute.customer || user.stripe_customer_id, status: 'active', limit: 1 });
        if (subs.data.length > 0) {
          restoredTier = resolveTier(subs.data[0].metadata?.tier);
        }
      } catch (err) {
        console.error('[WEBHOOK] dispute.closed: could not list subs:', err.message);
      }
      // Fallback: if no active sub, check for a recent legitimate payment
      // (Basic one-time, or a sub that's since canceled). The dispute
      // window is short — typically the disputed charge is the most
      // recent completed Stripe payment on this user. We guard against
      // restoring from the disputed payment itself by skipping rows where
      // status='disputed' (already recorded by .created).
      if (!restoredTier) {
        const recentPay = d.prepare(`
          SELECT tier_granted FROM payments
          WHERE user_id = ? AND provider = 'stripe' AND status = 'completed'
            AND tier_granted IS NOT NULL AND tier_granted != 'free'
          ORDER BY created_at DESC LIMIT 1
        `).get(user.id);
        if (recentPay) restoredTier = resolveTier(recentPay.tier_granted);
      }
      if (!restoredTier) {
        console.log('[WEBHOOK] dispute.closed won but no active sub or recent payment to restore for:', user.email);
        return;
      }
      const grant = grantConfigForTier(restoredTier);
      d.transaction(() => {
        db.updateUserTier(user.id, grant.tier);
        db.updateLicenseOnPayment(user.id, {
          tier: grant.tier,
          status: 'active',
          expires_at: grant.expires_at,
          sessions_limit: grant.sessions_limit,
          // Full re-seed: the dispute revocation zeroed the license, so the
          // restore must bring the interview clock back too (one-time tiers
          // get a fresh window; Ultra gets its -1 sentinel).
          credits_remaining_seconds: grant.credits_remaining_seconds,
          credits_expire_at: grant.credits_expire_at,
        });
      })();
      console.log('[WEBHOOK] Dispute won — restored tier for:', user.email, 'tier:', restoredTier);
      return;
    }

    case 'payment_intent.payment_failed':
    case 'charge.failed': {
      // Failure of a one-time charge — Basic purchase or renewal top-up.
      // Distinct from invoice.payment_failed which fires for subscription
      // invoices. Without this handler, failed one-time checkouts produce
      // no DB row, no email, no admin signal. (P1-S5 from the audit.)
      const obj = event.data.object;
      const customerId = obj.customer;
      // Anonymous / guest checkouts (no customer attached) — no user to
      // notify. Just log and bail.
      if (!customerId) {
        console.log('[WEBHOOK]', event.type, 'with no customer:', obj.id);
        return;
      }
      const d = db.getDB();
      const user = resolveStripeUser(customerId, { paymentIds: [obj.id, obj.payment_intent] });
      if (!user) {
        console.log('[WEBHOOK]', event.type, 'for unknown customer:', customerId);
        return;
      }
      if (!gateOutOfOrder(user.id, event.created, `stripe.${event.type}`)) return;
      // Stripe fires BOTH payment_intent.payment_failed and charge.failed
      // for a single declined card, and both land here — two identical
      // "your payment failed" rows and two emails for one decline. Key
      // both on the PaymentIntent (a charge carries its parent's id) so
      // the second delivery is recognised as the same failure. A genuine
      // retry creates a new PaymentIntent and still records.
      const failureRef = (obj.object === 'charge' && obj.payment_intent) ? obj.payment_intent : obj.id;
      if (db.hasFailedPaymentRecorded(user.id, failureRef)) {
        console.log('[WEBHOOK]', event.type, '— failure already recorded for', failureRef, '(same decline, other event type)');
        return;
      }
      db.recordPayment({
        user_id: user.id,
        email: user.email,
        provider: 'stripe',
        provider_payment_id: failureRef,
        provider_subscription_id: null,  // one-time, no sub
        amount: obj.amount || 0,
        currency: (obj.currency || 'usd').toUpperCase(),
        status: 'failed',
        tier_granted: null,
        metadata: {
          event: event.type,
          error_code: obj.last_payment_error?.code || obj.failure_code,
          error_message: obj.last_payment_error?.message || obj.failure_message,
        },
      });
      // Notify the user — for renewals they need to know to retry, and
      // for Basic checkouts the charge attempt failed.
      const license = db.getLicenseByUserId(user.id);
      await notifyPaymentFailed({
        user,
        tier: license?.tier,
        reason: obj.last_payment_error?.message || obj.failure_message || null,
      });
      console.log('[WEBHOOK] One-time payment failed for:', user.email, 'event:', event.type);
      return;
    }

    default:
      console.log('[WEBHOOK] Unhandled:', event.type);
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  RAZORPAY WEBHOOK
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.post('/razorpay', express.raw({ type: 'application/json' }), async (req, res) => {
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!webhookSecret) return res.status(503).json({ error: 'Razorpay webhooks not configured' });

  // CRITICAL: verify the signature on the RAW bytes Razorpay signed, not
  // a re-serialized JSON string. Any whitespace, unicode escaping, or key
  // ordering difference between their JSON and JSON.stringify(req.body)
  // yields a different HMAC and the legitimate webhook is rejected. Using
  // express.raw + Buffer keeps the bytes intact.
  const signature = req.headers['x-razorpay-signature'];
  const rawBody = req.body;
  if (!signature || !Buffer.isBuffer(rawBody)) {
    return res.status(400).json({ error: 'Missing signature or body' });
  }
  const expected = crypto.createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
  const sigBuf = Buffer.from(signature, 'hex');
  const expBuf = Buffer.from(expected, 'hex');
  // timingSafeEqual throws on length mismatch — guard first so a crafted
  // short signature returns 400, not 500.
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    console.error('[RZP WEBHOOK] Invalid signature');
    return res.status(400).json({ error: 'Invalid signature' });
  }

  let body;
  try {
    body = JSON.parse(rawBody.toString('utf8'));
  } catch (err) {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  // Razorpay sends x-razorpay-event-id on modern accounts. When absent
  // (older merchant accounts), derive a stable synthetic id from the
  // payload so retries of the same event still collide in the dedup
  // table.
  //
  // BUG FIX (Task #26): the previous synthetic id included `body.created_at`,
  // but Razorpay's docs say `created_at` changes per retry on older
  // accounts — meaning the same business event produced a DIFFERENT
  // synthetic id on each retry, completely defeating dedup. Drop
  // created_at from the tuple. The remaining (event + entity_id) tuple is
  // stable across retries: an `payment.captured` event for `pay_xxx` always
  // has the same payment.id, and Razorpay never emits two distinct
  // payment.captured events for the same payment.
  const headerEventId = req.headers['x-razorpay-event-id'];
  const payment = body.payload?.payment?.entity;
  const subscription = body.payload?.subscription?.entity;
  const refund = body.payload?.refund?.entity;
  const syntheticId = `${body.event || 'unknown'}:${payment?.id || subscription?.id || refund?.id || 'no-id'}`;
  const eventId = headerEventId || syntheticId;

  // Refuse the dead-id sentinel — if both body.event AND every entity id
  // are missing, the synthetic id collapses to "unknown:no-id" and would
  // collide across all such events, silently dropping any future malformed
  // events as "duplicates" of the first one we ever saw. Without this
  // guard a single bad payload would poison the dedup table forever.
  // (P0-C from the audit.)
  if (!headerEventId && eventId === 'unknown:no-id') {
    console.error('[RZP WEBHOOK] Refusing event with no x-razorpay-event-id header AND no entity id in payload');
    return res.status(400).json({ error: 'Missing event id and no entity to derive one from' });
  }

  if (!db.recordWebhookEventOnce(eventId, 'razorpay', body.event)) {
    console.log('[RZP WEBHOOK] Duplicate event skipped:', eventId, body.event);
    return res.json({ received: true, duplicate: true });
  }

  try {
    await handleRazorpayEvent(body);
    return res.json({ received: true });
  } catch (err) {
    console.error('[RZP WEBHOOK] Handler threw for', body.event, eventId, '—', err && err.message);
    db.clearWebhookEvent(eventId);
    return res.status(500).json({ error: 'Handler failed' });
  }
});

async function handleRazorpayEvent(body) {
  const event = body.event;
  const payload = body.payload;

  switch (event) {
    case 'subscription.charged': {
      const subscription = payload.subscription?.entity;
      const payment = payload.payment?.entity;
      const email = subscription?.notes?.user_email || payment?.notes?.user_email;
      // plan_id is the source of truth for what this subscription is
      // currently billing for. notes.tier is a snapshot from CREATION
      // time and goes stale after /upgrade-tier swaps the plan. Prefer
      // plan_id; fall back to notes only if the env-based mapping fails
      // (e.g. legacy subs created before plan IDs were configured).
      const planTier = tierForRazorpayPlan(subscription?.plan_id);
      const tier = resolveTier(planTier || subscription?.notes?.tier || payment?.notes?.tier);
      console.log('[RZP WEBHOOK] Subscription charged:', email, 'tier:', tier, planTier ? '(from plan_id)' : '(from notes)');

      if (!email) {
        console.error('[RZP WEBHOOK] subscription.charged: no email on payload');
        return;
      }
      if (!tier) {
        console.error('[RZP WEBHOOK] subscription.charged: unresolvable tier for sub', subscription?.id);
        return;
      }
      const user = db.getUserByEmail(email);
      if (!user) return;
      if (!gateOutOfOrder(user.id, body.created_at, 'rzp.subscription.charged')) return;

      // First-charge race with /verify-razorpay: both this event AND the
      // client's success callback can record the same payment.id. Without
      // a dedup guard here, the second one throws on the UNIQUE
      // (provider, provider_payment_id) index — handler returns 500 →
      // Razorpay retries → loops. Mirrors the pattern in payment.captured.
      // (P1-F from the audit.)
      if (payment?.id && db.isPaymentAlreadyRecorded(user.id, payment.id)) {
        console.log('[RZP WEBHOOK] subscription.charged: payment already recorded — skipping:', payment.id);
        return;
      }

      const grant = grantConfigForTier(tier);
      const d = db.getDB();
      let alreadyGranted = false;
      d.transaction(() => {
        // In-tx re-check — closes the small window between the pre-check
        // above and the writes here. Same pattern as payment.captured.
        if (payment?.id) {
          const dup = d.prepare(
            "SELECT id FROM payments WHERE user_id = ? AND provider = 'razorpay' AND provider_payment_id = ? AND status = 'completed' LIMIT 1"
          ).get(user.id, payment.id);
          if (dup) { alreadyGranted = true; return; }
        }
        db.updateUserTier(user.id, grant.tier);
        db.updateLicenseOnPayment(user.id, {
          tier: grant.tier,
          status: 'active',
          expires_at: grant.expires_at,
          sessions_limit: grant.sessions_limit,
          // A CHARGE is a billing cycle (see creditsForBillingCycle): the
          // first charge of a sub must land its allowance or the subscriber
          // has a tier and 0 seconds, and every later charge is the monthly
          // re-seed that makes "9 hours a month" mean anything.
          ...creditsForBillingCycle(grant),
        });
        // Legacy: prefix-marker in stripe_customer_id for provider detection
        // (still used by reads that haven't migrated to razorpay_subscription_id).
        // Prefer subscription.id (stable across renewals) over payment.id
        // (rolling per-payment) to reduce churn.
        // setPaymentProviderMarker refuses to overwrite a live `cus_…` — see
        // database.js for why that clobber breaks saved cards, /portal and
        // provider detection the moment India routes back to Razorpay.
        db.setPaymentProviderMarker(user.id, `rzp_${subscription?.id || payment?.id}`);
        // New column: dedicated Razorpay subscription pointer, set once.
        if (subscription?.id) db.setRazorpaySubscriptionId(user.id, subscription.id);
        db.recordPayment({
          user_id: user.id,
          email: user.email,
          provider: 'razorpay',
          provider_payment_id: payment?.id,
          provider_subscription_id: subscription?.id,
          amount: payment?.amount || 0,
          currency: payment?.currency?.toUpperCase() || 'INR',
          status: 'completed',
          tier_granted: grant.tier,
          metadata: { event: 'subscription.charged', tier: grant.tier },
        });
      })();
      if (alreadyGranted) {
        console.log('[RZP WEBHOOK] subscription.charged: payment already recorded inside tx — /verify-razorpay won the race:', payment?.id);
      } else {
        console.log('[RZP WEBHOOK] User upgraded to', grant.tier.toUpperCase(), ':', email);
      }
      return;
    }

    case 'subscription.cancelled':
    case 'subscription.halted': {
      const subscription = payload.subscription?.entity;
      const email = subscription?.notes?.user_email;
      console.log('[RZP WEBHOOK] Subscription cancelled/halted:', email);

      if (!email) return;
      const user = db.getUserByEmail(email);
      if (!user) return;
      if (!gateOutOfOrder(user.id, body.created_at, `rzp.${event}`)) return;
      // Capture the prior tier BEFORE we wipe the license so the
      // notification email can name the plan that just lapsed.
      const priorLicense = db.getLicenseByUserId(user.id);
      const priorTier = priorLicense?.tier || subscription?.notes?.tier;
      const d = db.getDB();
      d.transaction(() => {
        db.updateUserTier(user.id, 'free');
        db.updateLicenseOnPayment(user.id, {
          tier: 'free',
          status: 'expired',
          expires_at: Date.now(),
          sessions_limit: 5,
        });
        db.recordPayment({
          user_id: user.id,
          email: user.email,
          provider: 'razorpay',
          provider_payment_id: null,
          provider_subscription_id: subscription?.id,
          amount: 0,
          currency: 'INR',
          status: 'cancelled',
          tier_granted: 'free',
          metadata: { event, reason: event },
        });
      })();
      console.log('[RZP WEBHOOK] User downgraded to free:', email);

      // Razorpay halts a subscription only after several failed
      // recovery attempts — by this point the user almost certainly
      // doesn't know their card stopped working. Send a one-shot
      // notice on `halted`. We deliberately skip notifying on
      // user-initiated `cancelled` since they took the action
      // themselves and got UI confirmation already.
      if (event === 'subscription.halted') {
        await notifyPaymentFailed({
          user,
          tier: priorTier,
          reason: 'Repeated payment failures — the subscription has been halted by the bank/card network.',
        });
      }
      return;
    }

    case 'payment.captured': {
      const payment = payload.payment?.entity;
      const email = payment?.notes?.user_email;
      const rawTier = payment?.notes?.tier;
      // 'renewal' (legacy) and 'extension' (2026-07 one-click top-up)
      // both mean "+30 minutes on the existing pass" (grantTimeExtension
      // preserves the tier and adds a flat 30 minutes) rather than a fresh
      // tier grant. Either flow requires a known tier stamped at order
      // creation — that blocks stray payment.captured events for
      // unrelated orders.
      const isRenewal = payment?.notes?.mode === 'renewal'
        || payment?.notes?.mode === 'extension';
      console.log('[RZP WEBHOOK] Payment captured:', email, isRenewal ? '(renewal)' : `tier: ${rawTier}`);

      if (!email) return;
      if (!isRenewal && !VALID_TIERS.includes(rawTier)) {
        console.error('[RZP WEBHOOK] payment.captured without tier or renewal flag:', payment?.id);
        return;
      }
      const user = db.getUserByEmail(email);
      if (!user) return;
      // Out-of-order gate — without this, a stale payment.captured (Razorpay
      // retries up to 24h on 5xx) arriving AFTER subscription.cancelled
      // would re-grant Pro/Max to a canceled customer. Every other Razorpay
      // mutating handler runs this check; payment.captured was the
      // exception. (P0-B from the audit.)
      if (!gateOutOfOrder(user.id, body.created_at, 'rzp.payment.captured')) return;

      // Race with /verify-razorpay: both this webhook and the client's
      // success callback record a completed payment AND grant the same
      // tier/renewal on the same razorpay_payment_id. The pre-tx check
      // here is a fast-path — most duplicates are caught and we return
      // early without touching the DB. The IN-tx re-check below is the
      // correctness guarantee — it sees writes the pre-check missed
      // because of the await between /verify's signature verify and its
      // grant transaction. The UNIQUE index on (provider, provider_payment_id)
      // is the final DB-layer backstop.
      if (db.isPaymentAlreadyRecorded(user.id, payment.id)) {
        console.log('[RZP WEBHOOK] Payment already recorded by /verify-razorpay — skipping:', payment.id);
        return;
      }

      // Atomicity: same reasoning as the Stripe handler — grant + record
      // wrapped in a SQLite transaction so a partial failure rolls back
      // cleanly and the webhook retry processes the event exactly once.
      const sqlite = db.getDB();
      let grantedTier;
      let alreadyGranted = false;
      const apply = sqlite.transaction(() => {
        // In-tx re-check, see comment above the pre-tx check.
        const dup = sqlite.prepare(
          "SELECT id FROM payments WHERE user_id = ? AND provider = 'razorpay' AND provider_payment_id = ? AND status = 'completed' LIMIT 1"
        ).get(user.id, payment.id);
        if (dup) { alreadyGranted = true; return; }

        if (isRenewal) {
          const packSeconds = packSecondsFor(payment?.notes?.pack);
          const updated = db.grantTimeExtension(user.id, packSeconds);
          grantedTier = (updated && updated.tier) || 'basic';
        } else {
          const grant = grantConfigForTier(rawTier);
          grantedTier = grant.tier;
          db.updateUserTier(user.id, grant.tier);
          db.updateLicenseOnPayment(user.id, {
            tier: grant.tier,
            status: 'active',
            expires_at: grant.expires_at,
            sessions_limit: grant.sessions_limit,
            // One-time purchase → seed the full interview clock. Omitting
            // these left every Razorpay buyer with a tier but 0 seconds:
            // paid, yet every usage/model gate said "time used up".
            credits_remaining_seconds: grant.credits_remaining_seconds,
            credits_expire_at: grant.credits_expire_at,
            admin_granted_at: 0, // a real purchase supersedes any earlier admin comp
          });
        }
        // Never clobbers an existing Stripe `cus_…` marker — see
        // database.js setPaymentProviderMarker.
        db.setPaymentProviderMarker(user.id, `rzp_${payment.id}`);
        db.recordPayment({
          user_id: user.id,
          email: user.email,
          provider: 'razorpay',
          provider_payment_id: payment.id,
          provider_subscription_id: null,
          amount: payment.amount || 0,
          currency: (payment.currency || 'inr').toUpperCase(),
          status: 'completed',
          tier_granted: grantedTier,
          metadata: {
            event: 'payment.captured',
            order_id: payment.order_id,
            tier: grantedTier,
            mode: isRenewal ? 'renewal' : 'tier',
          },
        });
      });
      apply();
      if (alreadyGranted) {
        console.log('[RZP WEBHOOK] Payment already recorded inside tx — /verify-razorpay won the race:', payment.id);
      } else {
        console.log('[RZP WEBHOOK]', isRenewal ? 'Renewal applied for:' : `User upgraded to ${grantedTier.toUpperCase()}:`, email);
      }
      return;
    }

    case 'payment.failed': {
      const payment = payload.payment?.entity;
      const email = payment?.notes?.user_email;
      console.log('[RZP WEBHOOK] Payment failed:', email);

      if (!email) return;
      const user = db.getUserByEmail(email);
      if (!user) return;
      // Out-of-order gate matches the other mutating handlers (P0-B).
      // payment.failed is bookkeeping + notification, but a stale failed
      // event arriving after a successful retry would still send a
      // misleading "your payment failed" email.
      if (!gateOutOfOrder(user.id, body.created_at, 'rzp.payment.failed')) return;
      db.recordPayment({
        user_id: user.id,
        email: user.email,
        provider: 'razorpay',
        provider_payment_id: payment?.id,
        provider_subscription_id: null,
        amount: payment?.amount || 0,
        currency: (payment?.currency || 'inr').toUpperCase(),
        status: 'failed',
        tier_granted: null,
        metadata: { event: 'payment.failed', error_code: payment?.error_code },
      });
      // Flip license to past_due so the in-app banner fires before the
      // user sees a halt. Razorpay will retry the charge automatically;
      // a successful subscription.charged or payment.captured will move
      // us back to 'active'. (P1-D from the audit.)
      const license = db.getLicenseByUserId(user.id);
      if (license && license.status === 'active') {
        db.updateLicenseOnPayment(user.id, {
          tier: license.tier,
          status: 'past_due',
          expires_at: license.expires_at,
          sessions_limit: license.sessions_limit,
        });
      }
      // Razorpay's error_description is the user-friendly string
      // (e.g. "Your card was declined by the bank"). error_code is a
      // machine token like BAD_REQUEST_ERROR — not useful in an email.
      const reason = payment?.error_description || null;
      await notifyPaymentFailed({
        user,
        tier: license?.tier || payment?.notes?.tier,
        reason,
      });
      return;
    }

    case 'refund.created':
    case 'refund.processed': {
      // Razorpay fires refund.created when initiated and refund.processed
      // when funds move — TWO events for one refund, and (on older accounts)
      // with distinct synthetic event ids, so the webhook-event dedup lets
      // both through. Plus an admin-console refund already wrote a
      // compensating row. Dedup on the refund id (hasRefundBeenRecorded)
      // so exactly one refunded row exists per refund; the downgrade stays
      // idempotent and runs regardless.
      const refund = payload.refund?.entity;
      const paymentEntity = payload.payment?.entity;
      const paymentId = refund?.payment_id || paymentEntity?.id;
      if (!paymentId) {
        console.error('[RZP WEBHOOK] refund event without payment id');
        return;
      }
      // Look up the original payment row to find the user and the amount
      // originally charged (for partial vs full classification).
      const d = db.getDB();
      const priorPayment = d.prepare(
        'SELECT * FROM payments WHERE provider = ? AND provider_payment_id = ? AND status = ? ORDER BY created_at DESC LIMIT 1'
      ).get('razorpay', paymentId, 'completed');
      if (!priorPayment) {
        console.log('[RZP WEBHOOK] Refund for unknown payment:', paymentId);
        return;
      }
      const user = db.getUserById(priorPayment.user_id);
      if (!user) return;
      if (!gateOutOfOrder(user.id, body.created_at, `rzp.${event}`)) return;
      const refundAmount = refund?.amount || 0;
      const alreadyRecorded = refund?.id && db.hasRefundBeenRecorded('razorpay', refund.id);
      // Full-refund detection must be CUMULATIVE across partial refunds —
      // Razorpay events carry only this refund's amount (unlike Stripe's
      // charge.amount_refunded), so two 50% partials would each read
      // "partial" and the fully-refunded user would keep their paid tier
      // forever. Sum the refund rows already booked for this payment and
      // add the current one (unless it's the same refund id we already
      // recorded, in which case it's inside the sum).
      const priorRefundedPaise = d.prepare(`
        SELECT COALESCE(SUM(-amount), 0) AS s FROM payments
        WHERE provider = 'razorpay' AND provider_payment_id = ?
          AND status IN ('refunded', 'partially_refunded') AND amount < 0
      `).get(paymentId).s;
      const cumulativeRefunded = priorRefundedPaise + (alreadyRecorded ? 0 : refundAmount);
      // Accounting truth — the row's metadata must still say "this payment
      // was fully refunded" even when we choose not to touch the plan.
      const fullRefund = cumulativeRefunded >= priorPayment.amount;
      // Same top-up carve-out as the Stripe path: refunding a ₹2,099
      // extension in full must not revoke the ₹7,399 pass it topped up.
      // Entitlement decision only — never the bookkeeping.
      const wasTopUp = db.isTopUpPayment(priorPayment);
      const revokeTier = fullRefund && !wasTopUp;
      d.transaction(() => {
        if (!alreadyRecorded) {
          db.recordPayment({
            user_id: user.id,
            email: user.email,
            provider: 'razorpay',
            provider_payment_id: paymentId,
            provider_subscription_id: priorPayment.provider_subscription_id,
            amount: -refundAmount,
            currency: (refund?.currency || priorPayment.currency || 'INR').toUpperCase(),
            status: 'refunded',
            tier_granted: null,
            metadata: {
              refund_id: refund?.id,
              event,
              full_refund: fullRefund,
              cumulative_refunded: cumulativeRefunded, // paise, across all partials
              original_payment_id: paymentId,
            },
          });
        }
        if (revokeTier) {
          db.updateUserTier(user.id, 'free');
          db.updateLicenseOnPayment(user.id, {
            tier: 'free',
            status: 'refunded',
            expires_at: Date.now(),
            sessions_limit: 5,
          });
        }
      })();
      if (revokeTier) {
        console.log('[RZP WEBHOOK] Full refund — user downgraded to free:', user.email);
      } else if (fullRefund && wasTopUp) {
        console.log('[RZP WEBHOOK] Full refund of a TIME TOP-UP — recording only, plan left intact for:', user.email);
      } else {
        console.log('[RZP WEBHOOK] Partial refund recorded for:', user.email, 'amount:', refundAmount);
      }
      return;
    }

    case 'subscription.completed': {
      // Razorpay fires this when a subscription naturally completes its
      // total_count of cycles (creation now uses total_count: 120 ≈ 10
      // years; legacy subs created with 12 complete after a year). The
      // subscription enters status='completed' on
      // Razorpay's side; our license must mirror that or the user keeps
      // Pro/Max for free indefinitely. (P1-B from the audit.)
      const subscription = payload.subscription?.entity;
      const email = subscription?.notes?.user_email;
      console.log('[RZP WEBHOOK] Subscription completed (12-cycle natural end):', email);

      if (!email) return;
      const user = db.getUserByEmail(email);
      if (!user) return;
      if (!gateOutOfOrder(user.id, body.created_at, 'rzp.subscription.completed')) return;
      const d = db.getDB();
      d.transaction(() => {
        db.updateUserTier(user.id, 'free');
        db.updateLicenseOnPayment(user.id, {
          tier: 'free',
          status: 'expired',
          expires_at: Date.now(),
          sessions_limit: 5,
        });
        db.recordPayment({
          user_id: user.id,
          email: user.email,
          provider: 'razorpay',
          provider_payment_id: null,
          provider_subscription_id: subscription?.id,
          amount: 0,
          currency: 'INR',
          status: 'completed_naturally',
          tier_granted: 'free',
          metadata: { event: 'subscription.completed', reason: 'natural_end_of_total_count' },
        });
      })();
      console.log('[RZP WEBHOOK] User downgraded to free after natural end-of-subscription:', email);
      return;
    }

    case 'subscription.updated': {
      // Fires when the subscription's plan_id changes — e.g. after our
      // /upgrade-tier route schedules a Max→Pro downgrade for cycle_end.
      // Razorpay applies the change and emits subscription.updated.
      // Without handling this, the local tier stays on the OLD value
      // until the next subscription.charged tick, which can be days
      // away — UI shows wrong tier in that window. (P1-C from the audit.)
      const subscription = payload.subscription?.entity;
      const email = subscription?.notes?.user_email;
      const newPlanId = subscription?.plan_id;
      const newTier = tierForRazorpayPlan(newPlanId);
      console.log('[RZP WEBHOOK] Subscription updated:', email, 'new plan_id:', newPlanId, 'tier:', newTier);

      if (!email || !newTier) return;  // unknown plan — let next charge resolve it
      const user = db.getUserByEmail(email);
      if (!user) return;
      if (!gateOutOfOrder(user.id, body.created_at, 'rzp.subscription.updated')) return;
      const license = db.getLicenseByUserId(user.id);
      if (!license) return;
      // Only update if the tier actually changed — Razorpay also fires
      // subscription.updated for non-tier mutations (e.g. quantity).
      if (license.tier === newTier) {
        console.log('[RZP WEBHOOK] subscription.updated: tier unchanged, no-op');
        return;
      }
      const grant = grantConfigForTier(newTier);
      db.updateUserTier(user.id, grant.tier);
      db.updateLicenseOnPayment(user.id, {
        tier: grant.tier,
        // Preserve current status/expires_at — this isn't a fresh charge,
        // just a tier swap mid-cycle. Next subscription.charged will
        // refresh expires_at on the new plan's billing tick.
        status: license.status === 'past_due' ? 'past_due' : 'active',
        expires_at: license.expires_at,
        sessions_limit: grant.sessions_limit,
        // A swap TO Ultra must land the -1 unlimited sentinel immediately —
        // the user is billed Ultra from this cycle. Pro/Max swaps leave the
        // balance alone (legacy subs carry migration-era -1).
        ...creditsForLifecycleGrant(grant),
      });
      console.log('[RZP WEBHOOK] Subscription plan swap applied:', email, license.tier, '→', grant.tier);
      return;
    }

    case 'subscription.paused': {
      // Razorpay supports merchant- or user-initiated pauses. A paused
      // sub doesn't bill but also shouldn't grant tier access. Mirror
      // 'cancelled' semantics but with status='paused' so a future
      // 'subscription.resumed' can restore.
      const subscription = payload.subscription?.entity;
      const email = subscription?.notes?.user_email;
      console.log('[RZP WEBHOOK] Subscription paused:', email);
      if (!email) return;
      const user = db.getUserByEmail(email);
      if (!user) return;
      if (!gateOutOfOrder(user.id, body.created_at, 'rzp.subscription.paused')) return;
      const license = db.getLicenseByUserId(user.id);
      if (!license) return;
      db.updateLicenseOnPayment(user.id, {
        tier: license.tier,
        status: 'paused',
        expires_at: Date.now(),
        sessions_limit: license.sessions_limit,
      });
      return;
    }

    case 'subscription.resumed': {
      const subscription = payload.subscription?.entity;
      const email = subscription?.notes?.user_email;
      const planTier = tierForRazorpayPlan(subscription?.plan_id);
      const tier = resolveTier(planTier || subscription?.notes?.tier);
      console.log('[RZP WEBHOOK] Subscription resumed:', email, 'tier:', tier);
      if (!email || !tier) return;
      const user = db.getUserByEmail(email);
      if (!user) return;
      if (!gateOutOfOrder(user.id, body.created_at, 'rzp.subscription.resumed')) return;
      const grant = grantConfigForTier(tier);
      db.updateUserTier(user.id, grant.tier);
      db.updateLicenseOnPayment(user.id, {
        tier: grant.tier,
        status: 'active',
        expires_at: grant.expires_at,
        sessions_limit: grant.sessions_limit,
        ...creditsForLifecycleGrant(grant),
      });
      return;
    }

    case 'subscription.activated':
    case 'subscription.authenticated':
    case 'subscription.pending': {
      // Audit-trail-only events. The first tier grant lands via
      // subscription.charged or payment.captured (whichever Razorpay
      // emits first). Logging these gives operators visibility into
      // the lifecycle without mutating local state.
      const subscription = payload.subscription?.entity;
      const email = subscription?.notes?.user_email;
      console.log(`[RZP WEBHOOK] ${event}:`, email, 'sub:', subscription?.id);
      return;
    }

    default:
      console.log('[RZP WEBHOOK] Unhandled:', event);
  }
}

module.exports = router;
// Internals exposed for unit tests only — the production code path
// always uses the route handlers above.
module.exports._test = {
  handleRazorpayEvent,
  handleStripeEvent,
  gateOutOfOrder,
  tierForRazorpayPlan,
  resolveTier,
  grantConfigForTier,
  creditsForLifecycleGrant,
  creditsForBillingCycle,
  RECURRING_TIERS,
  VALID_TIERS,
};
