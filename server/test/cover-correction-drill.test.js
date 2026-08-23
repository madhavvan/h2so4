// ⚠️ REAL PAID gpt-5.6 CALLS — gated behind DRILL=1, like answer-drill.
//   DRILL=1 npx vitest run test/cover-correction-drill --silent=false
//
// THE CORRECT-THE-COVER CLAUSE, OBSERVED FOR THE FIRST TIME.
//
// buildCoverContinuation gained a clause on 2026-08-17: if the spoken
// opener is TECHNICALLY wrong (a backwards definition), the answer model
// may restate it correctly in passing — an exception to the "never
// rephrase" rule two lines above it. It shipped with zero observations,
// and its failure mode is precise: a model that reads the exception
// generously starts rephrasing GOOD openers too, which is the old
// restatement bug returning through the front door.
//
// Three arms, because the clause has three duties:
//   1. a WRONG opener is corrected, without announcing the correction
//   2. a CORRECT opener is continued, never restated
//   3. a correct-but-AWKWARD opener is also left alone — awkward is not
//      wrong, and that boundary is exactly where over-triggering starts
//
// The model under test is the one production runs (servingModels.openai),
// with the REAL continuation block — the clause is the variable, so the
// rules block is deliberately omitted.
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
if (fs.existsSync('.env')) {
  for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
process.env.JWT_SECRET = process.env.JWT_SECRET || 'drill';
process.env.DATABASE_PATH = ':memory:';
delete process.env.OPENAI_BASE_URL;
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.window = Object.assign(globalThis, { addEventListener() {}, removeEventListener() {} });
globalThis.__APP_VERSION__ = '0.0.0';

const RUN = process.env.DRILL === '1';
const { buildCoverContinuation } = require('../src/services/coverAnswer.js');
const { servingModels } = require('../src/routes/ai.js');

const N = 3; // samples per arm — the clause is stochastic, one sample proves nothing

const ANNOUNCES = /i need to correct|let me correct|i misspoke|correction:|i said that wrong|i should correct|apologi[sz]e|to be clear, i was wrong/i;
const REPHRASES = /in other words|to put it differently|put differently|what i mean is|to rephrase|said another way/i;

async function continueFrom(question, opener) {
  const OpenAI = require('openai');
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const r = await client.chat.completions.create({
    model: servingModels.openai,
    reasoning_effort: 'none',
    max_completion_tokens: 400,
    messages: [
      { role: 'system', content: 'You are the candidate in a live job interview. Answer in first person, spoken style, no markdown.' },
      { role: 'user', content: `${question}\n\n${buildCoverContinuation(opener)}` },
    ],
  });
  return (r.choices[0]?.message?.content || '').replace(/\s+/g, ' ').trim();
}

const firstSentenceHead = (s) => s.toLowerCase().split(/[.!?]/)[0].slice(0, 40);

describe.skipIf(!RUN)('the correct-the-cover clause', () => {
  it('ARM 1 — a backwards definition is corrected in passing, never announced', async () => {
    const q = 'What is the difference between a star schema and a snowflake schema?';
    // CLEANLY swapped — star and snowflake exchanged wholesale. The first
    // draft borrowed the garbled live opener, whose second half was
    // actually right; the model then corrected "by redirection" ("the key
    // distinction is the dimension design") and a literal-vocabulary grade
    // called that a failure. An unambiguous wrong gives the clause maximal
    // cause to fire, and the grade below accepts both honest shapes:
    // stating the true relationship, or redirecting to the real
    // distinction. What neither may do is announce.
    const wrong = 'A star schema normalizes its dimensions into many small sub-tables, while a snowflake schema keeps dimensions denormalized in single wide tables joined straight to the facts.';
    for (let i = 0; i < N; i++) {
      const out = await continueFrom(q, wrong);
      console.log(`   [wrong ${i + 1}] ${out.slice(0, 220)}`);
      expect(out.length).toBeGreaterThan(40);
      expect(ANNOUNCES.test(out), `announced the correction: "${out.slice(0, 160)}"`).toBe(false);
      // Two honest corrective shapes: state the true relationship (star =
      // denormalised / snowflake = normalised), or redirect to the real
      // distinction. Either unwinds the wrong claim for the listener.
      const statesTruth = /star[^.]{0,90}denormal|denormal[^.]{0,70}star|snowflake[^.]{0,90}normali/i.test(out);
      const redirects = /(distinction|difference|actually|in practice)[^.]{0,90}dimension/i.test(out);
      expect(statesTruth || redirects,
        `the wrong claim was left standing: "${out.slice(0, 200)}"`).toBe(true);
    }
  }, 180_000);

  it('ARM 2 — a correct opener is continued, not restated', async () => {
    const q = 'What does backpressure mean in a streaming system?';
    const good = 'Backpressure is a flow-control signal that stops upstream producers from sending more data until downstream consumers have processed the current batch.';
    for (let i = 0; i < N; i++) {
      const out = await continueFrom(q, good);
      console.log(`   [good ${i + 1}] ${out.slice(0, 220)}`);
      expect(out.toLowerCase().includes(firstSentenceHead(good)),
        `restated the opener: "${out.slice(0, 160)}"`).toBe(false);
      expect(REPHRASES.test(out), `rephrased a correct opener: "${out.slice(0, 160)}"`).toBe(false);
    }
  }, 180_000);

  it('ARM 3 — awkward is not wrong: a clumsy-but-true opener is left standing', async () => {
    const q = 'How would you design exactly-once delivery into a sink that cannot deduplicate?';
    const awkward = 'The thing about exactly-once is that the sink being non-idempotent is the thing that decides the whole design.';
    for (let i = 0; i < N; i++) {
      const out = await continueFrom(q, awkward);
      console.log(`   [awkw ${i + 1}] ${out.slice(0, 220)}`);
      expect(out.toLowerCase().includes(firstSentenceHead(awkward)),
        `restated the awkward opener: "${out.slice(0, 160)}"`).toBe(false);
      expect(REPHRASES.test(out), `rephrased style, which the clause does not license: "${out.slice(0, 160)}"`).toBe(false);
      expect(ANNOUNCES.test(out)).toBe(false);
    }
  }, 180_000);
});
