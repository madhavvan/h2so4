// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  WHAT THE 2026-09-06 PRODUCTION AUDIT OF THE COVER CHANGED.
//
//  3.7 days of logs: 12 LLM covers attempted, 5 rejected as fabricated
//  biographies — every one a question ABOUT the candidate on a request that
//  carried no evidence; every openai cover fired 14–21 words (6–9 s of
//  speech) into a 2.5–2.7 s gap; accepted covers were logged as a word
//  count so only the rejected ones could be audited; and the prewarm rail,
//  which fires on every 150 ms transcript settle, had no ceiling on how
//  many Groq prompts one question could spend.
//
//  The sizing is exercised for real (planCover is pure). The route-level
//  rules are pinned at the source: they sit in front of the model calls that
//  the live-provider drills exercise, and a skip is a skip whatever answers.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const codeOnly = (src) => src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const ai = codeOnly(readFileSync(join(ROOT, 'server/src/routes/ai.js'), 'utf8'));

const {
  planCover, COVER_TIERS, COVER_FLOOR_MS, SPOKEN_WORDS_PER_SEC,
  isExperientialQuestion, isBackgroundQuestion,
} = require('../src/services/coverAnswer.js');

describe('the opener is sized to its gap', () => {
  it('a 2.6 s gap gets a short clause, not the tier maximum', () => {
    const plan = planCover(2600);
    expect(plan.name).toBe('opener');
    expect(plan.minWords).toBe(8);
    expect(plan.maxWords).toBeLessThanOrEqual(12);
    // Speech for the max must not run to three times the gap any more.
    expect(plan.maxWords / SPOKEN_WORDS_PER_SEC).toBeLessThan(2.6 * 2.1);
    // Clocks and token budget are the tier's — only the words moved.
    expect(plan.chainBudgetMs).toBe(COVER_TIERS[0].chainBudgetMs);
    expect(plan.totalDeadlineMs).toBe(COVER_TIERS[0].totalDeadlineMs);
    expect(plan.maxTokens).toBe(COVER_TIERS[0].maxTokens);
  });

  it('grows with the gap and never exceeds the tier ceiling', () => {
    let prevMax = 0;
    for (const gap of [2600, 3000, 3400, 3800, 3999]) {
      const plan = planCover(gap);
      expect(plan.name).toBe('opener');
      expect(plan.minWords).toBeGreaterThanOrEqual(8);
      expect(plan.maxWords).toBeGreaterThanOrEqual(plan.minWords + 4);
      expect(plan.maxWords).toBeLessThanOrEqual(COVER_TIERS[0].maxWords);
      expect(plan.maxWords).toBeGreaterThanOrEqual(prevMax);
      prevMax = plan.maxWords;
    }
    // At the top of the opener band the words approach the old fixed budget.
    expect(planCover(3999).minWords).toBe(9);
  });

  it('below the floor there is still no cover, and the bridge/holding tiers are untouched', () => {
    expect(planCover(COVER_FLOOR_MS)).toBeNull();
    expect(planCover(6000)).toBe(COVER_TIERS[1]);
    expect(planCover(20000).name).toBe('holding');
  });
});

describe('a question about them, with nothing about them, is not asked', () => {
  it('the predicates the route uses are exported and agree with the prompt builder', () => {
    expect(isExperientialQuestion('Have you worked with Kafka?')).toBe(true);
    expect(isBackgroundQuestion('Tell me about yourself')).toBe(true);
    expect(isBackgroundQuestion('walk me through your background')).toBe(true);
    expect(isExperientialQuestion('How would you design exactly-once delivery?')).toBe(false);
    expect(isBackgroundQuestion('How would you design exactly-once delivery?')).toBe(false);
  });

  it('runCover and /cover/prewarm both skip when the evidence is under 200 chars', () => {
    expect(ai).toContain('const MIN_EVIDENCE_CHARS = 200;');
    const fn = ai.slice(ai.indexOf('function aboutThemWithoutEvidence(req, question)'), ai.indexOf('async function runCover('));
    expect(fn).toContain("const evidence = String(req.body?.coverContext || '').trim();");
    expect(fn).toContain('if (evidence.length >= MIN_EVIDENCE_CHARS) return false;');
    expect(fn).toContain('return isExperientialQuestion(question) || isBackgroundQuestion(question);');
    const run = ai.slice(ai.indexOf('async function runCover('), ai.indexOf('async function runCover(') + 6000);
    // After the free checks, before any plan or provider is touched.
    const skipAt = run.indexOf('if (aboutThemWithoutEvidence(req, question)) {');
    expect(skipAt).toBeGreaterThan(run.indexOf('if (!coverWorthy(question)) return'));
    expect(skipAt).toBeLessThan(run.indexOf('planCoverFor({'));
    expect(run).toContain('SKIPPED shape=about-them-no-evidence');
    const prewarm = ai.slice(ai.indexOf("router.post('/cover/prewarm'"), ai.indexOf("router.post('/cover/prewarm'") + 4000);
    expect(prewarm).toContain("return res.json({ cover: '', effort: null, reason: 'no-evidence' });");
  });
});

describe('the prewarm rail has a ceiling per user', () => {
  it('a prewarm inside the interval is HELD until it ends; an aborted hold starts nothing', () => {
    expect(ai).toContain('const PREWARM_MIN_INTERVAL_MS = 2500;');
    const prewarm = ai.slice(ai.indexOf("router.post('/cover/prewarm'"), ai.indexOf("router.post('/cover/prewarm'") + 6000);
    const holdAt = prewarm.indexOf('const hold = _prewarmMinIntervalMs - (Date.now() - lastStart);');
    expect(holdAt).toBeGreaterThan(-1);
    // Cached hits are served before the hold (free)…
    expect(holdAt).toBeGreaterThan(prewarm.indexOf('const cached = _prewarmGet(key);'));
    // …the abort wiring exists before the hold, so a client that moves on
    // ends the wait without anything being spent…
    expect(holdAt).toBeGreaterThan(prewarm.indexOf("res.on('close', () => { if (!res.writableEnded) ac.abort(); });"));
    expect(prewarm).toContain('await new Promise((resolve) => setTimeout(resolve, hold));');
    expect(prewarm).toContain("reason: 'superseded', ms: Date.now() - t0 });");
    // …and only a request that outlives the hold starts work and supersedes the previous one.
    const startAt = prewarm.indexOf('_prewarmLastStartByUser.set(uid, Date.now());');
    expect(startAt).toBeGreaterThan(holdAt);
    expect(startAt).toBeLessThan(prewarm.indexOf('_prewarmInFlightByUser.get(uid)'));
    // Nothing is refused outright any more.
    expect(prewarm).not.toContain("reason: 'throttled'");
    // Tests that fire prewarms back to back can turn the interval off.
    expect(ai).toContain('function _setPrewarmMinInterval(ms)');
  });
});

describe('accepted covers are auditable', () => {
  it('the accepted-cover log line carries the spoken text, truncated', () => {
    expect(ai).toContain('+ `text="${cover.replace(/\\s+/g, \' \').slice(0, 160)}"`');
  });
});
