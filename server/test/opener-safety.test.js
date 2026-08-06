// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  WHAT THE APP IS ALLOWED TO SAY FIRST
//
//  Every sentence asserted against below was produced by composeOpener
//  against a REAL resume and a REAL question out of the app's own database.
//  They are not hypotheticals: they are what the candidate would have said
//  out loud, in an interview, before this file existed.
//
//    "Worked — yeah, that was the Piramal work."
//    "engineering — yeah, that was the Jasper Therapeutics work."
//    "No, I haven't — my roles have been Piramal, Aurolife…"
//        ← in answer to "How have you made Airflow DAGs resilient?"
//    "Data Engineer at G Technologies since 2025 to 2025."
//
//  The last two are the dangerous ones. A denial of employment cannot be
//  taken back, and it was being triggered by an ACRONYM in a technical
//  question and by the word "your".
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { describe, it, expect } from 'vitest';

globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.window = Object.assign(globalThis, { addEventListener() {}, removeEventListener() {} });
globalThis.__APP_VERSION__ = '0.0.0';

const { buildLedger, EMPTY_LEDGER } = await import('../../services/factLedger.ts');
const { composeOpener, _explain } = await import('../../services/instantOpener.ts');

const RESUME = [
  'PROFESSIONAL EXPERIENCE',
  '',
  'Kestrelby Pharma, PA\t\t\t\t\t Apr 2023 - Present Senior Data Engineer',
  '',
  'Owned Kafka and Python pipelines at 3M records a day and cut latency 94%.',
  '',
  'Aldermoor Sciences, NJ\t\t\t\tMay 2021 – Apr 2023 Data Engineer',
  '',
  'Built Airflow DAGs and Snowflake models for the reporting estate.',
  '',
  'TECHNICAL SKILLS',
  '',
  'Streaming & Ingestion: Apache Kafka, Kinesis, Debezium',
  'Warehouse: Snowflake, Redshift, dbt',
].join('\n');

// A resume the extractor cannot read at all — an image-only PDF, an unusual
// template, a language it has no patterns for.
const UNREADABLE = [
  'Curriculum Vitae',
  'A long narrative account of a career, written in continuous prose with no',
  'headings, no dates in any recognisable format and no tabular structure at all.',
].join('\n');

const L = buildLedger([{ id: 'r', name: 'resume.docx', type: 'custom', content: RESUME }]);
const BLIND = buildLedger([{ id: 'u', name: 'cv.docx', type: 'custom', content: UNREADABLE }]);

describe('a denial of employment needs real evidence', () => {
  it('says no to a company that is genuinely absent', () => {
    const d = composeOpener(L, 'have you worked at Goldman Sachs?');
    expect(d.kind).toBe('speak');
    expect(d.text).toMatch(/^(No|I haven't)/i);
    console.log(`   ${_explain(L, 'have you worked at Goldman Sachs?')}`);
  });

  it('lowercase still works when the sentence names an EMPLOYER preposition', () => {
    // Deepgram lowercases some proper nouns; "worked for X" is unambiguous.
    expect(composeOpener(L, 'have you worked for ibm?').kind).toBe('speak');
  });

  it('⚠️ never denies employment because of an acronym in a technical question', () => {
    // "How have you made Airflow DAS resilient and at scale?" produced
    // "No, I haven't — my roles have been…". The acronym fallback fired on
    // ANY short question, and an acronym in a technical question is a
    // technology, not a company.
    for (const q of [
      'How have you made Airflow DAS resilient and at scale?',
      'how do you test your ETL jobs?',
      'what is your approach to CI/CD?',
      'how do you handle PII in a warehouse?',
    ]) {
      const d = composeOpener(L, q);
      expect(d.kind, `${q} -> ${JSON.stringify(d)}`).not.toBe('speak');
      if (d.kind === 'speak') console.log(`   LEAK: ${q} -> ${d.text}`);
    }
  });

  it('⚠️ never denies employment because the question contains "your"', () => {
    // "…actually matters for your work in your career" captured "your" as
    // the organisation and answered "No, not there. Where I have worked is…"
    for (const q of [
      'what actually matters for your work in your career?',
      'have you worked with data at scale?',
      'have you worked in healthcare before?',
    ]) {
      const d = composeOpener(L, q);
      expect(d.kind, `${q} -> ${JSON.stringify(d)}`).not.toBe('speak');
    }
  });

  it('does not deny a name that IS in the documents but is not an employer', () => {
    // Saying "no, I haven't" about a tool the resume lists contradicts the
    // candidate's own file, and the answer model then says the opposite.
    const d = composeOpener(L, 'what about Debezium?');
    expect(d.kind).not.toBe('speak');
    console.log(`   ${_explain(L, 'what about Debezium?')}`);
  });
});

describe('a resume the extractor could not read must not cause silence', () => {
  it('defers rather than suppressing — a live model may still cover', () => {
    // `suppress` forbids the LLM cover too. So a parse failure used to
    // produce GUARANTEED dead air: the one outcome the feature exists to
    // prevent, caused by the component meant to prevent it.
    expect(BLIND.employers.length).toBe(0);
    for (const q of ['have you worked at Goldman Sachs?', 'do you know Accenture?', 'what about IBM?']) {
      const d = composeOpener(BLIND, q);
      expect(d.kind, `${q} -> ${JSON.stringify(d)}`).toBe('defer');
    }
  });

  it('still suppresses when being challenged about a previous answer', () => {
    // The one case where an opener is itself the failure, and it must
    // survive every other change in this file.
    expect(composeOpener(L, 'then why did you answer IBM?').kind).toBe('suppress');
    expect(composeOpener(BLIND, "that's not true, is it?").kind).toBe('suppress');
  });
});

describe('the words themselves have to be sayable', () => {
  it('never names an ordinary verb as a technology', () => {
    // "Worked — yeah, that was the Piramal work." A denylist of common words
    // could never be complete; the knowledge base states which words are
    // technologies and those are the only candidates.
    for (const q of [
      'where have your worked before?',
      'can you mention the dates when you worked?',
      'tell me about your engineering approach',
    ]) {
      const d = composeOpener(L, q);
      if (d.kind !== 'speak') continue;
      expect(d.text, `bad topic word in: ${d.text}`)
        .not.toMatch(/^(?:Worked|Working|Work|Engineering|Handling|Management|For)\b/i);
      expect(d.text).not.toMatch(/\b(?:worked|engineering|handling|for) — yeah/i);
    }
  });

  it('names a real tool when the question names one', () => {
    const d = composeOpener(L, 'tell me about your Kafka work');
    expect(d.kind).toBe('speak');
    expect(d.text).toMatch(/Kafka/);
    expect(d.text).toMatch(/Kestrelby Pharma|Aldermoor Sciences/);
    console.log(`   ${d.text}`);
  });

  it('a single-year role does not become "since 2025 to 2025"', () => {
    const oneYear = buildLedger([{
      id: 'x', name: 'r.docx', type: 'custom',
      content: 'EXPERIENCE\n\nNorthgate Labs, IN\t\t\tMay 2025 – December 2025 Data Engineer\n\nBuilt pipelines.',
    }]);
    const d = composeOpener(oneYear, 'tell me about yourself');
    expect(d.kind).toBe('speak');
    expect(d.text).not.toMatch(/since \d{4} to \d{4}/);
    expect(d.text).not.toMatch(/(\d{4}) to \1/);
    console.log(`   ${d.text}`);
  });

  it('a closed range says "from…to", not "since"', () => {
    const closed = buildLedger([{
      id: 'y', name: 'r.docx', type: 'custom',
      content: 'EXPERIENCE\n\nNorthgate Labs, IN\t\t\tMay 2018 – Apr 2020 Data Engineer\n\nBuilt pipelines.',
    }]);
    const d = composeOpener(closed, 'walk me through your background');
    expect(d.text).not.toMatch(/since \d{4} to/);
    console.log(`   ${d.text}`);
  });

  it('never speaks the reserved label of an unlabelled skills list', () => {
    const bare = buildLedger([{
      id: 'z', name: 'r.docx', type: 'custom',
      content: ['EXPERIENCE', '', 'Northgate Labs, IN\t\t\tMay 2018 – Apr 2020 Quality Engineer',
        '', 'Ran investigations.', '', 'SKILLS', '', 'CAPA Management', 'Root Cause Analysis',
        'Change Control', 'Audit Support'].join('\n'),
    }]);
    const d = composeOpener(bare, 'what tools have you used?');
    if (d.kind === 'speak') {
      expect(d.text).not.toMatch(/^Mostly Skills\b/);
      expect(d.text).not.toMatch(/\bSkills —/);
      console.log(`   ${d.text}`);
    }
  });
});

describe('questions that were answerable and were not being answered', () => {
  const speaks = (q) => {
    const d = composeOpener(L, q);
    expect(d.kind, `${q} -> ${JSON.stringify(d)}`).toBe('speak');
    console.log(`   ${q}\n     → ${d.text}`);
    return d.text;
  };

  it('where have you worked', () => {
    expect(speaks('where have you worked before?')).toMatch(/Kestrelby Pharma/);
    expect(speaks('which companies have you been at?')).toMatch(/Aldermoor Sciences/);
  });

  it('walk me through your experience — without the word "background"', () => {
    expect(speaks('can you walk through your experience')).toMatch(/Kestrelby Pharma/);
    expect(speaks('walk me through your work experience')).toMatch(/Kestrelby Pharma/);
  });

  it('do you have experience with <a tool the resume lists>', () => {
    expect(speaks('do you have experience with Snowflake?')).toMatch(/Snowflake/i);
    expect(speaks('have you used Kafka?')).toMatch(/Kafka/i);
  });

  it('…and defers on a tool the resume does not list, rather than denying it', () => {
    // A resume lists what fitted on the page, so absence is weak evidence
    // for a TOOL — unlike an employer, where absence is the answer.
    const d = composeOpener(L, 'do you have experience with Kubernetes?');
    expect(d.kind).toBe('defer');
    console.log(`   ${_explain(L, 'do you have experience with Kubernetes?')}`);
  });

  it('an empty knowledge base still composes nothing and blames nobody', () => {
    for (const q of ['tell me about yourself', 'where have you worked?', 'have you used Kafka?']) {
      expect(composeOpener(EMPTY_LEDGER, q).kind).toBe('defer');
    }
  });
});
