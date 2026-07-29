// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  STRIPE REFUND TARGETING — turn a stored payment row into something
//  stripe.refunds.create() will actually accept.
//
//  The bug this fixes: all three refund call sites (admin console,
//  bot request_refund, bot refund_payment) did
//      payment_intent: id.startsWith('pi_') ? id : undefined
//      charge:         id.startsWith('ch_') ? id : undefined
//  which silently passes BOTH as undefined for any other id shape —
//  and Stripe rejects the call ("one of payment_intent or charge is
//  required"). The shape that lands there in practice is `cs_…`:
//  checkout.session.completed records `session.payment_intent || session.id`,
//  and in SUBSCRIPTION mode payment_intent is null, so every Ultra
//  first charge is stored as its Checkout Session id. The first invoice
//  is deliberately not recorded (billing_reason === 'subscription_create'
//  returns early in the webhook), so no pi_ row exists anywhere.
//  Result before this module: Ultra's first month — the $159 flagship —
//  could not be refunded from the admin console (500) or the support bot
//  (silently queued for a human). Only the Stripe Dashboard worked.
//
//  Resolving lazily here (instead of migrating stored ids) means
//  historical rows are fixed too, with no backfill.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// Pull the PaymentIntent id off an Invoice across API versions. Pre-Basil
// it's a top-level field; from 2025-03-31.basil it moved into the
// payments[] collection. We pin the SDK to a pre-Basil version
// (services/stripeClient.js) so the first branch is what runs today —
// the second is here so a future version bump degrades to "still works"
// instead of "refunds stop resolving".
function invoicePaymentIntentId(invoice) {
  if (!invoice) return null;
  if (typeof invoice.payment_intent === 'string') return invoice.payment_intent;
  if (invoice.payment_intent?.id) return invoice.payment_intent.id;
  const viaPayments = invoice.payments?.data?.[0]?.payment?.payment_intent;
  if (typeof viaPayments === 'string') return viaPayments;
  if (viaPayments?.id) return viaPayments.id;
  return null;
}

// Resolve { payment_intent } or { charge } for stripe.refunds.create().
// Throws an Error with .code = 'NO_REFUND_TARGET' when the row can't be
// mapped to anything refundable, so callers can report a precise reason
// instead of forwarding a raw Stripe validation error.
//
// `payment` is a row from our payments table.
async function resolveStripeRefundTarget(stripe, payment) {
  const id = payment?.provider_payment_id;
  if (!id) {
    const err = new Error('Payment row has no provider_payment_id — nothing to refund.');
    err.code = 'NO_REFUND_TARGET';
    throw err;
  }

  // Direct hits — the common case for one-time passes and top-ups.
  if (id.startsWith('pi_')) return { payment_intent: id };
  if (id.startsWith('ch_')) return { charge: id };

  // Checkout Session: `payment` mode carries the PaymentIntent directly;
  // `subscription` mode carries an invoice whose PI is the real charge.
  if (id.startsWith('cs_')) {
    const session = await stripe.checkout.sessions.retrieve(id);
    if (typeof session?.payment_intent === 'string') {
      return { payment_intent: session.payment_intent };
    }
    if (session?.payment_intent?.id) {
      return { payment_intent: session.payment_intent.id };
    }
    const invoiceId = typeof session?.invoice === 'string' ? session.invoice : session?.invoice?.id;
    if (invoiceId) {
      const invoice = await stripe.invoices.retrieve(invoiceId);
      const pi = invoicePaymentIntentId(invoice);
      if (pi) return { payment_intent: pi };
    }
    // Session with neither — fall through to the subscription route below.
  }

  // Invoice id stored directly (recurring-cycle rows on some configs).
  if (id.startsWith('in_')) {
    const invoice = await stripe.invoices.retrieve(id);
    const pi = invoicePaymentIntentId(invoice);
    if (pi) return { payment_intent: pi };
  }

  // Last resort: the row knows its subscription — refund that sub's most
  // recent invoice. Correct for "refund the charge this row represents"
  // when the row is the only record of a subscription's first cycle.
  const subId = payment.provider_subscription_id
    || (id.startsWith('sub_') ? id : null);
  if (subId) {
    const sub = await stripe.subscriptions.retrieve(subId);
    const latest = typeof sub?.latest_invoice === 'string' ? sub.latest_invoice : sub?.latest_invoice?.id;
    if (latest) {
      const invoice = await stripe.invoices.retrieve(latest);
      const pi = invoicePaymentIntentId(invoice);
      if (pi) return { payment_intent: pi };
    }
  }

  const err = new Error(
    `Could not resolve a refundable Stripe charge for payment id "${id}". `
    + 'Refund it from the Stripe Dashboard and record it manually.'
  );
  err.code = 'NO_REFUND_TARGET';
  throw err;
}

// A full refund of a SUBSCRIPTION charge has to end the subscription too.
// Without this, refunding an Ultra first month gives the money back, the
// charge.refunded webhook drops the user to free — and then the next
// billing cycle charges them again and customer.subscription.updated
// re-grants Ultra on an account we already refunded. The user is billed
// forever on a plan we told them was cancelled.
//
// Immediate cancel (not cancel_at_period_end) is the right semantic: we
// have returned the money for the current period, so there is no paid
// period left to honour.
//
// Best-effort by design — the refund has already succeeded when this
// runs, so a failure here must never turn into a failed refund. Returns a
// summary the caller folds into its audit entry.
async function cancelSubscriptionAfterFullRefund(stripe, payment, { isFullRefund }) {
  if (!isFullRefund) return { cancelled: false, reason: 'partial_refund' };

  let subId = payment?.provider_subscription_id || null;
  // Subscription-mode rows recorded before provider_subscription_id was
  // populated still know their Checkout Session — that session names the
  // subscription.
  if (!subId && payment?.provider_payment_id?.startsWith('cs_')) {
    try {
      const session = await stripe.checkout.sessions.retrieve(payment.provider_payment_id);
      subId = typeof session?.subscription === 'string' ? session.subscription : session?.subscription?.id || null;
    } catch { /* lookup failed — nothing to cancel, reported below */ }
  }
  if (!subId) return { cancelled: false, reason: 'no_subscription_on_row' };

  try {
    const cancelled = await stripe.subscriptions.cancel(subId);
    return { cancelled: true, subscription_id: subId, status: cancelled?.status || null };
  } catch (err) {
    // Already cancelled is a success for our purposes.
    const code = err?.code || err?.raw?.code;
    const msg = err?.raw?.message || err?.message || String(err);
    if (/no such subscription|already canceled|already cancelled/i.test(msg)) {
      return { cancelled: false, reason: 'already_cancelled', subscription_id: subId };
    }
    return { cancelled: false, reason: 'cancel_failed', subscription_id: subId, error: msg, code: code || null };
  }
}

module.exports = {
  invoicePaymentIntentId,
  resolveStripeRefundTarget,
  cancelSubscriptionAfterFullRefund,
};
