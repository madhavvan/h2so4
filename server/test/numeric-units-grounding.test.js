// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  AN INVENTED METRIC MUST NOT ESCAPE ON PUNCTUATION.
//
//  The number guard used to recognise only percentages, scale words
//  (thousand/million/billion) and bare digits. Everything else fell to
//  isNumberEmbeddedInToken — a filter meant for version numbers and
//  identifiers, which cannot tell those from a duration. Measured:
//
//      "24 hour" caught   ·   "24-hour" INVISIBLE
//      "90 ms"   caught   ·   "820ms"   INVISIBLE
//      "500 GB"  caught   ·   "40x"     INVISIBLE
//
//  So whether a fabrication was stopped depended on how it happened to be
//  typed. That is not academic: the invention recorded from a real
//  interview — "causing a 24-hour data loss" — is the invisible spelling.
//  A number the candidate then has to defend is the worst kind, because
//  the real answer is still generating and has not seen the invention;
//  the two contradict each other out loud.
//
//  Both halves of the check read the SAME regex — the résumé through
//  collectCanonicalNumbers and the cover through unverifiedNumbers — so
//  these tests pin the catch AND the non-rejection of true figures.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { unverifiedNumbers } = require('../src/services/groundingGuard.js');

// Deliberately carries NO 24, 820, 90, 48, 40, 500 or 15, so anything the
// cover states with those values is genuinely unsupported.
const RESUME = [
  'Data Engineer at Apollo Hospitals.',
  'Built Kafka pipelines processing 3 million clinical events daily.',
  'Held 94 % uptime across 400 Airflow DAGs.',
  'Ran a 2 TB warehouse and a 7 day retention window.',
].join('\n');

const caught = (text) => unverifiedNumbers(RESUME, text, '');

describe('invented metrics are caught however they are typed', () => {
  const INVENTED = [
    ['hyphenated duration — the recorded fabrication', 'causing a 24-hour data loss'],
    ['hyphenated duration, longer', 'a 48-hour outage over the weekend'],
    ['unit glued to the digits', 'we cut p99 latency from 820ms to the low hundreds'],
    ['spaced unit', 'the job took 90 ms per record'],
    ['multiplier', 'that made it 40x faster'],
    ['storage', 'we were moving 500 GB a night'],
    ['throughput', 'it sustained 15 QPS at peak'],
  ];
  for (const [label, text] of INVENTED) {
    it(`catches: ${label}`, () => {
      expect(caught(text).length, `"${text}" was allowed through`).toBeGreaterThan(0);
    });
  }
});

describe('true figures from the resume are still allowed', () => {
  // The other half of the job. A guard that rejects the candidate's real
  // numbers silently throws away good covers, which is how the previous
  // false-positive incidents happened.
  const TRUE_FIGURES = [
    'I handled 3 million clinical events daily at Apollo Hospitals.',
    'We held 94 % uptime.',
    'That ran across 400 DAGs.',
    'It was a 2 TB warehouse.',
    'We kept a 7 day retention window.',
  ];
  for (const text of TRUE_FIGURES) {
    it(`allows: ${text.slice(0, 46)}…`, () => {
      expect(caught(text), `"${text}" was wrongly rejected`).toEqual([]);
    });
  }
});

describe('the ordering trap inside canonicalizeNumber', () => {
  it('does not read the B of "GB" as billion', () => {
    // Stripping the unit AFTER the K/M/B scale-letter branch turned
    // "500 GB" into 500 × 1e9 with a leftover "G", which fails the numeric
    // parse and returns null — and null is a `continue`. Adding units to
    // the regex without fixing the order made this case go from CAUGHT to
    // INVISIBLE. This is the regression test for that.
    expect(caught('we were moving 500 GB a night').length).toBeGreaterThan(0);
    expect(caught('a 2 TB warehouse')).toEqual([]);   // true one still fine
  });

  it('still handles the scale words it always did', () => {
    expect(caught('roughly 9 million rows')).toEqual(['9 million']);
    expect(caught('3 million clinical events')).toEqual([]);
  });
});

describe('no knowledge base means no opinion', () => {
  it('flags nothing when there is nothing to contradict', () => {
    // The app's most common state is a session with no files uploaded.
    // Flagging every number there would suppress every cover.
    expect(unverifiedNumbers('', 'a 24-hour outage and 820ms latency', '')).toEqual([]);
  });
});
