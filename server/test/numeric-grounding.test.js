// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  NUMERIC GROUNDING — client and server agree, and the rules hold
//
//  Sibling of grounding-parity.test.js. That suite pins
//  unverifiedProperNouns; this one pins unverifiedNumbers. Same shape:
//  load both real implementations, run them over a shared corpus, assert
//  identical arrays. A guard that disagrees with its twin is worse than
//  no guard — it would pass exactly the figures the other rejects.
//
//  The four VERIFICATION scenarios from the spec are named first and
//  asserted exactly; the corpus after them covers the equivalence classes
//  and IGNORE filters the rule depends on (K/M/B collapse, bare-vs-percent,
//  allowed-echo, dedup, ordinals, small bare vs small-with-unit, empty-KB
//  abstention including the "digest has prose but no metrics" subtlety).
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.window = Object.assign(globalThis, { addEventListener() {}, removeEventListener() {} });
globalThis.__APP_VERSION__ = '0.0.0';

const require = createRequire(import.meta.url);
const guard = require('../src/services/groundingGuard.js');
const { unverifiedNumbers: clientUnverifiedNumbers } = await import('../../services/factLedger.ts');

const CTX = 'NUMBERS THAT ARE TRUE: ~40%, 50K+, 3M+, 94%, 75K+';

// ── THE FOUR GROUND-TRUTH SCENARIOS ──
//
// These are the probe cases the implementation is measured against. Both
// sides must return exactly these arrays, JSON-stable, or the cover path
// will disagree with itself about what is safe to speak.
const SCENARIOS = [
  {
    name: 'grounded K/M/B word form and bare-vs-percent',
    ctx: CTX,
    text: 'we processed 3 million records a day and cut runtime 94%',
    allowed: undefined,
    expect: [],
  },
  {
    name: 'invented percent and bare count',
    ctx: CTX,
    text: 'we cut latency by 62% across 400 services',
    allowed: undefined,
    expect: ['62%', '400'],
  },
  {
    name: 'empty context abstains even when text is full of figures',
    ctx: '',
    text: 'we cut latency by 62% across 400 services and made 94% faster with 3 million records',
    allowed: undefined,
    expect: [],
  },
  {
    name: 'token-embedded, version, and year are never claims',
    ctx: CTX,
    text: 'deployed on S3 and EC2 with OAuth 2.0 in 2023',
    allowed: undefined,
    expect: [],
  },
];

describe('unverifiedNumbers — the four verification scenarios', () => {
  for (const sc of SCENARIOS) {
    it(sc.name, () => {
      const server = guard.unverifiedNumbers(sc.ctx, sc.text, sc.allowed);
      const client = clientUnverifiedNumbers(sc.ctx, sc.text, sc.allowed);
      expect(server, `server: ${sc.name}`).toEqual(sc.expect);
      expect(client, `client: ${sc.name}`).toEqual(sc.expect);
    });
  }
});

// ── EMPTY-CONTEXT ABSTENTION ──
//
// Mirrors the "no vocabulary -> both abstain" case in grounding-parity.
// With nothing uploaded there is nothing to contradict, and flagging every
// number would suppress every cover in a session with no files. This must
// fire on empty/whitespace contextText alone — allowed being undefined or
// even full of numbers does not change it.
describe('unverifiedNumbers — empty contextText abstains', () => {
  it('blank context returns [] even when text looks fabricated and allowed is undefined', () => {
    const text = 'we cut latency by 62% across 400 services and made 94% faster with 3 million records';
    expect(guard.unverifiedNumbers('', text)).toEqual([]);
    expect(guard.unverifiedNumbers('   ', text)).toEqual([]);
    expect(guard.unverifiedNumbers('', text, undefined)).toEqual([]);
    expect(clientUnverifiedNumbers('', text)).toEqual([]);
    expect(clientUnverifiedNumbers('   ', text)).toEqual([]);
  });

  // The subtlety: empty means the STRING is blank, not "the digest has no
  // metrics". A real résumé with skills/employers but no numeric
  // achievements still produces a non-empty digest, and any number the
  // cover then states is correctly unverifiable.
  it('a non-empty digest with zero metrics does NOT abstain', () => {
    const proseOnly = 'SKILLS: Kafka, Python, Spark\nEMPLOYERS: Siemens, Apollo Hospitals';
    const text = 'we cut latency by 62% across 400 services';
    expect(guard.unverifiedNumbers(proseOnly, text)).toEqual(['62%', '400']);
    expect(clientUnverifiedNumbers(proseOnly, text)).toEqual(['62%', '400']);
  });
});

// ── EQUIVALENCE CLASSES AND IGNORE FILTERS ──
//
// Each case exists because a wrong call on it is a specific production
// failure mode: either a true cover dropped over a figure the résumé
// already states (false positive), or an invented quantity spoken aloud
// (false negative).
const PARITY_CASES = [
  // K/M/B collapse: every surface form of three million must clear against
  // a digest that lists 3M+. If any of these flags, the cover that quotes
  // the résumé's own metric is rejected for saying it.
  { ctx: CTX, text: 'we handled 3M records a day', allowed: undefined, expect: [] },
  { ctx: CTX, text: 'we handled 3M+ records a day', allowed: undefined, expect: [] },
  { ctx: CTX, text: 'we handled 3 million records a day', allowed: undefined, expect: [] },
  { ctx: CTX, text: 'we handled 3,000,000 records a day', allowed: undefined, expect: [] },
  { ctx: CTX, text: 'we handled over 3M+ records a day', allowed: undefined, expect: [] },
  { ctx: CTX, text: 'we handled ~3M records a day', allowed: undefined, expect: [] },
  { ctx: CTX, text: 'we handled about 3 million records a day', allowed: undefined, expect: [] },

  // Bare-vs-percent: the model frequently drops the unit when it repeats a
  // figure the digest showed with a percent sign. 94 must satisfy 94%.
  { ctx: CTX, text: 'runtime improved to 94 of the baseline', allowed: undefined, expect: [] },
  { ctx: CTX, text: 'cut that path by 94 percent', allowed: undefined, expect: [] },

  // Bare 94 must NOT match 94K — different magnitude, different number of
  // digits meant. A digest with only 94K leaves a bare 94 unverifiable.
  { ctx: 'NUMBERS THAT ARE TRUE: 94K+', text: 'we hit 94 on the score', allowed: undefined, expect: ['94'] },

  // allowed-echo: a number the interviewer just said belongs to them to
  // repeat, not an invention. Absent from context, present in allowed.
  {
    ctx: CTX,
    text: 'right, the 62% figure is the one I would start from',
    allowed: 'you mentioned cutting latency by 62% — walk me through that',
    expect: [],
  },

  // Same offending raw substring twice → report once, first-occurrence order.
  {
    ctx: CTX,
    text: 'we cut it by 62% on Monday and another 62% on Friday across 400 services',
    allowed: undefined,
    expect: ['62%', '400'],
  },

  // Ordinals are never quantities. "2nd" must pass clean even when neither
  // "2nd" nor "second" appears in the digest.
  {
    ctx: CTX,
    text: 'this is my 2nd time doing this kind of migration',
    allowed: undefined,
    expect: [],
  },

  // Small bare integer: ordinary speech ("I ran 3 experiments"), not a
  // claim. Exempt only when truly bare — no unit, no percent, no magnitude.
  {
    ctx: CTX,
    text: 'I ran 3 experiments before we shipped',
    allowed: undefined,
    expect: [],
  },

  // Small integer WITH a unit: the distinguishing case. 3 percent is a
  // specific checkable claim; if the digest has no such figure it MUST be
  // flagged. Skipping this case would let the small-bare rule swallow every
  // small metric.
  {
    ctx: CTX,
    text: 'we cut errors by 3 percent on that path',
    allowed: undefined,
    expect: ['3 percent'],
  },
  {
    ctx: CTX,
    text: 'scaled the topic to 3M partitions for the burst',
    allowed: undefined,
    expect: [], // 3M is in CTX
  },

  // Token adjacency and years — already in SCENARIOS, kept here so the
  // parity loop covers them under a second allowed-context too.
  {
    ctx: CTX,
    text: 'S3 and EC2 with OAuth 2.0 and llama-3.3 since 2019',
    allowed: undefined,
    expect: [],
  },

  // Invented pair from the live failure mode, against a real-looking digest.
  {
    ctx: CTX,
    text: 'we cut latency by 62% across 400 services',
    allowed: undefined,
    expect: ['62%', '400'],
  },
];

describe('client and server unverifiedNumbers agree exactly', () => {
  it('every parity case, both implementations', () => {
    let checked = 0;
    let disagreements = 0;
    for (const c of [...SCENARIOS.map((s) => ({
      ctx: s.ctx, text: s.text, allowed: s.allowed, expect: s.expect,
    })), ...PARITY_CASES]) {
      const server = guard.unverifiedNumbers(c.ctx, c.text, c.allowed);
      const client = clientUnverifiedNumbers(c.ctx, c.text, c.allowed);
      checked++;
      if (JSON.stringify(server) !== JSON.stringify(client)) {
        disagreements++;
        console.log(`   DISAGREE text="${c.text.slice(0, 60)}"`);
        console.log(`     client=${JSON.stringify(client)}  server=${JSON.stringify(server)}`);
      }
      expect(server, `server text="${c.text}"`).toEqual(c.expect);
      expect(client, `client text="${c.text}"`).toEqual(c.expect);
      expect(server, `parity text="${c.text}"`).toEqual(client);
    }
    console.log(`   ${checked} cases checked, ${disagreements} disagreements`);
    expect(disagreements).toBe(0);
  });

  // Same constant names and members on both sides — if MAGNITUDE_OF drifts,
  // 3M stops equalling 3 million on one side only, and the parity case
  // above would still pass if both are wrong the same way. Pin the source.
  it('MAGNITUDE_OF members are identical on both sides', async () => {
    const fs = await import('node:fs');
    const tsSrc = fs.readFileSync(new URL('../../services/factLedger.ts', import.meta.url), 'utf8');
    const jsSrc = fs.readFileSync(new URL('../src/services/groundingGuard.js', import.meta.url), 'utf8');
    const grab = (src) => {
      const m = /const MAGNITUDE_OF[^=]*=\s*\{([^}]+)\}/.exec(src);
      expect(m, 'MAGNITUDE_OF missing').toBeTruthy();
      return (m[1].match(/\b[a-z]+\s*:\s*\d+/g) || []).map((x) => x.replace(/\s+/g, '')).sort();
    };
    const a = grab(tsSrc);
    const b = grab(jsSrc);
    console.log(`   MAGNITUDE_OF client=[${a}] server=[${b}]`);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
  });
});
