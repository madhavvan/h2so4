// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  THE COVER HAS TO LAST UNTIL THE ANSWER ARRIVES
//
//  The cover was a fixed 12-30 words on every model for every question.
//  A candidate reads aloud at ~2.3 words/sec, so 25 words is about
//  eleven seconds of speech — and the gap it has to cover was never one
//  number. Measured 2026-07-25 (scripts/ttft-matrix.mjs), time to first
//  token on a realistic prompt:
//
//    gemini-3.6-flash MINIMAL   0.7s     ← a cover here is pure delay
//    claude-sonnet-5            1.2s
//    gpt-5.6 effort=low deep    2.2s
//    gpt-5.6 effort=high deep   9.2s     ← 25 words runs out first
//    grok-4.5 deep              18-32s   ← and had NO cover at all
//
//  So the fixed length was wrong at both ends: wasted on the fast models
//  and eleven seconds short on the slow ones. These tests pin the depth
//  model that replaced it — and pin it in terms of the only thing that
//  matters, SECONDS OF SPEECH against SECONDS OF SILENCE.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
const require = createRequire(import.meta.url);
const {
  predictMainTtftMs, planCover, planCoverFor, userPrompt,
  COVER_TIERS, COVER_FLOOR_MS, SPOKEN_WORDS_PER_SEC, streamCoverAnswer,
} = require('../src/services/coverAnswer.js');

const secondsOfSpeech = (words) => words / SPOKEN_WORDS_PER_SEC;

describe('the predicted gap matches what was measured', () => {
  it('grok is the extreme case at BOTH depths, and is treated as one', () => {
    // Deep: 32.0s / 17.9s / 19.8s on the bench, 20.4s median in-app.
    expect(predictMainTtftMs({ provider: 'xai', deep: true })).toBeGreaterThanOrEqual(15000);
    // Shallow is the one the bench got wrong. Timed directly it looked
    // like 1.8s; timed through the real route with the real rules block
    // it is 9.7s median (5.9 / 9.7 / 10.7). A cover-suppressing floor
    // calibrated on the bench figure would have left a ten-second
    // silence on every behavioral question asked of Grok.
    expect(predictMainTtftMs({ provider: 'xai', deep: false })).toBeGreaterThan(5000);
  });

  it('the slowest route in the product is planned for, not rounded away', () => {
    // groq/gpt-oss-120b: 24.3s shallow, 54.2s deep, measured in-app.
    // At 54s a fixed 110-word ceiling (48s of speech) leaves the
    // candidate six seconds short — standing in silence with the
    // interviewer waiting — so the holding budget is computed from the
    // gap rather than fixed.
    const { plan } = planCoverFor({ provider: 'groq', deep: true });
    expect(plan.name).toBe('holding');
    expect(secondsOfSpeech(plan.minWords)).toBeGreaterThan(45);
  });

  it('scales with the reasoning effort the server actually resolved', () => {
    const g = (effort) => predictMainTtftMs({ provider: 'openai', deep: true, effort });
    expect(g('none')).toBeLessThan(g('medium'));
    expect(g('medium')).toBeLessThan(g('high'));
    // 9.2s measured at high on a system-design question.
    expect(g('high')).toBeGreaterThanOrEqual(8000);
  });

  it('counts web search against Claude, which is where its silence comes from', () => {
    const bare = predictMainTtftMs({ provider: 'claude', webSearch: false });
    const searching = predictMainTtftMs({ provider: 'claude', webSearch: true });
    // Bare Sonnet 5 is the fastest main model in the fleet — 1.6s shallow
    // / 2.1s deep as PAINTED first character — so it gets the shortest
    // cover there is, but it does get one.
    expect(planCover(bare).name).toBe('opener');
    // A live search is a different animal entirely: the first token waits
    // on a round-trip to the web. This is the ONE figure in the table
    // that is estimated rather than measured — triggering a real
    // web_search on demand needs a question the fresh-context classifier
    // also fires on — so it is set conservatively and only has to be
    // right enough to land above the opener tier.
    expect(searching).toBeGreaterThan(bare * 3);
    expect(planCover(searching).name).not.toBe('opener');
    expect(secondsOfSpeech(planCover(searching).minWords)).toBeGreaterThan(searching / 1000);
  });

  it('"web search" means the question will probably search, not that the tool is on', () => {
    // The tool is enabled on every Claude request. Passing that flag
    // straight through would predict a 9-second silence for every
    // behavioral question in the product and put a 110-word holding
    // answer in front of a 1.2s reply. The route narrows it with the
    // fresh-context classifier instead.
    const ai = fs.readFileSync(path.resolve(process.cwd(), 'src', 'routes', 'ai.js'), 'utf8');
    expect(ai).toMatch(/webSearch: enableWebSearch !== false && needsLiveFacts\(question\)/);

    // And that classifier separates the two shapes the way we need.
    const { classify } = require('../src/services/freshContext.js');
    expect(classify('Tell me about a time you disagreed with your manager.')).toBe(false);
    expect(classify('How would you design a rate limiter?')).toBe(false);
    expect(classify("What's new in Airflow 3?")).toBe(true);
  });
});

describe('a fast model gets no cover at all', () => {
  it('gemini at MINIMAL beats any cover to the screen, so none is fired', () => {
    // 0.7-0.8s measured. The fastest cover provider needs 0.22-0.28s to
    // its FIRST token and then has to generate — racing that wins nothing
    // and costs the answer real milliseconds.
    const { plan } = planCoverFor({ provider: 'gemini', deep: false });
    expect(plan).toBeNull();
  });

  it('but the same model on a deep question does get one', () => {
    // A deep question lifts Gemini to thinkingLevel LOW: 4.1s measured.
    const { plan } = planCoverFor({ provider: 'gemini', deep: true });
    expect(plan).not.toBeNull();
  });

  it('a downgraded reasoning dial downgrades the cover with it', () => {
    // A tier-gated user's 'high' is forced to 'none' server-side. The
    // cover must plan from the RESOLVED effort, or every free user would
    // get a 110-word holding answer in front of a 1.4s reply.
    const asked = planCoverFor({ provider: 'openai', deep: true, effort: 'high' });
    const got = planCoverFor({ provider: 'openai', deep: true, effort: 'none' });
    expect(asked.gapMs).toBeGreaterThan(got.gapMs * 2);
    expect(asked.plan.minWords).toBeGreaterThan(got.plan.minWords);
    expect(got.plan.name).toBe('opener');
  });
});

describe('every tier buys more speech than the silence it covers', () => {
  // The whole feature reduces to this inequality. If it fails, the
  // candidate stops talking before the answer reaches them — which is
  // the exact failure the cover exists to prevent, just later.
  const CASES = [
    { label: 'gpt-5.6 low, deep',      args: { provider: 'openai', deep: true, effort: 'low' } },
    { label: 'gpt-5.6 medium, deep',   args: { provider: 'openai', deep: true, effort: 'medium' } },
    { label: 'gpt-5.6 high, deep',     args: { provider: 'openai', deep: true, effort: 'high' } },
    { label: 'claude + web search',    args: { provider: 'claude', webSearch: true } },
    { label: 'gemini LOW, deep',       args: { provider: 'gemini', deep: true } },
    { label: 'grok-4.5, deep',         args: { provider: 'xai', deep: true } },
    { label: 'grok-4.5, shallow',      args: { provider: 'xai', deep: false } },
  ];

  for (const { label, args } of CASES) {
    it(`${label}: the cover outlasts the wait`, () => {
      const { gapMs, plan } = planCoverFor(args);
      expect(plan, `${label} left the candidate with nothing to say`).not.toBeNull();
      // Worst case the model lands on the SHORT end of its budget, and
      // the cover's own first token costs ~0.3s before speech starts.
      const speech = secondsOfSpeech(plan.minWords);
      const silence = (gapMs - 300) / 1000;
      expect(speech, `${label}: ${plan.minWords} words = ${speech.toFixed(1)}s of speech vs ${silence.toFixed(1)}s of silence`)
        .toBeGreaterThan(silence);
    });
  }

  it('grok deep needs the holding tier specifically', () => {
    // 20s gap ⇒ at least (20 - 0.3) × 2.3 ≈ 45 words. An "opener" is the
    // wrong object at this length: it has to be a real, useful answer
    // that holds the floor on its own.
    const { plan } = planCoverFor({ provider: 'xai', deep: true });
    expect(plan.name).toBe('holding');
    expect(plan.minWords).toBeGreaterThanOrEqual(45);
  });
});

describe('the tiers are ordered and the budgets stay proportionate', () => {
  it('longer cover, more room to produce it, in that order', () => {
    for (let i = 1; i < COVER_TIERS.length; i++) {
      const prev = COVER_TIERS[i - 1];
      const cur = COVER_TIERS[i];
      expect(cur.minWords).toBeGreaterThanOrEqual(prev.maxWords);
      expect(cur.maxTokens).toBeGreaterThan(prev.maxTokens);
      expect(cur.chainBudgetMs).toBeGreaterThan(prev.chainBudgetMs);
    }
  });

  it('the token ceiling can actually hold the word budget', () => {
    // ~1.4 tokens per English word, plus slack. A cover truncated by
    // max_tokens stops mid-sentence — spoken aloud.
    for (const t of COVER_TIERS) {
      expect(t.maxTokens, `${t.name} would truncate at ${t.maxWords} words`)
        .toBeGreaterThan(t.maxWords * 1.4);
    }
  });

  it('never delays the answer by more than a fraction of the gap it covers', () => {
    // The main call is issued only after the cover returns, so the chain
    // budget IS added latency on the deep answer. It has to stay small
    // relative to the wait it is covering.
    for (const [gap, expected] of [[2000, 'opener'], [6000, 'bridge'], [20000, 'holding']]) {
      const plan = planCover(gap);
      expect(plan.name).toBe(expected);
      expect(plan.chainBudgetMs, `${expected} may delay a ${gap}ms answer too far`)
        .toBeLessThan(gap * 0.65);
    }
  });
});

describe('the length budget reaches the model', () => {
  it('each tier states its own budget, and says why it is that size', () => {
    const opener = userPrompt('q', 'other', '', COVER_TIERS[0]);
    const holding = userPrompt('q', 'other', '', COVER_TIERS[2]);
    expect(opener).toContain('12-30 words');
    expect(holding).toContain('60-110 words');
    // A model handed a bigger budget with no reason to fill it usefully
    // pads — and padding spoken aloud is worse than a short answer.
    expect(holding).toMatch(/hold the floor ON ITS OWN/);
  });

  it('the three-argument form still means "opener"', () => {
    // Existing callers and tests pass no plan.
    expect(userPrompt('q', 'other', '')).toContain('12-30 words');
  });

  it('stays inside the prompt budget even with a whole resume attached', () => {
    const huge = userPrompt('q?', 'other', 'x'.repeat(50_000), COVER_TIERS[2]);
    expect(huge.length).toBeLessThan(10_000);
  });
});

describe('the chain budget is a hard wall on added latency', () => {
  it('stops trying once the budget is spent, instead of running every provider', () => {
    // Three real providers, each hanging: the old chain would burn
    // 1500 + 1500 + 2600 before letting the main call go.
    const started = Date.now();
    const hang = () => new Promise(() => {});
    return streamCoverAnswer({
      question: 'a question long enough to be worth covering',
      category: 'system_design',
      onToken: () => {},
      plan: { ...COVER_TIERS[0], chainBudgetMs: 400 },
      _streamFn: hang,
      firstTokenDeadlineMs: 300,
    }).then((text) => {
      expect(text).toBe('');
      expect(Date.now() - started).toBeLessThan(1200);
    });
  });
});
