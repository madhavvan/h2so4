// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  requireTier middleware
//
//  Gates per-tier API access. A regression here = free users
//  hitting Claude Sonnet endpoints, eating Anthropic margin at
//  $0.05+/min. Pin the contract: free → blocked from PAID, pro →
//  blocked from MAX_ONLY, max → allowed everywhere. The middleware
//  reads tier from the LICENSE row, not the JWT — we monkey-patch
//  the database module property after-import so tier.js's `db`
//  reference (bound at require time) sees our test stub.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

process.env.JWT_SECRET = 'test-secret';
process.env.ADMIN_EMAILS = '';            // disable admin bypass
process.env.DATABASE_PATH = ':memory:';   // in-memory SQLite for the import to succeed

const require = createRequire(import.meta.url);
// Load the real database module FIRST so we can patch it before tier.js
// captures its `db` reference. Both modules see the same exports object,
// so reassigning a property here is visible to tier.js.
const dbMod = require('../src/database.js');
const origGetLicense = dbMod.getLicenseByUserId;
const mockGetLicense = vi.fn();
dbMod.getLicenseByUserId = mockGetLicense;

// Now load tier.js — its `const db = require('../database')` binds to
// dbMod, and our mockGetLicense is what it calls.
const { requireTier } = require('../src/middleware/tier.js');

const PAID = ['basic', 'pro', 'max'];
const MAX_ONLY = ['max'];

function makeReqRes() {
  const req = { user: { id: 'u', email: 'u@test' } };
  const status = vi.fn().mockReturnThis();
  const json = vi.fn().mockReturnThis();
  return { req, res: { status, json } };
}

describe('requireTier', () => {
  beforeEach(() => {
    mockGetLicense.mockReset();
  });

  it('PAID: free → 403', () => {
    mockGetLicense.mockReturnValue({ tier: 'free', status: 'active' });
    const { req, res } = makeReqRes();
    const next = vi.fn();
    requireTier(...PAID)(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('PAID: basic → next', () => {
    mockGetLicense.mockReturnValue({ tier: 'basic', status: 'active' });
    const { req, res } = makeReqRes();
    const next = vi.fn();
    requireTier(...PAID)(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('PAID: pro → next', () => {
    mockGetLicense.mockReturnValue({ tier: 'pro', status: 'active' });
    const { req, res } = makeReqRes();
    const next = vi.fn();
    requireTier(...PAID)(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('PAID: max → next', () => {
    mockGetLicense.mockReturnValue({ tier: 'max', status: 'active' });
    const { req, res } = makeReqRes();
    const next = vi.fn();
    requireTier(...PAID)(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('MAX_ONLY: free → 403', () => {
    mockGetLicense.mockReturnValue({ tier: 'free', status: 'active' });
    const { req, res } = makeReqRes();
    const next = vi.fn();
    requireTier(...MAX_ONLY)(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('MAX_ONLY: basic → 403', () => {
    mockGetLicense.mockReturnValue({ tier: 'basic', status: 'active' });
    const { req, res } = makeReqRes();
    const next = vi.fn();
    requireTier(...MAX_ONLY)(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('MAX_ONLY: pro → 403', () => {
    mockGetLicense.mockReturnValue({ tier: 'pro', status: 'active' });
    const { req, res } = makeReqRes();
    const next = vi.fn();
    requireTier(...MAX_ONLY)(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('MAX_ONLY: max → next', () => {
    mockGetLicense.mockReturnValue({ tier: 'max', status: 'active' });
    const { req, res } = makeReqRes();
    const next = vi.fn();
    requireTier(...MAX_ONLY)(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('rejects when no license row found (returns null)', () => {
    mockGetLicense.mockReturnValue(null);
    const { req, res } = makeReqRes();
    const next = vi.fn();
    requireTier(...PAID)(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('throws if called with empty allowedTiers (caller bug)', () => {
    expect(() => requireTier()).toThrow(/no allowed tiers/i);
  });
});
