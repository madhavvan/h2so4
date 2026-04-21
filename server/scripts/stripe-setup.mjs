// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  STRIPE SETUP — one-shot bootstrap for Basic / Pro / Max pricing
//
//  Usage (from repo root):
//     cd server
//     STRIPE_SECRET_KEY=sk_test_... node scripts/stripe-setup.mjs
//
//  Or if server/.env already has STRIPE_SECRET_KEY set:
//     cd server
//     node --env-file=.env scripts/stripe-setup.mjs
//
//  What it does:
//    - Creates (or reuses, by metadata.minicaai_plan key) three Products:
//        • minicaai Basic   (one-time)
//        • minicaai Pro     (recurring monthly)
//        • minicaai Max     (recurring monthly)
//    - Creates exactly one active Price per product at the target amount.
//      Stripe prices are immutable — if an existing active price has a
//      different amount, this script archives it and creates a new one.
//    - Prints the resulting price IDs as ready-to-paste .env lines.
//
//  Safe to re-run. Idempotent as long as metadata.minicaai_plan stays
//  attached to the products (do NOT delete that key in the dashboard).
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import Stripe from 'stripe';

const KEY = process.env.STRIPE_SECRET_KEY;
if (!KEY) {
  console.error('STRIPE_SECRET_KEY is not set. Aborting.');
  console.error('  Try: STRIPE_SECRET_KEY=sk_test_... node scripts/stripe-setup.mjs');
  process.exit(1);
}
if (!KEY.startsWith('sk_test_') && !KEY.startsWith('sk_live_')) {
  console.error('STRIPE_SECRET_KEY looks malformed (expected sk_test_... or sk_live_...). Aborting.');
  process.exit(1);
}

const MODE = KEY.startsWith('sk_live_') ? 'LIVE' : 'TEST';
const stripe = new Stripe(KEY, { apiVersion: '2024-06-20' });

// Single source of truth for what we want to exist in Stripe. Amounts are
// in USD cents. Keep these in sync with services/pricingService.ts
// (USD_PRICES) and the Razorpay config in server/src/routes/payments.js.
const PLANS = [
  {
    key: 'basic',
    name: 'minicaai Basic',
    description: '3 interview credits (3 hours total) · 14-day expiry · one-time purchase',
    unit_amount: 2500,   // $25.00
    recurring: null,     // one-time
    envVar: 'STRIPE_PRICE_BASIC_USD',
  },
  {
    key: 'pro',
    name: 'minicaai Pro',
    description: 'Unlimited interview sessions · all AI models · system audio · priority support',
    unit_amount: 2900,   // $29.00 / month
    recurring: { interval: 'month' },
    envVar: 'STRIPE_PRICE_PRO_USD',
  },
  {
    key: 'max',
    name: 'minicaai Max',
    description: 'Everything in Pro + Auto-Type into any editor (HackerRank, CoderPad, etc.)',
    unit_amount: 6900,   // $69.00 / month
    recurring: { interval: 'month' },
    envVar: 'STRIPE_PRICE_MAX_USD',
  },
];

// ── Find or create the Product, keyed on metadata.minicaai_plan ──
// Using metadata (not name) as the idempotency key means the user can
// freely rename the product in the dashboard without breaking re-runs.
async function findOrCreateProduct(plan) {
  const list = await stripe.products.search({
    query: `metadata['minicaai_plan']:'${plan.key}' AND active:'true'`,
    limit: 1,
  });
  if (list.data.length > 0) {
    const p = list.data[0];
    // Keep description in sync on re-runs so pricing copy changes land.
    if (p.description !== plan.description || p.name !== plan.name) {
      await stripe.products.update(p.id, {
        name: plan.name,
        description: plan.description,
      });
      console.log(`  updated product ${p.id} (${plan.name})`);
    } else {
      console.log(`  reused product ${p.id} (${plan.name})`);
    }
    return p;
  }
  const created = await stripe.products.create({
    name: plan.name,
    description: plan.description,
    metadata: { minicaai_plan: plan.key },
  });
  console.log(`  created product ${created.id} (${plan.name})`);
  return created;
}

// ── Find an active Price matching (amount, currency, recurring shape) ──
// Stripe prices are immutable, so "update" means "archive the old one and
// create a new one". We look for an exact match first to avoid churn.
async function findMatchingPrice(productId, plan) {
  // List is fine here — a product rarely has >10 prices and the default
  // page size is 10. If you end up with many historical prices, you may
  // want to paginate.
  const prices = await stripe.prices.list({ product: productId, active: true, limit: 100 });
  return prices.data.find(p => {
    if (p.currency !== 'usd') return false;
    if (p.unit_amount !== plan.unit_amount) return false;
    if (plan.recurring) {
      return p.recurring && p.recurring.interval === plan.recurring.interval;
    }
    return p.type === 'one_time';
  });
}

// ── Archive any OTHER active prices on the product. Keeps the dashboard
//    tidy and prevents accidental use of a stale price ID in the server
//    env after an amount change. ──
async function archiveStalePrices(productId, keepId) {
  const prices = await stripe.prices.list({ product: productId, active: true, limit: 100 });
  for (const p of prices.data) {
    if (p.id === keepId) continue;
    await stripe.prices.update(p.id, { active: false });
    console.log(`  archived stale price ${p.id}`);
  }
}

async function ensurePlan(plan) {
  console.log(`\n━ ${plan.name} (${plan.key}) ━`);
  const product = await findOrCreateProduct(plan);

  let price = await findMatchingPrice(product.id, plan);
  if (price) {
    console.log(`  reused price   ${price.id} (${plan.unit_amount / 100} USD${plan.recurring ? `/${plan.recurring.interval}` : ' one-time'})`);
  } else {
    const params = {
      product: product.id,
      currency: 'usd',
      unit_amount: plan.unit_amount,
      metadata: { minicaai_plan: plan.key },
    };
    if (plan.recurring) {
      params.recurring = { interval: plan.recurring.interval };
    }
    price = await stripe.prices.create(params);
    console.log(`  created price  ${price.id} (${plan.unit_amount / 100} USD${plan.recurring ? `/${plan.recurring.interval}` : ' one-time'})`);
  }

  // Clean up any other active prices on this product (amount drift from
  // prior runs, a manually-created price, etc.) so the .env we print is
  // unambiguous.
  await archiveStalePrices(product.id, price.id);
  return { plan, product, price };
}

async function main() {
  console.log(`━━━ Stripe setup · ${MODE} mode ━━━`);
  const results = [];
  for (const plan of PLANS) {
    results.push(await ensurePlan(plan));
  }

  console.log('\n━━━ Paste into server/.env ━━━');
  for (const { plan, price } of results) {
    console.log(`${plan.envVar}=${price.id}`);
  }
  console.log('');

  console.log('Next steps:');
  console.log(`  1. Paste the three lines above into server/.env (${MODE} mode).`);
  console.log('  2. Configure the webhook endpoint in the Stripe dashboard:');
  console.log('       https://dashboard.stripe.com/' + (MODE === 'LIVE' ? '' : 'test/') + 'webhooks');
  console.log('     URL:     https://<your-server-host>/api/v1/webhooks/stripe');
  console.log('     Events:  checkout.session.completed');
  console.log('              customer.subscription.updated');
  console.log('              customer.subscription.deleted');
  console.log('              invoice.payment_failed');
  console.log('     Copy the signing secret (whsec_...) into STRIPE_WEBHOOK_SECRET.');
  console.log('  3. Enable the Customer Portal so /portal works:');
  console.log('       https://dashboard.stripe.com/' + (MODE === 'LIVE' ? '' : 'test/') + 'settings/billing/portal');
  console.log('     Turn on "Cancel subscriptions" and "Update payment method".');
  console.log('  4. Restart the server so the new env vars take effect.');
}

main().catch(err => {
  console.error('\nStripe setup failed:', err.message);
  if (err.raw && err.raw.message) console.error('  detail:', err.raw.message);
  process.exit(1);
});
