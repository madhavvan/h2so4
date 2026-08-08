// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  A VERIFIED PAYMENT IS NOT AUTOMATICALLY *YOUR* PAYMENT.
//
//  /verify-razorpay checked the HMAC over `order_id|payment_id` and then
//  granted the tier it read out of the order's notes. The signature is
//  computed with OUR secret, so it verifies identically for whoever
//  presents it — it proves Razorpay issued the payment, not that the
//  caller is who it was issued to.
//
//  So one real purchase upgraded any number of accounts: pay once, hand
//  {order_id, payment_id, signature} to a friend, and their
//  /verify-razorpay grants them the tier too. The duplicate-payment
//  guard does not stop it — that is keyed per user_id, so the second
//  account looks like a first-time verification.
//
//  All four order/subscription create sites stamp notes.user_id and
//  notes.user_email; the verify route simply never read them back.
//
//  Razorpay is stubbed; no network, no money.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import http from 'node:http';

const require = createRequire(import.meta.url);

const RZP_SECRET = 'test-razorpay-key-secret';
process.env.JWT_SECRET = 'test-secret-payment-ownership';
process.env.RAZORPAY_KEY_SECRET = RZP_SECRET;
process.env.RAZORPAY_KEY_ID = 'rzp_test_key';
process.env.DATABASE_PATH = ':memory:';
process.env.ADMIN_EMAILS = '';

const PAYER = { id: 'u_payer', email: 'payer@example.com', tier: 'free' };
const FREELOADER = { id: 'u_freeloader', email: 'freeloader@example.com', tier: 'free' };

// The order the PAYER actually created and paid for.
const ORDER = {
  id: 'order_realpayment',
  amount: 419900,
  notes: { user_id: PAYER.id, user_email: PAYER.email, tier: 'pro' },
};

const dbMod = require('../src/database.js');
let granted = [];
dbMod.getUserById = (id) => [PAYER, FREELOADER].find((u) => u.id === id) || null;
dbMod.getLicenseByUserId = () => ({ tier: 'free', status: 'trial', key: 'MNC-TEST' });
dbMod.getDB = () => ({
  prepare: () => ({ get: () => null, run: () => {}, all: () => [] }),
  transaction: (fn) => fn,
});
dbMod.recordPayment = (p) => { granted.push(p); };
dbMod.logAdminAction = () => {};

// Stub the Razorpay SDK before payments.js constructs its client.
const rzpPath = (() => {
  try { return require.resolve('razorpay'); } catch { return 'razorpay-stub'; }
})();
require.cache[rzpPath] = {
  id: rzpPath,
  filename: rzpPath,
  loaded: true,
  exports: class {
    constructor() {
      this.orders = { fetch: async (id) => (id === ORDER.id ? ORDER : { id, notes: {} }) };
      this.subscriptions = { fetch: async (id) => ({ id, notes: {} }) };
    }
  },
};

const { generateToken } = require('../src/middleware/auth.js');
const paymentsRouter = require('../src/routes/payments.js');

let srv;
let port;

beforeAll(async () => {
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/v1/payments', paymentsRouter);
  srv = app.listen(0);
  await new Promise((r) => srv.once('listening', r));
  port = srv.address().port;
});

afterAll(() => { try { srv.close(); } catch { /* already down */ } });
beforeEach(() => { granted = []; });

function orderSignature(orderId, paymentId) {
  return crypto.createHmac('sha256', RZP_SECRET).update(`${orderId}|${paymentId}`).digest('hex');
}

function verifyAs(user, body) {
  const payload = JSON.stringify(body);
  const token = generateToken({ id: user.id, email: user.email, tier: user.tier });
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/api/v1/payments/verify-razorpay',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          Authorization: `Bearer ${token}`,
        },
      },
      (r) => {
        let text = '';
        r.on('data', (c) => { text += c; });
        r.on('end', () => {
          let json = null;
          try { json = JSON.parse(text); } catch { /* non-JSON */ }
          resolve({ status: r.statusCode, json, text });
        });
      },
    );
    req.write(payload);
    req.end();
  });
}

const REAL_PAYMENT = {
  razorpay_order_id: ORDER.id,
  razorpay_payment_id: 'pay_realpayment',
  razorpay_signature: orderSignature(ORDER.id, 'pay_realpayment'),
};

describe('/verify-razorpay ownership', () => {
  it('refuses a genuinely-signed payment presented by a different account', async () => {
    // Every field here is authentic — this is the payer's real order id,
    // real payment id and real signature. The ONLY thing wrong is who is
    // presenting it. That has to be enough to refuse.
    const res = await verifyAs(FREELOADER, REAL_PAYMENT);
    expect(res.status).toBe(403);
    expect(res.json.error).toMatch(/different account/i);
    expect(granted).toEqual([]);
  });

  it('still accepts it from the account that actually paid', async () => {
    // The check must not be so blunt that it breaks the real purchase.
    const res = await verifyAs(PAYER, REAL_PAYMENT);
    expect(res.status).toBeLessThan(400);
  });

  it('refuses an order that carries no owner stamp at all', async () => {
    // An order this server did not create. Granting on a tier read out of
    // a stranger's notes is the failure this guards against, so the safe
    // answer is to refuse rather than to fall through.
    const orphanId = 'order_not_ours';
    const res = await verifyAs(FREELOADER, {
      razorpay_order_id: orphanId,
      razorpay_payment_id: 'pay_orphan',
      razorpay_signature: orderSignature(orphanId, 'pay_orphan'),
    });
    expect(res.status).toBe(403);
    expect(granted).toEqual([]);
  });

  it('still rejects a bad signature before ownership is even considered', async () => {
    // Ownership is an ADDITIONAL gate, not a replacement for the HMAC.
    const res = await verifyAs(PAYER, {
      ...REAL_PAYMENT,
      razorpay_signature: 'deadbeef'.repeat(8),
    });
    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/verification failed/i);
  });

  it('rejects a missing signature', async () => {
    const res = await verifyAs(PAYER, {
      razorpay_order_id: ORDER.id,
      razorpay_payment_id: 'pay_realpayment',
    });
    expect(res.status).toBe(400);
  });
});
