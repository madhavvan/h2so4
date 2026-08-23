// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  AN EMPLOYER IS A NAME, NOT A SENTENCE ABOUT WORK.
//
//  The capitalisation heuristic in orgLooking cannot tell these apart,
//  because a resume bullet opens with a capitalised verb and is full of
//  capitalised product names — so it scores BETTER than a real employer:
//
//    "Pioneered AWS Lambda automation"      3 of 4 capitalised = 75%
//    "Engineered real-time ETL pipelines"   2 of 4             = 50%
//    "Apollo Hospitals"                     2 of 2             = 100%
//
//  Measured on real resumes in other people's templates (2026-08-17),
//  where a newline-less PDF puts the previous bullet inside the
//  date-anchor window, the app would have SPOKEN:
//
//    "It's been Pioneered AWS Lambda automation, Engineered Python/SQL
//     automation and Digitized records with MongoDB."
//    "It's been Client: NTT Global Data Centers Americas and Client: Sify
//     Technologies Ltd - Hyderabad Data Center."
//    "It's been Soft Skills and Managed structured and unstructured
//     healthcare datasets."
//
//  None of that is a fabrication the grounding guard could catch — every
//  word is on the document. It is the PARSE that is wrong, and the opener
//  speaks the parse.
//
//  ⚠️ FAILING CLOSED IS THE POINT. Two of those resumes now extract NO
//  employers at all, and that is the correct outcome: the opener defers,
//  the candidate hears the model's own first sentence, and nothing false is
//  said. A missed employer costs a moment; a bullet spoken as an employer
//  costs the interview.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { describe, it, expect } from 'vitest';

globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.window = Object.assign(globalThis, { addEventListener() {}, removeEventListener() {} });
globalThis.__APP_VERSION__ = '0.0.0';

const { buildLedger } = await import('../../services/factLedger.ts');
const { composeOpener } = await import('../../services/instantOpener.ts');

const led = (content) => buildLedger([{ id: 'r', name: 'r.pdf', type: 'custom', content }]);
const orgsOf = (content) => led(content).employers.map((e) => e.subject);

// The shape that breaks it: a PDF with almost no newlines, so the window
// before a date range runs back through the previous bullet.
const BLOB_RESUME =
  'VENU PENTLAM  Data Engineer  PROFESSIONAL EXPERIENCE  '
  + 'Freelance EMR Developer  Jan 2022 – Dec 2023  '
  + '● Pioneered AWS Lambda automation Jan 2024 – Present  '
  + '● Engineered Python/SQL automation Jun 2021 – Dec 2021  '
  + '● Digitized records with MongoDB Mar 2020 – May 2021  '
  + 'TECHNICAL SKILLS  Python, SQL, AWS Lambda, MongoDB  ';

// Contractor resumes label their fields inline.
const LABELLED_RESUME =
  'RISHI K  Telecom Engineer  PROFESSIONAL EXPERIENCE  '
  + 'Role: Jr Telecom Core Engineer | Client: NTT Global Data Centers Americas | Jan 2025 – Present  '
  + '● Managed core network provisioning and fault triage.  '
  + 'Role: Network Engineer | Client: Sify Technologies Ltd | Mar 2022 – Dec 2024  '
  + '● Handled datacenter interconnects.  ';

const RESUME_VERB = /^(pioneered|engineered|digitized|digitised|managed|built|designed|developed|implemented|created|led|owned|delivered|migrated|automated|handled|supported|trailblazed|masterminded|unleashed)\b/i;
const FIELD_LABEL = /^(client|role|company|employer|title|position|project)\s*:/i;

describe('a bullet is never read as an employer', () => {
  it('the newline-less blob yields no verb-headed employers', () => {
    for (const org of orgsOf(BLOB_RESUME)) {
      expect(RESUME_VERB.test(org), `bullet text extracted as an employer: "${org}"`).toBe(false);
    }
  });

  it('and would rather say NOTHING than say a bullet', () => {
    const d = composeOpener(led(BLOB_RESUME), 'Which companies have you worked for?');
    if (d.kind === 'speak') {
      expect(RESUME_VERB.test(d.text.replace(/^(mostly|it'?s been|most recently)\s+/i, '')),
        `would speak a bullet: "${d.text}"`).toBe(false);
    }
  });

  it('a percentage never survives inside a company name', () => {
    const orgs = orgsOf(BLOB_RESUME.replace('Pioneered AWS Lambda automation', 'Cut latency by 40% overall'));
    for (const org of orgs) expect(/%/.test(org), `metric in an employer: "${org}"`).toBe(false);
  });
});

describe('a field label is not part of the company name', () => {
  it('strips Client: / Role: and keeps the real name', () => {
    const orgs = orgsOf(LABELLED_RESUME);
    for (const org of orgs) {
      expect(FIELD_LABEL.test(org), `label kept in the employer: "${org}"`).toBe(false);
    }
    expect(orgs.join(' | ')).toMatch(/NTT Global Data Centers/);
  });

  it('and the spoken opener carries no label either', () => {
    const d = composeOpener(led(LABELLED_RESUME), 'Which companies have you worked for?');
    if (d.kind === 'speak') expect(d.text).not.toMatch(/\b(client|role)\s*:/i);
  });
});

describe('a section heading is not an employer', () => {
  for (const heading of ['Soft Skills', 'Technical Skills', 'Core Competencies', 'Interests']) {
    it(`"${heading}" is never extracted as a company`, () => {
      const doc =
        'A CANDIDATE  Engineer  PROFESSIONAL EXPERIENCE  '
        + `Data Engineer | Apollo Hospitals | Jan 2022 – Dec 2023  `
        + `● Owned the ingestion path.  ${heading}  Python, SQL  Jan 2020 – Dec 2021  `;
      for (const org of orgsOf(doc)) {
        expect(org.toLowerCase()).not.toBe(heading.toLowerCase());
      }
    });
  }
});

// ── THE CONTROL: real companies must still come through ──
describe('real employers are not collateral damage', () => {
  const REAL =
    'A CANDIDATE  Data Engineer  PROFESSIONAL EXPERIENCE  '
    + 'Data Engineer | Apollo Hospitals | Sep 2022 – Dec 2023  ● Owned Kafka ingestion at 3M records a day.  '
    + 'Research Assistant | Indiana University | Jan 2024 – Dec 2025  ● Built Snowflake models.  '
    + 'Analyst | KIMS Hospitals | Jun 2016 – Aug 2017  ● Reported on clinical data.  ';

  it('extracts all three', () => {
    const orgs = orgsOf(REAL);
    for (const want of ['Apollo Hospitals', 'Indiana University', 'KIMS Hospitals']) {
      expect(orgs.join(' | '), `${want} was lost`).toContain(want);
    }
  });

  it('a company whose name STARTS with an action verb survives when it carries a corporate suffix', () => {
    const doc =
      'A CANDIDATE  Analyst  PROFESSIONAL EXPERIENCE  '
      + 'Analyst | Managed Care Solutions Inc | Jan 2022 – Dec 2023  ● Ran reporting.  ';
    expect(orgsOf(doc).join(' | ')).toContain('Managed Care Solutions Inc');
  });
});
