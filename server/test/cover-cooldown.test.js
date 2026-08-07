// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  A PROVIDER THAT IS OUT OF QUOTA MUST STOP COSTING LATENCY.
//
//  Measured in the running app, 2026-08-06, both free tiers exhausted:
//
//    [cover] NO COVER — 3/3 provider(s) raced in 1501ms (budget 1200ms):
//      groq: 429 Rate limit reached / gemini: 429 quota exceeded /
//      haiku: no first token within 900ms
//
//  routes/ai.js does `await runCover(...)` BEFORE it calls OpenAI, so
//  that 1,501ms sat in front of an answer that was ready to start — and
//  it bought nothing, because both 429s were certain before the request
//  was made. The cover, whose entire purpose is removing dead air, was
//  the largest single source of it.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const cover = require('../src/services/coverAnswer.js');
const { streamCoverAnswer, _resetProviderCooldowns, _providerCooldowns, isQuotaFailure, COVER_TIERS } = cover;

const OPENER = COVER_TIERS[0];

/** A provider that fails immediately with a quota error, like a real 429. */
const rateLimited = (ms = 60) => () => new Promise((_, rej) => {
  setTimeout(() => rej(new Error('429 {"error":{"message":"Rate limit reached for model `llama-3.3-70b-versatile`"}}')), ms);
});
/** A provider that is merely SLOW — never answers, never says why. */
const hangs = () => () => new Promise(() => {});
/** A provider that speaks. */
const speaks = (ms, text) => () => Promise.resolve((async function* gen() {
  await new Promise((r) => setTimeout(r, ms));
  yield text;
}()));

const run = (fns, names, onToken = () => {}) => streamCoverAnswer({
  question: 'How would you design exactly-once delivery into a non-idempotent sink?',
  category: 'system_design',
  plan: OPENER,
  onToken,
  _providerFns: fns,
  _names: names,
});

describe('a 429 benches the provider; a slow call does not', () => {
  beforeEach(() => _resetProviderCooldowns());
  afterEach(() => _resetProviderCooldowns());

  it('tells a quota failure apart from a slow one', () => {
    expect(isQuotaFailure('429 Rate limit reached')).toBe(true);
    expect(isQuotaFailure('You exceeded your current quota')).toBe(true);
    expect(isQuotaFailure('RESOURCE_EXHAUSTED')).toBe(true);
    // Slow is not the same as out of quota. Benching a healthy provider
    // for a minute over one slow call would remove it from the race for
    // no reason — the first-token deadline already handles slow.
    expect(isQuotaFailure('no first token within 900ms')).toBe(false);
    expect(isQuotaFailure('client gone')).toBe(false);
  });

  it('a 429 puts that provider on cooldown', async () => {
    await run([rateLimited(), speaks(30, 'exactly-once is not achievable at that sink')], ['groq', 'haiku']);
    const cd = _providerCooldowns();
    expect(Object.keys(cd)).toContain('groq');
    expect(cd.groq).toBeGreaterThan(50_000);
    // The one that answered is healthy and must NOT be benched.
    expect(Object.keys(cd)).not.toContain('haiku');
  });

  it('a slow provider is NOT benched', async () => {
    await run([hangs(), speaks(30, 'the sink cannot dedupe, so the guarantee moves upstream')], ['groq', 'haiku']);
    expect(Object.keys(_providerCooldowns())).not.toContain('groq');
  });

  it('stays benched for the whole window — it is not retried next question', async () => {
    // This is the behaviour, and it is the point: a 429 means a quota
    // WINDOW, so asking again inside it is guaranteed to fail and
    // guaranteed to cost the main answer the time it takes to find out.
    await run([rateLimited()], ['groq']);
    expect(Object.keys(_providerCooldowns())).toContain('groq');

    let called = 0;
    const text = await run([(sig) => { called++; return speaks(20, 'never reached')(sig); }], ['groq']);
    expect(called, 'a benched provider must not be called again inside its window').toBe(0);
    expect(text).toBe('');
    // …and it is still benched, with time left to serve.
    expect(_providerCooldowns().groq).toBeGreaterThan(50_000);
  });
});

describe('the paid backstop is promoted when the free tiers are benched', () => {
  beforeEach(() => _resetProviderCooldowns());
  afterEach(() => _resetProviderCooldowns());

  it('skips the benched providers entirely instead of re-discovering their 429s', async () => {
    // Round 1: both free tiers 429. Haiku is third and only gets what is
    // left of the budget.
    await run([rateLimited(), rateLimited(), hangs()], ['groq', 'gemini', 'haiku']);
    const cd = _providerCooldowns();
    expect(Object.keys(cd).sort()).toEqual(['gemini', 'groq']);

    // Round 2: the same three are offered, but the two benched ones are
    // not tried at all — so haiku starts at index 0 and answers well
    // inside a budget it would previously have been starved of.
    let launched = 0;
    const counted = (fn) => (sig) => { launched++; return fn(sig); };
    const t0 = Date.now();
    const text = await run(
      [counted(rateLimited()), counted(rateLimited()), counted(speaks(120, 'strict exactly-once is impossible at that boundary'))],
      ['groq', 'gemini', 'haiku'],
    );
    expect(text).toContain('strict exactly-once');
    // Only ONE provider ran: the paid one. The two 429s cost nothing.
    expect(launched, 'a benched provider must not be called at all').toBe(1);
    expect(Date.now() - t0).toBeLessThan(OPENER.chainBudgetMs);
  });
});

describe('when everything is cooling, the cover costs zero', () => {
  beforeEach(() => _resetProviderCooldowns());
  afterEach(() => _resetProviderCooldowns());

  it('returns instantly rather than burning the chain budget', async () => {
    await run([rateLimited(), rateLimited(), rateLimited()], ['groq', 'gemini', 'haiku']);
    expect(Object.keys(_providerCooldowns()).sort()).toEqual(['gemini', 'groq', 'haiku']);

    const warn = console.warn;
    let line = '';
    console.warn = (...a) => { line = a.join(' '); };
    const t0 = Date.now();
    let text;
    try {
      text = await run([rateLimited(), rateLimited(), rateLimited()], ['groq', 'gemini', 'haiku']);
    } finally { console.warn = warn; }
    const elapsed = Date.now() - t0;

    expect(text).toBe('');
    // THE POINT: the main model's call is queued behind this await. With
    // every provider benched there is nothing to wait FOR, so waiting is
    // pure dead air. Measured 1,501ms before this existed.
    expect(elapsed, `all-cooling chain took ${elapsed}ms; it must be ~0`).toBeLessThan(60);
    expect(line).toMatch(/SKIPPED/);
    expect(line).toMatch(/0ms added/);
  });
});
