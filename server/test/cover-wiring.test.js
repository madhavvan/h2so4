// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  THE JOINTS OF THE 2026-08-20 REWIRING
//
//  Each of these pins one seam that had to move for the cover to read the
//  uploaded documents instead of a summary of them. They are here rather
//  than spread across the existing files because the failure they guard
//  against is a seam coming apart quietly — the shape this codebase keeps
//  losing hours to.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'wiring-secret';
process.env.DATABASE_PATH = ':memory:';

const require_ = createRequire(import.meta.url);
const contextStore = require_('../src/services/contextStore.js');
const guard = require_('../src/services/groundingGuard.js');
const cover = require_('../src/services/coverAnswer.js');

globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.window = Object.assign(globalThis, { addEventListener() {}, removeEventListener() {} });
globalThis.__APP_VERSION__ = '0.0.0';
const { composeOpener } = await import('../../services/instantOpener.ts');
const { buildLedger } = await import('../../services/factLedger.ts');

// ── 1. A speculative field must never fail a live answer ──
describe('a missing cover blob degrades, it does not 409', () => {
  beforeEach(() => contextStore._test._reset());

  it('resolveText THROWS on a miss — the main prompt still must', () => {
    // systemInstruction/prompt/messages keep the retryable 409: the model
    // cannot answer without them and the client knows how to re-upload.
    expect(() => contextStore.resolveText('u1', `⟪CTX:${'a'.repeat(64)}⟫`))
      .toThrowError(/context_missing/);
  });

  it('resolveTextLenient returns empty instead', () => {
    // The cover is a sentence spoken in front of an answer already on its
    // way. Refusing the whole request because the OPENER lost its grounding
    // would turn a degraded cover into a failed answer.
    expect(contextStore.resolveTextLenient('u1', `⟪CTX:${'a'.repeat(64)}⟫`)).toBe('');
  });

  it('…and resolves normally when the blob is there', () => {
    const text = 'the whole uploaded document';
    const { hash } = contextStore.put('u1', text);
    expect(contextStore.resolveTextLenient('u1', `⟪CTX:${hash}⟫`)).toBe(text);
  });

  it('still refuses an abusive expansion — that one is not a cache miss', () => {
    // CONTEXT_TOO_LARGE is the backstop against the amplification attack the
    // pricing pass exists to stop. Swallowing it would remove the only guard.
    const many = Array.from({ length: 40 }, () => `⟪CTX:${'b'.repeat(64)}⟫`).join(' ');
    expect(() => contextStore.resolveTextLenient('u1', many)).toThrowError(/context_too_large/);
  });
});

// ── 2. The two category sets encode one judgement ──
describe('PROBLEM_CATEGORIES does not drift from DEEP_CATEGORIES', () => {
  it('they are the same set, by value', () => {
    // coverAnswer says "answered from the question, so give it no
    // background"; routes/ai.js says "worth spending reasoning effort on".
    // Same judgement from two sides. If they diverge, a design question
    // starts getting a résumé again — which is the exact regression the
    // exclusion was added to prevent.
    const { DEEP_CATEGORIES } = require_('../src/routes/ai.js')._test;
    expect([...cover.PROBLEM_CATEGORIES].sort()).toEqual([...DEEP_CATEGORIES].sort());
  });
});

// ── 3. What the cover was allowed to say ──
describe('the guard reads the documents, not just the ledger', () => {
  const { allowedVocabulary } = require_('../src/routes/ai.js')._test;

  it('unions the ledger list with the documents', () => {
    const v = allowedVocabulary('kneat empower', 'The programme covered 70+ assets at Evonik.', 'q');
    expect(v).toMatch(/kneat/);
    expect(v).toMatch(/Evonik/);
  });

  it('falls back to the question when there is no knowledge base at all', () => {
    // ⚠️ THE STRICTEST MODE, NOT THE LOOSEST. With nothing uploaded the
    // question plus what the interviewer said IS the whole permitted
    // vocabulary — that is what stops a cover inventing an employer.
    expect(allowedVocabulary('', '', 'have you used Airflow?')).toBe('have you used Airflow?');
    expect(allowedVocabulary('   ', '  ', 'q')).toBe('q');
  });

  it('the true number in the documents stops being reported as invented', () => {
    // Measured live: the document said "70+ analytical and lab assets", the
    // digest did not carry it, and the guard rejected a correct cover with
    // fabricatedNumbers=[70].
    const docs = 'Evonik AL, CQV Lead — 70+ analytical and lab assets in scope.';
    expect(guard.unverifiedNumbers(docs, 'We had over 70 assets in scope.', 'q')).toEqual([]);
  });
});

// ── 4. A number is a value AND a dimension ──
describe('a figure does not vouch for a different quantity', () => {
  const ctx = 'The engagement is 12 months. Tolerance is 2.5%. Latency 250 ms.';

  it('"12 months" does not license an invented "12 weeks"', () => {
    // The measured hole: the guard compared 12 to 12 and passed it.
    expect(guard.unverifiedNumbers(ctx, 'It delayed release by 12 weeks.', 'q')).toEqual(['12 weeks']);
  });

  it('the same quantity in its own unit still passes', () => {
    expect(guard.unverifiedNumbers(ctx, 'The engagement is 12 months.', 'q')).toEqual([]);
    expect(guard.unverifiedNumbers(ctx, 'Latency was 250 ms.', 'q')).toEqual([]);
  });

  it('a bare repeat of a figure still passes — the model drops units', () => {
    // Deliberate and pre-existing: "94%" then "94" is a model repeating
    // itself, not inventing.
    expect(guard.unverifiedNumbers('Coverage reached 94%.', 'Coverage was 94.', 'q')).toEqual([]);
  });

  it('and the controls are still caught', () => {
    expect(guard.unverifiedNumbers(ctx, 'It slipped by 11 weeks.', 'q')).toEqual(['11 weeks']);
    expect(guard.unverifiedNumbers(ctx, 'Tolerance was 3.7 %.', 'q')).toEqual(['3.7 %']);
    expect(guard.unverifiedNumbers(ctx, 'It ran for 250 days.', 'q')).toEqual(['250 days']);
  });

  it('a magnitude letter is a SCALE, not a unit', () => {
    expect(guard.unverifiedNumbers('We moved 3 million records.', 'We moved 3M records.', 'q')).toEqual([]);
  });
});

// ── 4b. A model and a document spell punctuation differently ──
describe('Unicode punctuation does not turn a true sentence into a fabrication', () => {
  const VOCAB = 'HPLC GC dissolution balances UV-Vis TOC stability chambers autoclaves '
    + "Bachelor's Pharmaceutical Engineering JNTUH Evonik Kneat";

  it('a non-breaking hyphen does not split a real term into an invented one', () => {
    // Measured live: invented=[Vis] on "…balances, UV‑Vis, TOC…", where
    // every instrument named is printed in the uploaded document. U+2011.
    const cover = 'I personally qualified HPLC, GC, dissolution, balances, UV‑Vis and TOC.';
    expect(guard.unverifiedProperNouns(VOCAB, cover, 'q')).toEqual([]);
  });

  it('a curly apostrophe does not invent a degree the résumé states', () => {
    // Measured live: invented=[Bachelor’s, India] on a sentence that is
    // word-for-word what the document says.
    const cover = 'I earned a Bachelor’s in Pharmaceutical Engineering from JNTUH.';
    expect(guard.unverifiedProperNouns(VOCAB, cover, 'q')).toEqual([]);
  });

  it('a non-ASCII letter does not truncate a real vendor name', () => {
    // Measured live on the second document: REJECTED invented=[Bausch+Str]
    // on "I've engineered Bausch+Ströbel, VarioSys, and Syntegon filling
    // lines." — all three are printed in the uploaded file. The token scan
    // is an ASCII class, so it stopped dead at the "ö".
    const V = 'Bausch+Ströbel VarioSys Syntegon Watson-Marlow Sartorius';
    expect(guard.unverifiedProperNouns(V, "I've engineered Bausch+Ströbel, VarioSys, and Syntegon filling lines.", 'q'))
      .toEqual([]);
    // …and the same name typed without the umlaut is the same name.
    expect(guard.unverifiedProperNouns(V, 'I ran Bausch+Strobel lines.', 'q')).toEqual([]);
  });

  it('…and an accented name that is NOT in the documents is still caught', () => {
    expect(guard.unverifiedProperNouns('Syntegon Sartorius', 'I worked at Bürkert.', 'q'))
      .toEqual(['Burkert']);
  });

  it('…and an actual fabrication is still caught, curly or straight', () => {
    // The whole normalisation is worthless if it also waives inventions.
    expect(guard.unverifiedProperNouns(VOCAB, 'I did that at Accenture and IBM.', 'q'))
      .toEqual(['Accenture', 'IBM']);
    expect(guard.unverifiedProperNouns(VOCAB, 'I worked in Google’s lab.', 'q'))
      .toEqual(["Google's"]);
  });
});

// ── 5. A mention is not a question ──
describe('the local opener answers what was asked', () => {
  const led = buildLedger([{
    id: 'r', name: 'resume.docx', type: 'custom',
    content: 'VENU PENTALA\nPROFESSIONAL EXPERIENCE\n'
      + 'CQV Lead | Evonik | Jul 2023 – Present\n● Ran the lab deployment.\n'
      + 'Sr. CQV Engineer | Cook MyoSite | Nov 2021 – Jul 2023\n● Bioreactors and TFF.\n',
  }]);

  it('a yes/no about the employer is still answered', () => {
    const d = composeOpener(led, 'Have you worked at Evonik?');
    expect(d.kind).toBe('speak');
    expect(d.shape).toBe('entity-yes');
  });

  it('"who did you report to at Evonik" is NOT answered with "yes, I was there"', () => {
    // Measured live, spoken aloud: "Evonik AL ·, yes — there from 2023."
    // The main model's own answer named the actual manager.
    const d = composeOpener(led, 'Who did you report to at Evonik, and how large was your team?');
    expect(d.shape).not.toBe('entity-yes');
  });

  it('"how many OEMs did you coordinate at Evonik" likewise', () => {
    // Measured live: "Yeah, Evonik AL · — I was there there, 2023."
    const d = composeOpener(led, 'How many OEMs did you coordinate at Evonik?');
    expect(d.shape).not.toBe('entity-yes');
  });

  it('never says "there there" — a missing role means a shorter sentence', () => {
    const noRole = buildLedger([{
      id: 'r2', name: 'r2.docx', type: 'custom',
      content: 'A CANDIDATE\nPROFESSIONAL EXPERIENCE\nEvonik | Jul 2023 – Present\n● Ran it.\n',
    }]);
    const d = composeOpener(noRole, 'Have you worked at Evonik?');
    if (d.kind === 'speak') expect(d.text).not.toMatch(/\bthere there\b/);
  });

  it('a markdown middot never reaches the candidate’s mouth', () => {
    // "Mostly Evonik AL ·, Cook MyoSite PA ·, MSN NJ · and ScieGen NY ·."
    const md = buildLedger([{
      id: 'r3', name: 'prep.md', type: 'custom',
      content: 'PROFESSIONAL EXPERIENCE\n- Evonik AL · Jul 2023–now · CQV Lead — ran the programme.\n'
        + '- Cook MyoSite PA · Nov 2021–Jul 2023 · Sr. CQV Engineer — bioreactors.\n',
    }]);
    for (const e of md.employers) expect(e.subject).not.toMatch(/[·•]/);
  });

  it('a field LABEL never reaches it either — on EITHER extraction path', () => {
    // Contractor résumés label their fields inline. The org path was fixed
    // first and the ROLE path was not, so the app went on saying it out
    // loud — verified in the running app on 2026-08-20:
    //
    //   "Role: Jr Telecom Core Engineer / Network Infrastructure Engineer
    //    at NTT Global Data Centers Americas since 2025."
    //
    // Two code paths produce a role and both reach the same mouth, so both
    // assertions below matter; the org one alone passed throughout.
    const led = buildLedger([{
      id: 'r4', name: 'contract.docx', type: 'custom',
      content: [
        'PROFESSIONAL EXPERIENCE:',
        '',
        'Client: NTT Global Data Centers Americas, Dallas TX',
        '',
        'Jan 2025 - Present',
        '',
        'Role: Jr Telecom Core Engineer / Network Infrastructure Engineer',
        '',
        'Responsibilities:',
        '',
        '•  Provide Telecom core network support for 50+ nodes.',
      ].join('\n'),
    }]);
    expect(led.employers.length).toBeGreaterThan(0);
    for (const e of led.employers) {
      expect(e.subject, 'the org kept its label').not.toMatch(/^(Client|Role|Company|Title)\s*:/i);
      const spoken = String(e.detail || '').split(' — ')[0];
      expect(spoken, 'the ROLE kept its label').not.toMatch(/^(Client|Role|Company|Title)\s*:/i);
    }
  });

  it('…but a colon inside a real value survives', () => {
    // The bound is what keeps this from eating content: "Microsoft
    // Certified: Azure Data Engineer Associate | Microsoft" lost its first
    // half at a looser bound, and the ledger then read Microsoft as an
    // EMPLOYER — a fabrication another test in this repo exists to prevent.
    const led = buildLedger([{
      id: 'r5', name: 'cert.docx', type: 'custom',
      content: [
        'PROFESSIONAL EXPERIENCE',
        '',
        'Data Engineer | Apollo Hospitals | Jan 2022 - Dec 2023',
        'Built pipelines.',
        '',
        'CERTIFICATIONS',
        'Microsoft Certified: Azure Data Engineer Associate | Microsoft | Mar 2024',
      ].join('\n'),
    }]);
    const orgs = led.employers.map((e) => String(e.subject).toLowerCase()).join(' | ');
    expect(orgs).not.toMatch(/microsoft/);
  });

  it('a yes/no about a place is refused when the question names something else', () => {
    // Measured live in the app on 2026-08-20, on a résumé that says
    // "Merck & Co, VA":
    //
    //   Q "Did you work at Merck's New Jersey site?"
    //   A "I was, yeah — Automation/Validation Engineer at Merck & Co,
    //      2019 to 2021."          ← spoken
    //     "My site was in Virginia, not New Jersey."   ← the main model,
    //                                                    one beat later
    //
    // A yes affirms EVERYTHING in the question, so it confirmed a site the
    // candidate never worked at and then retracted it in the room.
    const led = buildLedger([{
      id: 'r6', name: 'ae.docx', type: 'custom',
      content: [
        'Professional Experience:',
        '',
        'Denali Therapeutics, UT     Mar 2024 - Present',
        'Sr. Automation Engineer',
        'Supported DeltaV DCS integration with cleanroom HVAC systems.',
        '',
        'Merck & Co, VA     Feb 2019 - Jun 2021',
        'Automation/Validation Engineer',
        'Provided MES operational support for PAS-X batch execution.',
      ].join('\n'),
    }]);
    expect(led.employers.length).toBeGreaterThan(1);

    // The employer alone → still answered.
    const plain = composeOpener(led, 'Did you work at Merck?');
    expect(plain.kind).toBe('speak');
    expect(plain.shape).toBe('entity-yes');

    // With a place the documents do not contain → nothing is said, in
    // EITHER direction. A "yes" would affirm New Jersey; a "no" would deny
    // Merck. Both are wrong, so the main model takes it.
    const withSite = composeOpener(led, "Did you work at Merck's New Jersey site?");
    expect(withSite.kind).toBe('defer');

    const withCity = composeOpener(led, 'Were you at the Denali Utah facility?');
    expect(withCity.kind).toBe('defer');
  });

  it('…but a denial the ledger CAN prove still gets made', () => {
    // The IBM case, which is the reason entity-no exists: an employer the
    // documents do not contain anywhere, named on its own.
    const led = buildLedger([{
      id: 'r7', name: 'ae.docx', type: 'custom',
      content: [
        'Professional Experience:',
        '',
        'Denali Therapeutics, UT     Mar 2024 - Present',
        'Sr. Automation Engineer',
        'Supported DeltaV DCS integration with cleanroom HVAC systems.',
        '',
        'Merck & Co, VA     Feb 2019 - Jun 2021',
        'Automation/Validation Engineer',
        'Provided MES operational support for PAS-X batch execution.',
      ].join('\n'),
    }]);
    const d = composeOpener(led, 'Have you ever worked at IBM?');
    expect(d.kind).toBe('speak');
    expect(d.shape).toBe('entity-no');
    expect(d.text).not.toMatch(/IBM/);
  });
});
