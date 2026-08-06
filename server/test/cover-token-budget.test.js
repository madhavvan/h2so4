// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  THE COVER'S BUDGET IS A TOKEN BUCKET, AND IT WAS OVERDRAWN
//
//  Groq meters llama-3.3-70b-versatile per MINUTE, not per request, and it
//  charges input + max_tokens against that bucket before generating
//  anything. Measured against the live API:
//
//    x-ratelimit-limit-tokens: 12000        (per minute)
//    one cover request:        ~3,830 tok   (9,000-char background +
//                                            the ~1,340-token system prompt)
//    => 3.1 covers per minute, then 429
//
//  A real interview asks a question every 20-40 seconds, so the primary
//  cover provider rate-limited partway through every conversation. Verified
//  live on 2026-07-29: two calls succeeded, the third returned
//  "Rate limit reached for model llama-3.3-70b-versatile".
//
//  The 9,000-char block is gone — the cover now receives the ledger DIGEST,
//  which is every role, project, skill line and metric in the WHOLE
//  knowledge base rather than the first 9,000 characters of one document.
//  It is complete AND an order of magnitude smaller. This test pins the
//  arithmetic, because the failure it prevents is invisible until an
//  interview is already underway.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.window = Object.assign(globalThis, { addEventListener() {}, removeEventListener() {} });
globalThis.__APP_VERSION__ = '0.0.0';

const require = createRequire(import.meta.url);
const { COVER_SYSTEM, userPrompt, COVER_TIERS } = require('../src/services/coverAnswer.js');
const { buildLedger } = await import('../../services/factLedger.ts');
const { ledgerDigest } = await import('../../services/instantOpener.ts');

// Groq's published limit for this model on this org.
const GROQ_TPM = 12_000;
// ~4 chars per token is the standard English approximation and the one the
// original measurement used, so the comparison stays apples to apples.
const tok = (s) => Math.ceil(String(s || '').length / 4);

// ⚠️ SIZED LIKE A REAL RESUME, ON PURPOSE.
//
// A twelve-line fixture makes this test say nothing: the background is then
// ~300 tokens either way and the "before" number bears no resemblance to the
// 3,830 that was actually measured. The four real PDFs in the user's database
// are 8,255-9,803 characters each, so the fixture below is padded with the
// kind of bullet prose that fills that space — several per role, which is
// what a real senior resume looks like.
const ROLE_BULLETS = (org) => [
  `●   Rebuilt the lakehouse ETL path at ${org} and cut cross-source query latency by roughly 40% through execution-plan tuning, partition pruning and clustering on the hot dimensions.`,
  '●   Owned the Kafka and Python ingestion path for clinical and operational events at around 3M records a day, with bounded retries, dead-letter handling and publish-time validation so a bad batch never reached reporting.',
  '●   Introduced dbt test coverage across the curated marts, dropping silent data-quality escapes to near zero and giving analysts a contract they could rely on instead of a nightly surprise.',
  '●   Reduced warehouse spend by consolidating overlapping extracts and moving cold history to Iceberg, holding query performance flat while cutting storage growth.',
  '●   Rewrote the orchestration topology so the nightly window fell from 6.2 hours to 2.1, mostly by removing false dependencies between independent DAG branches.',
].join('  ');

const ONE_RESUME = [
  'VENU MADHAV  Data Engineer | AWS Warehousing, Spark Pipelines & Curated Data Products',
  'PROFESSIONAL SUMMARY  Data engineer with 4+ years owning production pipelines end to end on AWS — ingestion, warehouse modelling, quality gates, and the curated datasets other teams build on.',
  'TECHNICAL SKILLS',
  '●   AWS Data Platform:   S3, Glue, Redshift, EMR, Lambda, Step Functions, Athena, MSK, IAM, CloudWatch',
  '●   Streaming & Event Processing:   Apache Kafka, Kinesis, Debezium, Structured Streaming, Flink basics',
  '●   Warehousing & Data Modelling:   Redshift, Snowflake, BigQuery, dbt, Iceberg, Delta, star schemas',
  '●   Languages & Query:   Python, SQL, PySpark, Scala, Bash, T-SQL, PL/SQL',
  '●   Operations & Practice:   Airflow, Terraform basics, Git, CI/CD, observability, on-call rotations',
  'PROFESSIONAL EXPERIENCE  Data Engineer   |   Siemens, Dallas, TX   |   April 2026 – Present',
  ROLE_BULLETS('Siemens'),
  'Data Engineer – Research Assistant   |   Indiana University, Indianapolis, IN   |   January 2024 – December 2025',
  ROLE_BULLETS('Indiana University'),
  'Data Engineer   |   Apollo Hospitals, Hyderabad, India   |   Sep 2022 – December 2023',
  ROLE_BULLETS('Apollo Hospitals'),
  'Data Engineer   |   KIMS Hospitals, Hyderabad, India   |   June 2016 – August 2017',
  ROLE_BULLETS('KIMS Hospitals'),
  'EDUCATION  Master of Science in Health Informatics   |   Indiana University   |   2025',
  'CERTIFICATIONS  AWS Certified Solutions Architect – Associate   |   Amazon Web Services   |   June 2023',
  'PROJECTS',
  'PipelineGuard — Agentic data-pipeline triage | Python, Elasticsearch, ES|QL',
  '●   Built a tool-calling agent that answers plain-language questions over live pipeline logs and names the failing stage with a probable root cause in seconds.',
  'DropGuard — Data integrity under concurrent load | Aurora DSQL, TypeScript',
  '●   Ran 2,000 concurrent writers against a naive read-then-write path and an optimistic-concurrency-guarded one to show where the lost updates actually come from.',
].join('  ');

describe('cover request size against the per-minute bucket', () => {
  const tier = COVER_TIERS[0];

  it('one resume: covers per minute, before and after', () => {
    const ledger = buildLedger([{ id: 'r', name: 'r.pdf', type: 'custom', content: ONE_RESUME }]);
    const digest = ledgerDigest(ledger);

    // BEFORE: the whole document, capped at 9,000 chars.
    const before = tok(COVER_SYSTEM) + tok(ONE_RESUME.slice(0, 9000)) + tier.maxTokens;
    // AFTER: the ledger digest.
    const after = tok(COVER_SYSTEM) + tok(digest) + tier.maxTokens;

    const perMinBefore = GROQ_TPM / before;
    const perMinAfter = GROQ_TPM / after;
    console.log(`   system prompt      ${tok(COVER_SYSTEM)} tok`);
    console.log(`   background BEFORE  ${tok(ONE_RESUME.slice(0, 9000))} tok (9,000-char slice of one file)`);
    console.log(`   background AFTER   ${tok(digest)} tok (complete ledger digest, ${digest.length} chars)`);
    console.log(`   request BEFORE     ${before} tok -> ${perMinBefore.toFixed(1)} covers/min`);
    console.log(`   request AFTER      ${after} tok -> ${perMinAfter.toFixed(1)} covers/min`);
    console.log(`   an interview asks a question every 20-40s = 1.5-3 covers/min needed`);
    expect(after).toBeLessThan(before);
    // A question every 20 seconds is 3 per minute. The bucket has to hold
    // that with headroom, or the primary provider 429s mid-conversation.
    expect(perMinAfter).toBeGreaterThan(4);
  });

  it('FOUR resumes — where the old block silently dropped three of them', () => {
    const files = [0, 1, 2, 3].map((i) => ({
      id: 'r' + i, name: `resume-${i}.pdf`, type: 'custom',
      content: ONE_RESUME.replace('Siemens', i ? `Company${i}` : 'Siemens'),
    }));
    const raw = files.reduce((a, f) => a + f.content.length, 0);
    const digest = ledgerDigest(buildLedger(files));
    const after = tok(COVER_SYSTEM) + tok(digest) + tier.maxTokens;
    console.log(`   4 files = ${raw} chars; the old cap sent 9000 of them (${((9000 / raw) * 100).toFixed(0)}%), first file only`);
    console.log(`   digest sends ${digest.length} chars covering ALL of them -> ${(GROQ_TPM / after).toFixed(1)} covers/min`);
    // Completeness: every company reaches the model.
    for (const c of ['Siemens', 'Company1', 'Company2', 'Company3']) {
      expect(digest, `digest is missing ${c}`).toContain(c);
    }
    expect(GROQ_TPM / after).toBeGreaterThan(4);
  });

  it('the assembled user prompt stays small even with the transcript attached', () => {
    const ledger = buildLedger([{ id: 'r', name: 'r.pdf', type: 'custom', content: ONE_RESUME }]);
    const recent = 'Interviewer: what platforms have you worked on?\n'
      + 'You already said: Mostly AWS — S3, Glue and Redshift.';
    const p = userPrompt('and where did the Kafka work happen?', 'other', ledgerDigest(ledger), tier, recent);
    const total = tok(COVER_SYSTEM) + tok(p) + tier.maxTokens;
    console.log(`   user prompt ${p.length} chars (${tok(p)} tok), whole request ${total} tok`);
    console.log(`   -> ${(GROQ_TPM / total).toFixed(1)} covers/min with two turns of transcript included`);
    expect(p).toContain('THE LAST FEW SECONDS');
    expect(p).toContain('what platforms have you worked on?');
    expect(GROQ_TPM / total).toBeGreaterThan(4);
  });

  it('the transcript is labelled as context, never as evidence', () => {
    const p = userPrompt('why?', 'other', 'ROLES:\n- Siemens', COVER_TIERS[0],
      'Interviewer: have you worked at IBM?\nYou already said: No, I haven\'t.');
    // The distinction the old prompt had no way to express: the background
    // is TRUE, the transcript merely HAPPENED. A line in it that the
    // background does not support must not be defended.
    expect(p).toMatch(/not\s+evidence about the candidate/);
    expect(p).toMatch(/must NOT be repeated or defended/);
    // Background still comes first — a fast model reads top-down.
    expect(p.indexOf('CANDIDATE BACKGROUND')).toBeLessThan(p.indexOf('THE LAST FEW SECONDS'));
  });

  it('no transcript -> no block, and the prompt is byte-identical to before', () => {
    const withNothing = userPrompt('what is a hashmap?', 'concept', 'ROLES:\n- Siemens', COVER_TIERS[0]);
    const withEmpty = userPrompt('what is a hashmap?', 'concept', 'ROLES:\n- Siemens', COVER_TIERS[0], '   ');
    expect(withNothing).toBe(withEmpty);
    expect(withNothing).not.toContain('THE LAST FEW SECONDS');
  });
});
