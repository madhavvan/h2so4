// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  A PREWARM THAT FINISHED LATE IS NOT A WASTED PREWARM (2026-08-23)
//
//  The prewarm runs in the silence while the speaker is still talking, and
//  the client only gets to USE it if the HTTP response beats the ~1,050ms
//  auto-send timer. Measured against a real 168 KB knowledge base over 12
//  distinct questions, one call each:
//
//      cover context   produced   arrived inside 1,050ms
//      7k (shipping)     11/12            6/12
//
//  Five covers per twelve were written, cleared the full grounding guard,
//  and were then dropped on the floor — while runCover went off and raced
//  three providers from scratch. That race is where the live logs'
//  "groq: produced nothing" comes from.
//
//  The server had them the whole time: _prewarmPut only ever stores a cover
//  that cleared coverVerdict (a rejected one returns before the write), so
//  claiming one needs no re-check. runCover now takes it before racing.
//
//  Consuming, not peeking — the same sentence must never be spoken twice,
//  which is why the client's takePrewarmedCover consumes too.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';

process.env.DATABASE_PATH = ':memory:';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const require = createRequire(import.meta.url);
const ai = require('../src/routes/ai.js')._test;

const { _prewarmTake, _prewarmKey, _resetPrewarmCache, _prewarmPut } = ai;

describe('the prewarm key', () => {
  it('is scoped per user, per provider, per question', () => {
    const a = _prewarmKey('u1', 'openai', 'What is IQ?');
    expect(a).not.toBe(_prewarmKey('u2', 'openai', 'What is IQ?'));
    expect(a).not.toBe(_prewarmKey('u1', 'gemini', 'What is IQ?'));
    expect(a).not.toBe(_prewarmKey('u1', 'openai', 'What is OQ?'));
  });

  it('normalises whitespace and case, so the send question matches the prewarm', () => {
    // The prewarm fires on an in-progress transcript; by send time the same
    // sentence may differ only in trailing space or capitalisation.
    expect(_prewarmKey('u1', 'openai', '  What is IQ? ')).toBe(_prewarmKey('u1', 'openai', 'what is iq?'));
  });
});

describe('taking a warmed cover', () => {
  beforeEach(() => _resetPrewarmCache());

  it('returns nothing when nothing was warmed', () => {
    expect(_prewarmTake(_prewarmKey('u1', 'openai', 'anything'))).toBeNull();
  });

  it('is CONSUMING — a second take finds nothing', () => {
    // The property that stops the same sentence being spoken twice: once by
    // the client's instantOpener rail and again by runCover.
    const key = _prewarmKey('u1', 'openai', 'What is IQ?');
    _prewarmPut(key, { cover: 'IQ verifies installation.', effort: 'none' });
    expect(_prewarmTake(key)?.cover).toBe('IQ verifies installation.');
    expect(_prewarmTake(key)).toBeNull();
  });

  it("a different user cannot claim another user's warmed cover", () => {
    _prewarmPut(_prewarmKey('u1', 'openai', 'What is IQ?'), { cover: 'mine', effort: 'none' });
    expect(_prewarmTake(_prewarmKey('u2', 'openai', 'What is IQ?'))).toBeNull();
    expect(_prewarmTake(_prewarmKey('u1', 'openai', 'What is IQ?'))?.cover).toBe('mine');
  });

  it('the send question matches a prewarm that differed only in case or spacing', () => {
    _prewarmPut(_prewarmKey('u1', 'openai', 'What is IQ?'), { cover: 'IQ verifies installation.', effort: 'none' });
    expect(_prewarmTake(_prewarmKey('u1', 'openai', '  what is iq?  '))?.cover)
      .toBe('IQ verifies installation.');
  });
});

describe('runCover claims it before racing providers — source contract', () => {
  // The behaviour is a few lines inside a long async function that needs an
  // SSE stream, a licence and three provider SDKs to execute. The contract
  // that matters is checkable directly, and it is the part that regresses:
  // that the claim happens BEFORE the provider race, and that it respects
  // the two things that mean "no opener at all".
  const { readFileSync } = require('node:fs');
  const { resolve, dirname } = require('node:path');
  const { fileURLToPath } = require('node:url');
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(resolve(here, '..', 'src', 'routes', 'ai.js'), 'utf8');
  const fn = /async function runCover\([\s\S]*?\n}/.exec(src)[0];

  it('runCover takes from the prewarm cache', () => {
    expect(fn).toMatch(/_prewarmTake\(_prewarmKey\(/);
  });

  it('the claim sits BEFORE the live provider race', () => {
    const claimAt = fn.indexOf('_prewarmTake');
    const raceAt = fn.search(/streamCoverAnswer|raceCover|coverRace/);
    expect(claimAt).toBeGreaterThan(-1);
    if (raceAt > -1) expect(claimAt).toBeLessThan(raceAt);
  });

  it('a suppressed question never claims one', () => {
    // suppress means "no opener from anyone" — a warmed line is still an
    // opener, and speaking it here is the IBM -> Accenture cascade.
    const claim = fn.slice(fn.indexOf('_prewarmTake') - 400, fn.indexOf('_prewarmTake'));
    expect(claim).toMatch(/coverPolicy\s*!==\s*'suppress'/);
  });

  it('the measurement escape hatch still removes the cover entirely', () => {
    const claim = fn.slice(fn.indexOf('_prewarmTake') - 400, fn.indexOf('_prewarmTake'));
    expect(claim).toMatch(/x-cover-disabled/);
  });
});
