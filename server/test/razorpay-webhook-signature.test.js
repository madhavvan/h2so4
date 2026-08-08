// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  RAZORPAY WEBHOOK SIGNATURE — the control with no tests.
//
//  Stripe's equivalent has had stripe-webhook-signature.test.js for a
//  while. Razorpay's had nothing, and it guards exactly the same thing:
//  the webhook is what grants tiers, records payments and processes
//  refunds. If the HMAC check regressed, anyone who could reach
//  POST /api/v1/webhooks/razorpay could grant themselves any tier by
//  posting a payload — no signature, no account, no payment.
//
//  Two failure shapes matter and neither is visible in normal use:
//
//    ACCEPTING a forgery — free tiers for anyone who finds the URL.
//    REJECTING the real thing — every Indian payment silently fails to
//    grant, because the HMAC is over the RAW bytes Razorpay signed and
//    re-serializing the JSON produces different bytes for the same
//    object. That is why the route mounts express.raw(), and it is the
//    kind of detail a well-meaning refactor to express.json() destroys.
//
//  Fully offline: HMACs are computed locally with a test secret.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import http from 'node:http';

const require = createRequire(import.meta.url);

const SECRET = 'test-razorpay-webhook-secret';
process.env.RAZORPAY_WEBHOOK_SECRET = SECRET;
process.env.JWT_SECRET = 'test-secret-rzp-webhook';
process.env.DATABASE_PATH = ':memory:';

// Keep the handler from touching a real DB if a payload ever gets past
// the signature gate. Every assertion below is about the gate itself.
const dbMod = require('../src/database.js');
dbMod.recordWebhookEventOnce = () => false; // "already seen" → handler no-ops
dbMod.getUserByEmail = () => null;
dbMod.getUserById = () => null;
dbMod.getLicenseByUserId = () => null;

const webhooksRouter = require('../src/routes/webhooks.js');

let srv;
let port;

beforeAll(async () => {
  const express = require('express');
  const app = express();
  app.use('/api/v1/webhooks', webhooksRouter);
  srv = app.listen(0);
  await new Promise((r) => srv.once('listening', r));
  port = srv.address().port;
});

afterAll(() => { try { srv.close(); } catch { /* already down */ } });

function sign(raw, secret = SECRET) {
  return crypto.createHmac('sha256', secret).update(raw).digest('hex');
}

function post(rawBody, headers = {}) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/api/v1/webhooks/razorpay',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(rawBody),
          ...headers,
        },
      },
      (r) => {
        let body = '';
        r.on('data', (c) => { body += c; });
        r.on('end', () => resolve({ status: r.statusCode, body }));
      },
    );
    req.write(rawBody);
    req.end();
  });
}

// A payload shaped like the real thing: a captured payment that, if it
// were ever processed unsigned, would grant a tier.
const EVENT = JSON.stringify({
  event: 'payment.captured',
  payload: {
    payment: {
      entity: {
        id: 'pay_forged123',
        amount: 249900,
        currency: 'INR',
        status: 'captured',
        notes: { user_email: 'attacker@example.com', user_id: 'u_attacker', tier: 'max' },
      },
    },
  },
});

describe('Razorpay webhook signature', () => {
  it('rejects a payload with no signature header at all', async () => {
    const res = await post(EVENT);
    expect(res.status).toBe(400);
    expect(res.body).toMatch(/signature/i);
  });

  it('rejects a forged signature', async () => {
    const res = await post(EVENT, { 'x-razorpay-signature': sign(EVENT, 'wrong-secret') });
    expect(res.status).toBe(400);
    expect(res.body).toMatch(/Invalid signature/i);
  });

  it('rejects a truncated signature without throwing a 500', async () => {
    // crypto.timingSafeEqual throws on a length mismatch. Without the
    // explicit length guard this returns 500 — which both leaks that the
    // comparison is reached and turns a crafted header into an error path.
    const res = await post(EVENT, { 'x-razorpay-signature': 'ab' });
    expect(res.status).toBe(400);
  });

  it('rejects a non-hex signature without throwing a 500', async () => {
    const res = await post(EVENT, { 'x-razorpay-signature': 'zzzz-not-hex-at-all' });
    expect(res.status).toBe(400);
  });

  it('accepts a correctly signed payload', async () => {
    const res = await post(EVENT, { 'x-razorpay-signature': sign(EVENT) });
    expect(res.status).toBe(200);
  });

  it('verifies the RAW bytes, not a re-serialized object', async () => {
    // Same JSON value, different bytes — extra whitespace, as any proxy
    // or re-serialization step would produce. Razorpay signed the
    // original bytes, so the reformatted body must NOT verify against
    // the original signature. This is the property express.raw() exists
    // to preserve; swapping the route to express.json() breaks it and
    // every real Indian payment starts failing verification.
    const reformatted = JSON.stringify(JSON.parse(EVENT), null, 2);
    expect(reformatted).not.toBe(EVENT);
    const res = await post(reformatted, { 'x-razorpay-signature': sign(EVENT) });
    expect(res.status).toBe(400);

    // ...and the reformatted bytes verify against their OWN signature,
    // confirming the failure above is about bytes and not about content.
    const ok = await post(reformatted, { 'x-razorpay-signature': sign(reformatted) });
    expect(ok.status).toBe(200);
  });

  it('rejects valid-signature-but-invalid-JSON as 400, not 500', async () => {
    const garbage = '{not json at all';
    const res = await post(garbage, { 'x-razorpay-signature': sign(garbage) });
    expect(res.status).toBe(400);
    expect(res.body).toMatch(/Invalid JSON/i);
  });

  it('refuses to process anything when the secret is unset', async () => {
    // A deploy that forgot RAZORPAY_WEBHOOK_SECRET must fail closed. The
    // dangerous alternative — treating "no secret" as "skip verification"
    // — turns a missing env var into an open grant endpoint.
    const saved = process.env.RAZORPAY_WEBHOOK_SECRET;
    delete process.env.RAZORPAY_WEBHOOK_SECRET;
    try {
      const res = await post(EVENT, { 'x-razorpay-signature': sign(EVENT) });
      expect(res.status).toBe(503);
    } finally {
      process.env.RAZORPAY_WEBHOOK_SECRET = saved;
    }
  });
});
