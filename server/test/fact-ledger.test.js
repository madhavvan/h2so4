// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  THE FACT LEDGER, AGAINST THE SENTENCES THAT ACTUALLY SHIPPED
//
//  Every fabricated string below was said to the user by the running app
//  on 2026-07-29, with a resume attached, and is in their local database.
//  The ledger's job is to have caught all of them before they were spoken.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { describe, it, expect } from 'vitest';

globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.window = Object.assign(globalThis, { addEventListener() {}, removeEventListener() {} });
globalThis.__APP_VERSION__ = '0.0.0';

const {
  buildLedger, unverifiedProperNouns, isGrounded, selectFacts,
  findOrganisation, _ledgerSummary, EMPTY_LEDGER,
} = await import('../../services/factLedger.ts');

// A resume in the shape pdfjs produces: page text joined with spaces, so
// the whole document is one line. This is the hard case and the real one.
const RESUME = [
  'VENU MADHAV  Data Engineer | AWS Warehousing, Spark Pipelines & Curated Data Products',
  'pentala@example.com |   3179559198 | Richardson, Texas   |   GitHub   |   LinkedIn',
  'PROFESSIONAL SUMMARY  Data engineer with 4+ years owning production pipelines end to end on AWS.',
  'TECHNICAL SKILLS',
  '●   AWS Data Platform:   S3, Glue, Redshift, EMR, Lambda, Step Functions, Athena',
  '●   Streaming & Event Processing:   Apache Kafka, Kinesis, Debezium, Structured Streaming',
  'PROFESSIONAL EXPERIENCE  Data Engineer   |   Siemens, Dallas, TX   |   April 2026 – Present',
  '●   Rebuilt the lakehouse ETL path and cut cross-source query latency ~40%.',
  'Data Engineer – Research Assistant   |   Indiana University, Indianapolis, IN, USA   |   January 2024 – December 2025',
  '●   Owned the ingestion path for 200K survey records.',
  'Data Engineer (Intern)   |   G Technologies, Indianapolis, IN   |   May 2025 – December 2025',
  '●   Shipped a dbt test suite covering 75K rows a night.',
  'Data Engineer   |   Apollo Hospitals, Hyderabad, Telangana, India   |   Sep 2022 – December 2023',
  '●   Owned Kafka and Python pipelines at 3M records a day and cut end-to-end latency 94%.',
  'Data Engineer   |   KIMS Hospitals, Hyderabad, Telangana, India   |   June 2016 – August 2017',
  '●   Built the reporting extract that replaced over 50K manual lookups.',
  'EDUCATION  Master of Science in Health Informatics   |   Indiana University, Indianapolis, IN, USA   |   2025',
  'CERTIFICATIONS  AWS Certified Solutions Architect – Associate   |   Amazon Web Services   |   June 2023',
  'Databricks Certified Data Engineer Associate   |   Databricks   |   March 2024',
  'PROJECTS',
  'PipelineGuard — Agentic data-pipeline triage | Python, Elasticsearch, ES|QL',
  '●   Cut incident triage from 45 minutes to 2 hours of saved engineer time per week.',
].join('  ');

const files = [{ id: 'r1', name: 'VMADp_DataEngineer.pdf', type: 'custom', content: RESUME }];
const ledger = buildLedger(files);

describe('what the ledger reads out of a PDF-shaped resume', () => {
  it('summary', () => {
    console.log('   ' + JSON.stringify(_ledgerSummary(ledger)));
    console.log('   employers: ' + ledger.employers.map((e) => `${e.subject} (${e.when})`).join(' | '));
    console.log('   projects:  ' + ledger.projects.map((p) => p.subject).join(' | '));
    console.log('   skills:    ' + ledger.skills.map((s) => s.subject).join(' | '));
    console.log('   metrics:   ' + ledger.metrics.map((m) => m.subject).join(', '));
  });

  it('finds every employer, with dates, and never a degree or a cert among them', () => {
    const orgs = ledger.employers.map((e) => e.subject);
    for (const want of ['Siemens', 'Indiana University', 'G Technologies', 'Apollo Hospitals', 'KIMS Hospitals']) {
      expect(orgs, `missing employer ${want}`).toContain(want);
    }
    expect(ledger.employers.every((e) => e.when.length > 0)).toBe(true);
    expect(orgs.some((o) => /Amazon Web Services|Databricks/.test(o))).toBe(false);
  });

  it('separates education and certifications', () => {
    expect(ledger.education.map((e) => e.subject)).toContain('Indiana University');
    expect(ledger.certifications.length).toBeGreaterThanOrEqual(2);
  });

  it('every fact points at real bytes in the file it claims to come from', () => {
    for (const f of ledger.facts) {
      expect(f.span.fileId).toBe('r1');
      expect(f.span.to).toBeGreaterThan(f.span.from);
      const slice = RESUME.slice(f.span.from, f.span.to);
      expect(slice.length).toBeGreaterThan(0);
      // The subject must be findable at or around its own span.
      const near = RESUME.slice(Math.max(0, f.span.from - 200), Math.min(RESUME.length, f.span.to + 200));
      expect(near.toLowerCase()).toContain(f.subject.toLowerCase().slice(0, 12));
    }
  });
});

describe('THE GUARD — the sentences the app actually spoke', () => {
  const SHIPPED_FABRICATIONS = [
    "I've worked mostly on Linux and Windows, and my favorite project was at IBM, building a cloud-based system for data analytics.",
    "I've spent several years at IBM, working on various projects and systems, including their cloud infrastructure and data analytics platforms.",
    'That was based on my experience with their systems at Accenture, where I worked on several projects.',
    "I've spent most of my time on AWS and Kubernetes, building infrastructure that scales, and my favorite project was designing a distributed system that cut latency in half.",
  ];

  it('flags each one, and names the invented entity', () => {
    for (const bad of SHIPPED_FABRICATIONS) {
      const offenders = unverifiedProperNouns(ledger, bad);
      console.log(`   FLAGGED [${offenders.join(', ')}]  <- ${bad.slice(0, 62)}...`);
      expect(offenders.length, `should have been rejected: ${bad}`).toBeGreaterThan(0);
    }
    expect(unverifiedProperNouns(ledger, SHIPPED_FABRICATIONS[0])).toContain('IBM');
    expect(unverifiedProperNouns(ledger, SHIPPED_FABRICATIONS[2])).toContain('Accenture');
  });

  it('passes the grounded openers — no false positives', () => {
    const GOOD = [
      "I've spent most of my time on AWS — S3, Glue and Redshift — because that's what the Siemens lakehouse runs on.",
      'PipelineGuard is the one I keep coming back to; it cut incident triage by about 45 minutes a case.',
      'At Apollo Hospitals I owned the Kafka and Python path for around 3M records a day.',
      'No, I haven\'t. My roles have been Siemens, Indiana University, G Technologies, Apollo Hospitals and KIMS Hospitals.',
      'Yeah, so the Debezium side of that was mine — Kinesis for the rest.',
      'Honestly, the Databricks certification is the one that actually changed how I work.',
      'Right — most of that was Structured Streaming, on EMR rather than Lambda.',
    ];
    for (const good of GOOD) {
      const offenders = unverifiedProperNouns(ledger, good);
      if (offenders.length) console.log(`   FALSE POSITIVE [${offenders.join(', ')}] in: ${good}`);
      expect(offenders, `false positive on: ${good}`).toEqual([]);
    }
  });

  it('a name the INTERVIEWER used is not a fabrication when echoed', () => {
    const q = 'have you worked at Goldman Sachs?';
    expect(unverifiedProperNouns(ledger, "No, I haven't worked at Goldman Sachs.")).not.toEqual([]);
    expect(unverifiedProperNouns(ledger, "No, I haven't worked at Goldman Sachs.", q)).toEqual([]);
  });

  it('an acronym is checked even at the start of a sentence', () => {
    expect(unverifiedProperNouns(ledger, 'IBM was where I did that.')).toContain('IBM');
    expect(unverifiedProperNouns(ledger, 'Honestly that was mostly Glue.')).toEqual([]);
  });

  it('a TOOL the resume never mentions is caught too, not just employers', () => {
    // Flink, Kubernetes and Terraform are absent from this resume. An opener
    // that claims them is the same defect as claiming IBM, one layer down —
    // and it is the layer the interviewer follows up on.
    expect(unverifiedProperNouns(ledger, 'Most of that ran on Flink.')).toEqual(['Flink']);
    expect(unverifiedProperNouns(ledger, 'We drove it all through Terraform and Kubernetes.'))
      .toEqual(['Terraform', 'Kubernetes']);
    // and the offender is reported without trailing punctuation
    expect(unverifiedProperNouns(ledger, 'That was Flink.')[0]).toBe('Flink');
  });

  it('an empty ledger flags nothing — a KB-less session must not be blocked', () => {
    expect(unverifiedProperNouns(EMPTY_LEDGER, 'I worked at IBM on Kubernetes.')).toEqual([]);
    expect(isGrounded(EMPTY_LEDGER, 'anything at all')).toBe(true);
  });
});

describe('lookup and selection', () => {
  it('findOrganisation answers the entity question exactly', () => {
    const apollo = findOrganisation(ledger, 'Apollo');
    expect(apollo?.subject).toBe('Apollo Hospitals');
    expect(apollo?.when).toContain('2022');
    expect(findOrganisation(ledger, 'IBM')).toBeNull();
    expect(findOrganisation(ledger, 'Accenture')).toBeNull();
    console.log(`   "Apollo" -> ${apollo.subject} / ${apollo.detail} / ${apollo.when}`);
    console.log('   "IBM" -> null (so the opener says no, deterministically)');
  });

  it('selectFacts ranks the relevant facts for a question', () => {
    const picked = selectFacts(ledger, 'tell me about your kafka streaming work', 4);
    console.log('   kafka question -> ' + picked.map((f) => `${f.kind}:${f.subject}`).join(', '));
    expect(picked.length).toBeGreaterThan(0);
    expect(picked.some((f) => /kafka|streaming/i.test(`${f.subject} ${f.detail}`))).toBe(true);
    // The point of carrying the bullets: the EMPLOYER where the Kafka work
    // happened must be reachable from the word "kafka". Without the body
    // text this returned a skills line and a bare "3M" and the opener had
    // no employer to anchor on.
    expect(picked.some((f) => f.kind === 'employer' && f.subject === 'Apollo Hospitals')).toBe(true);
  });

  it('an employer fact carries its own work, and its span still covers it', () => {
    const apollo = ledger.employers.find((e) => e.subject === 'Apollo Hospitals');
    expect(apollo.detail).toMatch(/Kafka/);
    expect(apollo.tokens).toContain('kafka');
    const proof = RESUME.slice(apollo.span.from, apollo.span.to);
    expect(proof).toContain('Apollo Hospitals');
    expect(proof).toContain('Kafka');
    console.log(`   Apollo fact detail: ${apollo.detail.slice(0, 96)}...`);
    console.log(`   span ${apollo.span.from}-${apollo.span.to} (${apollo.span.to - apollo.span.from} chars of proof)`);
  });

  it('is fast enough to run on every question', () => {
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 200; i++) selectFacts(ledger, 'kafka snowflake latency apollo', 6);
    const perCall = Number(process.hrtime.bigint() - t0) / 1000 / 200;
    const g0 = process.hrtime.bigint();
    for (let i = 0; i < 200; i++) unverifiedProperNouns(ledger, "I've spent several years at IBM building analytics platforms.");
    const perGuard = Number(process.hrtime.bigint() - g0) / 1000 / 200;
    console.log(`   selectFacts ${perCall.toFixed(1)}us/call   guard ${perGuard.toFixed(1)}us/call`);
    expect(perCall).toBeLessThan(2000);
    expect(perGuard).toBeLessThan(2000);
  });

  it('builds a 4-file knowledge base in a time the upload path can absorb', () => {
    const many = Array.from({ length: 4 }, (_, i) => ({
      id: 'f' + i, name: `resume-${i}.pdf`, type: 'custom', content: RESUME,
    }));
    const t0 = process.hrtime.bigint();
    const l = buildLedger(many);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    console.log(`   4 files (${l.charCount} chars) -> ${l.facts.length} facts in ${ms.toFixed(1)}ms`);
    expect(l.employers.length).toBeGreaterThanOrEqual(5);
    expect(ms).toBeLessThan(250);
  });

  it('survives junk input without inventing anything', () => {
    for (const junk of [null, undefined, [], [{ id: 'x', name: 'x', type: 'custom', content: '' }],
      [{ id: 'y', name: 'y', type: 'custom', content: 'Failed to extract text from PDF.' }],
      [{ id: 'z', name: 'z', type: 'custom', content: '???', base64: 'AAAA' }]]) {
      const l = buildLedger(junk);
      expect(Array.isArray(l.facts)).toBe(true);
      expect(l.employers.length).toBe(0);
    }
  });
});
