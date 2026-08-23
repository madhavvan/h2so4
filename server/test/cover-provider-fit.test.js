// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  A COVER IS SIZED FOR ONE ROUTE, AND IT COSTS THE CANDIDATE WORDS.
//
//  Two defects found in a real session on 2026-08-19, both visible in
//  .server.log, both producing the same symptom the product complaint
//  describes: "it says the same thing twice".
//
//  1. THE PREWARM STORE MATCHED ON THE QUESTION ALONE.
//     A cover's LENGTH comes entirely from the answering provider's
//     predicted gap. Measured: a 72-word groq HOLDING line — about 28
//     seconds of speech, written for groq's ~20s gap — was handed to an
//     OpenAI request whose first token arrived at 1,581ms. The candidate
//     reads half a minute of holding statement while the finished answer
//     sits underneath it, and the answer re-makes every point the holding
//     line just made.
//
//  2. THE SUB-FLOOR OVERRIDE IGNORED THE SIZE, NOT JUST THE FLOOR.
//     `planCover(gapMs) || COVER_TIERS[0]` turned "this route is fast
//     enough, say nothing" into the FULL opener tier: 12-30 words, 5-13
//     seconds of speech. Measured: gap~1400ms produced a 33-word opener
//     against a 1,677ms first token. Firing below the floor is still
//     right — silence on a fast route was the original complaint, and on
//     the prewarm rail the line is free to the SERVER. But it is never
//     free to the candidate, who has to say every word of it.
//
//  ⚠️ A NEW TIER MUST HAVE ITS OWN BRANCH IN tierDirective. Anything it
//  does not recognise falls through to the HOLDING directive, which tells
//  the model to hold the floor for half a minute — the exact opposite of
//  what a sub-floor line is for. That is asserted below through the real
//  userPrompt, not by reading the function.
//
//  No network: the store is exercised through its exported test seam.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.window = Object.assign(globalThis, { addEventListener() {}, removeEventListener() {} });
globalThis.__APP_VERSION__ = '0.0.0';

const proxy = await import('../../services/aiProxyService.ts');
const { _clearPrewarmedCover, _setPrewarmedCoverForTest, takePrewarmedCover } = proxy;

const require_ = createRequire(import.meta.url);
const { planForPrewarm, userPrompt, COVER_TIERS, SPOKEN_WORDS_PER_SEC } =
  require_('../src/services/coverAnswer.js');

const Q = 'how would you get exactly-once into a sink that cannot dedupe';
const LINE = 'The constraint that decides this is whether the sink can absorb a duplicate at all.';

describe('a prewarmed cover belongs to the route it was sized for', () => {
  beforeEach(() => _clearPrewarmedCover());

  it('does NOT hand a groq-sized line to an openai request', () => {
    _setPrewarmedCoverForTest(Q, LINE, 'low', 'groq');
    expect(
      takePrewarmedCover(Q, { provider: 'openai' }),
      'a holding line written for a ~20s gap is ~28s of speech in front of a ~1.5s answer'
    ).toBeNull();
  });

  it('still uses the line on the route it was written for', () => {
    _setPrewarmedCoverForTest(Q, LINE, 'low', 'groq');
    expect(takePrewarmedCover(Q, { provider: 'groq' })).not.toBeNull();
  });

  it('the question check still applies within one route', () => {
    _setPrewarmedCoverForTest(Q, LINE, 'low', 'openai');
    expect(
      takePrewarmedCover('tell me about a production incident', { provider: 'openai' })
    ).toBeNull();
  });

  it('a mismatch is rejected before it can be consumed, so the store survives', () => {
    _setPrewarmedCoverForTest(Q, LINE, 'low', 'groq');
    takePrewarmedCover(Q, { provider: 'openai' });          // rejected
    expect(
      takePrewarmedCover(Q, { provider: 'groq' }),
      'a wrong-route request must not burn the line the right route is about to use'
    ).not.toBeNull();
  });

  it('only fires when BOTH sides are known — the legacy/test seam is unaffected', () => {
    _setPrewarmedCoverForTest(Q, LINE, 'low');               // no provider stored
    expect(takePrewarmedCover(Q, { provider: 'openai' })).not.toBeNull();
    _clearPrewarmedCover();
    _setPrewarmedCoverForTest(Q, LINE, 'low', 'groq');
    expect(takePrewarmedCover(Q)).not.toBeNull();            // no provider asked
  });
});

describe('below the cover floor the line is one clause, not a paragraph', () => {
  // claude's gap sits under COVER_FLOOR_MS — the route planCover tells to
  // say nothing at all, and the one the `|| COVER_TIERS[0]` override used
  // to hand a 12-30 word opener.
  const subFloor = planForPrewarm('claude', 'none');

  it('is a sub-floor tier, not the full opener tier', () => {
    expect(subFloor.plan.name, 'the opener tier is 12-30 words = 5-13s of speech').toBe('spark');
  });

  it('is short enough that the answer can still make its own points', () => {
    expect(subFloor.plan.maxWords).toBeLessThanOrEqual(14);
    expect(subFloor.plan.minWords).toBeGreaterThanOrEqual(8);
    expect(subFloor.plan.maxWords).toBeGreaterThan(subFloor.plan.minWords);
  });

  it('says less than the opener tier it replaced', () => {
    expect(subFloor.plan.maxWords).toBeLessThan(COVER_TIERS[0].maxWords);
  });

  it('leaves the token allowance alone — an empty cover is the worst outcome', () => {
    // generationWindowMs is maxTokens x 12ms, so trimming this would stretch
    // the all-wedged failure path (see cover-claim-stall).
    expect(subFloor.plan.maxTokens).toBe(COVER_TIERS[0].maxTokens);
  });

  it('a route that is genuinely slow still gets a real cover', () => {
    const slow = planForPrewarm('groq', 'medium');
    expect(slow.plan.name).not.toBe('spark');
    expect(slow.plan.maxWords).toBeGreaterThan(30);
  });

  it('the spoken length is inside a few seconds, not a dozen', () => {
    const seconds = subFloor.plan.maxWords / SPOKEN_WORDS_PER_SEC;
    expect(seconds, 'a 33-word opener is ~14s of speech in front of a ~1.7s answer').toBeLessThan(7);
  });
});

describe('the sub-floor tier gets its OWN instruction', () => {
  const subFloor = planForPrewarm('claude', 'none');
  const prompt = userPrompt(Q, 'ml_data', 'BACKGROUND', subFloor.plan, '');

  it('tells the model to say one sentence and stop', () => {
    expect(prompt).toMatch(/ONE short sentence/i);
  });

  it('does NOT fall through to the holding directive', () => {
    // The failure this guards: an unrecognised tier name reaches the final
    // `return` in tierDirective, which is the HOLDING text.
    expect(
      prompt,
      'an unknown tier name falls through to "hold the floor for N seconds" — the opposite instruction'
    ).not.toMatch(/hold the floor/i);
  });

  it('carries the computed word budget, not the opener tier', () => {
    expect(prompt).toContain(`${subFloor.plan.minWords}-${subFloor.plan.maxWords} words`);
  });
});
