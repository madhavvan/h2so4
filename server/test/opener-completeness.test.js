// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  DO NOT CLAIM A COMPLETE LIST YOU HAVE JUST TRUNCATED.
//
//  listOrgs caps the spoken list at four names. The "where have you
//  worked" forms included "<orgs> — those are the ones." and "It's been
//  <orgs>." — both of which assert that is ALL of them. On a résumé with
//  five employers the two combined into a self-contradiction, measured
//  live against gpt-5.6 on 2026-08-17:
//
//    spoken : "Siemens, Indiana University, G Technologies and Apollo
//              Hospitals — those are the ones."
//    answer : "Chronologically, I started at KIMS Hospitals, then Apollo
//              Hospitals, Indiana University, G Technologies, and now
//              Siemens."
//
//  Nothing was fabricated, so no guard in this codebase had anything to
//  catch — every name is real and the main model is RIGHT to add the
//  fifth, because it can see the whole document. The defect is purely the
//  claim of completeness, and the interviewer hears both halves.
//
//  This is the class the grounding guard structurally cannot see: a true
//  sentence made false by what it implies.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { describe, it, expect } from 'vitest';

globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.window = Object.assign(globalThis, { addEventListener() {}, removeEventListener() {} });
globalThis.__APP_VERSION__ = '0.0.0';

const { buildLedger } = await import('../../services/factLedger.ts');
const { composeOpener } = await import('../../services/instantOpener.ts');

const role = (org, from, to) =>
  `Data Engineer   |   ${org}   |   ${from} – ${to}  `
  + `●   Built and owned ETL pipelines at ${org}, handling ingestion, modelling and quality gates.  `;

function ledgerWith(orgs) {
  const doc = [
    'VENU MADHAV  Data Engineer',
    'TECHNICAL SKILLS',
    '●   AWS Data Platform:   S3, Glue, Redshift, Kafka, Airflow, Snowflake',
    'PROFESSIONAL EXPERIENCE',
    ...orgs.map((o, i) => role(o, `Jan ${2016 + i * 2}`, `Dec ${2017 + i * 2}`)),
  ].join('  ');
  return buildLedger([{ id: 'r', name: 'r.pdf', type: 'custom', content: doc }]);
}

const CLAIMS_COMPLETE = /those are the ones|it'?s been/i;
const HEDGED = /\bmostly\b|among others|most recently/i;

const QUESTIONS = [
  'Which companies have you worked for?',
  'Where have you worked?',
  'What organizations have you worked for, and in what order?',
];

describe('the employer list only claims completeness when it IS complete', () => {
  it('four or fewer employers may be spoken as the whole list', () => {
    const ledger = ledgerWith(['Siemens', 'Apollo Hospitals', 'KIMS Hospitals']);
    expect(ledger.employers.length, 'fixture must extract the employers').toBeGreaterThanOrEqual(3);
    for (const q of QUESTIONS) {
      const d = composeOpener(ledger, q);
      if (d.kind !== 'speak') continue;
      // Every extracted employer is named, so either phrasing is honest.
      for (const org of ['Siemens', 'Apollo Hospitals', 'KIMS Hospitals']) {
        expect(d.text, `${org} missing from "${d.text}"`).toContain(org);
      }
    }
  });

  it('MORE than four is never spoken as a closed list', () => {
    const orgs = ['Siemens', 'Indiana University', 'G Technologies', 'Apollo Hospitals', 'KIMS Hospitals'];
    const ledger = ledgerWith(orgs);
    expect(ledger.employers.length, 'fixture must extract five employers').toBeGreaterThan(4);
    let spoke = 0;
    for (const q of QUESTIONS) {
      const d = composeOpener(ledger, q);
      if (d.kind !== 'speak') continue;
      spoke++;
      const named = orgs.filter((o) => d.text.includes(o)).length;
      if (named < orgs.length) {
        expect(
          CLAIMS_COMPLETE.test(d.text),
          `truncated to ${named} of ${orgs.length} but still claims the full set: "${d.text}"`
        ).toBe(false);
        expect(
          HEDGED.test(d.text),
          `a truncated list must be hedged, got: "${d.text}"`
        ).toBe(true);
      }
    }
    expect(spoke, 'at least one phrasing must actually speak').toBeGreaterThan(0);
  });

  it('the hedged forms carry no completeness claim of their own', () => {
    // Belt: the partial phrasings must not themselves imply a closed set,
    // or the fix would only move the problem into different words.
    for (const t of ['Mostly A, B and C.', 'A, B and C, among others.', 'Most recently A, B and C.']) {
      expect(CLAIMS_COMPLETE.test(t), `"${t}" still claims completeness`).toBe(false);
    }
  });
});
