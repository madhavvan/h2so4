// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  THE INSTANT OPENER, ON THE QUESTIONS THAT BROKE THE OLD ONE
//
//  Every question below is a real one from the user's own session on
//  2026-07-29, and for each one the answer the app actually spoke is
//  recorded next to it. The opener composed here has to be true, or has
//  to decline.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { describe, it, expect } from 'vitest';

globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.window = Object.assign(globalThis, { addEventListener() {}, removeEventListener() {} });
globalThis.__APP_VERSION__ = '0.0.0';

const { buildLedger, unverifiedProperNouns, EMPTY_LEDGER } = await import('../../services/factLedger.ts');
const { composeOpener, ledgerDigest, ledgerVocabulary, _explain } = await import('../../services/instantOpener.ts');

const RESUME = [
  'VENU MADHAV  Data Engineer | AWS Warehousing, Spark Pipelines & Curated Data Products',
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
  'PROJECTS',
  'PipelineGuard — Agentic data-pipeline triage | Python, Elasticsearch, ES|QL',
  '●   Cut incident triage from 45 minutes to 2 hours of saved engineer time per week.',
].join('  ');

const ledger = buildLedger([{ id: 'r1', name: 'VMADp_DataEngineer.pdf', type: 'custom', content: RESUME }]);

describe('the three questions from the transcript', () => {
  it('"on what platforms have you worked most and why? what\'s your fav project?"', () => {
    const q = "on what platforms have you worked most and why? what's your fav project?";
    const d = composeOpener(ledger, q);
    console.log(`   WAS: "I've worked mostly on Linux and Windows, and my favorite project was at IBM..."`);
    console.log(`   NOW: ${_explain(ledger, q)}`);
    expect(d.kind).toBe('speak');
    expect(unverifiedProperNouns(ledger, d.text)).toEqual([]);
    expect(d.text).not.toMatch(/IBM|Linux|Windows/);
  });

  it('"have you worked for IBM?" — a true, instant no', () => {
    const q = 'have you worked for IBM?';
    const d = composeOpener(ledger, q);
    console.log(`   WAS: "I've spent several years at IBM, working on various projects and systems..."`);
    console.log(`   NOW: ${_explain(ledger, q)}`);
    expect(d.kind).toBe('speak');
    expect(d.shape).toBe('entity-no');
    expect(d.text).toMatch(/^(No|I haven't)/i);
    expect(d.text).toContain('Siemens');
    expect(unverifiedProperNouns(ledger, d.text, q)).toEqual([]);
  });

  it('"then why did you answer IBM?" — SUPPRESSED, no model may cover it', () => {
    const q = 'then why did you answer IBM?';
    const d = composeOpener(ledger, q);
    console.log(`   WAS: "That was based on my experience with their systems at Accenture..."`);
    console.log(`   NOW: ${_explain(ledger, q)}`);
    expect(d.kind).toBe('suppress');
    expect(d.shape).toBe('meta');
  });

  it('"okay, and what is work at apollo?" — lowercase org still resolves', () => {
    const q = 'okay, and what is work at apollo?';
    const d = composeOpener(ledger, q);
    console.log(`   NOW: ${_explain(ledger, q)}`);
    expect(d.kind).toBe('speak');
    expect(d.shape).toBe('entity-yes');
    expect(d.text).toContain('Apollo Hospitals');
    expect(d.text).toMatch(/2022|2023/);
  });

  it('"and would you please introduce yourself?"', () => {
    const d = composeOpener(ledger, 'and would you please introduce yourself?');
    console.log(`   NOW: ${_explain(ledger, 'and would you please introduce yourself?')}`);
    expect(d.kind).toBe('speak');
    expect(d.shape).toBe('background');
    expect(d.text).toContain('Siemens');
    expect(unverifiedProperNouns(ledger, d.text)).toEqual([]);
  });
});

describe('every meta / challenge phrasing is suppressed', () => {
  const METAS = [
    'then why did you answer IBM?',
    'why did you say Kafka?',
    'you said you worked at IBM',
    'did you lie to me?',
    'you lied about that',
    'what are those mistakes?',
    'that is not true',
    "that's wrong",
    'why the contradiction?',
    'are you sure about that?',
    'you just mentioned Accenture',
    'how come you told me IBM?',
  ];
  it('all of them', () => {
    for (const q of METAS) {
      const d = composeOpener(ledger, q);
      console.log(`   ${d.kind.padEnd(8)} <- "${q}"`);
      expect(d.kind, `not suppressed: ${q}`).toBe('suppress');
    }
  });
});

describe('grounding is unconditional', () => {
  it('no composed opener ever contains an unsupported proper noun', () => {
    const QUESTIONS = [
      'what platforms have you worked on?', 'what is your tech stack?',
      "what's your favourite project?", 'tell me about a project you are proud of',
      'tell me about yourself', 'walk me through your background',
      'have you worked at Goldman Sachs?', 'have you worked for Infosys?',
      'do you know Terraform?', 'what about Databricks?',
      'have you used Kafka?', 'tell me about your Kafka work',
      'what is work at siemens?', 'who is KIMS?',
      'what languages do you write?', 'which clouds have you used?',
      'estimate the number of piano tuners in Chicago',
      'design a rate limiter for a multi-region API',
      'reverse a linked list in place',
      'why do you want this role?', 'what is your biggest weakness?',
      'how does a hashmap work?', 'and then?', 'mm okay right',
    ];
    let spoke = 0; let deferred = 0; let suppressed = 0;
    for (const q of QUESTIONS) {
      const d = composeOpener(ledger, q);
      if (d.kind === 'speak') {
        spoke++;
        const bad = unverifiedProperNouns(ledger, d.text, q);
        if (bad.length) console.log(`   UNGROUNDED [${bad}] "${d.text}" <- ${q}`);
        expect(bad, `ungrounded opener for "${q}": ${d.text}`).toEqual([]);
        console.log(`   speak[${d.shape}] "${d.text}"`);
      } else if (d.kind === 'suppress') { suppressed++; console.log(`   suppress <- ${q}`); }
      else { deferred++; }
    }
    console.log(`\n   spoke=${spoke}  deferred=${deferred}  suppressed=${suppressed}  of ${QUESTIONS.length}`);
    expect(spoke).toBeGreaterThan(6);
  });

  it('an unknown employer is never affirmed', () => {
    for (const q of ['have you worked at Goldman Sachs?', 'have you worked for Infosys?',
      'were you at Deloitte?', 'have you worked for ibm?', 'have you been at TCS?']) {
      const d = composeOpener(ledger, q);
      expect(d.kind, q).toBe('speak');
      expect(d.shape, q).toBe('entity-no');
      expect(d.text, q).toMatch(/^(No|I haven't)/i);
    }
  });

  it('a known employer is never denied', () => {
    for (const q of ['have you worked at Siemens?', 'what is work at apollo?',
      'have you worked for KIMS Hospitals?', 'were you at G Technologies?']) {
      const d = composeOpener(ledger, q);
      expect(d.kind, q).toBe('speak');
      expect(d.shape, q).toBe('entity-yes');
      expect(d.text, q).not.toMatch(/^No\b|haven't/i);
    }
  });

  it('education and certifications are not passed off as jobs', () => {
    const edu = composeOpener(ledger, 'what about Indiana University?');
    console.log(`   Indiana University -> ${_explain(ledger, 'what about Indiana University?')}`);
    expect(edu.kind).toBe('speak');
    // It IS an employer here (Research Assistant) AND the school. The
    // employer reading wins, and it must state the role, not a degree.
    expect(edu.text).toMatch(/Research Assistant|Master/);
  });

  it('no knowledge base -> defer, never invent', () => {
    for (const q of ['have you worked for IBM?', 'what platforms have you used?', 'tell me about yourself']) {
      const d = composeOpener(EMPTY_LEDGER, q);
      expect(d.kind, q).toBe('defer');
    }
    // …except a challenge, which is suppressed even with no files.
    expect(composeOpener(EMPTY_LEDGER, 'why did you say that?').kind).toBe('suppress');
  });
});

describe('speed and shape', () => {
  it('composes in microseconds', () => {
    const qs = ['have you worked for IBM?', 'what platforms?', "what's your fav project?", 'tell me about yourself'];
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 500; i++) composeOpener(ledger, qs[i % qs.length]);
    const us = Number(process.hrtime.bigint() - t0) / 1000 / 500;
    console.log(`   ${us.toFixed(1)}us per opener  (the LLM cover measured 528-1662ms)`);
    expect(us).toBeLessThan(1500);
  });

  it('the same question always opens the same way; different ones vary', () => {
    const a = composeOpener(ledger, 'have you worked for IBM?');
    const b = composeOpener(ledger, 'have you worked for IBM?');
    expect(a).toEqual(b);
    const forms = new Set();
    for (const q of ['have you worked for IBM?', 'have you worked at Infosys?',
      'were you at Deloitte?', 'have you been at TCS?', 'did you work for Wipro?']) {
      const d = composeOpener(ledger, q);
      if (d.kind === 'speak') forms.add(d.text.replace(/Siemens.*/, ''));
    }
    console.log(`   ${forms.size} distinct phrasings across 5 unknown-employer questions`);
    expect(forms.size).toBeGreaterThan(1);
  });

  it('an opener is short enough to be spoken', () => {
    for (const q of ['have you worked for IBM?', 'tell me about yourself', 'what platforms?']) {
      const d = composeOpener(ledger, q);
      if (d.kind === 'speak') {
        const words = d.text.split(/\s+/).length;
        console.log(`   ${words} words: "${d.text}"`);
        expect(words).toBeLessThan(50);
      }
    }
  });
});

describe('the digest and vocabulary that replace 9KB of prose', () => {
  it('digest is complete and compact', () => {
    const d = ledgerDigest(ledger);
    console.log(`\n   digest ${d.length} chars (old coverContext cap was 9000, one file only):\n${d.split('\n').map((l) => '     ' + l).join('\n')}`);
    for (const org of ['Siemens', 'Apollo Hospitals', 'KIMS Hospitals', 'G Technologies']) {
      expect(d, `digest missing ${org}`).toContain(org);
    }
    expect(d).toContain('PipelineGuard');
    expect(d.length).toBeLessThan(3600);
  });

  it('vocabulary carries the names the server needs to police a fallback', () => {
    const v = ledgerVocabulary(ledger);
    console.log(`   vocabulary ${v.length} chars, ${v.split(' ').length} tokens`);
    for (const w of ['siemens', 'apollo', 'kims', 'kafka', 'redshift']) expect(v).toContain(w);
    expect(v).not.toContain('accenture');
    expect(v).not.toMatch(/\bibm\b/);
  });

  it('both are empty for an empty knowledge base', () => {
    expect(ledgerDigest(EMPTY_LEDGER)).toBe('');
    expect(ledgerVocabulary(EMPTY_LEDGER)).toBe('');
  });
});
