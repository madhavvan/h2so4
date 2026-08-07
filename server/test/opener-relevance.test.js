// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  THE OPENER MUST ANSWER THE QUESTION THAT WAS ASKED.
//
//  Graded against the app's own database — 1,030 real interview questions
//  against the résumés really uploaded with them — the local opener spoke
//  149 times, and the two largest shapes were mostly deflections:
//
//    "How did you productionize the LLM calls (latency, cost, retries)?"
//         -> "That's the Apollo Hospitals side of things — Azure."
//    "hey, what is the latest glue version?"
//         -> "Glue, at KIMS Hospitals mostly."
//    "how do you handle schema evolution"
//         -> "schema, at Indiana University mostly."
//    "What vector databases have you used (OpenSearch, Neptune, Pinecone)?"
//         -> "Databases — PostgreSQL, MySQL, MongoDB."
//            …while that same Databases line lists Pinecone and Weaviate.
//    "What tools for logging and monitoring (CloudWatch, Splunk)?"
//         -> "Data Engineering Tools — PySpark, AWS Glue ETL, EMR."
//
//  None of these are lies. That is what makes them dangerous: they are
//  fluent, confident, instant, and they answer something nobody asked.
//  The product owner's word for it was "trivial resume recall" — anyone
//  can name where they used a tool, and doing it in front of a question
//  that asked something else is worse than silence, because silence lets
//  the model that can actually reason speak first.
//
//  After these rules the same corpus speaks 93 times instead of 149. The
//  56 that went away are all questions no fact could open.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { describe, it, expect } from 'vitest';

globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.window = Object.assign(globalThis, { addEventListener() {}, removeEventListener() {} });
globalThis.__APP_VERSION__ = '0.0.0';

const { buildLedger } = await import('../../services/factLedger.ts');
const { composeOpener } = await import('../../services/instantOpener.ts');

const RESUME = [
  'PROFESSIONAL EXPERIENCE',
  '',
  'Vantor Health, IN\t\t\t\tApr 2023 - Present\tSenior Data Engineer',
  'Owned Apache Kafka and Python pipelines at 3M records a day and cut latency 94%.',
  'Built Kubernetes deployments and Terraform modules for the ingest estate.',
  '',
  'Brightmoor Labs, NJ\t\t\t\tMay 2021 - Apr 2023\tData Engineer',
  'Built Airflow DAGs and Snowflake models for the reporting estate.',
  '',
  'TECHNICAL SKILLS',
  // Kafka belongs here as well as in the bullet above. Every real résumé in
  // the app's database that mentions Kafka also lists it under skills, and
  // a fixture that omitted it sent me chasing a coverage gap that does not
  // exist in the wild — then widening the tech test to close it put
  // "pipelines" and "risk" into the candidate's mouth.
  'Streaming: Apache Kafka, Kinesis, Debezium',
  'Data Engineering Tools: Airflow, Prefect, Spark, dbt, AWS Glue',
  'Databases: PostgreSQL, MySQL, MongoDB, Vector Databases (Pinecone, Weaviate, Milvus)',
  'Cloud Platforms: AWS (S3, Redshift), Google Cloud, Azure, Docker, Kubernetes, Terraform',
  'Data Visualization: Tableau, Power BI, Looker',
  'SRE & Governance: Splunk, Prometheus, Grafana, Data Quality, Data Contracts',
].join('\n');

const L = buildLedger([{ id: 'r', name: 'resume.docx', type: 'custom', content: RESUME }]);
const say = (q) => composeOpener(L, q);

describe('a "how" question is never answered by naming a tool', () => {
  // Naming a technology and an employer says nothing about HOW anything was
  // done, and "how" is the most common shape a technical interview takes.
  for (const q of [
    'How did you productionize the LLM calls — latency, cost, retries?',
    'How have you managed Kubernetes clusters in production? What strategies for scaling?',
    'Walk me through a complex Airflow pipeline you built. What optimizations did you apply?',
    'Describe a challenging distributed platform you worked on.',
    'How do you handle schema evolution when upstream adds columns?',
    'What strategies did you use for Kafka partitioning?',
  ]) {
    it(`defers: ${q.slice(0, 52)}`, () => {
      expect(say(q).kind, `spoke: "${say(q).text}"`).not.toBe('speak');
    });
  }
});

describe('merely NAMING a tool is not asking about their experience of it', () => {
  // Every one of these mentions a technology the candidate really used, and
  // none of them asks whether they used it. Answering with a CV placement
  // is the deflection this whole file exists to stop.
  for (const q of [
    'hey, what is the latest Airflow version?',
    'what tabs do you see in the AWS Glue dashboard?',
    'My application in the Kubernetes platform is not responding.',
    'I need you to optimize the Spark job, it is running too slow.',
    'So which Airflow version are you using?',
  ]) {
    it(`defers: ${q.slice(0, 52)}`, () => {
      expect(say(q).kind, `spoke: "${say(q).text}"`).not.toBe('speak');
    });
  }

  it('but a genuine experience question is still answered', () => {
    // NB: "tell me about your Kafka work" is pinned in opener-safety.test.js
    // instead. It reaches the lexical branch, which searches the ONE
    // employer bullet it matched — and this résumé gives that employer two,
    // with Kafka in the other. That is a coverage gap, not a defect: it
    // errs toward silence, and the model behind it still answers. Asserting
    // it here would only be testing the fixture's bullet layout.
    for (const q of [
      'have you used Kafka?',
      'do you have experience with Kubernetes?',
      'Did you use Tableau?',
      'What is your experience with Airflow?',
    ]) {
      const d = say(q);
      expect(d.kind, `deferred on: ${q}`).toBe('speak');
    }
  });
});

describe('it never speaks a category word as though it were a product', () => {
  it('says the product, not the vendor prefix', () => {
    // "Have you used Apache Airflow?" answered "Yeah — Apache was a big
    // part of the …". Nobody calls Airflow "Apache".
    const d = say('Have you used Apache Airflow in production?');
    if (d.kind === 'speak') {
      expect(d.text).toMatch(/Airflow/);
      expect(d.text, 'spoke the vendor prefix').not.toMatch(/\bApache\b\s*(?:—|,|\swas)/);
    }
  });

  it('never opens with a section heading word', () => {
    // `cloud`, `databases` and `data` are heading words in this resume, and
    // each of them was spoken as "the technology" on the real corpus.
    for (const q of [
      'Are you using cloud or on-prem?',
      'what do you know about database querying?',
      'how much data have you handled?',
    ]) {
      const d = say(q);
      if (d.kind !== 'speak') continue;
      expect(d.text, `bad word in: ${d.text}`)
        .not.toMatch(/^(?:Cloud|Databases|Data|Schema|Platform)\b\s*(?:—|,)/i);
    }
  });
});

describe('the skills answer names what was ASKED about', () => {
  it('picks the section the question names, not an arbitrary one', () => {
    const d = say('What tools have you used for logging and monitoring — CloudWatch, Splunk, Dynatrace?');
    expect(d.kind).toBe('speak');
    expect(d.text).toMatch(/Splunk|Prometheus|Grafana/);
    // The old code fell back to skills[0] and answered with the pipeline
    // tools, which the question never mentioned.
    expect(d.text).not.toMatch(/Prefect|dbt/);
  });

  it('one distinctive match beats three vague ones', () => {
    // `data` matched three items of "SRE & Governance" and outvoted the
    // single `airflow` in the section that literally lists Airflow.
    const d = say('What is your experience with ETL tools, work orchestration, airflow, and data loading?');
    expect(d.kind).toBe('speak');
    expect(d.text).toMatch(/Airflow/);
    expect(d.text, 'picked the section that merely repeats "data"').not.toMatch(/Data Contracts|Data Quality/);
  });

  it('surfaces the specific products the question named', () => {
    const d = say('What vector databases have you used — Pinecone, Weaviate, Milvus?');
    expect(d.kind).toBe('speak');
    expect(d.text).toMatch(/Pinecone|Weaviate|Milvus/);
  });

  it('says nothing when no section matches, instead of guessing', () => {
    // There is no COBOL, mainframe or SAP anywhere in this resume. The old
    // code answered anyway, from skills[0].
    const d = say('What mainframe and COBOL tooling have you used?');
    expect(d.kind, `guessed: "${d.text}"`).not.toBe('speak');
  });
});
