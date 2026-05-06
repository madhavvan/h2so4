const express = require('express');
const crypto = require('crypto');
const db = require('../database');
const { sendMail, renderPaymentFailedEmail } = require('../email');

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

let stripe = null;
if (process.env.STRIPE_SECRET_KEY) {
  stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
}

// ── Tier helpers (mirror of payments.js — kept local to avoid a cross-file
//    dependency; webhooks may run in a separate worker in the future). ──
const VALID_TIERS = ['basic', 'pro', 'max'];
const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;
const BASIC_INITIAL_CREDIT_SECONDS = 3 * 3600; // 3 hours, matches "3 credits"

// Strict: returns null for unknown/missing. Every money-granting path uses
// this — the prior version defaulted to 'pro', which silently upgraded a
// Basic buyer to Pro if their checkout metadata was ever dropped.
function resolveTier(t) {
  return VALID_TIERS.includes(t) ? t : null;
}

// Initial license values for a fresh tier grant. Includes the credits
// fields so a Basic checkout seeds 3 hours of session time server-side
// (was client-only in the legacy ledger; see the database.js migration
// comment for why that didn't propagate across devices).
function grantConfigForTier(tier) {
  if (tier === 'basic') {
    const expires_at = Date.now() + FOURTEEN_DAYS_MS;
    return {
      tier: 'basic',
      sessions_limit: 3,
      expires_at,
      credits_remaining_seconds: BASIC_INITIAL_CREDIT_SECONDS,
      credits_expire_at: expires_at,
    };
  }
  // Pro/Max: -1 sentinels mirror sessions_limit / expires_at convention
  // ("unlimited"). The client's getCreditsRemainingSeconds reads tier===basic
  // anyway and short-circuits Pro/Max to "unlimited time".
  return {
    tier,
    sessions_limit: -1,
    expires_at: -1,
    credits_remaining_seconds: -1,
    credits_expire_at: -1,
  };
}

// Reverse-lookup: given a Razorpay plan_id, return the tier it represents.
// Needed because /upgrade-tier swaps a subscription's plan_id but Razorpay
// has no API to update notes.tier — so subsequent subscription.charged
// webhooks would read stale notes and re-grant the old tier without this.
// Built lazily so missing env vars at import time don't crash the module.
function tierForRazorpayPlan(planId) {
  if (!planId) return null;
  if (planId === process.env.RAZORPAY_PLAN_ID_MAX) return 'max';
  if (planId === process.env.RAZORPAY_PLAN_ID_PRO) return 'pro';
  if (planId === process.env.RAZORPAY_PLAN_ID) return 'pro'; // legacy alias
  return null;
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
    case 'checkout.session.completed': {
      const session = event.data.object;
      const email = session.customer_email || session.metadata?.user_email;
      // `mode === 'renewal'` signals the Basic +1/+1h top-up flow —
      // grant the renewal instead of resetting to full Basic.
      const isRenewal = session.metadata?.mode === 'renewal';
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
      const apply = sqlite.transaction(() => {
        if (isRenewal) {
          const updated = db.grantBasicRenewal(user.id);
          grantedTier = (updated && updated.tier) || 'basic';
        } else {
          const grant = grantConfigForTier(tier);
          grantedTier = grant.tier;
          db.updateUserTier(user.id, grant.tier);
          db.updateLicenseOnPayment(user.id, {
            tier: grant.tier,
            status: 'active',
            expires_at: grant.expires_at,  // Basic: now+14d, Pro/Max: -1 (Stripe-managed)
            sessions_limit: grant.sessions_limit, // Basic: 3, Pro/Max: -1
          });
        }
        // Save Stripe customer ID (even on renewal — may be the first
        // time we see this customer if they renewed via a different
        // email / guest flow).
        if (session.customer) {
          sqlite.prepare('UPDATE users SET stripe_customer_id = ?, updated_at = ? WHERE id = ?')
            .run(session.customer, Date.now(), user.id);
        }
        db.recordPayment({
          user_id: user.id,
          email: user.email,
          provider: 'stripe',
          provider_payment_id: session.payment_intent || session.id,
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
          },
        });
      });
      apply();
      console.log('[WEBHOOK]', isRenewal ? 'Renewal applied for:' : `User upgraded to ${grantedTier.toUpperCase()}:`, email);
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
      const user = d.prepare('SELECT * FROM users WHERE stripe_customer_id = ?').get(invoice.customer);
      if (!user) {
        console.log('[WEBHOOK] invoice.payment_succeeded for unknown customer:', invoice.customer);
        return;
      }
      const license = db.getLicenseByUserId(user.id);
      db.recordPayment({
        user_id: user.id,
        email: user.email,
        provider: 'stripe',
        provider_payment_id: invoice.payment_intent,
        provider_subscription_id: invoice.subscription,
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
      console.log('[WEBHOOK] Recurring charge recorded for:', user.email, 'amount:', invoice.amount_paid);
      return;
    }

    case 'customer.subscription.updated': {
      const subscription = event.data.object;
      const customerId = subscription.customer;
      // Tier rides on subscription_data.metadata set at checkout creation.
      const subTier = resolveTier(subscription.metadata?.tier);

      const d = db.getDB();
      const user = d.prepare('SELECT * FROM users WHERE stripe_customer_id = ?').get(customerId);
      if (!user) return;

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
      const periodEndMs = (subscription.current_period_end || 0) * 1000;

      console.log('[WEBHOOK] Subscription updated:', customerId, 'tier:', tier, 'status:', subscription.status, 'cancel_at_period_end:', isCanceling);

      if (isActiveOrTrialing && isCanceling) {
        // Cancel-at-period-end: user clicked Cancel but cycle hasn't ended.
        // Status flips to 'canceling' so the client can render an explicit
        // "Cancellation scheduled — access until <date>" banner and offer a
        // Reactivate button. expires_at = current_period_end so the timer
        // is honest about when access actually ends.
        db.updateUserTier(user.id, grant.tier);
        db.updateLicenseOnPayment(user.id, {
          tier: grant.tier,
          status: 'canceling',
          expires_at: periodEndMs > 0 ? periodEndMs : grant.expires_at,
          sessions_limit: grant.sessions_limit,
        });
      } else if (isActiveOrTrialing) {
        // Normal active sub — full grant. Also clears any prior 'canceling'
        // state (covers the case where the user cancels then reactivates
        // via the portal — Stripe flips cancel_at_period_end back to false
        // and we should reflect that locally).
        db.updateUserTier(user.id, grant.tier);
        db.updateLicenseOnPayment(user.id, {
          tier: grant.tier,
          status: 'active',
          expires_at: grant.expires_at,
          sessions_limit: grant.sessions_limit,
        });
      } else if (subscription.status === 'past_due') {
        // Grace period — Stripe's dunning will retry. Do nothing to the
        // license until `canceled` or `unpaid` arrives.
        console.log('[WEBHOOK] Subscription past_due for:', user.email);
      } else if (subscription.status === 'paused') {
        // Stripe collection paused (manual pause via portal/API). Treat as
        // a soft revoke — user keeps no access while the sub is paused,
        // but the customer/sub records stay in Stripe so a future resume
        // restores the relationship without a fresh signup. customer.subscription.resumed
        // (handled below) flips this back to 'active'.
        db.updateUserTier(user.id, 'free');
        db.updateLicenseOnPayment(user.id, {
          tier: 'free',
          status: 'paused',
          expires_at: Date.now(),
          sessions_limit: 5,
        });
        console.log('[WEBHOOK] Subscription paused for:', user.email);
      } else if (['canceled', 'unpaid'].includes(subscription.status)) {
        db.updateUserTier(user.id, 'free');
        db.updateLicenseOnPayment(user.id, {
          tier: 'free',
          status: 'expired',
          expires_at: Date.now(),
          sessions_limit: 5,
        });
      } else if (subscription.status === 'incomplete_expired') {
        // First payment never succeeded; subscription is dead. The user
        // never received a license for this sub, so this is purely a
        // logging hook — no DB write needed. Without this branch the
        // event would silently fall through (which is what we want
        // behaviourally) but we'd lose the audit trail.
        console.log('[WEBHOOK] Subscription incomplete_expired for:', user.email, '— never granted, no-op');
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
      // subscription.updated with status='paused'. Same revoke behavior.
      const subscription = event.data.object;
      const d = db.getDB();
      const user = d.prepare('SELECT * FROM users WHERE stripe_customer_id = ?').get(subscription.customer);
      if (!user) return;
      db.updateUserTier(user.id, 'free');
      db.updateLicenseOnPayment(user.id, {
        tier: 'free',
        status: 'paused',
        expires_at: Date.now(),
        sessions_limit: 5,
      });
      console.log('[WEBHOOK] customer.subscription.paused for:', user.email);
      return;
    }

    case 'customer.subscription.resumed': {
      // Counterpart to .paused — restore the tier the metadata says this
      // sub was for. Mirrors the active branch in subscription.updated.
      const subscription = event.data.object;
      const tier = resolveTier(subscription.metadata?.tier);
      const d = db.getDB();
      const user = d.prepare('SELECT * FROM users WHERE stripe_customer_id = ?').get(subscription.customer);
      if (!user || !tier) return;
      const grant = grantConfigForTier(tier);
      db.updateUserTier(user.id, grant.tier);
      db.updateLicenseOnPayment(user.id, {
        tier: grant.tier,
        status: 'active',
        expires_at: grant.expires_at,
        sessions_limit: grant.sessions_limit,
      });
      console.log('[WEBHOOK] customer.subscription.resumed for:', user.email, 'restored tier:', grant.tier);
      return;
    }

    case 'invoice.payment_action_required': {
      // 3DS / SCA challenge needed before Stripe can collect. The retry
      // window is short (Stripe typically gives a few hours). Notify the
      // user immediately so they can complete the challenge in time.
      const invoice = event.data.object;
      const d = db.getDB();
      const user = d.prepare('SELECT * FROM users WHERE stripe_customer_id = ?').get(invoice.customer);
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
      const user = d.prepare('SELECT * FROM users WHERE stripe_customer_id = ?').get(customerId);
      if (!user) return;
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
      console.log('[WEBHOOK] User downgraded to free:', user.email);
      return;
    }

    case 'invoice.payment_failed': {
      const invoice = event.data.object;
      const customerId = invoice.customer;
      console.log('[WEBHOOK] Payment failed for:', customerId);

      const d = db.getDB();
      const user = d.prepare('SELECT * FROM users WHERE stripe_customer_id = ?').get(customerId);
      if (!user) return;
      db.recordPayment({
        user_id: user.id,
        email: user.email,
        provider: 'stripe',
        provider_payment_id: invoice.payment_intent,
        provider_subscription_id: invoice.subscription,
        amount: invoice.amount_due || 0,
        currency: (invoice.currency || 'usd').toUpperCase(),
        status: 'failed',
        tier_granted: null,
        metadata: { invoice_id: invoice.id },
      });
      // Best-effort notification — the user's card was declined and
      // Stripe will retry over the dunning window. Telling them now
      // gives them a chance to fix the card before the sub lapses.
      const license = db.getLicenseByUserId(user.id);
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
      const refundAmount = charge.amount_refunded || 0;
      const fullRefund = charge.refunded === true && refundAmount >= charge.amount;

      const d = db.getDB();
      const user = d.prepare('SELECT * FROM users WHERE stripe_customer_id = ?').get(charge.customer);
      if (!user) {
        console.log('[WEBHOOK] charge.refunded for unknown customer:', charge.customer);
        return;
      }

      db.recordPayment({
        user_id: user.id,
        email: user.email,
        provider: 'stripe',
        provider_payment_id: charge.payment_intent || charge.id,
        provider_subscription_id: null,
        amount: -refundAmount, // negative so revenue sums stay correct
        currency: (charge.currency || 'usd').toUpperCase(),
        status: 'refunded',
        tier_granted: null,
        metadata: {
          charge_id: charge.id,
          original_amount: charge.amount,
          full_refund: fullRefund,
          reason: charge.refunds?.data?.[0]?.reason || null,
        },
      });

      if (fullRefund) {
        db.updateUserTier(user.id, 'free');
        db.updateLicenseOnPayment(user.id, {
          tier: 'free',
          status: 'refunded',
          expires_at: Date.now(),
          sessions_limit: 5,
        });
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
      let user = dispute.customer
        ? d.prepare('SELECT * FROM users WHERE stripe_customer_id = ?').get(dispute.customer)
        : null;
      if (!user && dispute.charge && stripe) {
        try {
          const charge = await stripe.charges.retrieve(dispute.charge);
          if (charge && charge.customer) {
            user = d.prepare('SELECT * FROM users WHERE stripe_customer_id = ?').get(charge.customer);
          }
        } catch (err) {
          console.error('[WEBHOOK] dispute.created: could not resolve charge', dispute.charge, err.message);
        }
      }
      if (!user) {
        console.log('[WEBHOOK] charge.dispute.created — could not map to user:', dispute.id);
        return;
      }
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
      let user = dispute.customer
        ? d.prepare('SELECT * FROM users WHERE stripe_customer_id = ?').get(dispute.customer)
        : null;
      if (!user && dispute.charge && stripe) {
        try {
          const charge = await stripe.charges.retrieve(dispute.charge);
          if (charge && charge.customer) {
            user = d.prepare('SELECT * FROM users WHERE stripe_customer_id = ?').get(charge.customer);
          }
        } catch (err) {
          console.error('[WEBHOOK] dispute.closed: could not resolve charge', dispute.charge, err.message);
        }
      }
      if (!user) return;
      // Restore the tier from the user's most recent paid subscription.
      // We can't read it from the dispute payload directly — query Stripe
      // for any active subscription on this customer. If they have no
      // active sub (e.g. it was canceled while disputed), we leave them on
      // free; they can resubscribe.
      let restoredTier = null;
      try {
        const subs = await stripe.subscriptions.list({ customer: dispute.customer || user.stripe_customer_id, status: 'active', limit: 1 });
        if (subs.data.length > 0) {
          restoredTier = resolveTier(subs.data[0].metadata?.tier);
        }
      } catch (err) {
        console.error('[WEBHOOK] dispute.closed: could not list subs:', err.message);
      }
      if (!restoredTier) {
        console.log('[WEBHOOK] dispute.closed won but no active sub to restore for:', user.email);
        return;
      }
      const grant = grantConfigForTier(restoredTier);
      db.updateUserTier(user.id, grant.tier);
      db.updateLicenseOnPayment(user.id, {
        tier: grant.tier,
        status: 'active',
        expires_at: grant.expires_at,
        sessions_limit: grant.sessions_limit,
      });
      console.log('[WEBHOOK] Dispute won — restored tier for:', user.email, 'tier:', restoredTier);
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
  // table. created_at is in the outer body on Razorpay's payload.
  const headerEventId = req.headers['x-razorpay-event-id'];
  const payment = body.payload?.payment?.entity;
  const subscription = body.payload?.subscription?.entity;
  const refund = body.payload?.refund?.entity;
  const syntheticId = `${body.event || 'unknown'}:${payment?.id || subscription?.id || refund?.id || 'no-id'}:${body.created_at || ''}`;
  const eventId = headerEventId || syntheticId;

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

      const grant = grantConfigForTier(tier);
      db.updateUserTier(user.id, grant.tier);
      db.updateLicenseOnPayment(user.id, {
        tier: grant.tier,
        status: 'active',
        expires_at: grant.expires_at,
        sessions_limit: grant.sessions_limit,
      });
      const d = db.getDB();
      d.prepare('UPDATE users SET stripe_customer_id = ?, updated_at = ? WHERE id = ?')
        .run(`rzp_${payment?.id || subscription?.id}`, Date.now(), user.id);
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
      console.log('[RZP WEBHOOK] User upgraded to', grant.tier.toUpperCase(), ':', email);
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
      // Capture the prior tier BEFORE we wipe the license so the
      // notification email can name the plan that just lapsed.
      const priorLicense = db.getLicenseByUserId(user.id);
      const priorTier = priorLicense?.tier || subscription?.notes?.tier;
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
      // `notes.mode === 'renewal'` signals a Basic top-up (+1 session /
      // +1h) rather than a fresh tier grant. Either flow requires a
      // known tier stamped at order creation — that blocks stray
      // payment.captured events for unrelated orders.
      const isRenewal = payment?.notes?.mode === 'renewal';
      console.log('[RZP WEBHOOK] Payment captured:', email, isRenewal ? '(renewal)' : `tier: ${rawTier}`);

      if (!email) return;
      if (!isRenewal && !VALID_TIERS.includes(rawTier)) {
        console.error('[RZP WEBHOOK] payment.captured without tier or renewal flag:', payment?.id);
        return;
      }
      const user = db.getUserByEmail(email);
      if (!user) return;

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
          const updated = db.grantBasicRenewal(user.id);
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
          });
        }
        sqlite.prepare('UPDATE users SET stripe_customer_id = ?, updated_at = ? WHERE id = ?')
          .run(`rzp_${payment.id}`, Date.now(), user.id);
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
      // Razorpay's error_description is the user-friendly string
      // (e.g. "Your card was declined by the bank"). error_code is a
      // machine token like BAD_REQUEST_ERROR — not useful in an email.
      const license = db.getLicenseByUserId(user.id);
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
      // when funds move. Treat both the same — the webhook_events dedup
      // lets a later event replay safely on the same refund id.
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
      const refundAmount = refund?.amount || 0;
      const fullRefund = refundAmount >= priorPayment.amount;
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
          original_payment_id: paymentId,
        },
      });
      if (fullRefund) {
        db.updateUserTier(user.id, 'free');
        db.updateLicenseOnPayment(user.id, {
          tier: 'free',
          status: 'refunded',
          expires_at: Date.now(),
          sessions_limit: 5,
        });
        console.log('[RZP WEBHOOK] Full refund — user downgraded to free:', user.email);
      } else {
        console.log('[RZP WEBHOOK] Partial refund recorded for:', user.email, 'amount:', refundAmount);
      }
      return;
    }

    default:
      console.log('[RZP WEBHOOK] Unhandled:', event);
  }
}

module.exports = router;
