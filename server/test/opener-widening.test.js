// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  THE DETERMINISTIC OPENER, WIDENED (2026-09-06).
//
//  Measured on the real question corpus: 14.0% coverage, and among the
//  deferred about-them questions a handful of FACT-shaped ones the ledger
//  could have answered — current role, employment dates, years, certs,
//  "explain your projects", a bare greeting — plus one bug: "Have you
//  worked with Kafka?" was deferred because a capitalised tool name was
//  checked as a possible employer before the have-you-used shape ran.
//
//  Every new shape keeps the rail's one rule: TRUE from parsed facts or say
//  nothing. Same fixtures as opener-safety.test.js and instant-opener.test.js.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { describe, it, expect } from 'vitest';

globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.window = Object.assign(globalThis, { addEventListener() {}, removeEventListener() {} });
globalThis.__APP_VERSION__ = '0.0.0';

const { buildLedger, EMPTY_LEDGER } = await import('../../services/factLedger.ts');
const { composeOpener } = await import('../../services/instantOpener.ts');

// opener-safety's résumé: two employers with dates, six tools, no certs.
const TWO_JOBS = buildLedger([{ id: 'r', name: 'resume.docx', type: 'custom', content: [
  'PROFESSIONAL EXPERIENCE', '',
  'Kestrelby Pharma, PA\t\t\t\t\t Apr 2023 - Present Senior Data Engineer', '',
  'Owned Kafka and Python pipelines at 3M records a day and cut latency 94%.', '',
  'Aldermoor Sciences, NJ\t\t\t\tMay 2021 – Apr 2023 Data Engineer', '',
  'Built Airflow DAGs and Snowflake models for the reporting estate.', '',
  'TECHNICAL SKILLS', '',
  'Streaming & Ingestion: Apache Kafka, Kinesis, Debezium',
  'Warehouse: Snowflake, Redshift, dbt',
].join('\n') }]);

// instant-opener's résumé: five employers, a degree, a certification, a project.
const FULL = buildLedger([{ id: 'r1', name: 'VMADp_DataEngineer.pdf', type: 'custom', content: [
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
].join('  ') }]);

const say = (ledger, q) => { const d = composeOpener(ledger, q); return d; };

describe('a bare greeting is answered at once, with no facts and no documents', () => {
  it('speaks on the greeting shapes, even with an empty knowledge base', () => {
    for (const q of ['Good morning, how are you doing today?', 'heyy, how are you?', "Hi — how's it going?", 'Nice to meet you!',
      'so how are you today?', 'Excellent. How are you doing today?', "It's a pleasure to meet you."]) {
      const d = say(EMPTY_LEDGER, q);
      expect(d.kind, q).toBe('speak');
      expect(d.shape).toBe('greeting');
      // Nothing capitalised but the first word: no fact, no name, nothing to guard.
      expect(d.text.replace(/^[A-Z]/, '')).not.toMatch(/[A-Z]{2,}|\b[A-Z][a-z]+\b/);
    }
  });
  it('"nice to meet you" gets a meet-you reply, not "I\'m good"', () => {
    expect(say(EMPTY_LEDGER, 'Nice to meet you!').text).toMatch(/meet you too/);
    expect(say(EMPTY_LEDGER, 'How are you doing?').text).not.toMatch(/meet you too/);
  });
  it('a pleasantry in front of a real question does not win', () => {
    // Over the length cap the last sentence is not read as the question.
    const long = 'Good morning, thanks for making the time today, we have about forty five minutes together and I want to cover a lot. How are you?';
    expect(say(TWO_JOBS, long).shape).not.toBe('greeting');
  });
  it('never fires on a real question that merely starts like one', () => {
    for (const q of ['How are you handling schema drift in production?', 'how are you doing the deduplication?', 'how is it going with the Kafka migration at Kestrelby?']) {
      expect(say(TWO_JOBS, q).shape, q).not.toBe('greeting');
    }
  });
});

describe('a capitalised tool is a have-you-used question, not an employer to deny', () => {
  it('"Have you worked with Kafka?" is finally answered from the résumé', () => {
    const d = say(TWO_JOBS, 'Have you worked with Kafka?');
    expect(d.kind, JSON.stringify(d)).toBe('speak');
    expect(d.shape).toBe('topic');
    expect(d.text).toMatch(/Kafka/);
    expect(d.text).toMatch(/Kestrelby Pharma/);
  });
  it('"your experience where you worked with Snowflake?" too — a tool the skills section lists', () => {
    const d = say(TWO_JOBS, 'Have you worked with Snowflake in production?');
    expect(d.kind, JSON.stringify(d)).toBe('speak');
    expect(d.shape).toBe('topic');
    expect(d.text).toMatch(/Snowflake/);
    expect(d.text).toMatch(/Aldermoor Sciences/);
  });
  it('a tool named ONLY in a bullet still defers: isSpeakableTech is the skills list, on purpose', () => {
    // Python appears in an experience bullet and nowhere in TECHNICAL SKILLS.
    // isSpeakableTech documents why the whole vocabulary is not admitted
    // (measured: "pipelines", "risk", "Role" spoken as tools). Quiet beats wrong.
    const d = say(TWO_JOBS, 'Can you tell me about your experience where you worked with Python?');
    expect(d.kind).toBe('defer');
  });
  it('an unknown ORGANISATION is still handled exactly as before', () => {
    // Denied with real evidence (the safety file pins the wording); never affirmed.
    expect(say(TWO_JOBS, 'have you worked at Goldman Sachs?').kind).toBe('speak');
    expect(say(TWO_JOBS, 'have you worked at Goldman Sachs?').text).toMatch(/^No|haven't/);
    // A tool the résumé does NOT list is neither denied nor affirmed.
    expect(say(TWO_JOBS, 'Have you worked with Flink?').kind).toBe('defer');
  });
});

describe('the current role, present tense', () => {
  it('"what is your current role?" names the present employer with its tenure', () => {
    const d = say(TWO_JOBS, "What's your current role?");
    expect(d.kind, JSON.stringify(d)).toBe('speak');
    expect(d.shape).toBe('current');
    expect(d.text).toMatch(/Senior Data Engineer/);
    expect(d.text).toMatch(/Kestrelby Pharma/);
    expect(d.text).toMatch(/since 2023/);
    expect(d.text).not.toMatch(/Aldermoor/);
  });
  it('"where do you work?" is the current employer; "where have you worked?" is still the list', () => {
    expect(say(TWO_JOBS, 'where do you work now?').shape).toBe('current');
    expect(say(TWO_JOBS, 'what do you do for a living?').shape).toBe('current');
    const past = say(TWO_JOBS, 'where have you worked?');
    expect(past.kind).toBe('speak');
    expect(past.shape).toBe('platforms');   // WHERE_WORKED reports under this shape
    expect(past.text).toMatch(/Aldermoor Sciences/);
  });
});

describe('dates and years are answered with the timeline, never a summed total', () => {
  it('"can you mention the dates when you worked?" — most recent first, in the grammar the dates justify', () => {
    const d = say(TWO_JOBS, 'can you mention the dates when you worked?');
    expect(d.kind, JSON.stringify(d)).toBe('speak');
    expect(d.shape).toBe('dates');
    expect(d.text).toMatch(/Kestrelby Pharma since 2023/);
    expect(d.text).toMatch(/Aldermoor Sciences from 2021 to 2023/);
    expect(d.text.indexOf('Kestrelby')).toBeLessThan(d.text.indexOf('Aldermoor'));
    // The safety file's rule: never open on a stray verb.
    expect(d.text).not.toMatch(/^(?:Worked|Working|Work|Engineering|Handling|Management|For)\b/i);
  });
  it('"how many years of experience do you have?" gives the dates, not an invented number', () => {
    const d = say(FULL, 'how many years of experience do you have?');
    expect(d.kind, JSON.stringify(d)).toBe('speak');
    expect(d.shape).toBe('dates');
    // KIMS 2016 must not be summed into "ten years" when the résumé says 4+.
    expect(d.text).not.toMatch(/\b(?:ten|10|9|nine)\+?\s*years/i);
    expect(d.text).toMatch(/Siemens since 2026/);
  });
  it('"when did you join <a known employer>?" answers for that employer only', () => {
    const d = say(TWO_JOBS, 'When did you join Aldermoor Sciences?');
    expect(d.kind, JSON.stringify(d)).toBe('speak');
    expect(d.shape).toBe('dates');
    expect(d.text).toMatch(/Aldermoor Sciences/);
    expect(d.text).toMatch(/from 2021 to 2023/);
    expect(d.text).not.toMatch(/Kestrelby/);
    const h = say(TWO_JOBS, 'How long have you been at Kestrelby Pharma?');
    expect(h.shape, JSON.stringify(h)).toBe('dates');
    expect(h.text).toMatch(/Kestrelby Pharma — since 2023|Kestrelby Pharma, since 2023/);
  });
  it('a process question that happens to mention time or a job is NOT a dates question', () => {
    for (const q of [
      'When you worked at Aldermoor Sciences, how did you handle schema drift?',
      'how long have you been working with Kafka?',
      'when did you start using Kinesis?',
      'How many years of Snowflake experience do you have?',
    ]) {
      expect(say(TWO_JOBS, q).shape, q).not.toBe('dates');
    }
  });
});

describe('the current-role shape is read off the last sentence, anchored', () => {
  it('the three corpus non-sequiturs no longer get a job title back', () => {
    for (const q of [
      'Why are you looking to leave your current role at Siemens?',
      'why are you leaving your current role?',
      'A calibration comes back out of tolerance mid-study. What do you do?',
      "Excellent. Let's move into your technical experience. Walk me through your recent primary coding languages, and what sort of work are you currently doing with them?",
    ]) {
      expect(say(FULL, q).shape, q).not.toBe('current');
    }
  });
  it('filler and a lead-in sentence are skipped to reach the question', () => {
    expect(say(TWO_JOBS, 'Thanks for joining. So, what is your current role?').shape).toBe('current');
    expect(say(TWO_JOBS, 'Okay great. Are you currently employed?').shape).toBe('current');
  });
  it('a résumé whose latest job has ENDED says "most recently", never "currently"', () => {
    const ENDED = buildLedger([{ id: 'r', name: 'resume.docx', type: 'custom', content: [
      'PROFESSIONAL EXPERIENCE', '',
      'Aldermoor Sciences, NJ\t\t\t\tMay 2021 – Apr 2023 Data Engineer', '',
      'Built Airflow DAGs and Snowflake models for the reporting estate.', '',
      'TECHNICAL SKILLS', '', 'Warehouse: Snowflake, Redshift, dbt',
    ].join('\n') }]);
    const d = say(ENDED, "What's your current role?");
    expect(d.kind, JSON.stringify(d)).toBe('speak');
    expect(d.shape).toBe('current');
    expect(d.text).toMatch(/^(?:Most recently|The latest was) Data Engineer at Aldermoor Sciences/);
    expect(d.text).toMatch(/from 2021 to 2023/);
    expect(d.text).not.toMatch(/Currently|Right now/);
  });
});

describe('present-tense status needs the adverb', () => {
  it('"are you working on the ingestion side?" is not an employment-status question', () => {
    expect(say(TWO_JOBS, 'are you working on the ingestion side?').shape).not.toBe('current');
    expect(say(TWO_JOBS, 'what is your current work on Snowflake?').shape).not.toBe('current');
    expect(say(TWO_JOBS, 'are you currently working?').shape).toBe('current');
  });
});

describe('certifications: spoken only when parsed, never denied', () => {
  it('names the parsed certification', () => {
    const d = say(FULL, 'Do you have any certifications?');
    expect(d.kind, JSON.stringify(d)).toBe('speak');
    expect(d.shape).toBe('certs');
    expect(d.text).toMatch(/AWS Certified Solutions Architect/);
    expect(d.text).not.toMatch(/\b(?:engineer|role|worked)\b/i);   // not passed off as a job
  });
  it('with none parsed it defers rather than saying no', () => {
    const d = say(TWO_JOBS, 'Do you have any certifications?');
    expect(d.kind).toBe('defer');
  });
});

describe('"explain your projects" joins the projects shape', () => {
  it('speaks the project list', () => {
    const d = say(FULL, 'Can you explain about your projects?');
    expect(d.kind, JSON.stringify(d)).toBe('speak');
    expect(d.shape).toBe('project');
    expect(d.text).toMatch(/PipelineGuard/);
  });
  it('the singular favourite-project shape is untouched', () => {
    const d = say(FULL, "What's your favourite project?");
    expect(d.kind).toBe('speak');
    expect(d.text).toMatch(/PipelineGuard/);
  });
});

describe('every widened opener is still grounded, short and deterministic', () => {
  const QS = ['Good morning, how are you doing today?', 'Have you worked with Kafka?', "What's your current role?",
    'can you mention the dates when you worked?', 'Do you have any certifications?', 'Can you explain about your projects?'];
  it('the same question opens the same way twice, and never runs long', () => {
    for (const q of QS) {
      const a = say(FULL, q); const b = say(FULL, q);
      expect(a).toEqual(b);
      if (a.kind === 'speak') expect(a.text.length).toBeLessThanOrEqual(260);
    }
  });
});
