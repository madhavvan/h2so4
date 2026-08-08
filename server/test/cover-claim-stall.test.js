// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  THE PROVIDER THAT CLAIMED THE RACE AND THEN SAID NOTHING
//
//  The hedged race replaced a serial chain that could only ever try one
//  provider. Then the claim gate quietly put the single point of failure
//  back: a provider claimed on its FIRST TOKEN, and the claim could not
//  be taken back. But a first token is not output — the emitter withholds
//  everything until a finished sentence clears MIN_FLUSH_WORDS — so a
//  provider that yielded one token and then wedged produced "" while
//  holding the race for the whole generation window.
//
//  Measured, with a healthy alternative sitting one stagger behind it:
//
//    [cover] NO COVER — tier=opener 1/2 provider(s) raced in 1238ms
//            (budget 1200ms): stallerP0: produced nothing
//
//  One of two. The healthy hedge never launched: at its 250ms stagger it
//  read the claim, decided it was not needed and returned. The candidate
//  got silence AND the main answer was delayed by the full chain budget —
//  the exact pair of failures the hedged race exists to remove.
//
//  The fix splits the gate in two. The claim is provisional and lapses if
//  it does not turn into words (CLAIM_STALL_MS); what is permanent is
//  SPEAKING — the first flush that actually reaches the user. These tests
//  pin both halves, because relaxing the gate to cure a silence is only
//  correct if it cannot buy a double-speak in exchange: two providers
//  interleaving their words into one sentence the candidate then reads
//  aloud is strictly worse than no cover at all.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  streamCoverAnswer, COVER_TIERS, HEDGE_STAGGER_MS, CLAIM_STALL_MS,
} = require('../src/services/coverAnswer.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OPENER = COVER_TIERS[0];
const Q = 'a question long enough to be worth covering';

// The shape that killed the cover: it does not hang before speaking and
// it does not fail — it says exactly enough to win the race and then
// stops, which is the one state nothing was watching for.
const stallsAfterOneToken = () => (async function* () {
  yield { text: 'So ' };
  await new Promise(() => {});
})();

const speaks = (delay, words, gap = 1) => (signal) => (async function* () {
  await sleep(delay);
  for (const w of words.split(' ')) {
    if (signal && signal.aborted) return;
    yield { text: w + ' ' };
    if (gap) await sleep(gap);
  }
})();

describe('a claim that never becomes words is handed back', () => {
  it('the healthy hedge launches instead of standing down for a wedged provider', async () => {
    const seen = [];
    const launched = [];
    const t0 = Date.now();
    const text = await streamCoverAnswer({
      question: Q, category: 'other', plan: OPENER,
      onToken: (t) => seen.push(t),
      _providerFns: [
        (s) => { launched.push(0); return stallsAfterOneToken(s); },
        (s) => { launched.push(1); return speaks(20, 'I would start by pinning down what the sink can actually guarantee.')(s); },
      ],
      _names: ['stallerP0', 'healthyP1'],
    });
    expect(launched, 'the hedge must actually run').toContain(1);
    expect(text).toContain('pinning down');
    expect(seen.join('')).toContain('pinning down');
    // And it must arrive inside the budget the main answer is waiting
    // behind — the whole point is that the wedged provider no longer gets
    // to spend it. Previously: "" in 1238ms of a 1200ms budget.
    expect(Date.now() - t0).toBeLessThan(OPENER.chainBudgetMs);
  });

  it('the single token it did emit is never spoken', async () => {
    // Releasing the claim must not release the fragment with it. "So" is
    // not a cover, it is the app telling the candidate to say "So" out
    // loud to an interviewer and stop.
    const seen = [];
    const text = await streamCoverAnswer({
      question: Q, category: 'other', plan: OPENER,
      onToken: (t) => seen.push(t),
      _providerFns: [stallsAfterOneToken, speaks(20, 'Most of that work was on the ingestion side end to end.')],
    });
    expect(seen.join('')).not.toMatch(/^So\b/);
    expect(text).not.toMatch(/^So\b/);
    expect(text).toContain('ingestion side');
  });

  it('every provider is reported when they all wedge, and the wall still holds', async () => {
    // Three claims, three lapses, three real attempts — where the old
    // gate reported one of three and called it a chain.
    const t0 = Date.now();
    const warn = console.warn;
    let line = '';
    console.warn = (s) => { line = String(s); };
    try {
      const text = await streamCoverAnswer({
        question: Q, category: 'other', plan: OPENER,
        onToken: () => {},
        _providerFns: [stallsAfterOneToken, stallsAfterOneToken, stallsAfterOneToken],
        _names: ['groq', 'gemini', 'haiku'],
      });
      expect(text).toBe('');
    } finally { console.warn = warn; }
    expect(line).toMatch(/3\/3 provider\(s\) raced/);
    // Bounded: each lapse hands over at CLAIM_STALL_MS, so the overrun is
    // one stagger per provider and not one generation window per provider.
    expect(Date.now() - t0).toBeLessThan(OPENER.chainBudgetMs + 1200);
  });
});

describe('but only one provider is ever read aloud', () => {
  it('a lapsed claimant that recovers cannot interleave with the hedge it let in', async () => {
    // The dangerous case the release creates: BOTH providers are alive
    // and both produce a whole sentence. Whoever reaches the screen first
    // owns it outright; the other is barred at its own first flush, and
    // what it buffered is dropped rather than appended.
    const seen = [];
    const text = await streamCoverAnswer({
      question: Q, category: 'other', plan: OPENER,
      onToken: (t) => seen.push(t),
      _providerFns: [
        () => (async function* () {
          yield { text: 'So ' };
          await sleep(CLAIM_STALL_MS + 150);
          yield { text: 'alpha alpha alpha alpha alpha alpha alpha.' };
        })(),
        speaks(HEDGE_STAGGER_MS + 70, 'beta beta beta beta beta beta beta.'),
      ],
    });
    const joined = seen.join('');
    expect(joined).not.toMatch(/alpha[\s\S]*beta|beta[\s\S]*alpha/);
    expect(joined.includes('alpha') || joined.includes('beta')).toBe(true);
    // What the main model is told to continue from is still exactly what
    // the user saw — the barred provider's buffer is not in it.
    expect(text).toBe(joined.trim());
  });

  it('a fast primary still leaves the PAID backstop untouched', async () => {
    // The claim stays on the first token precisely so this holds. Moving
    // it to the first flush instead would have launched all three on
    // every ordinary run, because a one-sentence opener does not flush
    // until it finishes — insurance turning into a standing bill.
    let backstopCalled = false;
    const text = await streamCoverAnswer({
      question: Q, category: 'other', plan: OPENER,
      onToken: () => {},
      _providerFns: [
        speaks(5, 'Most of that work has been on the ingestion side end to end.'),
        () => { throw new Error('gemini should not have been asked'); },
        () => { backstopCalled = true; throw new Error('backstop should not have been asked'); },
      ],
      _names: ['groq', 'gemini', 'haiku'],
    });
    expect(text).toContain('ingestion side');
    expect(backstopCalled).toBe(false);
  });

  it('a claimant that is merely slow to finish keeps its hedges parked', async () => {
    // Steady tokens are not a stall. A provider mid-sentence must not be
    // handed over on the strength of the emitter holding its words back —
    // that would be the standing bill arriving through the other door.
    let hedgesLaunched = 0;
    const text = await streamCoverAnswer({
      question: Q, category: 'other', plan: OPENER,
      onToken: () => {},
      _providerFns: [
        // ~40 words at 12ms: past both staggers, never silent.
        speaks(20, 'I would want to start with what the numbers are actually measuring here before touching anything else, because that decides which half of the system is even worth looking at first.', 12),
        (s) => { hedgesLaunched++; return speaks(5, 'beta beta beta beta beta beta beta.')(s); },
        (s) => { hedgesLaunched++; return speaks(5, 'gamma gamma gamma gamma gamma gamma gamma.')(s); },
      ],
      _names: ['groq', 'gemini', 'haiku'],
    });
    expect(text).toContain('actually measuring');
    expect(hedgesLaunched).toBe(0);
  });
});
