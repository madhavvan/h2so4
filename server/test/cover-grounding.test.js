// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  THE COVER MUST SAY SOMETHING TRUE
//
//  The cover is the first thing the interviewer HEARS — the candidate
//  speaks it aloud while the real answer forms. It used to be sent the
//  question and nothing else, under a prompt that said "YOU DO NOT KNOW
//  THIS CANDIDATE'S BACKGROUND", so "tell me about your experience"
//  produced a sentence about the act of answering: "I'd look at my
//  overall background and identify the areas I've spent most time on."
//  Reported by the user, from a real session, with four files uploaded.
//
//  These tests pin BOTH directions, because the fix has an obvious way
//  to go wrong: grounding it invites fabrication, and a made-up employer
//  spoken out loud has to be retracted mid-interview.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { userPrompt, COVER_SYSTEM } = require('../src/services/coverAnswer.js');

const RESUME = 'ALEX MORGAN — Data Engineer. Fidelity: Kafka to Snowflake, 40M events/day. Optum: Airflow, dbt.';

describe('the prompt the cover model actually receives', () => {
  it('puts the background before the question', () => {
    // A fast model reads top-down against a 1.5s first-token deadline;
    // facts arriving after the question are facts it may not reach.
    const p = userPrompt('What have you worked on most?', 'other', RESUME);
    expect(p.indexOf('CANDIDATE BACKGROUND')).toBeLessThan(p.indexOf('Interviewer asked'));
    expect(p).toContain('Fidelity');
  });

  it('says the background is true and bounds it', () => {
    const p = userPrompt('q?', 'other', RESUME);
    expect(p).toMatch(/true — use it, never go beyond it/);
  });

  it('omits the section entirely when there is no background', () => {
    // Not an empty header — an empty header invites the model to fill it.
    const p = userPrompt('What have you worked on most?', 'other', '');
    expect(p).not.toContain('CANDIDATE BACKGROUND');
  });

  it('caps the background, but high enough to hold a whole resume', () => {
    // The cap exists for the 1,500ms first-token deadline, not to save
    // tokens — and it was originally 1,200, which cut a real resume off
    // before its first employer. Measured after raising it: first token
    // still 500-740ms on Groq llama-3.3-70b. So: generous enough for any
    // resume, hard enough that a 50K document cannot blow the deadline.
    const huge = userPrompt('q?', 'other', 'x'.repeat(50_000));
    expect(huge.length).toBeLessThan(10_000);
    const realistic = userPrompt('q?', 'other', 'x'.repeat(7_300));   // a real resume
    expect(realistic).toContain('x'.repeat(7_300));                   // uncut
  });
});

describe('the system prompt', () => {
  it('tells the model to answer from the background, not describe answering', () => {
    expect(COVER_SYSTEM).toMatch(/GROUND EVERY SPECIFIC IN THE CANDIDATE BACKGROUND/);
    expect(COVER_SYSTEM).toMatch(/do not describe how you would go about answering/);
  });

  it('still forbids inventing specifics', () => {
    // The original prompt's fear was correct; only its remedy was wrong.
    expect(COVER_SYSTEM).toMatch(/never name a tool, employer, product or domain that is not in the/);
    expect(COVER_SYSTEM).toMatch(/never state a metric, team size or timeframe that is not there/);
  });

  it('keeps a safe fallback for when there is no background', () => {
    expect(COVER_SYSTEM).toMatch(/if the background is missing or does not cover the question/);
  });

  it('contains no plausible-looking fake employer to copy', () => {
    // Measured, not theoretical: an earlier draft used a realistic
    // example ("Kafka into Snowflake at Fidelity") and llama-3.3-70b
    // recited it verbatim as the candidate's own history when NO
    // background was supplied. Examples here must be unmistakably
    // placeholders.
    expect(COVER_SYSTEM).toMatch(/<THEIR EMPLOYER>/);
    expect(COVER_SYSTEM).toMatch(/placeholders/i);
    for (const real of ['Fidelity', 'Optum', 'Google', 'Amazon']) {
      expect(COVER_SYSTEM, `${real} would be copied as fact`).not.toContain(real);
    }
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  "IMMEDIATELY AFTER UPLOADING, THE MODEL SHOULD KNOW THE FILES"
//
//  The identity card is extracted in the background and is deliberately
//  NOT awaited — the first question must not stall for 3-9s. The risk
//  that creates is a first question answered with no grounding at all.
//  These pin that the grounding path does NOT depend on the card, so
//  question one is as grounded as question ten.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import fs from 'node:fs';
import path from 'node:path';
const PROXY_SRC = fs.readFileSync(
  path.resolve(process.cwd(), '..', 'services', 'aiProxyService.ts'), 'utf8');

describe('question one is grounded, without waiting for extraction', () => {
  it('the cover context is built from the files, not from the card', () => {
    const fn = /export function buildCoverContext[\s\S]*?\n}/.exec(PROXY_SRC)[0];
    expect(fn).toMatch(/strongIdentitySignal/);
    expect(fn).toMatch(/weakIdentitySignal/);
    // If it consulted the card it would be empty on the first question —
    // exactly the moment the user is complaining about.
    expect(fn).not.toMatch(/getResolvedCardsOrKickoff|resolvedCards|ExtractedCards/);
  });

  it('the main answer evidence is built from the files too', () => {
    const fn = /export async function assembleEvidence[\s\S]*?\n}/.exec(PROXY_SRC)[0];
    expect(fn).toMatch(/strongIdentitySignal/);
    expect(fn).not.toMatch(/getResolvedCardsOrKickoff|resolvedCards/);
  });

  it('refuses to guess when no file reads as an identity document', () => {
    // Four large reference PDFs and no resume: an opener anchored on the
    // wrong document is worse than a careful one, because it is spoken.
    const fn = /export function buildCoverContext[\s\S]*?\n}/.exec(PROXY_SRC)[0];
    expect(fn).toMatch(/if \(files\.length === 0\) return '';/);
  });

  it('is sent on every streaming route that fires a cover', () => {
    const claude = fs.readFileSync(path.resolve(process.cwd(), '..', 'services', 'claudeService.ts'), 'utf8');
    // Four stream* functions live in aiProxyService (openai, gemini, xai,
    // groq) and one in claudeService. Every one of them now fires a cover,
    // so every one of them has to carry the background — a route that
    // fires a cover without it produces the content-free opener this
    // whole file exists to prevent.
    const sent = (PROXY_SRC.match(/coverContext: isAutoSolve \? '' : buildCoverContext\(contextFiles\)/g) || []).length;
    expect(sent).toBe(4);
    expect(claude).toMatch(/coverContext: isAutoSolve \? '' : buildCoverContext\(contextFiles\)/);
    // Auto-Solve output is code typed into an editor — no spoken opener,
    // so no background needs to travel with it.
  });

  it('the routes read it and hand it to the cover', () => {
    const ai = fs.readFileSync(path.resolve(process.cwd(), 'src', 'routes', 'ai.js'), 'utf8');
    // ONE reader, in the shared runCover helper. It used to be copied into
    // each route, which is exactly how three routes ended up with no cover
    // at all — including grok, measured at 18-32s to first token. A single
    // wiring cannot be half-applied.
    const uses = (ai.match(/candidateContext: typeof req\.body\?\.coverContext === 'string'/g) || []).length;
    expect(uses).toBe(1);
    // …and every stream route calls it.
    const callers = (ai.match(/await runCover\(\{/g) || []).length;
    expect(callers).toBe(5);   // openai, claude, xai, gemini, groq
    for (const provider of ['openai', 'claude', 'xai', 'gemini', 'groq']) {
      expect(ai, `no cover on /stream/${provider}`).toMatch(new RegExp(`provider: '${provider}'`));
    }
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  THE OPENER MUST NOT BE WALKED BACK
//
//  Found by running ten recruiter questions through the real app with a
//  real resume. On FOUR of seven technical questions the spoken opener
//  guessed a mechanism and the very next sentence reversed it:
//
//    spoken:  "First thing I'd look at is the partitioning…"
//    then:    "Before tuning anything, I'd confirm the slowdown is real."
//
//  The interviewer hears both halves. Cause was this prompt: it told the
//  cover to COMMIT TO AN APPROACH, but the cover answers in under a
//  second, before anything is diagnosed — so a named cause is a guess,
//  while the reasoning model behind it correctly establishes facts first.
//  They disagreed by construction.
//
//  Fix: on a problem, open with what you would ESTABLISH, which cannot
//  be contradicted. After: 0 of 7 contradicted, 0 of 7 reciting the
//  resume (was 4 and 3).
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe('problems open with what you would establish, not the fix', () => {
  it('separates questions about them from problems to solve', () => {
    expect(COVER_SYSTEM).toMatch(/THREE KINDS OF QUESTION, THREE KINDS OF OPENING/);
    expect(COVER_SYSTEM).toMatch(/WHAT YOU WOULD ESTABLISH FIRST, never with the\s*\n?solution/);
  });

  it('says why, so nobody softens it back into guessing', () => {
    expect(COVER_SYSTEM).toMatch(/a named cause or mechanism is a GUESS/);
    expect(COVER_SYSTEM).toMatch(/walk it back\s*\n?\s*mid-sentence/);
  });

  it('forbids importing a technology the question never mentioned', () => {
    // Observed: a Spark question drew "the Delta lakehouse" out of the
    // resume. The candidate's stack is not necessarily the asker's.
    expect(COVER_SYSTEM).toMatch(/Never assume their stack/);
  });

  it('the category hints no longer ask for a technique up front', () => {
    const { CATEGORY_HINTS } = (() => {
      const src = fs.readFileSync(
        path.resolve(process.cwd(), 'src', 'services', 'coverAnswer.js'), 'utf8');
      const m = /const CATEGORY_HINTS = \{[\s\S]*?\n\};/.exec(src)[0];
      return { CATEGORY_HINTS: m };
    })();
    // These two lines were the direct cause of the guessed mechanisms.
    expect(CATEGORY_HINTS).not.toMatch(/name the technique\/pattern you would reach for/);
    expect(CATEGORY_HINTS).not.toMatch(/name the overall shape you would start from/);
    expect(CATEGORY_HINTS).toMatch(/what you would clarify or check about the input first/);
    expect(CATEGORY_HINTS).toMatch(/which constraint or requirement you would pin down first/);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  THE COVER MUST NOT FAIL SILENTLY
//
//  Measured against the running app: the cover was not happening at all.
//  Both providers were free-tier and both returned 429 the same day
//  (Groq's org token limit, Gemini's daily quota). The answer still
//  arrived — seconds later, with the candidate sitting in silence, which
//  is the exact failure this feature exists to prevent. Nothing logged
//  it, because the failure path was a bare `catch {}`.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe('the cover chain cannot go quiet', () => {
  const SRC = fs.readFileSync(
    path.resolve(process.cwd(), 'src', 'services', 'coverAnswer.js'), 'utf8');

  it('says so, loudly, when every provider fails', () => {
    expect(SRC).toMatch(/\[cover\] NO COVER/);
    // …and names which one failed and why, or the log is useless.
    expect(SRC).toMatch(/failures\.join/);
  });

  it('has a PAID provider behind the two free ones', () => {
    // Two free quotas are one bad afternoon away from being no quota.
    expect(SRC).toMatch(/anthropicCoverFactory/);
    const chain = /const providers = \[\][\s\S]*?if \(providers\.length === 0\)/.exec(SRC)[0];
    expect(chain.indexOf('groqCoverFactory')).toBeLessThan(chain.indexOf('anthropicCoverFactory'));
    expect(chain.indexOf('geminiCoverFactory')).toBeLessThan(chain.indexOf('anthropicCoverFactory'));
  });

  it('does not let an SDK retry eat the whole budget', () => {
    // A rate-limited Groq took 2,285ms to fall through because the SDK
    // was quietly retrying a 429. The cover's entire budget is 1,500ms;
    // the chain's own deadline is the retry policy.
    expect(SRC).toMatch(/new Groq\(\{ apiKey, maxRetries: 0/);
    expect(SRC).toMatch(/new Anthropic\(\{ apiKey, maxRetries: 0/);
  });

  it('gives the last provider room, since nothing follows it', () => {
    // Holding the backstop to the same deadline as a provider that has
    // alternatives behind it just guarantees silence.
    expect(SRC).toMatch(/const LAST_PROVIDER_DEADLINE_MS = \d+/);
    expect(SRC).toMatch(/const isLast = i === providers\.length - 1/);
  });

  it('the routes actually pass the backstop key', () => {
    const ai = fs.readFileSync(path.resolve(process.cwd(), 'src', 'routes', 'ai.js'), 'utf8');
    // Once, in runCover — which every stream route goes through, so the
    // backstop now reaches five routes instead of the two that happened
    // to have the line copied into them.
    expect((ai.match(/anthropicKey: process\.env\.ANTHROPIC_API_KEY/g) || []).length).toBe(1);
    const helper = /async function runCover\(\{[\s\S]*?\n}/.exec(ai)[0];
    expect(helper).toMatch(/groqKey: process\.env\.GROQ_API_KEY/);
    expect(helper).toMatch(/geminiKey: process\.env\.GEMINI_API_KEY/);
    expect(helper).toMatch(/anthropicKey: process\.env\.ANTHROPIC_API_KEY/);
  });

  it('never spends the chain budget it does not have', () => {
    // The chain had no TOTAL bound: three providers at their own
    // deadlines came to 1,500 + 1,500 + 2,600 = 5,600ms, and because the
    // main model call is issued only after this returns, that was 5.6
    // seconds added to the DEEP answer on the day every cover provider
    // was down — no cover AND a slower answer, which is strictly worse
    // than not having the feature.
    expect(SRC).toMatch(/chainBudgetMs/);
    expect(SRC).toMatch(/const remaining = \(\) => budgetMs - \(Date\.now\(\) - startedAt\)/);
    expect(SRC).toMatch(/if \(remaining\(\) <= 200\)/);
  });
});
