// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  PAYMENTS — Razorpay (India) + Stripe (Global)
//  Auto-routes based on user's country_code
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const express = require('express');
const { authMiddleware } = require('../middleware/auth');
const db = require('../database');

const router = express.Router();

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

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  CREATE CHECKOUT — auto-routes
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.post('/create-checkout', authMiddleware, async (req, res) => {
  try {
    const { country_code } = req.body;
    const provider = getPaymentProvider(country_code || req.user.country_code || 'US');

    if (provider === 'razorpay') {
      return await createRazorpayCheckout(req, res);
    } else {
      return await createStripeCheckout(req, res);
    }
  } catch (err) {
    console.error('Checkout error:', err.message, err.stack);
    res.status(500).json({ error: err.message || 'Failed to create checkout. Please try again.' });
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  STRIPE — $50/mo for USA + Global
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function createStripeCheckout(req, res) {
  if (!stripe) {
    return res.status(503).json({ error: 'Stripe is not configured. Contact support.' });
  }

  const priceId = process.env.STRIPE_PRICE_USD;
  if (!priceId) {
    return res.status(503).json({ error: 'Pricing not configured yet. Contact support.' });
  }

  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3005';

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    payment_method_types: ['card'],
    customer_email: req.user.email,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${frontendUrl}?payment=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${frontendUrl}?payment=cancelled`,
    metadata: {
      user_email: req.user.email,
      user_id: req.user.id,
      provider: 'stripe',
    },
    billing_address_collection: 'required',
  });

  res.json({
    provider: 'stripe',
    checkout_url: session.url,
    session_id: session.id,
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  RAZORPAY — Rs.3999/mo for India
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function createRazorpayCheckout(req, res) {
  if (!razorpay) {
    return res.status(503).json({ error: 'Razorpay is not configured. Contact support.' });
  }

  const planId = process.env.RAZORPAY_PLAN_ID;

  // Option A: Subscription (recurring via Razorpay Plans)
  if (planId) {
    const subscription = await razorpay.subscriptions.create({
      plan_id: planId,
      total_count: 12, // 12 months max
      quantity: 1,
      notes: {
        user_email: req.user.email,
        user_id: req.user.id,
      },
    });

    return res.json({
      provider: 'razorpay',
      subscription_id: subscription.id,
      key_id: process.env.RAZORPAY_KEY_ID,
      amount: 399900, // Rs.3999 in paise
      currency: 'INR',
      name: 'minicaai Pro',
      description: 'Pro Plan — Rs.3999/month',
      user_email: req.user.email,
      user_name: req.user.name || '',
    });
  }

  // Option B: One-time order (if no plan created yet — for testing)
  const order = await razorpay.orders.create({
    amount: 399900, // Rs.3999 in paise
    currency: 'INR',
    receipt: `pro_${req.user.id}_${Date.now()}`,
    notes: {
      user_email: req.user.email,
      user_id: req.user.id,
      tier: 'pro',
    },
  });

  res.json({
    provider: 'razorpay',
    order_id: order.id,
    key_id: process.env.RAZORPAY_KEY_ID,
    amount: order.amount,
    currency: order.currency,
    name: 'minicaai Pro',
    description: 'Pro Plan — Rs.3999/month',
    user_email: req.user.email,
    user_name: req.user.name || '',
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

    // Verify signature
    const crypto = require('crypto');
    const secret = process.env.RAZORPAY_KEY_SECRET;

    let expectedSignature;
    if (razorpay_subscription_id) {
      // Subscription verification
      expectedSignature = crypto
        .createHmac('sha256', secret)
        .update(`${razorpay_payment_id}|${razorpay_subscription_id}`)
        .digest('hex');

      if (expectedSignature !== razorpay_signature) {
        return res.status(400).json({ error: 'Payment verification failed. Invalid signature.' });
      }
    } else if (razorpay_order_id) {
      // Order verification
      expectedSignature = crypto
        .createHmac('sha256', secret)
        .update(`${razorpay_order_id}|${razorpay_payment_id}`)
        .digest('hex');

      if (expectedSignature !== razorpay_signature) {
        return res.status(400).json({ error: 'Payment verification failed. Invalid signature.' });
      }
    }

    // Payment verified — upgrade user
    const user = db.getUserById(req.user.id);
    if (user) {
      db.updateUserTier(user.id, 'pro');
      db.updateLicenseOnPayment(user.id, {
        tier: 'pro',
        status: 'active',
        expires_at: -1,
        sessions_limit: -1,
      });

      // Store payment reference
      const d = db.getDB();
      d.prepare('UPDATE users SET stripe_customer_id = ?, updated_at = ? WHERE id = ?')
        .run(`rzp_${razorpay_payment_id}`, Date.now(), user.id);

      // Record payment in history
      db.recordPayment({
        user_id: user.id,
        email: user.email,
        provider: 'razorpay',
        provider_payment_id: razorpay_payment_id,
        provider_subscription_id: razorpay_subscription_id || null,
        amount: 399900,
        currency: 'INR',
        status: 'completed',
        tier_granted: 'pro',
        metadata: { order_id: razorpay_order_id, verified_client_side: true },
      });
    }

    const license = db.getLicenseByUserId(req.user.id);

    res.json({
      success: true,
      message: 'Payment verified. Account upgraded to Pro!',
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

    res.json({
      status: license.status,
      tier: license.tier,
      provider,
      expires_at: license.expires_at,
      sessions_used: license.sessions_used,
      sessions_limit: license.sessions_limit,
    });
  } catch (err) {
    console.error('Subscription status error:', err.message);
    res.status(500).json({ error: 'Failed to check subscription' });
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  STRIPE CUSTOMER PORTAL (manage/cancel)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.post('/portal', authMiddleware, async (req, res) => {
  try {
    if (!stripe) return res.status(503).json({ error: 'Stripe not configured' });

    const customers = await stripe.customers.list({ email: req.user.email, limit: 1 });
    if (customers.data.length === 0) return res.status(404).json({ error: 'No Stripe subscription found' });

    const session = await stripe.billingPortal.sessions.create({
      customer: customers.data[0].id,
      return_url: process.env.FRONTEND_URL || 'http://localhost:3005',
    });

    res.json({ portal_url: session.url });
  } catch (err) {
    console.error('Portal error:', err.message);
    res.status(500).json({ error: 'Failed to create portal session' });
  }
});

module.exports = router;
