// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  THE VOCABULARY THE CLIENT SENDS MUST BE READABLE BY THE GUARD.
//
//  Two halves, built independently:
//    · the CLIENT produces coverVocabulary via ledgerVocabulary(ledger) —
//      `Array.from(ledger.vocabulary).join(' ')`
//    · the SERVER reads it via parseVocabulary(), which splits on
//      whitespace, lowercases, and does NOT strip punctuation
//
//  If those two disagree about what a token is, the guard treats the
//  candidate's OWN skills as invented and throws the cover away — and a
//  dropped cover is silence in a live interview, on the questions where
//  holding the floor matters most. That failure is invisible: the server
//  logs "REJECTED invented=[Airflow]" and everything downstream looks fine.
//
//  This round-trips real résumé text through the real client builder into
//  the real server guard and asserts the candidate's own words survive.
//  It is the only test that covers the SEAM; each half's own tests pass
//  happily while disagreeing with each other.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.window = Object.assign(globalThis, { addEventListener() {}, removeEventListener() {} });
globalThis.__APP_VERSION__ = '0.0.0';

const require = createRequire(import.meta.url);
const guard = require('../src/services/groundingGuard.js');
const { buildLedger } = await import('../../services/factLedger.ts');
const { ledgerVocabulary } = await import('../../services/instantOpener.ts');

// Shaped like a real résumé: comma-separated skill lists and trailing stops,
// which is exactly where a punctuation disagreement would show up.
const RESUME = [
  'VENU MADHAV PENTALA — Data Engineer',
  'TECHNICAL SKILLS',
  'Languages: Python, Java, SQL, Scala.',
  'Data: Apache Kafka, Airflow, Spark, dbt, PostgreSQL, MongoDB.',
  'Cloud: AWS S3, Glue, Redshift, Lambda, Athena.',
  'PROFESSIONAL EXPERIENCE',
  'Data Engineer | Apollo Hospitals, Hyderabad | Sep 2022 – Dec 2023',
  'Owned Kafka and Python pipelines at 3M records a day.',
  'Software Engineer | Indiana University | 2024 – 2025',
  'Maintained 400 Airflow DAGs for a research data platform.',
  'EDUCATION',
  'Master of Science in Health Informatics | Indiana University | 2025',
].join('\n');

const ledger = buildLedger([{ name: 'resume.txt', content: RESUME }]);
const vocabString = ledgerVocabulary(ledger);

describe('the client vocabulary survives the server parser', () => {
  it('produces a non-empty vocabulary at all', () => {
    expect(vocabString.length, 'no vocabulary means the guard abstains entirely').toBeGreaterThan(0);
  });

  // Every one of these is written in the résumé above. If the guard calls
  // any of them invented, it is rejecting the candidate's own background.
  const OWN_WORDS = [
    'Python', 'Java', 'Kafka', 'Airflow', 'Spark', 'PostgreSQL', 'MongoDB',
    'Redshift', 'Lambda', 'Athena', 'Apollo', 'Indiana',
  ];

  it('does not call the candidate\'s own skills invented', () => {
    const sentence = `At Apollo Hospitals I used ${OWN_WORDS.join(', ')} across the pipelines.`;
    const flagged = guard.unverifiedProperNouns(vocabString, sentence, '');
    expect(
      flagged,
      'these appear verbatim in the résumé; flagging them drops a true cover and leaves the candidate silent'
    ).toEqual([]);
  });

  it('each word individually survives the round trip', () => {
    const missed = [];
    for (const w of OWN_WORDS) {
      const flagged = guard.unverifiedProperNouns(vocabString, `I worked with ${w} there.`, '');
      if (flagged.length) missed.push(w);
    }
    expect(missed, 'words the client sent that the server cannot find').toEqual([]);
  });

  it('STILL catches a name the résumé does not contain', () => {
    // The round trip must not be made to pass by weakening the guard.
    const flagged = guard.unverifiedProperNouns(vocabString, 'I spent four years at Goldman Sachs.', '');
    expect(flagged.length, 'the guard has stopped guarding').toBeGreaterThan(0);
  });
});

describe('parseVocabulary and the checker agree on what a token is', () => {
  // The client's join(' ') is not the only producer — the server falls back
  // to `allowed` (the question + interviewer turns) when no vocabulary was
  // sent, and that IS punctuated prose.
  it('a comma- or period-terminated term is still recognised', () => {
    const punctuated = 'Skills: Airflow, Python, PostgreSQL, MongoDB.';
    const flagged = guard.unverifiedProperNouns(punctuated, 'I used Airflow and MongoDB.', '');
    expect(
      flagged,
      'punctuation attached to a vocabulary term must not hide it — the checker strips ' +
        'punctuation from the sentence, so the parser must strip it from the vocabulary too'
    ).toEqual([]);
  });
});
