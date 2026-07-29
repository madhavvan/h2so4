// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  THE CHAIN THAT COULD ONLY EVER TRY ONE PROVIDER
//
//  The cover had three providers, the last of them PAID and added
//  specifically for the day the two free tiers are down. It also had one
//  budget for the whole chain, sized from the predicted gap. For the
//  opener tier — which is what fires for the app's default model on an
//  ordinary question — that budget is 1,200ms, and a single provider's
//  first-token deadline is 1,500ms. So provider one was handed MORE than
//  the entire budget and the loop's next iteration hit `remaining() <=
//  200` and stopped.
//
//  Measured in the running app, on a real question from a real session:
//
//    [cover] NO COVER — tier=opener 1/3 provider(s) tried in 1210ms
//            (budget 1200ms): no first token within 1200ms
//
//  One of three. The backstop was unreachable on EVERY tier, and the
//  answer that followed took twenty-five seconds with the candidate
//  sitting in silence.
//
//  The budget was never the problem — the SERIAL chain was. These tests
//  pin the hedged race that replaced it, and the two failure modes it
//  exists to remove: an unreachable backstop, and a cover so truncated
//  that the app told the candidate to say "So the" out loud.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  streamCoverAnswer, COVER_TIERS, HEDGE_STAGGER_MS, MIN_FLUSH_WORDS,
  generationWindowMs, predictMainTtftMs, staticTtftMs, recordMainTtftMs,
  planCover, _resetObservedTtft,
} = require('../src/services/coverAnswer.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OPENER = COVER_TIERS[0];
const Q = 'a question long enough to be worth covering';

// A provider that never speaks. The exact shape that killed the chain:
// it does not FAIL, it just hangs, so a serial chain waits out its whole
// deadline and has nothing left for anyone else.
const hangs = () => async () => { await new Promise(() => {}); };

// A provider that speaks after `delay`, one word every `gap` ms.
const speaks = (delay, words, gap = 1) => (signal) => (async function* () {
  await sleep(delay);
  for (const w of words.split(' ')) {
    if (signal && signal.aborted) return;
    yield { text: w + ' ' };
    if (gap) await sleep(gap);
  }
})();

const dies = (delay, msg) => async () => { await sleep(delay); throw new Error(msg); };

describe('the backstop is actually reachable', () => {
  it('a hanging primary no longer consumes the whole budget', async () => {
    const seen = [];
    const t0 = Date.now();
    const text = await streamCoverAnswer({
      question: Q, category: 'other', plan: OPENER,
      onToken: (t) => seen.push(t),
      _providerFns: [hangs(), hangs(), speaks(20, 'I would start by pinning down what the sink can actually guarantee')],
      _names: ['groq', 'gemini', 'haiku'],
    });
    // The third provider — the PAID backstop — answered, inside the
    // opener tier's 1,200ms chain budget. Under the serial chain this
    // was arithmetically impossible.
    expect(text).toContain('pinning down');
    expect(Date.now() - t0).toBeLessThan(OPENER.chainBudgetMs + 400);
  });

  it('every provider that can help is in flight, not queued behind a timeout', async () => {
    // Three hangs: all three must have been LAUNCHED (the log says so),
    // and the whole thing still returns inside the budget.
    const t0 = Date.now();
    const warn = console.warn;
    let line = '';
    console.warn = (s) => { line = String(s); };
    try {
      const text = await streamCoverAnswer({
        question: Q, category: 'other', plan: OPENER,
        onToken: () => {},
        _providerFns: [hangs(), hangs(), hangs()],
        _names: ['groq', 'gemini', 'haiku'],
      });
      expect(text).toBe('');
    } finally { console.warn = warn; }
    expect(line).toMatch(/NO COVER/);
    expect(line, 'all three should have raced, not one').toMatch(/3\/3 provider\(s\) raced/);
    expect(Date.now() - t0).toBeLessThan(OPENER.chainBudgetMs + 600);
  });
});

describe('a hedge does not wait out its stagger for a provider that already died', () => {
  it('a fast 429 promotes the next provider immediately', async () => {
    // Groq returns a rate-limit in 150-300ms. Sitting on the stagger
    // timer after that is the serial chain's wasted time creeping back
    // in. Measured before this fix: groq 429'd, the backstop launched at
    // 700ms with 499ms of budget left, and the run produced no cover.
    const startedAt = [];
    const mark = (i) => () => { startedAt[i] = Date.now(); };
    const t0 = Date.now();
    const text = await streamCoverAnswer({
      question: Q, category: 'other', plan: OPENER,
      onToken: () => {},
      _providerFns: [
        (s) => { mark(0)(); return dies(30, '429 rate limited')(s); },
        (s) => { mark(1)(); return dies(30, '429 daily quota')(s); },
        (s) => { mark(2)(); return speaks(20, 'I would want to pin down what the sink can actually guarantee')(s); },
      ],
      _names: ['groq', 'gemini', 'haiku'],
    });
    expect(text).toContain('pin down');
    // Both hedges should have started far sooner than their staggers
    // (250ms, 500ms) because the providers ahead of them had failed.
    expect(startedAt[1] - t0).toBeLessThan(HEDGE_STAGGER_MS);
    expect(startedAt[2] - t0).toBeLessThan(2 * HEDGE_STAGGER_MS);
  });

  it('the backstop gets a floor when it is the only hope left', async () => {
    // With the two free tiers gone, holding the paid backstop to whatever
    // scraps of budget remain buys a guaranteed silence. Here it needs
    // 700ms for its first token — more than the opener budget would have
    // left it — and the cover still lands, well ahead of the main
    // model's own 1.4-2.1s.
    const text = await streamCoverAnswer({
      question: Q, category: 'other', plan: OPENER,
      onToken: () => {},
      _providerFns: [
        dies(500, '429 rate limited'),
        dies(500, '429 daily quota'),
        speaks(700, 'I would start by confirming what the numbers are actually measuring'),
      ],
      _names: ['groq', 'gemini', 'haiku'],
    });
    expect(text).toContain('actually measuring');
  });

  it('the floor is for the backstop only, never for a lone provider', async () => {
    // A single configured provider must still be walled by the budget —
    // otherwise the floor becomes a way for any hung cover to hold the
    // main answer.
    const t0 = Date.now();
    const text = await streamCoverAnswer({
      question: Q, category: 'other',
      plan: { ...OPENER, chainBudgetMs: 400 },
      onToken: () => {}, firstTokenDeadlineMs: 300,
      _providerFns: [hangs()],
    });
    expect(text).toBe('');
    expect(Date.now() - t0).toBeLessThan(900);
  });
});

describe('the hedges only fire when they are needed', () => {
  it('a fast primary means the paid backstop is never called at all', async () => {
    let backstopCalled = false;
    const text = await streamCoverAnswer({
      question: Q, category: 'other', plan: OPENER,
      onToken: () => {},
      _providerFns: [
        speaks(5, 'Most of that work has been on the ingestion side end to end'),
        () => { throw new Error('gemini should not have been asked'); },
        () => { backstopCalled = true; throw new Error('backstop should not have been asked'); },
      ],
    });
    expect(text).toContain('ingestion side');
    // The hedge for provider 2 is scheduled at HEDGE_STAGGER_MS; the
    // primary answered long before that, so nothing else ran. This is
    // what keeps a PAID backstop from becoming a standing bill.
    expect(backstopCalled).toBe(false);
  });

  it('only ONE provider is ever allowed to reach the user', async () => {
    // Two providers that both answer. Without a claim gate their words
    // interleave into a single sentence spoken by the candidate.
    const seen = [];
    const text = await streamCoverAnswer({
      question: Q, category: 'other', plan: COVER_TIERS[1],
      onToken: (t) => seen.push(t),
      _providerFns: [
        speaks(HEDGE_STAGGER_MS + 60, 'alpha alpha alpha alpha alpha alpha alpha'),
        speaks(5, 'beta beta beta beta beta beta beta'),
      ],
    });
    const joined = seen.join('');
    expect(joined).not.toMatch(/alpha[\s\S]*beta|beta[\s\S]*alpha/);
    expect(text.includes('alpha') || text.includes('beta')).toBe(true);
  });
});

describe('nothing half-said reaches the candidate', () => {
  it('a two-word fragment is never spoken', async () => {
    // The real failure: first token at 1,038ms of a 1,200ms budget left
    // 162ms to produce seventeen words, and the abort kept whatever had
    // arrived. The app told the candidate to say "So the" and stop.
    const seen = [];
    const text = await streamCoverAnswer({
      question: Q, category: 'other', plan: OPENER,
      onToken: (t) => seen.push(t),
      // Speaks two words then hangs forever.
      _providerFns: [(signal) => (async function* () {
        yield { text: 'So ' };
        yield { text: 'the ' };
        await new Promise(() => {});
      })()],
    });
    expect(seen.join('')).toBe('');
    expect(text).toBe('');
  });

  it('but a complete short answer still gets through', async () => {
    const seen = [];
    const text = await streamCoverAnswer({
      question: Q, category: 'other', plan: OPENER,
      onToken: (t) => seen.push(t),
      _providerFns: [speaks(5, 'Mostly Azure and AWS.')],
    });
    // Four words — under MIN_FLUSH_WORDS — but the stream ENDED cleanly,
    // so it is a deliberate short answer, not a truncation.
    expect(text).toBe('Mostly Azure and AWS.');
    expect(seen.join('')).toContain('Azure');
  });

  it('the minimum is words, not bytes', () => {
    expect(MIN_FLUSH_WORDS).toBeGreaterThanOrEqual(4);
    expect(MIN_FLUSH_WORDS).toBeLessThanOrEqual(10);
  });

  it('what the main model is told to continue from is what the user saw', async () => {
    // The cover text is handed to the main model verbatim as a
    // continuation instruction. If it contained words that were dropped
    // before reaching the screen, the answer would continue from a
    // sentence nobody ever heard.
    const seen = [];
    const text = await streamCoverAnswer({
      question: Q, category: 'other', plan: OPENER,
      onToken: (t) => seen.push(t),
      _providerFns: [(signal) => (async function* () {
        yield { text: 'I would want to confirm what is actually happening first. ' };
        yield { text: 'And the other half of' };
        await new Promise(() => {});
      })()],
    });
    expect(text).toBe(seen.join('').trim());
    expect(text).not.toContain('other half of');
  });
});

describe('a provider that starts talking is allowed to finish', () => {
  it('generation gets its own window, not the leftovers of the chain budget', async () => {
    // 17 words at 12ms each is ~200ms of generation — more than the
    // opener chain budget has left after a 900ms first token, and
    // exactly the case that produced truncated covers in production.
    const words = 'I would start by working out whether the slowdown is real and where it begins';
    const text = await streamCoverAnswer({
      question: Q, category: 'other', plan: OPENER,
      onToken: () => {},
      _providerFns: [speaks(900, words, 12)],
    });
    expect(text).toBe(words);
  });

  it('but a provider that never starts is still walled at the first-token deadline', async () => {
    const t0 = Date.now();
    const text = await streamCoverAnswer({
      question: Q, category: 'other',
      plan: { ...OPENER, chainBudgetMs: 400 },
      onToken: () => {},
      _providerFns: [hangs()],
      firstTokenDeadlineMs: 300,
    });
    expect(text).toBe('');
    // The generation window must NOT be added to the wait for a provider
    // that produced nothing — that would let a hung cover hold the main
    // answer hostage for both deadlines.
    expect(Date.now() - t0).toBeLessThan(300 + generationWindowMs(OPENER));
  });
});

describe('the prediction learns from what actually happened', () => {
  beforeEach(() => _resetObservedTtft());

  const ARGS = { provider: 'openai', deep: false, effort: 'none' };

  it('a slow answer lengthens the NEXT cover on that route', () => {
    // The real event: predicted 1,400ms, actual 25,000ms, opener tier —
    // roughly 13 seconds of speech against 25 seconds of silence.
    expect(planCover(predictMainTtftMs(ARGS)).name).toBe('opener');
    recordMainTtftMs(ARGS, 25_000);
    const after = predictMainTtftMs(ARGS);
    expect(after).toBeGreaterThan(staticTtftMs(ARGS));
    expect(planCover(after).name).not.toBe('opener');
  });

  it('one bad minute cannot pin the cover to it forever', () => {
    recordMainTtftMs(ARGS, 120_000);
    // Capped relative to the calibrated figure, so a hung provider does
    // not buy a 150-word holding answer in front of a 1.4s reply.
    expect(predictMainTtftMs(ARGS)).toBeLessThanOrEqual(staticTtftMs(ARGS) * 4);
  });

  it('decays back down as the route recovers', () => {
    recordMainTtftMs(ARGS, 25_000);
    const spiked = predictMainTtftMs(ARGS);
    for (let i = 0; i < 8; i++) recordMainTtftMs(ARGS, 1_200);
    expect(predictMainTtftMs(ARGS)).toBeLessThan(spiked);
  });

  it('observation can only ever make the cover LONGER, never shorter', () => {
    // A prediction that could fall below the calibrated floor is a new
    // way to leave someone silent.
    for (let i = 0; i < 20; i++) recordMainTtftMs(ARGS, 50);
    expect(predictMainTtftMs(ARGS)).toBe(staticTtftMs(ARGS));
  });

  it('is keyed per route and depth, so one slow model does not lengthen every cover', () => {
    recordMainTtftMs({ provider: 'xai', deep: true }, 40_000);
    expect(predictMainTtftMs(ARGS)).toBe(staticTtftMs(ARGS));
  });

  it('ignores nonsense samples', () => {
    recordMainTtftMs(ARGS, 0);
    recordMainTtftMs(ARGS, -5);
    recordMainTtftMs(ARGS, NaN);
    expect(predictMainTtftMs(ARGS)).toBe(staticTtftMs(ARGS));
  });
});

describe('the routes report what the main model did', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const ai = fs.readFileSync(path.resolve(process.cwd(), 'src', 'routes', 'ai.js'), 'utf8');

  it('every streaming route times its own first token', () => {
    // Five routes, five reporters — the gap that let three of five
    // routes ship with no cover at all was two hand-wired copies of the
    // same wiring, and this is the same shape of mistake.
    expect((ai.match(/mainTtftReporter\(\{/g) || []).length).toBe(6);
    expect((ai.match(/ttft\.firstToken\(\)/g) || []).length).toBe(5);
  });

  it('times from when the main call was ISSUED, not from route entry', () => {
    // Otherwise the cover chain in front of it is counted as the main
    // model's latency and feeds back to make the next cover longer,
    // which compounds on itself.
    expect((ai.match(/ttft\.issued\(\)/g) || []).length).toBe(5);
    const openai = /router\.post\('\/stream\/openai'[\s\S]*?\n}\);/.exec(ai)[0];
    expect(openai.indexOf('runCover(')).toBeLessThan(openai.indexOf('ttft.issued()'));
  });

  it('leaves a line in the log when an answer blows past its prediction', () => {
    expect(ai).toMatch(/\[ttft\] SLOW main answer/);
  });
});
