// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  requireActiveSubscriptionInRegion — IN-region paid-only gate
//
//  Policy (May 2026): Indian users must hold an active paid
//  subscription to access any AI feature. Free, trial, expired,
//  refunded, paused all return 403. Active, canceling (cycle-end
//  pending), and past_due (Razorpay retry window) pass through.
//
//  Same monkey-patch pattern as tier-middleware.test.js — replace
//  database module exports BEFORE the middleware binds them.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

process.env.JWT_SECRET = 'test-secret';
process.env.ADMIN_EMAILS = 'admin@minicaai.com';
process.env.DATABASE_PATH = ':memory:';

const require = createRequire(import.meta.url);
const dbMod = require('../src/database.js');

const mockGetUserById = vi.fn();
const mockGetLicense = vi.fn();
dbMod.getUserById = mockGetUserById;
dbMod.getLicenseByUserId = mockGetLicense;

const { requireActiveSubscriptionInRegion, regionRequiresPaidSubscription } =
  require('../src/middleware/regionGate.js');

function makeReqRes(email = 'user@example.com') {
  const req = { user: { id: 'u_test', email } };
  const status = vi.fn().mockReturnThis();
  const json = vi.fn().mockReturnThis();
  return { req, res: { status, json } };
}

beforeEach(() => {
  mockGetUserById.mockReset();
  mockGetLicense.mockReset();
});

describe('regionRequiresPaidSubscription', () => {
  it('returns true for IN', () => {
    expect(regionRequiresPaidSubscription('IN')).toBe(true);
    expect(regionRequiresPaidSubscription('in')).toBe(true);
  });
  it('returns false for US, GB, etc.', () => {
    expect(regionRequiresPaidSubscription('US')).toBe(false);
    expect(regionRequiresPaidSubscription('GB')).toBe(false);
    expect(regionRequiresPaidSubscription('')).toBe(false);
    expect(regionRequiresPaidSubscription(null)).toBe(false);
  });
});

describe('requireActiveSubscriptionInRegion — non-IN users (no gate)', () => {
  it('US free user passes — gate doesnt apply', () => {
    mockGetUserById.mockReturnValue({ id: 'u', country_code: 'US' });
    const { req, res } = makeReqRes();
    const next = vi.fn();
    requireActiveSubscriptionInRegion(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('GB Pro user passes', () => {
    mockGetUserById.mockReturnValue({ id: 'u', country_code: 'GB' });
    const { req, res } = makeReqRes();
    const next = vi.fn();
    requireActiveSubscriptionInRegion(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('user with no country defaults to US (no gate)', () => {
    mockGetUserById.mockReturnValue({ id: 'u' });  // no country_code
    const { req, res } = makeReqRes();
    const next = vi.fn();
    requireActiveSubscriptionInRegion(req, res, next);
    expect(next).toHaveBeenCalled();
  });
});

describe('requireActiveSubscriptionInRegion — IN admin bypass', () => {
  it('IN admin email passes regardless of license', () => {
    mockGetUserById.mockReturnValue({ id: 'u', country_code: 'IN' });
    // No license fetched — admin bypass is the first check
    const { req, res } = makeReqRes('admin@minicaai.com');
    const next = vi.fn();
    requireActiveSubscriptionInRegion(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(mockGetLicense).not.toHaveBeenCalled();
  });
});

describe('requireActiveSubscriptionInRegion — IN gate denials', () => {
  beforeEach(() => {
    mockGetUserById.mockReturnValue({ id: 'u', country_code: 'IN' });
  });

  it('IN free user → 403 subscription_required', () => {
    mockGetLicense.mockReturnValue({ tier: 'free', status: 'active' });
    const { req, res } = makeReqRes();
    const next = vi.fn();
    requireActiveSubscriptionInRegion(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      error: 'subscription_required',
      region: 'IN',
      current_tier: 'free',
    }));
    expect(next).not.toHaveBeenCalled();
  });

  it('IN trial user (status=trial) → 403', () => {
    mockGetLicense.mockReturnValue({ tier: 'free', status: 'trial', expires_at: Date.now() + 1e9 });
    const { req, res } = makeReqRes();
    const next = vi.fn();
    requireActiveSubscriptionInRegion(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('IN expired Pro user → 403', () => {
    mockGetLicense.mockReturnValue({ tier: 'pro', status: 'expired', expires_at: Date.now() - 1e9 });
    const { req, res } = makeReqRes();
    const next = vi.fn();
    requireActiveSubscriptionInRegion(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('IN refunded user → 403', () => {
    mockGetLicense.mockReturnValue({ tier: 'free', status: 'refunded', expires_at: Date.now() });
    const { req, res } = makeReqRes();
    const next = vi.fn();
    requireActiveSubscriptionInRegion(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('IN paused user → 403', () => {
    mockGetLicense.mockReturnValue({ tier: 'pro', status: 'paused', expires_at: Date.now() });
    const { req, res } = makeReqRes();
    const next = vi.fn();
    requireActiveSubscriptionInRegion(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('IN user with no license → 403', () => {
    mockGetLicense.mockReturnValue(null);
    const { req, res } = makeReqRes();
    const next = vi.fn();
    requireActiveSubscriptionInRegion(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      error: 'subscription_required',
      current_tier: 'none',
    }));
    expect(next).not.toHaveBeenCalled();
  });

  it('IN active Pro user but expires_at in past → 403', () => {
    // Stale row that hasn't had its expiry webhook arrive yet.
    mockGetLicense.mockReturnValue({ tier: 'pro', status: 'active', expires_at: Date.now() - 1000 });
    const { req, res } = makeReqRes();
    const next = vi.fn();
    requireActiveSubscriptionInRegion(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('requireActiveSubscriptionInRegion — IN gate passes', () => {
  beforeEach(() => {
    mockGetUserById.mockReturnValue({ id: 'u', country_code: 'IN' });
  });

  it('IN active Pro user → next', () => {
    mockGetLicense.mockReturnValue({ tier: 'pro', status: 'active', expires_at: -1 });
    const { req, res } = makeReqRes();
    const next = vi.fn();
    requireActiveSubscriptionInRegion(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.license).toEqual(expect.objectContaining({ tier: 'pro' }));
  });

  it('IN active Max user → next', () => {
    mockGetLicense.mockReturnValue({ tier: 'max', status: 'active', expires_at: -1 });
    const { req, res } = makeReqRes();
    const next = vi.fn();
    requireActiveSubscriptionInRegion(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('IN canceling Pro user (still in cycle) → next', () => {
    // User canceled but expires_at is in the future — they paid for this
    // cycle; access continues until expires_at.
    mockGetLicense.mockReturnValue({ tier: 'pro', status: 'canceling', expires_at: Date.now() + 1e9 });
    const { req, res } = makeReqRes();
    const next = vi.fn();
    requireActiveSubscriptionInRegion(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('IN past_due Pro user (Razorpay retry window) → next', () => {
    // Card failed but Razorpay is still retrying. User keeps access during
    // grace period; if final retry fails, subscription.halted will flip
    // status='expired' and the gate then rejects.
    mockGetLicense.mockReturnValue({ tier: 'pro', status: 'past_due', expires_at: Date.now() + 1e9 });
    const { req, res } = makeReqRes();
    const next = vi.fn();
    requireActiveSubscriptionInRegion(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('IN active Basic user → next', () => {
    mockGetLicense.mockReturnValue({ tier: 'basic', status: 'active', expires_at: Date.now() + 1e9 });
    const { req, res } = makeReqRes();
    const next = vi.fn();
    requireActiveSubscriptionInRegion(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('IN Pro user with expires_at = -1 (recurring, no fixed end) → next', () => {
    mockGetLicense.mockReturnValue({ tier: 'pro', status: 'active', expires_at: -1 });
    const { req, res } = makeReqRes();
    const next = vi.fn();
    requireActiveSubscriptionInRegion(req, res, next);
    expect(next).toHaveBeenCalled();
  });
});

describe('requireActiveSubscriptionInRegion — fail-closed on internal error', () => {
  it('returns 500 when DB throws', () => {
    mockGetUserById.mockImplementation(() => { throw new Error('disk full'); });
    const { req, res } = makeReqRes();
    const next = vi.fn();
    requireActiveSubscriptionInRegion(req, res, next);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(next).not.toHaveBeenCalled();
  });
});
