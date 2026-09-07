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

  // The question here must be one ABOUT THEM. Since 2026-08-06 the résumé
  // is only sent when it is, because a fast model handed a résumé and a
  // hard technical question answers from the résumé — measured live,
  // "I'd verify the current data processing workflows at Indiana
  // University and Apollo Hospitals" in front of a question about the
  // INTERVIEWER's Airflow instance.
  it('says the background is true and bounds it', () => {
    const p = userPrompt('have you worked with Kafka?', 'other', RESUME);
    expect(p).toMatch(/true — use it, never go beyond it/);
  });

  it('does NOT send the résumé for a problem to solve', () => {
    // A problem question is answered from the QUESTION. Sending the
    // résumé is what produced résumé recitation in front of every
    // technical question in the 2026-08-06 run.
    const p = userPrompt(
      'How would you design exactly-once delivery into a non-idempotent sink?',
      'system_design',
      RESUME,
    );
    expect(p).not.toContain('CANDIDATE BACKGROUND');
    expect(p).not.toContain('Apollo');
  });

  // ── THE ASYMMETRY THAT DECIDES THIS PREDICATE ──
  // Graded over the real question corpus on 2026-08-06. A narrower version
  // of BACKGROUND_Q withheld the résumé from three genuinely
  // candidate-focused questions, and none of them degraded gracefully:
  //   "explain about your peojects"  -> "I need the CANDIDATE BACKGROUND
  //                                      section to answer this"
  //   "largest data volume you have" -> "around two terabytes" (invented;
  //                                      the truth is 3M records/day)
  //   "which Azure services have you used" -> "I haven't worked with Azure"
  // Withholding it produces invention or denial, SPOKEN. Sending it to a
  // problem question only produces recitation, which the prompt forbids
  // anyway. So the predicate is deliberately generous, and these are the
  // cases that pin both edges of it.
  it('is generous about what counts as a question about them', () => {
    for (const q of [
      'can you explain about your peojects?',
      'What is the largest data volume you have personally been responsible for?',
      'Which Azure services have you used for LLM workloads?',
      'Have you ever worked at IBM?',
      'Do you know FastAPI?',
      'Are you familiar with Databricks?',
      'Tell me about a time you disagreed with your team lead.',
      'What is a technical decision you made that turned out to be wrong?',
      'where have your worked before?',
    ]) {
      expect(userPrompt(q, 'ml_data', RESUME), q).toContain('CANDIDATE BACKGROUND');
    }
  });

  it('but hypothetical framing is not a question about them', () => {
    // "you" in a hypothetical is not the same pronoun. An earlier version
    // matched a bare "do you" and handed the résumé to a Snowflake cost
    // question, which is how résumé recitation reached a problem answer.
    for (const q of [
      'How would you design exactly-once delivery into a non-idempotent sink?',
      'Cut our Snowflake bill by 40 percent without degrading SLA. Where do you start?',
      'How would you approach a 400-DAG Airflow instance with a 30% failure rate?',
      'A dashboard shows wrong numbers but every pipeline is green.',
      'What is the difference between a data lake and a lakehouse?',
      'How does Kafka guarantee ordering?',
    ]) {
      expect(userPrompt(q, 'ml_data', RESUME), q).not.toContain('CANDIDATE BACKGROUND');
    }
  });

  it('still sends it for the questions that are about them', () => {
    // "tell me about yourself" does not match the have-you/do-you shape,
    // so it needs its own predicate — and it reaches the live cover
    // whenever the résumé failed to parse, which is when it matters most.
    for (const q of [
      'tell me about yourself',
      'walk me through your background',
      'where have you worked before?',
      'what have you worked on?',
    ]) {
      expect(userPrompt(q, 'other', RESUME), q).toContain('CANDIDATE BACKGROUND');
    }
    // …and for the two categories that are lookups about their own life.
    expect(userPrompt('what was your degree?', 'clarifier', RESUME)).toContain('CANDIDATE BACKGROUND');
    expect(userPrompt('tell me about a time you shipped something hard', 'behavioral', RESUME))
      .toContain('CANDIDATE BACKGROUND');
  });

  it('omits the section entirely when there is no background', () => {
    // Not an empty header — an empty header invites the model to fill it.
    const p = userPrompt('What have you worked on most?', 'other', '');
    expect(p).not.toContain('CANDIDATE BACKGROUND');
  });

  it('does NOT cut the background — the budget lives where it is built', () => {
    // ⚠️ THIS TEST USED TO ASSERT THE OPPOSITE, and the assertion was the
    // bug. It pinned `bg.slice(0, 9000)` as "generous enough for any
    // resume", which was true while the background WAS a resume.
    //
    // It is now the candidate's uploaded documents, verbatim. Measured on a
    // real 39,891-char upload: the cut landed at char 9,000, and the section
    // reading "Used GMARS? No. Do not claim it" sits at ~char 30,000 — so
    // the app claimed GMARS out loud, three times across two live runs, on
    // a document that forbids it in capitals.
    //
    // A cap in two places is a cap that will disagree, and this pair had
    // already disagreed once before (client 9,000 vs this line still at
    // 1,200, which sliced off every employer). The budget now lives in ONE
    // place — COVER_SOURCE_MAX_CHARS in services/coverSource.ts — where it
    // can drop whole named sections and log which, instead of cutting a
    // sentence in half and telling nobody.
    const ABOUT_THEM = 'have you worked with Kafka?';
    const whole = 'x'.repeat(30_000);
    expect(userPrompt(ABOUT_THEM, 'other', whole)).toContain(whole);
    const realistic = userPrompt(ABOUT_THEM, 'other', 'x'.repeat(7_300));
    expect(realistic).toContain('x'.repeat(7_300));
  });

  it('still gives a PROBLEM question no background at all', () => {
    // The narrowing in userPrompt is to PROBLEM_CATEGORIES, not a removal.
    // A model handed a résumé and "design exactly-once delivery" reaches for
    // the résumé; that was measured live and the exclusion stands for
    // exactly the categories it was proven on.
    const p = userPrompt('how would you design exactly-once delivery?', 'system_design', RESUME);
    expect(p).not.toContain('CANDIDATE BACKGROUND');
  });

  it('…but a CONCEPT question now gets it, because the documents answer it', () => {
    // Measured: "minimum weight vs smallest net weight" is defined in the
    // uploaded file. With the background excluded the cover got it backwards
    // 0 times out of 3; with the same file present it matched the document's
    // own wording. Excluding the material did not stop résumé recitation —
    // it just made the model guess.
    const p = userPrompt('what is the difference between OQ and PQ?', 'concept', RESUME);
    expect(p).toContain('CANDIDATE BACKGROUND');
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
    // groq) and one in claudeService. Every one of them fires a cover, so
    // every one has to carry the background — a route that fires a cover
    // without it produces the content-free opener this file exists to
    // prevent.
    //
    // The payload is now built by ONE function, buildOpenerPayload, and it
    // carries strictly more than the old prose block did: the locally
    // composed opener, the cover policy, the ledger DIGEST (every role,
    // project, skill line and metric in the WHOLE knowledge base, where the
    // old coverContext was a 9,000-char slice of a single file) and the
    // vocabulary the server needs to police a fallback model.
    //
    // ⚠️ EACH ROUTE NAMES ITSELF. The provider argument is not decoration:
    // a prewarmed cover's LENGTH is chosen from that provider's predicted
    // gap, and the store now refuses to hand a line written for one route
    // to another (see cover-provider-fit.test.js). A route that omits its
    // provider, or copies a neighbour's, silently reopens the defect where
    // a 72-word groq holding line was spoken in front of a 1.5s OpenAI
    // answer — so the four are asserted DISTINCT, not merely counted.
    const named = (PROXY_SRC.match(
      /buildOpenerPayload\(query, contextFiles, history, \{ provider: '(openai|gemini|xai|groq)' \}\)/g
    ) || []);
    expect(named.length).toBe(4);
    expect(new Set(named).size, 'two routes sharing a provider is the cross-route bug').toBe(4);
    expect(claude).toMatch(
      /buildOpenerPayload\(query, contextFiles, history, \{ provider: 'claude' \}\)/
    );
    // And the payload really does carry the background.
    const fn = /export function buildOpenerPayload[\s\S]*?\n}/.exec(PROXY_SRC)[0];
    expect(fn).toMatch(/ledgerDigest\(ledger\)/);
    expect(fn).toMatch(/ledgerVocabulary\(ledger\)/);
    // The rail carries the MODEL's cover and nothing else (2026-08-22).
    // composeOpener used to be called here and its sentence took precedence;
    // it spoke extractor artifacts as fact ("Opened 6 May 2026" as an
    // employer) and is no longer on the product path. What remains is the
    // suppress verdict, which is about the transcript, not about composing.
    expect(fn).not.toMatch(/composeOpener\(/);
    expect(fn).toMatch(/isChallengeToPreviousAnswer\(query\)/);
    expect(fn).toMatch(/takePrewarmedCover\(query,/);
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
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  A PROBLEM QUESTION GETS A JUDGEMENT, NOT A PROCESS
//
//  History, because this rule has now been wrong in BOTH directions and
//  the tests below exist to stop it swinging a third time.
//
//  v1 said "name the technique/pattern you would reach for" — so the
//  cover guessed a mechanism the reasoning model then contradicted one
//  sentence later, out loud, mid-answer.
//  v2 over-corrected to "open with WHAT YOU WOULD ESTABLISH FIRST" —
//  safe, uncontradictable, and completely empty. Measured live in the
//  running app on 2026-08-06: "I'd want to confirm the current ETL
//  pipeline's performance metrics" in front of a question about
//  exactly-once delivery, while the main model's own first sentence was
//  "true exactly-once delivery is impossible if the sink supports
//  neither deduplication nor transactional writes." The cover was
//  DISPLACING a better opening with filler.
//
//  v3 (current) names the third option the first two missed: state what
//  is ALREADY TRUE about the problem as stated — the constraint, the
//  distinction, or the reframe. Substantive, and still uncontradictable,
//  because it is a claim about the QUESTION rather than about a system
//  nobody has looked at yet.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe('problems open with a judgement, not a process', () => {
  it('separates questions about them from problems to solve', () => {
    expect(COVER_SYSTEM).toMatch(/THREE KINDS OF QUESTION, THREE KINDS OF OPENING/);
    expect(COVER_SYSTEM).toMatch(/THE ONE THING THAT IS ALREADY TRUE ABOUT THIS PROBLEM/);
  });

  it('names the three substantive shapes it can take', () => {
    expect(COVER_SYSTEM).toMatch(/THE CONSTRAINT that decides the whole answer/);
    expect(COVER_SYSTEM).toMatch(/THE DISTINCTION the question turns on/);
    expect(COVER_SYSTEM).toMatch(/THE REFRAME/);
  });

  it('still forbids guessing the cause — the v1 failure', () => {
    expect(COVER_SYSTEM).toMatch(/THIS IS NOT A GUESS AT THE CAUSE/);
    expect(COVER_SYSTEM).toMatch(/Never name the culprit, the\s*\n?\s*mechanism, or the fix/);
    // …and still says WHY, so nobody softens it back into guessing.
    expect(COVER_SYSTEM).toMatch(/contradict them one sentence\s*\n?\s*later/);
  });

  it('and now forbids narrating the process — the v2 failure', () => {
    expect(COVER_SYSTEM).toMatch(/IT IS NOT A DESCRIPTION OF YOUR PROCESS/);
    // The exact sentences measured in the app, quoted in the prompt so a
    // future editor sees what this is guarding against.
    expect(COVER_SYSTEM).toMatch(/I'd verify the\s*\n?\s*current metrics/);
    // The test a writer can apply to their own sentence.
    expect(COVER_SYSTEM).toMatch(/still make sense pasted under a\s*\n?\s*completely different question/);
  });

  it('keeps the employment history out of a problem answer', () => {
    expect(COVER_SYSTEM).toMatch(/never open a problem\s*\n?\s*question with their employment history/);
  });

  it('forbids importing a technology the question never mentioned', () => {
    // Observed: a Spark question drew "the Delta lakehouse" out of the
    // resume. The candidate's stack is not necessarily the asker's.
    expect(COVER_SYSTEM).toMatch(/Never assume their stack/);
  });

  it('the category hints ask for a judgement, not a technique and not a process', () => {
    const CATEGORY_HINTS = (() => {
      const src = fs.readFileSync(
        path.resolve(process.cwd(), 'src', 'services', 'coverAnswer.js'), 'utf8');
      return /const CATEGORY_HINTS = \{[\s\S]*?\n\};/.exec(src)[0];
    })();
    // v1's mistake — guessing a mechanism.
    expect(CATEGORY_HINTS).not.toMatch(/name the technique\/pattern you would reach for/);
    expect(CATEGORY_HINTS).not.toMatch(/name the overall shape you would start from/);
    // v2's mistake — narrating the process. Every one of these shipped.
    expect(CATEGORY_HINTS).not.toMatch(/what you would clarify or check about the input first/);
    expect(CATEGORY_HINTS).not.toMatch(/which constraint or requirement you would pin down first/);
    expect(CATEGORY_HINTS).not.toMatch(/say what you would verify or measure first/);
    expect(CATEGORY_HINTS).not.toMatch(/say how you would break the problem down first/);
    // v3 — what they must ask for instead.
    expect(CATEGORY_HINTS).toMatch(/the invariant that decides the approach/);
    expect(CATEGORY_HINTS).toMatch(/the constraint the whole design turns on/);
    expect(CATEGORY_HINTS).toMatch(/what is or is not achievable given what they described/);
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
    // ⚠️ THE RULE IS "NOT COPIED INTO EVERY ROUTE", NOT "APPEARS ONCE".
    //
    // This asserted a count of exactly 1, which was the right shape when
    // runCover was the only place a cover could be produced: the backstop
    // reached five routes through one helper instead of the two that
    // happened to have the line pasted in. There are now TWO cover entry
    // points — runCover (in-line, on the answer path) and /cover/prewarm
    // (written during the silence timer) — and both legitimately need the
    // full chain. What must never come back is the key appearing inside a
    // /stream/ handler, because that is the copy-paste this guards.
    const entryPoints = ['async function runCover({', "router.post('/cover/prewarm'"];
    for (const marker of entryPoints) {
      const start = ai.indexOf(marker);
      expect(start, `${marker} is missing`).toBeGreaterThan(-1);
      const body = ai.slice(start, ai.indexOf('\n});', start) + 4);
      expect(body, `${marker} must reach the paid backstop`).toMatch(/anthropicKey: process\.env\.ANTHROPIC_API_KEY/);
      expect(body).toMatch(/groqKey: process\.env\.GROQ_API_KEY/);
      expect(body).toMatch(/geminiKey: process\.env\.GEMINI_API_KEY/);
    }
    // runCover now produces up to TWICE — the cover, and a topic salvage
    // when a self-claim is rejected on a holding-tier gap (see the SALVAGE
    // block) — so the key legitimately appears three times: runCover ×2 and
    // /cover/prewarm ×1. The guard that matters is the per-entry-point check
    // above (each reaches the backstop) plus the helper check below; the
    // total must never exceed those three, which is what would flag the key
    // being pasted into a /stream/ or /chat/ handler.
    expect((ai.match(/anthropicKey: process\.env\.ANTHROPIC_API_KEY/g) || []).length).toBe(entryPoints.length + 1);

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
