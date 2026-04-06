const express = require('express');
const crypto = require('crypto');
const db = require('../database');

const router = express.Router();

let stripe = null;
if (process.env.STRIPE_SECRET_KEY) {
  stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
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
      console.log('[WEBHOOK] Payment completed:', email);

      if (email) {
        const user = db.getUserByEmail(email);
        if (user) {
          db.updateUserTier(user.id, 'pro');
          db.updateLicenseOnPayment(user.id, {
            tier: 'pro',
            status: 'active',
            expires_at: -1,  // Managed by Stripe
            sessions_limit: -1,
          });
          // Save Stripe customer ID
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
            amount: session.amount_total || 5000,
            currency: (session.currency || 'usd').toUpperCase(),
            status: 'completed',
            tier_granted: 'pro',
            metadata: { checkout_session_id: session.id, customer_id: session.customer },
          });
          console.log('[WEBHOOK] User upgraded to Pro:', email);
        }
      }
      break;
    }

    case 'customer.subscription.updated': {
      const subscription = event.data.object;
      const customerId = subscription.customer;
      console.log('[WEBHOOK] Subscription updated:', customerId);

      const d = db.getDB();
      const user = d.prepare('SELECT * FROM users WHERE stripe_customer_id = ?').get(customerId);
      if (user) {
        const isActive = ['active', 'trialing'].includes(subscription.status);
        const isCanceling = subscription.cancel_at_period_end;

        if (isActive && !isCanceling) {
          db.updateUserTier(user.id, 'pro');
          db.updateLicenseOnPayment(user.id, {
            tier: 'pro',
            status: 'active',
            expires_at: -1,
            sessions_limit: -1,
          });
        } else if (isCanceling) {
          // Will cancel at period end — keep pro until then
          const periodEnd = subscription.current_period_end * 1000;
          db.updateLicenseOnPayment(user.id, {
            tier: 'pro',
            status: 'active',
            expires_at: periodEnd,
            sessions_limit: -1,
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
      console.log('[RZP WEBHOOK] Subscription charged:', email);

      if (email) {
        const user = db.getUserByEmail(email);
        if (user) {
          db.updateUserTier(user.id, 'pro');
          db.updateLicenseOnPayment(user.id, {
            tier: 'pro',
            status: 'active',
            expires_at: -1,
            sessions_limit: -1,
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
            amount: payment?.amount || 399900,
            currency: payment?.currency?.toUpperCase() || 'INR',
            status: 'completed',
            tier_granted: 'pro',
            metadata: { event: 'subscription.charged' },
          });
          console.log('[RZP WEBHOOK] User upgraded to Pro:', email);
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
      console.log('[RZP WEBHOOK] Payment captured:', email);

      if (email && payment?.notes?.tier === 'pro') {
        const user = db.getUserByEmail(email);
        if (user) {
          db.updateUserTier(user.id, 'pro');
          db.updateLicenseOnPayment(user.id, {
            tier: 'pro',
            status: 'active',
            expires_at: -1,
            sessions_limit: -1,
          });
          const d = db.getDB();
          d.prepare('UPDATE users SET stripe_customer_id = ?, updated_at = ? WHERE id = ?')
            .run(`rzp_${payment.id}`, Date.now(), user.id);
          db.recordPayment({
            user_id: user.id,
            email: user.email,
            provider: 'razorpay',
            provider_payment_id: payment.id,
            provider_subscription_id: null,
            amount: payment.amount || 399900,
            currency: (payment.currency || 'inr').toUpperCase(),
            status: 'completed',
            tier_granted: 'pro',
            metadata: { event: 'payment.captured', order_id: payment.order_id },
          });
          console.log('[RZP WEBHOOK] User upgraded to Pro:', email);
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
