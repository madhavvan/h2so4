// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Stripe webhook signature verification
//
//  This is THE auth boundary for everything tier-granting in
//  webhooks.js. If signature verification breaks (or weakens to
//  string ===), an attacker can grant themselves Pro/Max with a
//  crafted POST. We use Stripe's own `generateTestHeaderString`
//  helper to pin: (a) legit signatures pass, (b) tampered bodies
//  fail, (c) wrong-secret signatures fail, (d) expired timestamps
//  fail.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { describe, it, expect } from 'vitest';
import Stripe from 'stripe';

const stripe = new Stripe('sk_test_fake_for_unit_test', { apiVersion: '2024-06-20' });
const WEBHOOK_SECRET = 'whsec_test_unit_secret';

function makeSignedRequest(payload, secret = WEBHOOK_SECRET, timestamp = Math.floor(Date.now() / 1000)) {
  const body = JSON.stringify(payload);
  const header = stripe.webhooks.generateTestHeaderString({
    payload: body,
    secret,
    timestamp,
  });
  return { body, header };
}

describe('Stripe webhook signature', () => {
  const validPayload = {
    id: 'evt_test_1',
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_test_1' } },
  };

  it('accepts a legitimate signature', () => {
    const { body, header } = makeSignedRequest(validPayload);
    const event = stripe.webhooks.constructEvent(body, header, WEBHOOK_SECRET);
    expect(event.id).toBe('evt_test_1');
    expect(event.type).toBe('checkout.session.completed');
  });

  it('rejects a tampered body', () => {
    const { header } = makeSignedRequest(validPayload);
    const tamperedBody = JSON.stringify({ ...validPayload, type: 'invoice.payment_succeeded' });
    expect(() =>
      stripe.webhooks.constructEvent(tamperedBody, header, WEBHOOK_SECRET)
    ).toThrow(/signature/i);
  });

  it('rejects a signature signed with the wrong secret', () => {
    const { body, header } = makeSignedRequest(validPayload, 'whsec_wrong_secret');
    expect(() =>
      stripe.webhooks.constructEvent(body, header, WEBHOOK_SECRET)
    ).toThrow(/signature/i);
  });

  it('rejects a signature with an old timestamp (replay protection)', () => {
    const tenMinAgo = Math.floor(Date.now() / 1000) - 600;
    const { body, header } = makeSignedRequest(validPayload, WEBHOOK_SECRET, tenMinAgo);
    // tolerance defaults to 5 min; 10 min should be rejected
    expect(() =>
      stripe.webhooks.constructEvent(body, header, WEBHOOK_SECRET, 300)
    ).toThrow(/timestamp/i);
  });

  it('rejects malformed signature header', () => {
    expect(() =>
      stripe.webhooks.constructEvent('{}', 't=123,v1=garbage', WEBHOOK_SECRET)
    ).toThrow();
    expect(() =>
      stripe.webhooks.constructEvent('{}', '', WEBHOOK_SECRET)
    ).toThrow();
  });
});
