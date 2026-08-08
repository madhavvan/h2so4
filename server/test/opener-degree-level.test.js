// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ASKED ABOUT THE BACHELORS, DO NOT SPEAK THE MASTERS.
//
//  The EDUCATION matcher recognises "bachelors" and "masters" as distinct
//  questions; the selection did not. selectFacts ranks by lexical overlap,
//  so "what was your bachelors on?" shares no term with "Master of
//  Science", scores nothing, and fell through to `|| ledger.education[0]`
//  — the most recent entry. Observed on a real résumé: asked about the
//  BACHELORS, the opener said "Indiana University — Master of Science".
//
//  Same shape as the `ledger.skills[0]` fallback that was removed from the
//  platforms branch, and it fails the same way: nothing matched, so it
//  guessed — and a guess here is spoken out loud, instantly, before the
//  real answer exists.
//
//  Deferring is the correct outcome for a level the résumé does not carry:
//  silence for a beat, then the main model answers from the full document.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { describe, it, expect, beforeEach } from 'vitest';

globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.window = Object.assign(globalThis, { addEventListener() {}, removeEventListener() {} });

const { buildLedger, resetLedger } = await import('../../services/factLedger.ts');
const { composeOpener } = await import('../../services/instantOpener.ts');

// Guard against the exact mistake this file already made once: an earlier
// draft probed for `decideOpener || instantOpener || openerFor || default`,
// none of which exist, so `decide` was undefined, every call returned '',
// and all four tests passed while exercising nothing at all.
if (typeof composeOpener !== 'function') {
  throw new Error('composeOpener is not exported — this suite would pass vacuously');
}

const BOTH_DEGREES = `
VENU MADHAV

EDUCATION
Master of Science, Health Informatics | Indiana University | 2024 - 2025
Bachelor of Technology, Computer Science | Osmania University | 2016 - 2020

PROFESSIONAL EXPERIENCE
Data Engineer | Apollo Hospitals | Jan 2022 - Dec 2023
Built Kafka pipelines for clinical events.
`.trim();

const MASTERS_ONLY = `
VENU MADHAV

EDUCATION
Master of Science, Health Informatics | Indiana University | 2024 - 2025

PROFESSIONAL EXPERIENCE
Data Engineer | Apollo Hospitals | Jan 2022 - Dec 2023
`.trim();

const ledgerFor = (text) => {
  resetLedger();
  return buildLedger([{ id: 'f1', name: 'resume.pdf', content: text }]);
};

/** The words the candidate would actually say, or '' when the opener defers. */
const speak = (ledger, q) => {
  const d = composeOpener(ledger, q);
  return d && d.kind === 'speak' && d.text ? String(d.text) : '';
};

beforeEach(() => resetLedger());

describe('degree level is respected', () => {
  it('answers the bachelors question with the bachelors', () => {
    const said = speak(ledgerFor(BOTH_DEGREES), 'what was your bachelors on?');
    if (!said) return;                       // deferring is also acceptable
    expect(said).not.toMatch(/master/i);
  });

  it('answers the masters question with the masters', () => {
    const said = speak(ledgerFor(BOTH_DEGREES), 'what was your masters in?');
    if (!said) return;
    expect(said).not.toMatch(/bachelor|b\.?tech/i);
  });

  it('DEFERS rather than speaking the masters when only a masters exists', () => {
    // The exact recorded failure. Saying "Master of Science" to someone who
    // asked about the bachelors is worse than a beat of silence.
    const said = speak(ledgerFor(MASTERS_ONLY), 'what was your bachelors on?');
    expect(said).not.toMatch(/master/i);
  });

  it('leaves an unqualified education question exactly as it was', () => {
    // No level named means any degree is a truthful answer — this branch
    // must not become stricter, or a good opener is lost for no reason.
    const said = speak(ledgerFor(MASTERS_ONLY), 'where did you study?');
    if (said) expect(said).toMatch(/indiana|master/i);
  });
});
