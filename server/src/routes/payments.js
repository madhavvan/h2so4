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

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  CREATE CHECKOUT — auto-routes
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.post('/create-checkout', authMiddleware, async (req, res) => {
  try {
    const { country_code } = req.body;
    const tier = normalizeTier(req.body.tier);
    const provider = getPaymentProvider(country_code || req.user.country_code || 'US');

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
    const { country_code } = req.body || {};
    const provider = getPaymentProvider(country_code || req.user.country_code || 'US');
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
// Price ID env per tier. Legacy STRIPE_PRICE_USD is honored as a fallback
// for 'pro' so existing deployments keep working while Basic/Max prices
// get configured.
const STRIPE_PRICE_ENV = {
  basic: 'STRIPE_PRICE_BASIC_USD',
  pro:   'STRIPE_PRICE_PRO_USD',
  max:   'STRIPE_PRICE_MAX_USD',
};

async function createStripeCheckout(req, res, tier) {
  if (!stripe) {
    return res.status(503).json({ error: 'Stripe is not configured. Contact support.' });
  }

  const priceId = process.env[STRIPE_PRICE_ENV[tier]]
    || (tier === 'pro' ? process.env.STRIPE_PRICE_USD : null);
  if (!priceId) {
    return res.status(503).json({
      error: `Pricing for ${tier.toUpperCase()} is not configured yet. Contact support.`,
    });
  }

  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3005';
  // Basic is a one-time purchase (3 credits, 14-day expiry). Pro/Max are
  // recurring subscriptions with provider-managed lifecycle.
  const mode = tier === 'basic' ? 'payment' : 'subscription';

  const sessionParams = {
    mode,
    payment_method_types: ['card'],
    customer_email: req.user.email,
    line_items: [{ price: priceId, quantity: 1 }],
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
  };
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

    // Signature verified — resolve which tier (or renewal) was actually
    // purchased by fetching the original subscription/order from Razorpay
    // and reading the `notes` we stamped at create time. Trusting client-
    // sent values is unsafe (a free user could POST tier=max). Falls back
    // to 'pro' if the fetch fails, matching the legacy behavior.
    let grantedTier = 'pro';
    let grantedAmount = RAZORPAY_TIER_CONFIG.pro.amountPaise;
    let isRenewal = false;
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
      if (!isRenewal && RAZORPAY_TIER_CONFIG[grantedTier]) {
        grantedAmount = RAZORPAY_TIER_CONFIG[grantedTier].amountPaise;
      }
    } catch (fetchErr) {
      console.error('[verify-razorpay] tier lookup failed, defaulting to pro:', fetchErr.message);
    }

    // Payment verified — grant the tier (or renewal top-up).
    const user = db.getUserById(req.user.id);
    let grantedTierLabel = grantedTier;
    if (user) {
      if (isRenewal) {
        // Renewal: +1 session, +1 hour — no tier reset, no expiry overwrite.
        db.grantBasicRenewal(user.id);
        // Basic renewal doesn't change the tier; keep whatever the user
        // already had (almost always 'basic', occasionally 'free' if they
        // let it lapse and are topping up). getLicenseByUserId below
        // reflects the post-renewal state.
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
    }

    const license = db.getLicenseByUserId(req.user.id);

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

    // Optimistic status update in the local DB — the definitive downgrade
    // lands via the subscription.cancelled webhook once the cycle ends.
    res.json({
      success: true,
      message: 'Your subscription will be cancelled at the end of the current billing period. You keep full access until then.',
      subscription_id: subId,
    });
  } catch (err) {
    console.error('Razorpay cancel error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to cancel subscription' });
  }
});

module.exports = router;
