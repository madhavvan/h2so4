// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  THE COVER READS THE DOCUMENTS, NOT A SUMMARY — AND READS THE
//  PART OF THEM THAT BEARS ON THE QUESTION.
//
//  coverContext used to be ledgerDigest(): the uploaded files parsed into a
//  fact ledger and rebuilt into prose. Measured on a real 39,891-char
//  upload, that rebuild delivered 863 characters — four employers as eight
//  entries, a line the document says not to claim, and the INTERVIEWER's
//  own company's capital figures under a heading reading "NUMBERS THAT ARE
//  TRUE". Every fabrication in the 2026-08-20 live runs came from it.
//
//  ── AND THEN THE REPLACEMENT WAS WRONG TOO ──
//
//  Version one sent the whole document minus a list of SECTION HEADING
//  NAMES. It was written against one pharmaceutical prep file. The next
//  real upload titled the same section "WHO THE CLIENT IS, AND HOW TO PIN
//  IT DOWN" instead of "CLIENT IDENTIFICATION AND SITE INTEL" and went
//  straight through, carrying nine consultancy names the candidate never
//  worked for and a salary band. A list of English headings from one
//  industry cannot be the mechanism in an app used by candidates in every
//  field.
//
//  What the measurement actually showed was a RELEVANCE problem: a model
//  handed 12,000 tokens of mixed content lost the one line that mattered
//  (Kneat, 0/3), and found it when the irrelevant material was gone (3/3).
//  Relevance is measurable without knowing the industry, and this app
//  already measures it — kbRetrieval, BM25, used by the main answer.
//
//  So these tests pin: everything the candidate uploaded is kept verbatim,
//  a genuine job posting is the one exclusion, and what one question is
//  answered from is chosen by relevance to that question.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.window = Object.assign(globalThis, { addEventListener() {}, removeEventListener() {} });
globalThis.__APP_VERSION__ = '0.0.0';

const {
  buildCoverSourceDetailed, buildCoverSource, selectCoverEvidence, resetCoverSource,
  COVER_SOURCE_MAX_CHARS, COVER_EVIDENCE_CHARS, COVER_SELECT_FROM,
} = await import('../../services/coverSource.ts');
const { isJobDescription, looksLikeJobPosting } = await import('../../services/factLedger.ts');

const file = (name, content, extra = {}) => ({ id: name, name, type: 'custom', content, ...extra });

// Sized so the fixture carries a REAL document's marker density. A prep
// document quotes a posting in one section out of twenty; a 4,000-char
// fixture with those same three markers is, correctly, a posting.
const PAD = `\n# 0. NOTES\n${'Prepared from the resume and the role brief. '.repeat(450)}\n`;

const RESUME_MD = [
  '# 2. THE RESUME',
  '- Evonik AL · Jul 2023–now · CQV Lead — 70+ analytical assets, Kneat Gx governance.',
  PAD,
  '# 1. THE ROLE (verbatim)',
  '> Role Overview: Lead the coordination of a large laboratory deployment.',
  '> Responsibilities: run the programme. Qualifications: five years.',
  '',
  '# 3. REFERENCES · ADDRESS HISTORY',
  'Vasu Dama, manager. 12 Stonehenge Ln, Piscataway.',
  '',
  '# 4. CLIENT IDENTIFICATION AND SITE INTEL',
  'Lilly Medicine Foundry — $4.5 B · ~1.2 M sq ft. >$18 B committed to LEAP.',
  '',
  '# 8. INSTRUMENT QUALIFICATION DATA',
  'Balances — USP <41>: accuracy within 0.10% of the test-weight value.',
  '',
  '# 12. Q&A',
  'Used GMARS? No. GMARS is Lilly’s Maximo-based EAM/CMMS. Do not claim it.',
].join('\n');

beforeEach(() => resetCoverSource());

describe('what the cover model is given', () => {
  it('keeps the candidate’s own document WORD FOR WORD', () => {
    // Not paraphrased, not restructured, not rebuilt from a parse. The
    // digest is what invented things; verbatim text cannot.
    const { text } = buildCoverSourceDetailed([file('prep.md', RESUME_MD)]);
    expect(text).toContain('- Evonik AL · Jul 2023–now · CQV Lead — 70+ analytical assets, Kneat Gx governance.');
    expect(text).toContain('Used GMARS? No.');
    expect(text).toContain('Balances — USP <41>: accuracy within 0.10% of the test-weight value.');
  });

  it('KEEPS the section that sat past the old 9,000-char cut', () => {
    // "Used GMARS? No. Do not claim it" lives at char ~30,000 of the real
    // file. The old 9,000-char slice cut it off, and the app claimed GMARS
    // out loud three times across two live runs.
    const { text, truncatedChars } = buildCoverSourceDetailed([file('prep.md', RESUME_MD)]);
    expect(truncatedChars).toBe(0);
    expect(text).toMatch(/Do not claim it/);
  });

  it('KEEPS the client-research section too — the blocklist is gone', () => {
    // ⚠️ THIS ASSERTION IS THE REVERSE OF WHAT IT WAS, on purpose. Dropping
    // this section by its heading name is what could not generalise. It is
    // now kept in the source and simply not SELECTED for a question it has
    // nothing to do with — see the relevance tests below, which is where
    // the protection moved.
    const { text, dropped } = buildCoverSourceDetailed([file('prep.md', RESUME_MD)]);
    expect(text).toContain('Lilly Medicine Foundry');
    expect(dropped).toEqual([]);
  });

  it('never includes a job-description FILE', () => {
    // The one exclusion, and the only correctness condition here: a posting
    // describes the company on the OTHER side of the table.
    const jd = file('posting.txt',
      'Company overview: we are seeking a CQV lead. Responsibilities: run it. Qualifications: five years.');
    const { text, dropped } = buildCoverSourceDetailed([file('cv.md', '# 2. THE RESUME\nEvonik, CQV Lead.'), jd]);
    expect(text).not.toMatch(/we are seeking/i);
    expect(text).toContain('Evonik, CQV Lead.');
    expect(dropped.join(' ')).toMatch(/job posting/i);
  });

  it('a plain resume with no headings passes through WHOLE', () => {
    const plain = 'VENU PENTALA\nCQV Lead\nEvonik, Cook MyoSite, MSN, ScieGen.\nReferences available on request.';
    const { text, dropped } = buildCoverSourceDetailed([file('resume.docx', plain)]);
    expect(text).toContain(plain);
    expect(dropped).toEqual([]);
  });

  it('orders a named resume first, and is stable across calls', () => {
    const files = [file('notes.md', 'x'.repeat(500)), file('Venu-Resume.docx', 'y'.repeat(100))];
    const a = buildCoverSourceDetailed(files).text;
    const b = buildCoverSourceDetailed(files.slice().reverse()).text;
    expect(a.indexOf('Venu-Resume.docx')).toBeLessThan(a.indexOf('notes.md'));
    expect(a).toBe(b);
  });

  it('reports truncation instead of performing it silently', () => {
    const huge = file('big.md', 'z'.repeat(COVER_SOURCE_MAX_CHARS + 5_000));
    const { text, truncatedChars } = buildCoverSourceDetailed([huge]);
    expect(text.length).toBeLessThanOrEqual(COVER_SOURCE_MAX_CHARS);
    expect(truncatedChars).toBeGreaterThan(0);
  });

  it('is empty for an empty knowledge base — the guard’s strictest mode', () => {
    expect(buildCoverSourceDetailed([]).text).toBe('');
    expect(buildCoverSourceDetailed([file('img.png', '', { base64: 'AAA' })]).text).toBe('');
  });

  it('memoises on the files, and forgets them on reset', () => {
    const files = [file('a.md', 'hello world')];
    expect(buildCoverSource(files)).toContain('hello world');
    resetCoverSource();
    expect(buildCoverSource([])).toBe('');
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  DENSITY, NOT PRESENCE — WHAT A JOB POSTING ACTUALLY LOOKS LIKE
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe('telling a posting from a document that quotes one', () => {
  it('a real posting is saturated with posting markers', () => {
    // Measured on the real ones in the app's own database: 6.4 to 20.2
    // distinct markers per 10,000 characters.
    expect(looksLikeJobPosting(
      'Role overview: we are seeking a CQV lead. Responsibilities: run the '
      + 'programme. Minimum qualifications: five years. What you\'ll do: travel.'
    )).toBe(true);
  });

  it('a 40,000-char prep document that quotes one is NOT a posting', () => {
    // The measurement that forced this: 2 markers in a 1,972-char quoted
    // section, 0 in the other 38,023 chars — and the file was condemned
    // whole, delivering ZERO characters to the cover model.
    const big = RESUME_MD + '\n' + 'Balance qualification detail. '.repeat(1200);
    expect(big.length).toBeGreaterThan(30_000);
    expect(looksLikeJobPosting(big)).toBe(false);
    expect(isJobDescription(file('prep.md', big))).toBe(false);
    expect(buildCoverSourceDetailed([file('prep.md', big)]).text.length).toBeGreaterThan(20_000);
  });

  it('an explicit type label still outranks every heuristic', () => {
    expect(isJobDescription({ id: 'x', name: 'x', type: 'jd', content: 'hello' })).toBe(true);
    expect(isJobDescription({ id: 'x', name: 'x', type: 'resume', content: 'Responsibilities: qualifications: requirements:' })).toBe(false);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  WHAT ONE QUESTION IS ANSWERED FROM
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe('selecting evidence for the question', () => {
  // Big enough to trip selection, and made of clearly separable topics so
  // the assertions are about ranking rather than about luck.
  // Each block is comfortably larger than the evidence budget, so what
  // comes back is genuinely a CHOICE rather than "it all fitted anyway".
  const BIG = [
    'VENU PENTALA — CQV Lead. Evonik AL, Jul 2023 to now.',
    '',
    '# KNEAT',
    'Kneat Gx governance: authoring, review, approval, exception ageing. '.repeat(160),
    '',
    '# BALANCES',
    'Balance qualification, minimum weight versus smallest net weight. '.repeat(160),
    '',
    '# CLIENT RESEARCH',
    'ProPharma, Kymanox and Syner-G are the consultancies in this space. '.repeat(160),
    'The band runs $53.63/hr up to $111,940-151,449 annually. '.repeat(100),
  ].join('\n');

  it('sends the whole thing when it is small enough to read', () => {
    const small = file('resume.docx', 'VENU PENTALA\nCQV Lead at Evonik.\nKneat Gx, HPLC, dissolution.');
    expect(selectCoverEvidence([small], 'have you used Kneat?'))
      .toContain('Kneat Gx, HPLC, dissolution.');
  });

  it('is bounded once the knowledge base is bigger than attention', () => {
    const files = [file('prep.md', BIG)];
    expect(buildCoverSource(files).length).toBeGreaterThan(COVER_SELECT_FROM);
    const picked = selectCoverEvidence(files, 'have you used Kneat Gx?');
    expect(picked.length).toBeLessThanOrEqual(COVER_EVIDENCE_CHARS + 200);
  });

  it('picks the passage the question is about', () => {
    const picked = selectCoverEvidence([file('prep.md', BIG)], 'have you used Kneat Gx for exception ageing?');
    expect(picked).toMatch(/Kneat Gx governance/);
  });

  it('…and leaves the interviewer’s company research behind, without a heading list', () => {
    // This is where the deleted blocklist's job went. Nothing here knows
    // that "CLIENT RESEARCH" is a section about somebody else — it simply
    // does not score against a question about balances, so the consultancy
    // names and the salary band never enter what the model is shown, and
    // therefore never enter what the guard treats as true.
    const picked = selectCoverEvidence([file('prep.md', BIG)], 'what does a balance qualification establish?');
    expect(picked).toMatch(/minimum weight/i);
    expect(picked).not.toMatch(/ProPharma|Kymanox|Syner-G/);
    expect(picked).not.toMatch(/111,940/);
  });

  it('always carries the identity block, whatever the question is about', () => {
    // Retrieval answers "which passages match", never "who is this". A
    // topical question scores nothing in a résumé header, and a cover
    // handed three paragraphs about balances and no employer is how the
    // app ends up unable to say where the candidate works.
    const picked = selectCoverEvidence([file('prep.md', BIG)], 'what does a balance qualification establish?');
    expect(picked).toMatch(/VENU PENTALA/);
  });

  it('a question with no usable terms still returns evidence', () => {
    expect(selectCoverEvidence([file('prep.md', BIG)], 'and then?').length).toBeGreaterThan(200);
    expect(selectCoverEvidence([file('prep.md', BIG)], '').length).toBeGreaterThan(200);
  });

  it('an excluded posting cannot come back through retrieval', () => {
    const jd = file('posting.txt',
      'Role overview: we are seeking a CQV lead. Responsibilities: run it. '
      + 'Minimum qualifications: five years. What you\'ll do: own the programme. '.repeat(3));
    const picked = selectCoverEvidence([file('prep.md', BIG), jd], 'what does the role involve?');
    expect(picked).not.toMatch(/we are seeking/i);
  });

  it('is empty when nothing was uploaded', () => {
    expect(selectCoverEvidence([], 'anything?')).toBe('');
  });
});

// ── The two real documents that drove every decision above ──
const REAL = path.join(
  process.env.USERPROFILE || process.env.HOME || '',
  'OneDrive', 'pharma', 'Lilly_CQV_Interview_FactFile.md',
);
const REAL2 = path.join(
  process.env.USERPROFILE || process.env.HOME || '',
  'OneDrive', 'pharma', 'FillFinish_TechTransfer_Lead_Process_Engineer.md',
);
const have = (p) => { try { return fs.existsSync(p); } catch { return false; } };

describe.skipIf(!have(REAL2))('the prep document that OPENS by quoting the posting', () => {
  it('is not thrown away whole on the strength of its first 3,000 characters', () => {
    // Measured: isJobDescription returned TRUE on 2 marker hits inside a
    // 1,972-char quoted section, and the cover source came out at ZERO
    // chars for a 39,996-char document about the candidate. The first fact
    // file survived only by luck — it scored 1, not 2.
    const content = fs.readFileSync(REAL2, 'utf8');
    const f = file(path.basename(REAL2), content);
    expect(isJobDescription(f)).toBe(false);
    const { text, truncatedChars } = buildCoverSourceDetailed([f]);
    expect(text.length).toBeGreaterThan(35_000);
    expect(truncatedChars).toBe(0);
    // The section that says what NOT to claim is the LAST one in the file,
    // so a tail truncation takes it first. That is exactly how the old
    // 9,000-char cut lost "Used GMARS? No."
    expect(text).toMatch(/Do not claim:/);
  });

  it('and a question about the work does not retrieve the client research', () => {
    const content = fs.readFileSync(REAL2, 'utf8');
    const picked = selectCoverEvidence([file(path.basename(REAL2), content)],
      'what fill-weight checks did you run during PPQ?');
    expect(picked).not.toMatch(/ProPharma|Kymanox|Syner-G/);
    expect(picked).not.toMatch(/111,940|53\.63/);
  });
});

describe.skipIf(!have(REAL))('the real upload that produced the fabrications', () => {
  it('delivers the document, not 863 characters of reconstruction', () => {
    const content = fs.readFileSync(REAL, 'utf8');
    const { text } = buildCoverSourceDetailed([file(path.basename(REAL), content)]);
    expect(text.length).toBeGreaterThan(20_000);
    // The four things the digest got wrong, all correct here by construction.
    expect(text).toMatch(/Kneat/);
    expect(text).not.toMatch(/NUMBERS THAT ARE TRUE/);
  });

  it('answers the two questions the digest could not', () => {
    const content = fs.readFileSync(REAL, 'utf8');
    const files = [file(path.basename(REAL), content)];
    expect(selectCoverEvidence(files, 'have you used Kneat?')).toMatch(/Kneat/);
    expect(selectCoverEvidence(files, 'have you used GMARS?')).toMatch(/GMARS/);
  });
});
