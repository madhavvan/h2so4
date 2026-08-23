// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  THE PREWARM ENDPOINT'S CONTRACT — cancellable, and honest about doubt.
//
//  Source-asserted, for the same reason transcription-latency.test.js
//  asserts the Deepgram query string: executing this handler needs paid
//  provider calls (the GROQBENCH-gated wire test does that), and the two
//  properties pinned here are one-token regressions that a green wire test
//  would not catch — `signal: undefined` still produces covers, and
//  `effort: used` still produces valid-looking hints.
//
//  1. CANCELLATION. The handler used to call streamCoverAnswer with
//     `signal: undefined`. The client aborts its fetch on every transcript
//     growth step (350ms-stable pauses while someone is still talking),
//     so every superseded prewarm — depth judge, cover, and the parallel
//     second attempt — ran to completion server-side and billed for a
//     question that no longer existed: five-plus full generations to
//     deliver one.
//
//  2. THE EFFORT HINT MUST BE THE VERDICT, NOT THE DEFAULT. planForPrewarm
//     defaults a null verdict to 'low' — correct for SIZING the cover,
//     where a guess costs a few words. Returning that default as the hint
//     converted a 900ms judge timeout into an opinion that OVERRIDES the
//     server's classifier at send (observed live: "depth=null->low
//     ready=1538ms"), making shallow questions pay reasoning latency.
//     A null hint falls through to the classifier, the designed fallback.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const AI = readFileSync(join(HERE, '..', 'src', 'routes', 'ai.js'), 'utf8');
const PROXY = readFileSync(join(HERE, '..', '..', 'services', 'aiProxyService.ts'), 'utf8');

const start = AI.indexOf("router.post('/cover/prewarm'");
const handler = AI.slice(start, AI.indexOf('\n});', start) + 4);

describe('the prewarm endpoint is cancellable', () => {
  it('has a handler to assert against at all', () => {
    expect(start).toBeGreaterThan(-1);
    expect(handler.length).toBeGreaterThan(500);
  });

  it('never hands the cover chain a dead signal', () => {
    expect(handler, 'an un-cancellable generation bills for abandoned questions')
      .not.toContain('signal: undefined');
    expect(handler).toContain('signal: ac.signal');
  });

  it('a dead client aborts the work — and only a dead one', () => {
    // writableEnded is the discriminator: 'close' also fires after every
    // NORMAL response, and aborting on that would kill nothing today but
    // becomes a landmine the moment anything after res.json is added.
    expect(handler).toMatch(/res\.on\('close',\s*\(\)\s*=>\s*\{\s*if\s*\(!res\.writableEnded\)\s*ac\.abort\(\)/);
  });

  it('a newer prewarm from the same user supersedes the older one', () => {
    expect(handler).toContain('_prewarmInFlightByUser.get(uid)');
    expect(handler, 'the previous in-flight generation must be aborted, not raced')
      .toMatch(/prev\.abort\(\)/);
  });

  it('cleanup is ownership-checked, so a superseded call cannot evict its successor', () => {
    // The exact bug the CLIENT side had: T1's cleanup clearing T2's slot,
    // leaving T3 nothing to abort. Same shape, same fix, both sides.
    expect(handler).toMatch(/_prewarmInFlightByUser\.get\(uid\)\s*===\s*ac\)\s*_prewarmInFlightByUser\.delete\(uid\)/);
  });
});

describe('the effort hint is the verdict, never the sizing default', () => {
  it('the success response and the cache carry `depth`', () => {
    expect(handler).toMatch(/_prewarmPut\(key,\s*\{\s*cover,\s*effort:\s*depth\s*\}\)/);
    expect(handler).toMatch(/res\.json\(\{\s*cover,\s*effort:\s*depth/);
  });

  it('`used` is never returned as an effort hint on any path', () => {
    expect(
      handler.match(/effort:\s*used/g),
      "planForPrewarm's default ('low' on judge failure) must size the cover, not steer the answer model"
    ).toBeNull();
  });
});

describe('the client in-flight slot is ownership-checked too', () => {
  it('prewarmCover clears only its own controller', () => {
    expect(PROXY, 'the aborted-check variant lets a superseded call null its successor')
      .toMatch(/if\s*\(ctl\s*&&\s*_prewarmInFlight\s*===\s*ctl\)\s*_prewarmInFlight\s*=\s*null/);
    expect(PROXY).not.toMatch(/_prewarmInFlight\.signal\.aborted === false\) _prewarmInFlight = null/);
  });
});
