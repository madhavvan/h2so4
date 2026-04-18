const express = require('express');
const crypto = require('crypto');
const db = require('../database');

const router = express.Router();

let stripe = null;
if (process.env.STRIPE_SECRET_KEY) {
  stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
}

// ── Tier helpers (mirror of payments.js — kept local to avoid a cross-file
//    dependency; webhooks may run in a separate worker in the future). ──
const VALID_TIERS = ['basic', 'pro', 'max'];
const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;
function resolveTier(t, fallback = 'pro') {
  return VALID_TIERS.includes(t) ? t : fallback;
}
function grantConfigForTier(tier) {
  if (tier === 'basic') {
    return { tier: 'basic', sessions_limit: 3, expires_at: Date.now() + FOURTEEN_DAYS_MS };
  }
  return { tier, sessions_limit: -1, expires_at: -1 };
}

router.post('/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Stripe not configured' });

  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      const email = session.customer_email || session.metadata?.user_email;
      // `mode === 'renewal'` signals the Basic +1/+1h top-up flow —
      // grant the renewal instead of resetting to full Basic.
      const isRenewal = session.metadata?.mode === 'renewal';
      const tier = resolveTier(session.metadata?.tier);
      console.log('[WEBHOOK] Payment completed:', email, isRenewal ? '(renewal)' : `tier: ${tier}`);

      if (email) {
        const user = db.getUserByEmail(email);
        if (user) {
          let grantedTier;
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
            const d = db.getDB();
            d.prepare('UPDATE users SET stripe_customer_id = ?, updated_at = ? WHERE id = ?')
              .run(session.customer, Date.now(), user.id);
          }
          // Record payment
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
          console.log('[WEBHOOK]', isRenewal ? 'Renewal applied for:' : `User upgraded to ${grantedTier.toUpperCase()}:`, email);
        }
      }
      break;
    }

    case 'customer.subscription.updated': {
      const subscription = event.data.object;
      const customerId = subscription.customer;
      // Tier rides on subscription_data.metadata set at checkout creation.
      // Fall back to the user's current license tier so an update event
      // doesn't accidentally downgrade a Max user to Pro.
      const subTier = resolveTier(subscription.metadata?.tier, null);
      console.log('[WEBHOOK] Subscription updated:', customerId, 'tier:', subTier);

      const d = db.getDB();
      const user = d.prepare('SELECT * FROM users WHERE stripe_customer_id = ?').get(customerId);
      if (user) {
        const currentLicense = db.getLicenseByUserId(user.id);
        const tier = subTier || resolveTier(currentLicense?.tier);
        const grant = grantConfigForTier(tier);

        const isActive = ['active', 'trialing'].includes(subscription.status);
        const isCanceling = subscription.cancel_at_period_end;

        if (isActive && !isCanceling) {
          db.updateUserTier(user.id, grant.tier);
          db.updateLicenseOnPayment(user.id, {
            tier: grant.tier,
            status: 'active',
            expires_at: grant.expires_at,
            sessions_limit: grant.sessions_limit,
          });
        } else if (isCanceling) {
          // Will cancel at period end — keep the paid tier until then.
          const periodEnd = subscription.current_period_end * 1000;
          db.updateLicenseOnPayment(user.id, {
            tier: grant.tier,
            status: 'active',
            expires_at: periodEnd,
            sessions_limit: grant.sessions_limit,
          });
          console.log('[WEBHOOK] Subscription canceling at period end for:', user.email);
        } else if (subscription.status === 'past_due') {
          // Grace period: 3 days past due, then downgrade
          console.log('[WEBHOOK] Subscription past_due for:', user.email);
        } else if (['canceled', 'unpaid'].includes(subscription.status)) {
          db.updateUserTier(user.id, 'free');
          db.updateLicenseOnPayment(user.id, {
            tier: 'free',
            status: 'expired',
            expires_at: Date.now(),
            sessions_limit: 5,
          });
        }
        console.log('[WEBHOOK] Subscription status:', subscription.status, 'for:', user.email);
      }
      break;
    }

    case 'customer.subscription.deleted': {
      const subscription = event.data.object;
      const customerId = subscription.customer;
      console.log('[WEBHOOK] Subscription cancelled:', customerId);

      const d = db.getDB();
      const user = d.prepare('SELECT * FROM users WHERE stripe_customer_id = ?').get(customerId);
      if (user) {
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
      }
      break;
    }

    case 'invoice.payment_failed': {
      const invoice = event.data.object;
      const customerId = invoice.customer;
      console.log('[WEBHOOK] Payment failed for:', customerId);

      const d = db.getDB();
      const user = d.prepare('SELECT * FROM users WHERE stripe_customer_id = ?').get(customerId);
      if (user) {
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
      }
      break;
    }

    default:
      console.log('[WEBHOOK] Unhandled:', event.type);
  }

  res.json({ received: true });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  RAZORPAY WEBHOOK
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.post('/razorpay', express.json(), async (req, res) => {
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!webhookSecret) return res.status(503).json({ error: 'Razorpay webhooks not configured' });

  // Verify signature
  const signature = req.headers['x-razorpay-signature'];
  const expectedSignature = crypto
    .createHmac('sha256', webhookSecret)
    .update(JSON.stringify(req.body))
    .digest('hex');

  if (signature !== expectedSignature) {
    console.error('[RZP WEBHOOK] Invalid signature');
    return res.status(400).json({ error: 'Invalid signature' });
  }

  const event = req.body.event;
  const payload = req.body.payload;

  switch (event) {
    case 'subscription.charged': {
      const subscription = payload.subscription?.entity;
      const payment = payload.payment?.entity;
      const email = subscription?.notes?.user_email || payment?.notes?.user_email;
      const tier = resolveTier(subscription?.notes?.tier || payment?.notes?.tier);
      const grant = grantConfigForTier(tier);
      console.log('[RZP WEBHOOK] Subscription charged:', email, 'tier:', tier);

      if (email) {
        const user = db.getUserByEmail(email);
        if (user) {
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
        }
      }
      break;
    }

    case 'subscription.cancelled':
    case 'subscription.halted': {
      const subscription = payload.subscription?.entity;
      const email = subscription?.notes?.user_email;
      console.log('[RZP WEBHOOK] Subscription cancelled/halted:', email);

      if (email) {
        const user = db.getUserByEmail(email);
        if (user) {
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
        }
      }
      break;
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

      if (email && VALID_TIERS.includes(rawTier)) {
        const user = db.getUserByEmail(email);
        if (user) {
          let grantedTier;
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
          const d = db.getDB();
          d.prepare('UPDATE users SET stripe_customer_id = ?, updated_at = ? WHERE id = ?')
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
          console.log('[RZP WEBHOOK]', isRenewal ? 'Renewal applied for:' : `User upgraded to ${grantedTier.toUpperCase()}:`, email);
        }
      }
      break;
    }

    case 'payment.failed': {
      const payment = payload.payment?.entity;
      const email = payment?.notes?.user_email;
      console.log('[RZP WEBHOOK] Payment failed:', email);

      if (email) {
        const user = db.getUserByEmail(email);
        if (user) {
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
        }
      }
      break;
    }

    default:
      console.log('[RZP WEBHOOK] Unhandled:', event);
  }

  res.json({ received: true });
});

module.exports = router;
