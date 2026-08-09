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
    // `gate` on main, `liveGate` on fix/security-hardening (the C2
    // frozen-gate fix renamed it). Either is fine — what this pins is that
    // the cooling predicate is being passed at all.
    expect(app).toMatch(/pickFallbackModel\(failedModel, \w+\.allowedModels, isModelCooling\)/);
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

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  …AND THE CHOSEN MODEL IS THE ONE ACTUALLY CALLED.
//
//  Everything above this line passed while the fallback did nothing at all.
//  `_modelOverride` was threaded through executeSend and read by the tier
//  gate, and then the request was issued with
//  `streamers[currentSettings.selectedModel]` — the provider that had just
//  refused. The retry re-hit the outage, the 60s cooldown picked a model it
//  never called, and the user read "Using GPT for this answer" immediately
//  before a Gemini error.
//
//  The tests that missed it asserted the override was PASSED
//  (`expect(app).toMatch(/_modelOverride/)`). Passing an argument nothing
//  routes on is exactly the failure they were meant to catch, so these
//  assert the argument is CONSUMED at the call site.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe('the model the send resolved to is the model that gets called', () => {
  const app = fs.readFileSync(path.join(ROOT, 'App.tsx'), 'utf8');

  /** executeSend's body, from its declaration to its dependency array. */
  function executeSendBody() {
    const start = app.indexOf('const executeSend = useCallback(');
    expect(start, 'executeSend not found — did it get renamed?').toBeGreaterThan(-1);
    const end = app.indexOf('}, [cancelActiveStream]);', start);
    expect(end, "executeSend's dependency array not found").toBeGreaterThan(start);
    return app.slice(start, end);
  }

  it('routes on currentModel, not on the picker value', () => {
    const body = executeSendBody();
    expect(
      body,
      'the streamer must be chosen by the model THIS send resolved to — the ' +
        'outage override, or a routed-around choice when the pick is benched',
    ).toMatch(/streamers\[currentModel\]/);
  });

  it('never re-reads selectedModel to choose the streamer', () => {
    const body = executeSendBody();
    expect(
      body,
      'selectedModel is what the picker SHOWS. The fallback deliberately never ' +
        'writes to it (that write was the gpt<->grok ping-pong), so routing on ' +
        'it sends the retry straight back into the provider that just failed.',
    ).not.toMatch(/streamers\[currentSettings\.selectedModel\]/);
  });

  it('dispatches on the very variable the override resolves into', () => {
    // The bug in one sentence: currentModel existed, and every reader of it
    // was a permission check or a string in a message. Nothing dispatched.
    //
    // Counting occurrences cannot catch that — the broken version mentions
    // currentModel five times. So follow the chain instead: find the name
    // _modelOverride resolves into, then require THAT name to index the
    // streamer map. Renaming the variable stays fine; routing around it
    // does not.
    const body = executeSendBody();
    const decl = body.match(/const (\w+): ModelKey = _modelOverride/);
    expect(decl, 'the outage override no longer resolves into a named model').not.toBeNull();
    const resolved = decl[1];
    expect(
      body,
      `_modelOverride resolves into \`${resolved}\`, so \`${resolved}\` is what the ` +
        'request must be issued with — anything else makes the retry, the ' +
        'cooldown and the notice message all decorative',
    ).toMatch(new RegExp(`streamers\\[${resolved}\\]`));
  });

  it('a failed regenerate says something instead of blanking the screen', () => {
    // handleRegenerate cleared the pending bubble and added no message, so a
    // regenerate against a down provider looked like a dead button —
    // mid-interview, on the path a user reaches for when answers stop.
    const start = app.indexOf('const handleRegenerate = async');
    expect(start).toBeGreaterThan(-1);
    const body = app.slice(start, start + 6000);
    const katch = body.slice(body.indexOf('} catch (err: any) {'));
    expect(katch).toMatch(/looksLikeProviderOutage\(actualError\)/);
    expect(
      katch,
      'the catch must commit a message, not just clear the streaming bubble',
    ).toMatch(/db\.addMessage\(errorMsg\)|setMessages\(prev => \[\.\.\.prev, errorMsg\]\)/);
  });
});
