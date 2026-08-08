// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ONE RESUME LAYOUT WAS THE CONTRACT, AND EVERY USER BRINGS THEIR OWN
//
//  The fact ledger read a three-column pipe table: "Role | Company | Dates".
//  That is the layout of ONE resume template. Measured over the 50 distinct
//  documents in the app's own database it read 18 of them — every one
//  generated from that template — and found nothing at all in the other 32,
//  which include four perfectly ordinary resumes.
//
//  A document that yields no facts yields no spoken opener, silently, so the
//  live-model cover took over on every question: the exact path that says
//  "my favorite project was at IBM" about a candidate who has never worked
//  at IBM. The user's report — "why are the cover answers not coming from
//  the uploaded file?" — was this, and the answer was that for two thirds of
//  real documents, they could not.
//
//  Every fixture below is the SHAPE of a real document from that database
//  (company names substituted), and each one produced zero employers before
//  the date-anchored reader was added.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { describe, it, expect } from 'vitest';

globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.window = Object.assign(globalThis, { addEventListener() {}, removeEventListener() {} });
globalThis.__APP_VERSION__ = '0.0.0';

const { buildLedger, isJobDescription, GENERIC_SKILL_LABEL } =
  await import('../../services/factLedger.ts');
const { composeOpener, ledgerDigest, ledgerVocabulary } =
  await import('../../services/instantOpener.ts');

const file = (name, content) => [{ id: 'f1', name, type: 'custom', content }];

// ── Layout A: company + right-aligned dates, ROLE ON THE NEXT LINE ──
const TAB_ALIGNED = [
  'PROFESSIONAL WORK EXPERIENCE',
  '',
  'Bracknell Devices, NC                                    \t\t Nov 2022 – Present',
  '',
  'Metrology Specialist',
  '',
  'Ensured on-site calibrations were performed in accordance with cGMP requirements.',
  '',
  'Rowanhill Labs, NJ                                        July 2020 – Nov 2022',
  '',
  'Metrology Engineer',
  '',
  'Executed scheduled calibrations across 400 instruments.',
].join('\n');

// ── Layout B: company, dates AND role all on one line ──
const ONE_LINE = [
  'PROFESSIONAL SUMMARY',
  '',
  'Sterile Manufacturing Operator with 10+ years of experience.',
  '',
  'Kestrelby Pharma, PA\t\t\t\t\t Apr 2023  - Present Senior Sterile Manufacturing Operator',
  '',
  'Managed daily operation of automated sterile filling lines.',
  '',
  'Aldermoor Sciences,  NJ\t\t\t\tAug 2021 – Apr 2023 Aseptic Fill-Finish Operator',
  '',
  'Prepared sterile injectable formulations.',
].join('\n');

// ── Layout C: no gap at all between the date and the role ──
const GLUED = [
  'EXPERIENCE',
  '',
  'Thornwick Therapeutics, CA Jan 2023 – PresentSenior MSAT Engineer',
  '',
  'Led end-to-end transfer of conditioning therapeutics.',
  '',
  'SKILLS',
  '',
  'MSAT & Technology Transfer: Technology Transfer, Process Scale-Up, PPQ, CPV',
  'Data Analysis: Minitab, JMP, Statistical Trending',
].join('\n');

// ── Layout D: a SKILLS section that is a list, not a table ──
const BARE_SKILLS = [
  'Summary:',
  '',
  'Senior Quality Engineer with 6+ years of experience.',
  '',
  'SKILLS',
  '',
  'CAPA Management (End-to-End Lifecycle)',
  'Root Cause Analysis (5 Whys, Fishbone, FMEA)',
  'Change Control & Complaint Management',
  'Quality Audits & Inspection Support',
  '',
  'Professional Experience',
  '',
  'Harrowgate Medical, IN  \t\t\t\tJuly 2024 - Present',
  '',
  'Senior Quality Engineer',
  '',
  'Led remediation efforts for recurring quality issues.',
].join('\n');

describe('resume layouts that are not a pipe table', () => {
  it('A — company line, dates right-aligned, role underneath', () => {
    const l = buildLedger(file('metrology.docx', TAB_ALIGNED));
    const orgs = l.employers.map((e) => e.subject);
    expect(orgs).toContain('Bracknell Devices');
    expect(orgs).toContain('Rowanhill Labs');
    const first = l.employers.find((e) => e.subject === 'Bracknell Devices');
    expect(first.detail).toMatch(/Metrology Specialist/);
    expect(first.when).toMatch(/Nov 2022/);
    // The bullets under the role belong to it — that is what makes the fact
    // answerable by a question about the WORK rather than the letterhead.
    expect(first.detail).toMatch(/cGMP/);
    console.log(`   A -> ${orgs.join(', ')}`);
  });

  it('B — company, dates and role all on the same line', () => {
    const l = buildLedger(file('operator.docx', ONE_LINE));
    const orgs = l.employers.map((e) => e.subject);
    expect(orgs).toContain('Kestrelby Pharma');
    expect(orgs).toContain('Aldermoor Sciences');
    expect(l.employers.find((e) => e.subject === 'Kestrelby Pharma').detail)
      .toMatch(/Senior Sterile Manufacturing Operator/);
    console.log(`   B -> ${orgs.join(', ')}`);
  });

  it('C — role glued to the date with no separator, plus labelled skills', () => {
    const l = buildLedger(file('msat.docx', GLUED));
    expect(l.employers.map((e) => e.subject)).toContain('Thornwick Therapeutics');
    expect(l.skills.map((s) => s.subject)).toContain('Data Analysis');
    console.log(`   C -> ${l.employers.map((e) => e.subject).join(', ')} | skills ${l.skills.length}`);
  });

  it('D — a bare-list SKILLS section becomes one unlabelled fact', () => {
    const l = buildLedger(file('quality.docx', BARE_SKILLS));
    expect(l.employers.map((e) => e.subject)).toContain('Harrowgate Medical');
    const generic = l.skills.find((s) => s.subject === GENERIC_SKILL_LABEL);
    expect(generic, 'a list-style skills section should still be read').toBeTruthy();
    expect(generic.detail).toMatch(/CAPA Management/);
    console.log(`   D -> ${l.employers.map((e) => e.subject)} | ${generic.detail.slice(0, 60)}…`);
  });

  it('every employer carries dates, and no section heading became a company', () => {
    for (const src of [TAB_ALIGNED, ONE_LINE, GLUED, BARE_SKILLS]) {
      const l = buildLedger(file('r.docx', src));
      for (const e of l.employers) {
        expect(e.when.length, `${e.subject} has no dates`).toBeGreaterThan(0);
        expect(e.subject).not.toMatch(/^(?:PROFESSIONAL|EXPERIENCE|SKILLS|SUMMARY|EDUCATION)/i);
        // and the fact points at bytes that actually contain it
        expect(src.slice(e.span.from, e.span.to)).toContain(e.subject.split(' ')[0]);
      }
    }
  });
});

describe('things that look like a resume and are not', () => {
  // A markdown table is also "text | text | something ending in a year", and
  // EMPLOYER_LINE matched it. The app would have said, out loud:
  //   "Yeah, 1500 — I was healthy4_cd45- there, 1927."
  const MARKDOWN_TABLE = [
    '# Cell counts',
    '',
    '| sample | cells | mean | max | ratio | kept | pct |',
    '|---|---:|---:|---:|---:|---:|---:|',
    '| healthy4_cd45- | 1500 | 1927.5 | 6269.5 | 3.71 | 1470 | 98.0 |',
    '| healthy5_cd45+ | 1500 | 905.5 | 2262.5 | 2.34 | 1490 | 99.3 |',
  ].join('\n');

  it('a numeric markdown table yields no employers', () => {
    const l = buildLedger(file('notes.md', MARKDOWN_TABLE));
    expect(l.employers).toEqual([]);
    expect(l.education).toEqual([]);
  });

  it('a date inside a sentence is not a job header', () => {
    const PROSE = [
      'Interview prep notes',
      '',
      'Composite from 2025–2026 candidate reports across several sites.',
      'Nimbus Systems 2016–2017 then a gap to 2022. Have the narrative ready.',
    ].join('\n');
    const l = buildLedger(file('prep.md', PROSE));
    expect(l.employers.map((e) => e.subject)).not.toContain('Composite from');
    expect(l.employers.length, 'prose should not become employment').toBe(0);
  });

  it('a job description contributes no facts, no vocabulary and no numbers', () => {
    const JD = [
      'Data Engineer with AI/ML',
      'Requisition Number: 2349888',
      'Work Model: Remote-eligible',
      'Salary Range: $72,800 – $130,000 annually',
      'Role Overview',
      'Northwind Health is seeking a highly skilled Data Engineering Analyst.',
      'Responsibilities: build pipelines, own quality, mentor engineers.',
    ].join('\n');
    expect(isJobDescription({ name: 'posting.txt', content: JD })).toBe(true);

    const both = buildLedger([
      { id: 'r', name: 'resume.docx', type: 'custom', content: TAB_ALIGNED },
      { id: 'j', name: 'posting.txt', type: 'custom', content: JD },
    ]);
    const resumeOnly = buildLedger(file('resume.docx', TAB_ALIGNED));

    expect(both.jdCount).toBe(1);
    expect(both.facts.length).toBe(resumeOnly.facts.length);
    // Vocabulary is the guard's definition of a supportable name. Admitting
    // the hiring company would let "I spent years at Northwind" pass — said
    // to Northwind.
    expect(both.vocabulary.has('northwind')).toBe(false);
    expect(ledgerDigest(both)).not.toMatch(/72,800|130,000/);
  });

  it('numbers are only taken from inside the candidate\'s own entries', () => {
    // A prep document full of statistics is not a list of the candidate's
    // achievements, and the digest prints these under "NUMBERS THAT ARE TRUE".
    const NOTES = 'Study notes. Snowflake handles 500M rows a day and cuts costs 40% typically.';
    const l = buildLedger(file('study.md', NOTES));
    expect(l.metrics).toEqual([]);
    // …while a metric inside a real role's bullets is kept.
    const withRole = buildLedger(file('r.docx', TAB_ALIGNED.replace(
      'Executed scheduled calibrations across 400 instruments.',
      'Executed scheduled calibrations across 400 instruments, cutting downtime 35%.')));
    expect(withRole.metrics.map((m) => m.subject).join(' ')).toMatch(/35%/);
  });
});

describe('a large knowledge base does not lose its own sections or names', () => {
  const bigLedger = (targetChars) => {
    const files = [];
    let chars = 0, i = 0;
    const sources = [TAB_ALIGNED, ONE_LINE, GLUED, BARE_SKILLS];
    while (chars < targetChars) {
      const body = sources[i % sources.length]
        // Distinct company names per copy, so this is a genuinely wide KB
        // rather than the same four facts repeated.
        .replace(/Bracknell|Rowanhill|Kestrelby|Aldermoor|Thornwick|Harrowgate/g, (m) => `${m}${i}`);
      files.push({ id: `f${i}`, name: `resume-${i}.docx`, type: 'custom', content: body });
      chars += body.length; i++;
    }
    return buildLedger(files);
  };

  it('the digest still carries every section at 200K, not just ROLES', () => {
    // Before per-section budgets this was a single tail truncation over a
    // fixed section order, so the LAST sections silently vanished: at 85K
    // SKILLS was gone and at 200K only ROLES survived. The more the
    // candidate uploaded, the less the cover knew about them.
    const l = bigLedger(200_000);
    const d = ledgerDigest(l);
    expect(d.length).toBeLessThanOrEqual(3_500);
    for (const head of ['ROLES', 'SKILLS:']) {
      expect(d, `"${head}" missing from a 200K digest`).toContain(head);
    }
    // and it says what it left out rather than implying there was nothing
    expect(d).toMatch(/\[…\d+ more\]|\[\d+ not shown\]/);
    console.log(`   200K digest ${d.length} chars, sections: `
      + ['ROLES', 'PROJECTS:', 'SKILLS:', 'EDUCATION:', 'CERTIFICATIONS:', 'NUMBERS']
        .filter((h) => d.includes(h)).join(' '));
  });

  it('the vocabulary keeps the names that will actually be spoken', () => {
    // The old truncation sorted longest-first and dropped 1,026 real names
    // from a 400K knowledge base — the candidate's own name and every short
    // acronym — while keeping run-together PDF junk. Anything missing here
    // is treated as INVENTED by the server guard, so a large KB silently
    // rejected its own true sentences.
    const l = bigLedger(400_000);
    const v = ledgerVocabulary(l);
    expect(v.length).toBeLessThanOrEqual(8_000);
    const kept = new Set(v.split(/\s+/));

    // THE INVARIANT THAT MATTERS: whatever the digest SHOWS the model, the
    // guard must accept the model saying. Those two strings travel together
    // in the same request, so a name in one and not the other is a cover
    // that gets composed and then thrown away for quoting its own briefing.
    //
    // (Not "every employer survives": with more distinct employers than fit
    // in any budget, something must be dropped. The right thing to drop is
    // whatever the model was never told about.)
    // Months and "Present" appear in the digest's date fields and are in the
    // guard's DISCOURSE set, so they are never checked against vocabulary at
    // all — excluding them here keeps the assertion about NAMES.
    const DATEWORD = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*$|^(present|current)$/;
    const shown = ledgerDigest(l).match(/[A-Z][A-Za-z0-9]+/g) || [];
    const lost = [...new Set(shown.map((w) => w.toLowerCase()))]
      .filter((w) => !DATEWORD.test(w) && l.vocabulary.has(w) && !kept.has(w));
    expect(lost, `names shown to the model but rejected by the guard: ${lost.slice(0, 8).join(', ')}`).toEqual([]);
    console.log(`   400K: ${l.vocabulary.size} tokens -> ${v.length} chars; `
      + `${shown.length} names in the digest, ${lost.length} unsupported`);
  });

  it('buildLedger stays linear in input size — 4x the knowledge base costs ~4x, not ~16x', () => {
    // ── A STOPWATCH MEASURES THE MACHINE, NOT THE PARSER ──
    //
    // This was `expect(ms).toBeLessThan(1_500)` on a single 400K build.
    // Measured on one machine, one commit, one afternoon: quiet it passed;
    // with three background agents running it took 1,587ms and failed; run
    // again in isolation, 2,578ms and failed. A 1.7x swing from ambient load
    // alone — and that failure was investigated as a regression from an
    // unrelated change before anyone thought to look at what else was on the
    // CPU. On a shared CI runner it goes red on changes that never touched
    // the ledger, and the standing instinct will be to blame the change.
    //
    // What this test actually protects is that buildLedger stays roughly
    // LINEAR in input size. The catastrophe worth catching is someone making
    // the parser accidentally quadratic — a nested scan, a backtracking
    // regex, an indexOf that re-walks the whole haystack once per line. That
    // is invisible on the four small fixtures above and lethal on a real
    // 400K knowledge base, which is the size the upload path actually sees.
    //
    // So: time two sizes and assert the RATIO. A ratio is dimensionless, and
    // dividing one measurement by another divides the machine's speed out.
    // Measured with 16 CPU burners pinning this 16-core box, the absolute
    // times went from 55ms/265ms to 334ms/1,403ms — five times slower — while
    // the ratio moved from 4.1 to 4.2. That is the whole argument.
    const SMALL = 100_000, LARGE = 400_000;   // a 4x input ratio
    const MAX_RATIO = 8;                      // linear predicts ~4, quadratic ~16
    const CEILING_MS = 15_000;

    // WHY 100K AND NOT SOMETHING SMALLER: the denominator has to be worth
    // dividing by. At 100K the build measured 44–105ms across every condition
    // tried here, quiet and loaded — comfortably clear of the 1ms floor
    // applied below. That floor is not the real guard, it is belt-and-braces
    // so that a future machine fast enough to make this sub-millisecond
    // yields a finite number instead of Infinity. Choosing sizes that are
    // genuinely measurable is the real guard. Deliberately NOT a skip: a
    // test that quietly stops asserting is the failure mode this whole file
    // exists to catch.
    const timeBuild = (chars) => {
      const t0 = process.hrtime.bigint();
      bigLedger(chars);
      return Number(process.hrtime.bigint() - t0) / 1e6;
    };

    // WARM-UP, THEN A SYMMETRIC SCHEDULE — two separate biases to kill.
    //
    //   JIT: the first build pays to compile the parser, which inflates
    //   whichever size happens to run first.
    //
    //   HEAP FRESHNESS: subtler, and the one that actually bit. Across five
    //   consecutive trials the 100K best-of-3 went 55, 57, 63, 74, 76ms —
    //   monotonic, not noise. The process heap grows and every later
    //   measurement pays more for it, so the size measured FIRST is measured
    //   on the freshest heap and looks fastest. If that is the SMALL one the
    //   denominator is flattered and the ratio inflates, which is a false
    //   failure of exactly the kind this rewrite exists to remove.
    //
    // Hence: warm up at BOTH sizes so JIT and heap growth are already paid
    // for, then alternate which size leads so the fresh slots are shared out
    // evenly. Measured over 11 trials, blocked sampling (sss then lll) peaked
    // at a ratio of 6.51 while the alternating schedule peaked at 5.29 — and
    // under load the difference was starker still, 6.51 against 4.67.
    //
    // (In a full-file run the two tests above have already built 200K and
    // 400K ledgers, so the warm-up is partly redundant. It is here so the
    // test still holds up when someone runs it alone with .only.)
    bigLedger(LARGE); bigLedger(SMALL); bigLedger(LARGE);

    // Best of 3 at each size: a GC pause or a scheduler hiccup can only ever
    // ADD time, so the minimum is the cleanest estimate of the real cost.
    const best = { [SMALL]: Infinity, [LARGE]: Infinity };
    const sample = (n) => { best[n] = Math.min(best[n], timeBuild(n)); };
    sample(SMALL); sample(LARGE);
    sample(LARGE); sample(SMALL);
    sample(SMALL); sample(LARGE);

    const small = best[SMALL], large = best[LARGE];
    const ratio = large / Math.max(small, 1);
    console.log(`   scaling: 100K ${small.toFixed(0)}ms -> 400K ${large.toFixed(0)}ms `
      + `= ${ratio.toFixed(2)}x for 4x the input (linear ~4, quadratic ~16)`);

    expect(ratio, `buildLedger scaled ${ratio.toFixed(2)}x for 4x the input `
      + `(${small.toFixed(0)}ms -> ${large.toFixed(0)}ms). Linear is ~4x and quadratic `
      + `is ~16x, so this is a SHAPE regression, not a slow machine — look for a nested `
      + `scan or a backtracking regex in the parser, not for a background process.`)
      .toBeLessThan(MAX_RATIO);

    // The ratio alone would be satisfied by everything being uniformly
    // catastrophic, so keep an absolute ceiling for the genuine disaster —
    // an accidental near-infinite loop scales fine and still ruins an upload.
    // 15s is roughly 8x the slowest 400K build ever seen here (1,758ms, under
    // 16 CPU burners), so ambient load cannot reach it; only a real fault can.
    expect(large, `a 400K build took ${large.toFixed(0)}ms, past the ${CEILING_MS}ms `
      + `catastrophe ceiling. That is ~8x the worst ever measured under deliberate CPU `
      + `saturation, so this is not a loaded machine.`)
      .toBeLessThan(CEILING_MS);
    // Vitest's default 5s budget would fire under load before either
    // assertion could report — and the timeout must also exceed the slowest
    // run the ceiling above still tolerates (5 large + 4 small builds, ~90s
    // if a single large build sat right at 15s), or the catastrophe case
    // dies with a bare timeout instead of the message explaining it.
  }, 120_000);
});
