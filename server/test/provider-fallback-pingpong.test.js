// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  "changing from gpt to grok and grok to gpt"
//
//  Reported verbatim by a live user, alongside "taking time to give the
//  answer". Those are one event, not two.
//
//  What happened: a provider 429s. The client retried it three times with
//  1s + 2s + 4s of backoff (withRetry), THEN App.tsx's outage fallback
//  fired — and that fallback wrote its choice into settings AND
//  localStorage, permanently replacing the model the user had picked.
//
//  The oscillation follows mechanically from FALLBACK_PREFERENCE:
//
//      user picks GPT -> GPT 429s -> pick first pref != openai  = xai
//                                 -> SAVED. user is now on Grok.
//      later Grok 429s -> pick first pref != xai                = openai
//                                 -> SAVED. user is back on GPT.
//
//  So it ping-pongs between exactly two providers forever, and the user's
//  real choice is gone after the first hiccup. Nobody chose Grok.
//
//  These tests pin the two properties that stop it:
//    1. the fallback picker never returns a provider that is cooling, so
//       the "swing back" candidate is not offered while it is benched;
//    2. a rate limit is NOT retried with backoff, so the fallback happens
//       in ~0ms instead of after ~7s of dead air.
//
//  Pure logic — the two functions are re-implemented here from the source
//  they mirror, because App.tsx cannot be imported outside a renderer.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('the fix is actually present in the source', () => {
  const app = fs.readFileSync(path.join(ROOT, 'App.tsx'), 'utf8');

  it('the outage fallback no longer persists the model choice', () => {
    // The two writes that caused the ping-pong. If either comes back, the
    // user's picker starts being rewritten by transient provider faults
    // again — and this test is the only thing that would notice.
    const fallbackBlock = app.slice(
      app.indexOf('const failedModel ='),
      app.indexOf('const failedModel =') + 2600,
    );
    expect(fallbackBlock).not.toMatch(/setItem\('SELECTED_MODEL', next\)/);
    expect(fallbackBlock).not.toMatch(/setSettings\(prev => \(\{ \.\.\.prev, selectedModel: next \}\)\)/);
  });

  it('the retry is told the model explicitly instead of mutating shared state', () => {
    expect(app).toMatch(/_modelOverride/);
    expect(app).toMatch(/executeSend\(textToSend, imageBase64, isAutoSolve, \(_fallbackAttempt \|\| 0\) \+ 1, next\)/);
  });

  it('a benched provider is skipped when choosing the fallback', () => {
    expect(app).toMatch(/pickFallbackModel\(failedModel, liveGate\.allowedModels, isModelCooling\)/);
    expect(app).toMatch(/providerCooldownRef/);
  });
});

describe('a rate limit fails fast instead of burning 7s of backoff', () => {
  const svc = fs.readFileSync(path.join(ROOT, 'services', 'aiProxyService.ts'), 'utf8');

  it('withRetry bails immediately on a quota refusal', () => {
    expect(svc).toMatch(/if \(isRateLimited\(err\)\) throw err;/);
  });

  it('keeps retrying things that genuinely might succeed next time', () => {
    // A 5xx or a dropped socket must still get its three attempts — the
    // point is to stop retrying a QUOTA, not to stop retrying.
    expect(svc).toMatch(/const MAX_RETRIES = 3/);
  });

  it("preserves the server's own rate_limit verdict instead of re-deriving it", () => {
    // routes/ai.js normalises five provider SDKs into one shape; the client
    // used to flatten it to English and re-match by substring.
    expect(svc).toMatch(/function httpError/);
    expect(svc).toMatch(/e\.status = status/);
    expect(svc).toMatch(/err\.code === 'rate_limit'/);
  });
});

describe('the fallback picker, replayed', () => {
  // Mirrors FALLBACK_PREFERENCE + pickFallbackModel in App.tsx.
  const PREF = ['openai', 'xai', 'gemini', 'groq', 'claude'];
  const pick = (failed, allowed, cooling = () => false) => {
    for (const c of PREF) {
      if (c === failed) continue;
      if (!allowed.includes(c)) continue;
      if (cooling(c)) continue;
      return c;
    }
    return null;
  };
  const ALL = ['openai', 'xai', 'gemini', 'groq', 'claude'];

  it('reproduces the ping-pong WITHOUT the cooldown', () => {
    // The old behaviour, so the regression is visible if cooling is lost.
    const first = pick('openai', ALL);
    expect(first).toBe('xai');
    const second = pick(first, ALL);
    expect(second).toBe('openai');          // ← straight back. gpt -> grok -> gpt
  });

  it('does NOT swing back while the failed provider is still cooling', () => {
    const cooling = new Set(['openai']);
    const first = pick('openai', ALL, (m) => cooling.has(m));
    expect(first).toBe('xai');
    cooling.add('xai');
    const second = pick('xai', ALL, (m) => cooling.has(m));
    expect(second).not.toBe('openai');      // the whole point
    expect(second).toBe('gemini');
  });

  it('still returns null when everything usable is exhausted', () => {
    // Then the caller shows a real error rather than looping.
    const cooling = new Set(ALL);
    expect(pick('openai', ALL, (m) => cooling.has(m))).toBeNull();
  });

  it('never offers a model the plan does not allow', () => {
    // Basic/trial cannot use Claude; a fallback into it would 402 midway.
    const allowed = ['openai', 'xai', 'gemini', 'groq'];
    const cooling = new Set(['openai', 'xai', 'gemini', 'groq']);
    expect(pick('openai', allowed, (m) => cooling.has(m))).toBeNull();
  });
});
