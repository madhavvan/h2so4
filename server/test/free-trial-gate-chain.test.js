// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  FREE-TRIAL GATE CHAIN — the 10-minute trial can never be wrongly blocked
//
//  Regression armor for the 2026-07 free-trial contract. The live incident
//  it guards against: a free US signup WITH trial seconds left getting a
//  403 tier_required on a model route (symptom of a stale server build
//  whose model routes didn't list 'free'). These tests run the EXACT
//  middleware chain the model routes are wired with — pulled from
//  routes/ai.js's test surface, chained in route order against a REAL
//  in-memory license row created the same way auth.js signup creates it —
//  so any refactor that reintroduces the block fails the suite:
//
//    · region gate  (router.use — US/non-IN falls through)
//    · requireTier(...TRIAL_MODELS)  (free carve-out, tier.js:78)
//    · requireTimeRemaining          (402 ONLY at a positively-resolved 0)
//
//  Pinned properties:
//  1. Fresh free signup rows seed trial_remaining_seconds=600 +
//     trial_granted_at, and resolveTimeBucket reads them as {trial, 600}.
//  2. US free + trial seconds → openai/xai/groq/gemini chains ALL pass.
//  3. US free → Claude chain 403s (CLAUDE_TIERS excludes 'free') — the
//     one intended tier block for trial users.
//  4. Post-trial (0s) → 402 no_time_remaining with the TRIAL paywall
//     message — never a 403 tier error.
//  5. The free carve-out runs BEFORE the paid status/expiry checks: a
//     free row's status='trial' (hasAccess=false) and even a past
//     expires_at must not bounce a trial user with seconds left.
//  6. IN policy unchanged: free+trial in IN is still 403
//     subscription_required (do NOT silently grant trial in IN —
//     see TODO(owner-decision) in routes/ai.js).
//  7. requireTimeRemaining fails OPEN on internal errors (live-interview
//     discipline: a DB blip must never kill a session).
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';

process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
process.env.ADMIN_EMAILS = '';            // disable admin bypass everywhere
process.env.DATABASE_PATH = ':memory:';

const require = createRequire(import.meta.url);
const db = require('../src/database.js');
const { requireTier } = require('../src/middleware/tier.js');
const { requireActiveSubscriptionInRegion } = require('../src/middleware/regionGate.js');
const aiRouter = require('../src/routes/ai.js');
const { requireTimeRemaining, geminiQuotaGate, TRIAL_MODELS, CLAUDE_TIERS } = aiRouter._test;

// ── Chain runner ──
// Executes express-style middlewares in order against a shared req.
// Resolves {passed:true} only when EVERY gate called next(); otherwise
// captures the terminal {status, body}. All three gates are synchronous
// (better-sqlite3), but the promise shape keeps this future-proof.
function runChain(middlewares, req) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(b) { resolve({ passed: false, status: this.statusCode, body: b }); return this; },
    };
    let i = 0;
    const next = (err) => {
      if (err) return resolve({ passed: false, status: 500, body: { error: String(err) } });
      const mw = middlewares[i++];
      if (!mw) return resolve({ passed: true, status: 200, body: null });
      try { mw(req, res, next); }
      catch (e) { resolve({ passed: false, status: 500, body: { error: e.message } }); }
    };
    next();
  });
}

// Gate stacks EXACTLY as routes/ai.js wires them (chat + stream mirrors
// use the same factories with the same args):
//   /chat|stream/gemini            → geminiQuotaGate, requireTimeRemaining
//   /chat|stream/openai|xai|groq   → requireTier(...TRIAL_MODELS), requireTimeRemaining
//   /chat|stream/claude            → requireTier(...CLAUDE_TIERS), requireTimeRemaining
// router.use(requireActiveSubscriptionInRegion) runs first on all of them.
const geminiChain = () => [requireActiveSubscriptionInRegion, geminiQuotaGate, requireTimeRemaining];
const trialModelChain = () => [requireActiveSubscriptionInRegion, requireTier(...TRIAL_MODELS), requireTimeRemaining];
const claudeChain = () => [requireActiveSubscriptionInRegion, requireTier(...CLAUDE_TIERS), requireTimeRemaining];

// ── Fixtures ──
// Replicates routes/auth.js signup EXACTLY for the free tier: user row +
// license row (status 'trial', expires_at +30d, sessions_limit 5). The
// trial seeding itself (trial_remaining_seconds / trial_granted_at) is
// createLicense's job — that's part of what we're testing.
let seq = 0;
function freshSignup(tier = 'free', countryCode = 'US', licensePatch = {}) {
  seq += 1;
  const id = `u_trialchain_${seq}`;
  const email = `${id}@test.example`;
  db.createUser({ id, email, name: 'Trial Chain', password: 'pw-123456', tier, country_code: countryCode });
  const isFree = tier === 'free';
  db.createLicense({
    key: `MNC-${id}`,
    user_id: id,
    email,
    tier,
    status: isFree ? 'trial' : 'active',
    country_code: countryCode,
    expires_at: Date.now() + 30 * 24 * 60 * 60 * 1000,
    sessions_limit: isFree ? 5 : 3,
  });
  if (Object.keys(licensePatch).length) {
    const sets = Object.keys(licensePatch).map(k => `${k} = ?`).join(', ');
    db.getDB().prepare(`UPDATE licenses SET ${sets} WHERE user_id = ?`)
      .run(...Object.values(licensePatch), id);
  }
  return { req: { user: { id, email } }, id, email };
}

beforeAll(() => {
  db.getDB(); // force schema creation (lazy singleton)
});

describe('tier constants — the trial contract itself', () => {
  it("TRIAL_MODELS includes 'free' (dropping it re-creates the live bug)", () => {
    expect(TRIAL_MODELS).toContain('free');
    expect(TRIAL_MODELS).toEqual(['free', 'basic', 'pro', 'max', 'ultra', 'enterprise']);
  });
  it("CLAUDE_TIERS excludes 'free' and 'basic' (Claude is Pro+)", () => {
    expect(CLAUDE_TIERS).toEqual(['pro', 'max', 'ultra', 'enterprise']);
    expect(CLAUDE_TIERS).not.toContain('free');
  });
});

describe('fresh free signup — DB seeding', () => {
  it('seeds trial_remaining_seconds=600 + trial_granted_at, bucket resolves {trial, 600}', () => {
    const { id } = freshSignup('free', 'US');
    const license = db.getLicenseByUserId(id);
    expect(license.tier).toBe('free');
    expect(license.status).toBe('trial');
    expect(license.trial_remaining_seconds).toBe(600);
    expect(license.trial_granted_at).toBeGreaterThan(0);
    const bucket = db.resolveTimeBucket(license);
    expect(bucket).toEqual({ source: 'trial', remaining: 600 });
  });
});

describe('US free signup WITH trial seconds — every trial model passes', () => {
  it('openai/xai/groq chain (requireTier TRIAL_MODELS) → passes, license attached', async () => {
    const { req } = freshSignup('free', 'US');
    const r = await runChain(trialModelChain(), req);
    expect(r).toEqual({ passed: true, status: 200, body: null });
    expect(req.license).toBeTruthy();
    expect(req.license.tier).toBe('free');
  });

  it('gemini chain (quota gate, no tier gate) → passes', async () => {
    const { req } = freshSignup('free', 'US');
    const r = await runChain(geminiChain(), req);
    expect(r.passed).toBe(true);
  });

  it('claude chain → 403 tier_required (the ONE intended block for trial users)', async () => {
    const { req } = freshSignup('free', 'US');
    const r = await runChain(claudeChain(), req);
    expect(r.passed).toBe(false);
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('tier_required');
    expect(r.body.current).toBe('free');
    expect(r.body.required).toEqual(CLAUDE_TIERS);
  });

  it("free carve-out ordering: status='trial' (hasAccess=false) must NOT bounce a trial user", async () => {
    // If a refactor moves the hasAccess()/expiry checks ABOVE the free
    // carve-out in requireTier, this fails: free rows sit at status
    // 'trial' forever, which hasAccess() rejects by design.
    const { req } = freshSignup('free', 'US');
    const license = db.getLicenseByUserId(req.user.id);
    expect(license.status).toBe('trial');
    const r = await runChain(trialModelChain(), req);
    expect(r.passed).toBe(true);
  });

  it('even a PAST expires_at must not block free-with-seconds (30-day stamp is UI bookkeeping)', async () => {
    const { req } = freshSignup('free', 'US', { expires_at: Date.now() - 24 * 60 * 60 * 1000 });
    const r = await runChain(trialModelChain(), req);
    expect(r.passed).toBe(true);
  });
});

describe('US free signup POST-trial (0 seconds) — paywall, never a tier error', () => {
  it('trial-model chain → 402 no_time_remaining with the trial paywall message', async () => {
    const { req } = freshSignup('free', 'US', { trial_remaining_seconds: 0 });
    const r = await runChain(trialModelChain(), req);
    expect(r.passed).toBe(false);
    expect(r.status).toBe(402);              // paywall, NOT 403 tier_required
    expect(r.body.error).toBe('no_time_remaining');
    expect(r.body.source).toBe('trial');
    expect(r.body.message).toMatch(/10-minute/i);
  });

  it('gemini chain → same 402 (nothing stays free after the trial)', async () => {
    const { req } = freshSignup('free', 'US', { trial_remaining_seconds: 0 });
    const r = await runChain(geminiChain(), req);
    expect(r.status).toBe(402);
    expect(r.body.error).toBe('no_time_remaining');
  });

  it('claude chain post-trial → still the tier 403 (tier gate sits before the time gate)', async () => {
    const { req } = freshSignup('free', 'US', { trial_remaining_seconds: 0 });
    const r = await runChain(claudeChain(), req);
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('tier_required');
  });
});

describe('IN region policy — UNCHANGED (paid-only, no trial)', () => {
  it('IN free signup WITH trial seconds → 403 subscription_required before any trial gate runs', async () => {
    const { req } = freshSignup('free', 'IN');
    const r = await runChain(trialModelChain(), req);
    expect(r.passed).toBe(false);
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('subscription_required');
  });

  it('IN active basic passes (paid access in IN unaffected)', async () => {
    const { req } = freshSignup('basic', 'IN', {
      credits_remaining_seconds: 1800,
      credits_expire_at: Date.now() + 14 * 24 * 60 * 60 * 1000,
    });
    const r = await runChain(trialModelChain(), req);
    expect(r.passed).toBe(true);
  });
});

describe('paid tiers through the same chains (no collateral damage)', () => {
  it('US basic with credits → trial-model chain passes; claude chain 403s', async () => {
    const { req } = freshSignup('basic', 'US', {
      credits_remaining_seconds: 1800,
      credits_expire_at: Date.now() + 14 * 24 * 60 * 60 * 1000,
    });
    expect((await runChain(trialModelChain(), req)).passed).toBe(true);
    const claude = await runChain(claudeChain(), { user: req.user });
    expect(claude.status).toBe(403);
    expect(claude.body.error).toBe('tier_required');
  });

  it('US pro with credits → claude chain passes', async () => {
    const { req } = freshSignup('pro', 'US', {
      credits_remaining_seconds: 3600,
      credits_expire_at: Date.now() + 14 * 24 * 60 * 60 * 1000,
    });
    const r = await runChain(claudeChain(), req);
    expect(r.passed).toBe(true);
  });

  it('US basic with 0 credits → 402 no_time_remaining (source credits)', async () => {
    const { req } = freshSignup('basic', 'US', {
      credits_remaining_seconds: 0,
      credits_expire_at: Date.now() + 14 * 24 * 60 * 60 * 1000,
    });
    const r = await runChain(trialModelChain(), req);
    expect(r.status).toBe(402);
    expect(r.body.source).toBe('credits');
  });

  it('US enterprise → unlimited, claude chain passes with no time gate', async () => {
    const { req } = freshSignup('enterprise', 'US');
    const r = await runChain(claudeChain(), req);
    expect(r.passed).toBe(true);
  });

  // 2026-08: Ultra is metered (9 h/cycle), so it goes through the time gate
  // like any pass — with an allowance it passes, at zero it 402s. Before this
  // change Ultra short-circuited to 'unlimited' and never reached either.
  it('US ultra with allowance → claude chain passes on the credit bucket', async () => {
    const { req } = freshSignup('ultra', 'US', {
      credits_remaining_seconds: 9 * 60 * 60,
      credits_expire_at: 0,
      expires_at: -1,
    });
    const r = await runChain(claudeChain(), req);
    expect(r.passed).toBe(true);
  });

  it('US ultra at 0 seconds → 402 no_time_remaining (source credits)', async () => {
    const { req } = freshSignup('ultra', 'US', {
      credits_remaining_seconds: 0,
      credits_expire_at: 0,
      expires_at: -1,
    });
    const r = await runChain(claudeChain(), req);
    expect(r.status).toBe(402);
    expect(r.body.source).toBe('credits');
  });
});

describe('requireTimeRemaining failure discipline', () => {
  it('fails OPEN when the bucket resolver throws (live-interview rule)', async () => {
    const { req } = freshSignup('free', 'US');
    const orig = db.resolveTimeBucket;
    db.resolveTimeBucket = () => { throw new Error('synthetic DB blip'); };
    try {
      const r = await runChain([requireTimeRemaining], req);
      expect(r.passed).toBe(true); // let the request through, never 5xx a live session
    } finally {
      db.resolveTimeBucket = orig;
    }
  });

  it('denies ONLY on a positively-resolved empty bucket (0 seconds)', async () => {
    const { req } = freshSignup('free', 'US', { trial_remaining_seconds: 1 });
    // 1 second left → still allowed. The 402 fires at exactly 0.
    expect((await runChain([requireTimeRemaining], req)).passed).toBe(true);
    db.getDB().prepare('UPDATE licenses SET trial_remaining_seconds = 0 WHERE user_id = ?').run(req.user.id);
    const r = await runChain([requireTimeRemaining], { user: req.user });
    expect(r.status).toBe(402);
  });
});
