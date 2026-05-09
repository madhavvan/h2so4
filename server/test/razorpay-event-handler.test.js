// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  handleRazorpayEvent — webhook handler unit tests
//
//  Covers every fix from the Razorpay audit:
//    • P0-B: payment.captured & payment.failed gate stale events
//    • P1-B: subscription.completed downgrades user (12-cycle natural end)
//    • P1-C: subscription.updated swaps tier on plan change
//    • P1-D: payment.failed flips to status='past_due'
//    • P1-F: subscription.charged dedup vs /verify-razorpay race
//    • New handlers: subscription.paused / .resumed / .activated
//
//  Pattern: monkey-patch the database module's exports BEFORE webhooks.js
//  binds `const db = require('../database')`. Same pattern as
//  tier-middleware.test.js — webhooks.js's module-level `db` reference
//  resolves to the mutated dbMod, so our spies receive every call.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';

process.env.JWT_SECRET = 'test-secret';
process.env.DATABASE_PATH = ':memory:';
process.env.RAZORPAY_PLAN_ID_PRO = 'plan_test_pro';
process.env.RAZORPAY_PLAN_ID_MAX = 'plan_test_max';

const require = createRequire(import.meta.url);
const dbMod = require('../src/database.js');

// Replace every db function that handleRazorpayEvent might call.
const mocks = {
  getUserByEmail: vi.fn(),
  getUserById: vi.fn(),
  getLicenseByUserId: vi.fn(),
  gateAndRecordEventForUser: vi.fn(),
  updateUserTier: vi.fn(),
  updateLicenseOnPayment: vi.fn(),
  recordPayment: vi.fn(),
  isPaymentAlreadyRecorded: vi.fn(),
  grantBasicRenewal: vi.fn(),
  getDB: vi.fn(),
};
for (const [k, v] of Object.entries(mocks)) {
  dbMod[k] = v;
}

// Now load webhooks.js — its top-level `db` is the same dbMod, so all
// our patched functions are visible to the handlers.
const webhookRouter = require('../src/routes/webhooks.js');
const { handleRazorpayEvent } = webhookRouter._test;

// Build a fake getDB() return — used for the in-tx prepared-statement
// dedup checks inside payment.captured and subscription.charged. The
// transaction wrapper is a passthrough so the handler body runs synchronously.
function makeFakeDB({ inTxDup = false } = {}) {
  const prepare = vi.fn(() => ({
    run: vi.fn(),
    get: vi.fn(() => (inTxDup ? { id: 1 } : undefined)),
  }));
  const transaction = (fn) => () => fn();  // execute the body inline
  return { prepare, transaction };
}

const TEST_USER = { id: 'user_1', email: 'test@example.com' };
const TEST_LICENSE_ACTIVE = { tier: 'pro', status: 'active', expires_at: -1, sessions_limit: 30 };

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  // Default: gate accepts (so the happy-path tests don't have to set this)
  mocks.gateAndRecordEventForUser.mockReturnValue({ accept: true });
  // Default: no payment dedup match (pre-tx + in-tx)
  mocks.isPaymentAlreadyRecorded.mockReturnValue(false);
  mocks.getUserByEmail.mockReturnValue(TEST_USER);
  mocks.getUserById.mockReturnValue(TEST_USER);
  mocks.getLicenseByUserId.mockReturnValue(TEST_LICENSE_ACTIVE);
  mocks.getDB.mockReturnValue(makeFakeDB());
});

// ─── P1-B: subscription.completed downgrades user ───
describe('subscription.completed', () => {
  it('downgrades user to free + status=expired + records audit payment row', async () => {
    await handleRazorpayEvent({
      event: 'subscription.completed',
      created_at: Math.floor(Date.now() / 1000),
      payload: {
        subscription: {
          entity: { id: 'sub_done', plan_id: 'plan_test_pro', notes: { user_email: TEST_USER.email } },
        },
      },
    });

    expect(mocks.updateUserTier).toHaveBeenCalledWith(TEST_USER.id, 'free');
    expect(mocks.updateLicenseOnPayment).toHaveBeenCalledWith(TEST_USER.id, expect.objectContaining({
      tier: 'free',
      status: 'expired',
    }));
    expect(mocks.recordPayment).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'razorpay',
      status: 'completed_naturally',
      tier_granted: 'free',
      metadata: expect.objectContaining({ event: 'subscription.completed' }),
    }));
  });

  it('respects the out-of-order gate (stale event ignored)', async () => {
    mocks.gateAndRecordEventForUser.mockReturnValue({ accept: false, reason: 'out_of_order' });
    await handleRazorpayEvent({
      event: 'subscription.completed',
      created_at: 1,
      payload: { subscription: { entity: { id: 'sub_x', notes: { user_email: TEST_USER.email } } } },
    });
    expect(mocks.updateUserTier).not.toHaveBeenCalled();
    expect(mocks.recordPayment).not.toHaveBeenCalled();
  });
});

// ─── P1-C: subscription.updated swaps tier ───
describe('subscription.updated', () => {
  it('swaps tier when plan_id changes Max → Pro', async () => {
    mocks.getLicenseByUserId.mockReturnValue({ ...TEST_LICENSE_ACTIVE, tier: 'max' });
    await handleRazorpayEvent({
      event: 'subscription.updated',
      created_at: Math.floor(Date.now() / 1000),
      payload: {
        subscription: {
          entity: {
            id: 'sub_swap',
            plan_id: 'plan_test_pro',  // new plan = Pro
            notes: { user_email: TEST_USER.email },
          },
        },
      },
    });

    expect(mocks.updateUserTier).toHaveBeenCalledWith(TEST_USER.id, 'pro');
    expect(mocks.updateLicenseOnPayment).toHaveBeenCalledWith(TEST_USER.id, expect.objectContaining({
      tier: 'pro',
      status: 'active',
    }));
  });

  it('no-op when tier unchanged (e.g. quantity-only update)', async () => {
    // license already pro, plan_id maps to pro → no change
    await handleRazorpayEvent({
      event: 'subscription.updated',
      created_at: Math.floor(Date.now() / 1000),
      payload: {
        subscription: {
          entity: { id: 'sub_noop', plan_id: 'plan_test_pro', notes: { user_email: TEST_USER.email } },
        },
      },
    });
    expect(mocks.updateUserTier).not.toHaveBeenCalled();
  });

  it('preserves past_due status if already past_due (no false-active flip)', async () => {
    mocks.getLicenseByUserId.mockReturnValue({ ...TEST_LICENSE_ACTIVE, tier: 'max', status: 'past_due' });
    await handleRazorpayEvent({
      event: 'subscription.updated',
      created_at: Math.floor(Date.now() / 1000),
      payload: {
        subscription: {
          entity: { id: 'sub_past', plan_id: 'plan_test_pro', notes: { user_email: TEST_USER.email } },
        },
      },
    });
    expect(mocks.updateLicenseOnPayment).toHaveBeenCalledWith(TEST_USER.id, expect.objectContaining({
      status: 'past_due',
    }));
  });

  it('no-op when plan_id is unknown (env not configured)', async () => {
    await handleRazorpayEvent({
      event: 'subscription.updated',
      created_at: Math.floor(Date.now() / 1000),
      payload: {
        subscription: {
          entity: { id: 'sub_unk', plan_id: 'plan_NEVER_HEARD_OF', notes: { user_email: TEST_USER.email } },
        },
      },
    });
    expect(mocks.updateUserTier).not.toHaveBeenCalled();
  });
});

// ─── subscription.paused / .resumed ───
describe('subscription.paused', () => {
  it('flips license to status=paused, expires_at=now', async () => {
    await handleRazorpayEvent({
      event: 'subscription.paused',
      created_at: Math.floor(Date.now() / 1000),
      payload: { subscription: { entity: { id: 'sub_pause', notes: { user_email: TEST_USER.email } } } },
    });
    expect(mocks.updateLicenseOnPayment).toHaveBeenCalledWith(TEST_USER.id, expect.objectContaining({
      status: 'paused',
    }));
  });
});

describe('subscription.resumed', () => {
  it('re-grants tier with status=active', async () => {
    await handleRazorpayEvent({
      event: 'subscription.resumed',
      created_at: Math.floor(Date.now() / 1000),
      payload: {
        subscription: {
          entity: { id: 'sub_resume', plan_id: 'plan_test_pro', notes: { user_email: TEST_USER.email } },
        },
      },
    });
    expect(mocks.updateUserTier).toHaveBeenCalledWith(TEST_USER.id, 'pro');
    expect(mocks.updateLicenseOnPayment).toHaveBeenCalledWith(TEST_USER.id, expect.objectContaining({
      tier: 'pro', status: 'active',
    }));
  });
});

// ─── P0-B: payment.captured gate ───
describe('payment.captured — out-of-order gate (P0-B)', () => {
  it('rejects stale event arriving after subscription.cancelled', async () => {
    mocks.gateAndRecordEventForUser.mockReturnValue({ accept: false, reason: 'out_of_order' });
    await handleRazorpayEvent({
      event: 'payment.captured',
      created_at: 1,  // way old
      payload: {
        payment: {
          entity: {
            id: 'pay_stale',
            amount: 249900,
            currency: 'INR',
            notes: { user_email: TEST_USER.email, tier: 'pro' },
          },
        },
      },
    });
    // No tier grant should fire
    expect(mocks.updateUserTier).not.toHaveBeenCalled();
    expect(mocks.recordPayment).not.toHaveBeenCalled();
    expect(mocks.isPaymentAlreadyRecorded).not.toHaveBeenCalled();  // gate ran first
  });

  it('processes fresh event normally', async () => {
    await handleRazorpayEvent({
      event: 'payment.captured',
      created_at: Math.floor(Date.now() / 1000),
      payload: {
        payment: {
          entity: {
            id: 'pay_fresh',
            amount: 249900,
            currency: 'INR',
            notes: { user_email: TEST_USER.email, tier: 'pro' },
          },
        },
      },
    });
    expect(mocks.updateUserTier).toHaveBeenCalledWith(TEST_USER.id, 'pro');
  });
});

// ─── P1-D: payment.failed flips to past_due ───
describe('payment.failed → past_due (P1-D)', () => {
  it('flips license from active → past_due', async () => {
    await handleRazorpayEvent({
      event: 'payment.failed',
      created_at: Math.floor(Date.now() / 1000),
      payload: {
        payment: {
          entity: {
            id: 'pay_failed',
            amount: 249900,
            currency: 'INR',
            error_description: 'Card declined',
            notes: { user_email: TEST_USER.email, tier: 'pro' },
          },
        },
      },
    });
    expect(mocks.updateLicenseOnPayment).toHaveBeenCalledWith(TEST_USER.id, expect.objectContaining({
      tier: 'pro',
      status: 'past_due',
    }));
    expect(mocks.recordPayment).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
  });

  it('does NOT flip if license is already canceling (avoid resurrecting a canceling sub)', async () => {
    mocks.getLicenseByUserId.mockReturnValue({ ...TEST_LICENSE_ACTIVE, status: 'canceling' });
    await handleRazorpayEvent({
      event: 'payment.failed',
      created_at: Math.floor(Date.now() / 1000),
      payload: {
        payment: {
          entity: { id: 'pay_failed2', amount: 1, notes: { user_email: TEST_USER.email } },
        },
      },
    });
    // Status should NOT change (only flips when status === 'active')
    expect(mocks.updateLicenseOnPayment).not.toHaveBeenCalled();
  });

  it('respects the out-of-order gate', async () => {
    mocks.gateAndRecordEventForUser.mockReturnValue({ accept: false, reason: 'out_of_order' });
    await handleRazorpayEvent({
      event: 'payment.failed',
      created_at: 1,
      payload: {
        payment: { entity: { id: 'pay_x', notes: { user_email: TEST_USER.email } } },
      },
    });
    expect(mocks.recordPayment).not.toHaveBeenCalled();
    expect(mocks.updateLicenseOnPayment).not.toHaveBeenCalled();
  });
});

// ─── P1-F: subscription.charged dedup vs /verify-razorpay race ───
describe('subscription.charged dedup (P1-F)', () => {
  it('skips when isPaymentAlreadyRecorded returns true (pre-tx)', async () => {
    mocks.isPaymentAlreadyRecorded.mockReturnValue(true);
    await handleRazorpayEvent({
      event: 'subscription.charged',
      created_at: Math.floor(Date.now() / 1000),
      payload: {
        subscription: {
          entity: { id: 'sub_charge', plan_id: 'plan_test_pro', notes: { user_email: TEST_USER.email } },
        },
        payment: { entity: { id: 'pay_already_done', amount: 249900 } },
      },
    });
    expect(mocks.updateUserTier).not.toHaveBeenCalled();
    expect(mocks.recordPayment).not.toHaveBeenCalled();
  });

  it('skips when in-tx dedup match (race won by /verify-razorpay)', async () => {
    // pre-tx says no, but in-tx finds a row (mid-flight by /verify-razorpay)
    mocks.isPaymentAlreadyRecorded.mockReturnValue(false);
    mocks.getDB.mockReturnValue(makeFakeDB({ inTxDup: true }));
    await handleRazorpayEvent({
      event: 'subscription.charged',
      created_at: Math.floor(Date.now() / 1000),
      payload: {
        subscription: {
          entity: { id: 'sub_race', plan_id: 'plan_test_pro', notes: { user_email: TEST_USER.email } },
        },
        payment: { entity: { id: 'pay_race', amount: 249900 } },
      },
    });
    // Body of tx returned early via alreadyGranted=true → no mutation
    expect(mocks.updateUserTier).not.toHaveBeenCalled();
    expect(mocks.updateLicenseOnPayment).not.toHaveBeenCalled();
    expect(mocks.recordPayment).not.toHaveBeenCalled();
  });

  it('grants tier when no dedup match (happy path)', async () => {
    await handleRazorpayEvent({
      event: 'subscription.charged',
      created_at: Math.floor(Date.now() / 1000),
      payload: {
        subscription: {
          entity: { id: 'sub_first', plan_id: 'plan_test_pro', notes: { user_email: TEST_USER.email } },
        },
        payment: { entity: { id: 'pay_first', amount: 249900, currency: 'INR' } },
      },
    });
    expect(mocks.updateUserTier).toHaveBeenCalledWith(TEST_USER.id, 'pro');
    expect(mocks.recordPayment).toHaveBeenCalledWith(expect.objectContaining({
      status: 'completed',
      tier_granted: 'pro',
    }));
  });
});

// ─── Lifecycle audit-only events ───
describe('subscription.activated / authenticated / pending — audit-only', () => {
  for (const event of ['subscription.activated', 'subscription.authenticated', 'subscription.pending']) {
    it(`${event} is logged only — no mutation`, async () => {
      await handleRazorpayEvent({
        event,
        created_at: Math.floor(Date.now() / 1000),
        payload: { subscription: { entity: { id: 'sub_x', notes: { user_email: TEST_USER.email } } } },
      });
      expect(mocks.updateUserTier).not.toHaveBeenCalled();
      expect(mocks.updateLicenseOnPayment).not.toHaveBeenCalled();
      expect(mocks.recordPayment).not.toHaveBeenCalled();
    });
  }
});
