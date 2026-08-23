// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  WHICH OPENER WINS — and why the order is the safety argument.
//
//  There are now two things that can put words in the candidate's mouth:
//  the LOCAL opener, assembled from verified spans of their own documents,
//  and the PREWARMED one, written by a model during the silence timer.
//
//  The precedence is not a preference, it is the whole safety story:
//
//    1. local wins        — it cannot fabricate and costs 0ms. A model
//                           sentence must never displace a verified fact.
//    2. suppress is final — the user is challenging a previous answer, and
//                           a model given the question with no transcript
//                           invents a justification. That is the
//                           IBM -> Accenture cascade, and it is exactly the
//                           moment a prewarmed line would look most useful.
//    3. defer uses prewarm — the ledger has no fact that opens this
//                           question. On the real corpus that is 978 of
//                           1,143 questions, and today every one of them
//                           gets silence.
//
//  No network here: prewarmCover's cache is exercised through the exported
//  test seam, so this runs in the normal suite and costs nothing.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { describe, it, expect, beforeEach } from 'vitest';

globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.window = Object.assign(globalThis, { addEventListener() {}, removeEventListener() {} });
globalThis.__APP_VERSION__ = '0.0.0';

const proxy = await import('../../services/aiProxyService.ts');
const { buildOpenerPayload, _clearPrewarmedCover, _setPrewarmedCoverForTest, takePrewarmedCover } = proxy;

const RESUME = [
  'VENU MADHAV  Data Engineer',
  'TECHNICAL SKILLS',
  '●   AWS Data Platform:   S3, Glue, Redshift, Kafka, Airflow, Snowflake',
  'PROFESSIONAL EXPERIENCE  Data Engineer   |   Siemens, Dallas, TX   |   April 2026 – Present',
  '●   Rebuilt the lakehouse ETL path and cut query latency ~40%.',
  'Data Engineer   |   Apollo Hospitals, Hyderabad, India   |   Sep 2022 – December 2023',
  '●   Owned Kafka and Python pipelines at 3M records a day.',
].join('  ');
const FILES = [{ id: 'r', name: 'r.pdf', type: 'custom', content: RESUME }];

const LINE = 'The constraint that decides this is whether the sink can absorb a duplicate at all.';

describe('opener precedence', () => {
  beforeEach(() => _clearPrewarmedCover());

  // ⚠️ INVERTED 2026-08-22. This test used to assert the opposite — that a
  // question the LEDGER could answer was opened by a locally composed
  // sentence, and that no model line could displace it. That precedence is
  // gone. A live drive against a 166 KB markdown knowledge base had the
  // local composer speak "Before that, Opened 6 May 2026 and Cook Myosite"
  // (a date read as an employer) and "that's where I did my 2. MS-specific
  // OQ" (a markdown list marker read as a noun), at 0ms, in front of the
  // model cover that would have answered properly. Provenance checking
  // cannot catch those: every token was in the document, only the relations
  // between them were invented.
  it('a question the ledger COULD answer still takes the model cover', () => {
    const q = 'Which companies have you worked for?';
    _setPrewarmedCoverForTest(q, LINE, 'medium');
    const p = buildOpenerPayload(q, FILES, []);
    expect(p.coverShape).toBe('prewarm');
    expect(p.instantOpener).toBe(LINE);
  });

  it('and with no prewarm ready it stays SILENT — there is no local fallback', () => {
    const q = 'Which companies have you worked for?';
    const p = buildOpenerPayload(q, FILES, []);
    expect(p.instantOpener, 'a composed sentence must never reach the rail').toBe('');
    expect(p.coverPolicy).toBe('defer');
  });

  it('a challenge to a previous answer is still opened by NOTHING', () => {
    // The one verdict that survived. A model handed the question without the
    // transcript invents a reason — the IBM -> Accenture cascade.
    const q = 'Wait, that contradicts what you just said. Which is it?';
    _setPrewarmedCoverForTest(q, LINE, 'medium');
    const p = buildOpenerPayload(q, FILES, []);
    expect(p.instantOpener).toBe('');
    expect(p.coverPolicy).toBe('suppress');
  });

  it('a DEFERRED question takes the prewarmed line and its effort verdict', () => {
    const q = 'Design exactly-once delivery into a sink that cannot deduplicate.';
    _setPrewarmedCoverForTest(q, LINE, 'medium');
    const p = buildOpenerPayload(q, FILES, []);
    expect(p.instantOpener).toBe(LINE);
    expect(p.coverPolicy).toBe('open');
    expect(p.coverShape).toBe('prewarm');
    expect(p.coverEffort).toBe('medium');
  });

  it('with no prewarm, a deferred question is unchanged — silence, as today', () => {
    const q = 'Design exactly-once delivery into a sink that cannot deduplicate.';
    const p = buildOpenerPayload(q, FILES, []);
    expect(p.instantOpener).toBe('');
    expect(p.coverPolicy).toBe('defer');
  });
});

describe('the divergence check — the line was written for a question that may have grown', () => {
  beforeEach(() => _clearPrewarmedCover());

  it('accepts a small tail added while the speaker kept talking', () => {
    _setPrewarmedCoverForTest('what is your experience with Kafka', LINE, 'low');
    expect(takePrewarmedCover('what is your experience with Kafka and PySpark?')).not.toBeNull();
  });

  it('rejects a question that grew beyond recognition', () => {
    _setPrewarmedCoverForTest('what about Kafka', LINE, 'low');
    expect(takePrewarmedCover(
      'what about Kafka — actually forget that, design me an exactly-once pipeline into a warehouse that cannot deduplicate rows'
    )).toBeNull();
  });

  it('rejects a different question entirely', () => {
    _setPrewarmedCoverForTest('what is your experience with Kafka', LINE, 'low');
    expect(takePrewarmedCover('tell me about a production incident')).toBeNull();
  });

  it('is case and whitespace insensitive, because a transcript is neither', () => {
    _setPrewarmedCoverForTest('What is your   experience with Kafka', LINE, 'low');
    expect(takePrewarmedCover('what is your experience with kafka')).not.toBeNull();
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  AN OPENER IS SPOKEN ONCE — take consumes, peek does not.
//
//  takePrewarmedCover used to leave the store intact, so a consecutive
//  similar question inside the 45s TTL reused it verbatim: "…experience
//  with Kafka" answered, "…experience with Kafka streams" asked twenty
//  seconds later (19% growth — inside the divergence bound), and the
//  candidate opened both answers with the IDENTICAL sentence.
//
//  The peek half is what makes consumption safe to add at all: the hook
//  re-fires as the transcript grows and consults the store through
//  buildOpenerPayload to decide whether to refetch. If that consultation
//  consumed, the hook's own re-fire would destroy the cover before send.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe('consumption — spoken once, peeked freely', () => {
  beforeEach(() => _clearPrewarmedCover());
  const DEFER_Q = 'Design exactly-once delivery into a sink that cannot deduplicate.';

  it('a taken cover cannot be re-spoken by the next similar question', () => {
    _setPrewarmedCoverForTest('what is your experience with kafka', LINE, 'low');
    expect(takePrewarmedCover('what is your experience with kafka')).not.toBeNull();
    expect(
      takePrewarmedCover('what is your experience with kafka streams'),
      'the SAME opening sentence would be spoken twice in a row'
    ).toBeNull();
  });

  it('a speculative build peeks — the hook re-fire must not destroy the cover before send', () => {
    _setPrewarmedCoverForTest(DEFER_Q, LINE, 'medium');
    const p1 = buildOpenerPayload(DEFER_Q, FILES, [], { speculative: true });
    const p2 = buildOpenerPayload(DEFER_Q, FILES, [], { speculative: true });
    expect(p1.instantOpener).toBe(LINE);
    expect(p2.instantOpener, 'a peek consumed the store').toBe(LINE);
    // The send path takes for real…
    expect(buildOpenerPayload(DEFER_Q, FILES, []).instantOpener).toBe(LINE);
    // …and after it, the store is empty: the next build defers, so the next
    // question earns a FRESH cover instead of an echo.
    const after = buildOpenerPayload(DEFER_Q, FILES, []);
    expect(after.instantOpener).toBe('');
    expect(after.coverPolicy).toBe('defer');
  });
});
