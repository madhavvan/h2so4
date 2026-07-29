// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  STRIPE CLIENT — one construction site, one pinned API version
//
//  Why this module exists: every `require('stripe')(key)` call site used
//  to omit `apiVersion`, which means the SDK sends NO Stripe-Version
//  header and Stripe answers with whatever the ACCOUNT's default version
//  is. That default moves when Stripe promotes a new version on the
//  dashboard — and our code reads several fields that were REMOVED in
//  2025-03-31.basil:
//    · subscription.current_period_end   (moved onto subscription items)
//    · invoice.payment_intent            (moved into invoice.payments[])
//    · invoice.subscription              (moved to invoice.parent)
//    · charge.refunds                    (no longer expanded by default)
//  Reading them against a Basil+ account yields `undefined` silently:
//  cancels_at goes null, subscription-cycle payment rows lose their ids,
//  and the refund-dedup key disappears (duplicate refund rows). None of
//  it throws — it just quietly produces wrong data.
//
//  Pinning here freezes the wire format at the version this codebase was
//  written and tested against (the SDK's own target — stripe-node v14).
//  Upgrading is then a deliberate, reviewable change: bump the constant,
//  update the field reads, run the suite.
//
//  NOTE: the WEBHOOK endpoint has its own api_version, configured in the
//  Stripe Dashboard, and this constant does NOT control it. Keep the
//  dashboard endpoint on the same version (see DEPLOY note in README).
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// The API version stripe-node v14.x targets. Every field this codebase
// reads exists in this version.
const STRIPE_API_VERSION = '2023-10-16';

// Build a Stripe client with the pinned version, or return null when the
// secret key isn't configured (dev boxes, CI). Callers already handle
// null by returning a 503 "Stripe is not configured".
function createStripeClient(secretKey = process.env.STRIPE_SECRET_KEY) {
  if (!secretKey) return null;
  return require('stripe')(secretKey, { apiVersion: STRIPE_API_VERSION });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  WEBHOOK PAYLOAD COMPAT — the version we DON'T control
//
//  The pin above governs calls we MAKE. It does not govern the shape of
//  events Stripe SENDS: a webhook endpoint carries its own api_version,
//  set in the Dashboard when the endpoint is created and silently
//  inherited from the account default. Nothing in a deploy checks it, and
//  nothing fails when it drifts — the fields below simply arrive as
//  `undefined` and every consequence is quiet and wrong:
//
//    · current_period_end → cancels_at goes null, and a canceling license
//      loses its cycle-end date (see resolveCancelPeriodEnd)
//    · invoice.payment_intent / .subscription → subscription-cycle payment
//      rows lose the ids that map them back to a user, so refunds and
//      chargebacks on renewals can't be resolved
//    · charge.refunds → the refund-dedup key disappears, so one refund
//      books twice
//
//  Rather than depend on a Dashboard setting staying right forever, read
//  both shapes. Each accessor tries the pinned (2023-10-16) location
//  first, then the 2025-03-31.basil+ location. Correct under either, and
//  it stays correct through the upgrade instead of breaking at the moment
//  someone clicks "update version" in the Dashboard.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// Warn ONCE per process when a delivered event's version differs from the
// pin — enough to make drift visible in the logs without a line per event.
let _versionWarned = false;
function warnOnApiVersionDrift(event) {
  if (_versionWarned || !event || !event.api_version) return;
  if (event.api_version === STRIPE_API_VERSION) return;
  _versionWarned = true;
  console.warn('━'.repeat(60));
  console.warn('[stripe] WEBHOOK API VERSION DRIFT');
  console.warn(`  endpoint sends: ${event.api_version}`);
  console.warn(`  code pinned to: ${STRIPE_API_VERSION}`);
  console.warn('  The compat accessors in services/stripeClient.js handle the');
  console.warn('  known field moves, so this is a heads-up, not an outage.');
  console.warn('  Align the Dashboard webhook endpoint version when convenient.');
  console.warn('━'.repeat(60));
}

// subscription.current_period_end (2023-10-16) moved onto each
// subscription ITEM in 2025-03-31.basil. Take the furthest item end: for
// the single-item subscriptions we sell they are identical, and for a
// hypothetical multi-item sub the latest end is the honest "access until".
function subscriptionPeriodEnd(subscription) {
  if (!subscription) return null;
  if (typeof subscription.current_period_end === 'number' && subscription.current_period_end > 0) {
    return subscription.current_period_end;
  }
  const items = subscription.items?.data || [];
  const ends = items
    .map(i => i && i.current_period_end)
    .filter(n => typeof n === 'number' && n > 0);
  return ends.length ? Math.max(...ends) : null;
}

// invoice.payment_intent (2023-10-16) moved into invoice.payments[] in
// 2025-03-31.basil. This id is what ties a renewal charge to its user, so
// losing it breaks refund/chargeback resolution on every recurring charge.
function invoicePaymentIntentId(invoice) {
  if (!invoice) return null;
  const direct = invoice.payment_intent;
  if (typeof direct === 'string') return direct;
  if (direct && typeof direct.id === 'string') return direct.id; // expanded object
  const payments = invoice.payments?.data || invoice.payments || [];
  for (const p of Array.isArray(payments) ? payments : []) {
    const pi = p?.payment?.payment_intent;
    if (typeof pi === 'string') return pi;
    if (pi && typeof pi.id === 'string') return pi.id;
  }
  return null;
}

// invoice.subscription (2023-10-16) moved to invoice.parent
// .subscription_details.subscription in 2025-03-31.basil.
function invoiceSubscriptionId(invoice) {
  if (!invoice) return null;
  const direct = invoice.subscription;
  if (typeof direct === 'string') return direct;
  if (direct && typeof direct.id === 'string') return direct.id;
  const nested = invoice.parent?.subscription_details?.subscription;
  if (typeof nested === 'string') return nested;
  if (nested && typeof nested.id === 'string') return nested.id;
  return null;
}

// charge.refunds stopped being expanded by default in 2025-03-31.basil, so
// `charge.refunds.data[0]` — the refund id we dedup on — is simply absent.
// Without it hasRefundBeenRecorded can't match, and the admin-console row
// plus the webhook row both book the same refund. Falls back to one list
// call, which only happens on the degraded path.
async function latestRefundFor(stripeClient, charge) {
  const inline = charge?.refunds?.data?.[0];
  if (inline) return inline;
  if (!stripeClient || !charge?.id) return null;
  try {
    const list = await stripeClient.refunds.list({ charge: charge.id, limit: 1 });
    return list?.data?.[0] || null;
  } catch (err) {
    console.warn('[stripe] refunds.list fallback failed for charge', charge.id, '—', err && err.message);
    return null;
  }
}

module.exports = {
  STRIPE_API_VERSION,
  createStripeClient,
  warnOnApiVersionDrift,
  subscriptionPeriodEnd,
  invoicePaymentIntentId,
  invoiceSubscriptionId,
  latestRefundFor,
};
