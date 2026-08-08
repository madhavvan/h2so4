// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  THE COVER'S BUDGET IS A TOKEN BUCKET, NOT A CONTEXT WINDOW
//
//  The cover ships the candidate's whole resume on EVERY question, and
//  it runs on Groq's llama-3.3-70b — a free tier metered per minute.
//  Measured against the live API on 2026-07-28:
//
//    x-ratelimit-limit-tokens: 12000     (per minute)
//    one cover request:        ~4,150 tok
//    => under three covers a minute, and then 429.
//
//  Two 429s showed up in a single twelve-question run, and a real
//  interview asks a question every twenty to forty seconds.
//
//  Most of that payload is the skills wall — a couple of thousand
//  characters of comma-separated tool names, of which a twenty-word
//  spoken opener needs the CATEGORY and none of the tail.
//
//  ⚠️ The thing these tests really guard is not the size. It is that
//  shrinking the context must NEVER cost an employer. That exact bug
//  shipped once: a 1,200-char cap sliced off every employer past the
//  skills list, and the app told an interviewer that the candidate's own
//  current employer "isn't a name that comes up in my experience". So
//  distillForCover is removal-only, inside two named sections, and it
//  verifies itself — and if the verification fails it declines to run.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.window = Object.assign(globalThis, { addEventListener() {}, removeEventListener() {} });
globalThis.__APP_VERSION__ = '0.0.0';
const { distillForCover, buildCoverContext } = await import('../../services/aiProxyService.ts');

// A resume in the shape a PDF actually extracts to: one long run with
// almost no newlines. That shape is not cosmetic — it is why the first
// version of this silently did nothing on every PDF in the corpus.
const SKILLS = [
  '●   Cloud Data Platform:   Data Factory, Synapse Analytics, Fabric, ADLS Gen2, Databricks, Event Hubs, Functions, AKS, Key Vault, DevOps, Monitor, IAM/RBAC, ARM and Terraform',
  '●   Programming & Query Languages:   Python (pandas, PySpark), SQL and PL/SQL, Spark SQL, C#/.NET, Java, Scala, TypeScript, Go, Rust, Bash; data structures, OOD, concurrency',
  '●   ETL/ELT & Orchestration:   Data Factory, Apache Airflow, Databricks, dbt, Spark, Flink, NiFi, Dagster, Prefect, Trino, Glue, Fivetran, Airbyte, CDC ingestion, backfills',
  '●   Streaming & Event Processing:   Event Hubs, Kafka, MSK, Kinesis, Redpanda, Debezium, backpressure, bounded retries, dead-letter queues, consumer-lag tuning, exactly-once',
].join('  ');

const EXPERIENCE = [
  'Data Engineer | Northwind Systems, Dallas, TX | April 2026 – Present (Contract)',
  '●   Own cloud lakehouse ETL across Data Factory, ADLS Gen2, and Delta at multi-million-row scale.',
  '●   Tune Spark and Trino execution plans, partitioning, and caching; cross-source latency down ~40%.',
  'Data Engineer – Research Assistant | Lakeside University, Indianapolis, IN, USA | January 2024 – December 2025',
  '●   Owned Airflow, Python, and SQL production ETL at 200K+ records/day; pipeline latency down 30%.',
  'Data Engineer | Corvid Hospitals, Hyderabad, Telangana, India | Sep 2022 – December 2023',
  '●   Owned Kafka and Python streaming ETL for clinical and operational events; 3M+ records/day.',
  'Data Engineer | Harbourline Health, Hyderabad, Telangana, India | June 2016 – August 2017',
  '●   Owned PostgreSQL batch pipelines processing 75K+ records daily; retrieval time down 50%.',
].join('  ');

const PROJECTS = [
  'Sentinel   —   Agentic Pipeline Triage | Elasticsearch, ES|QL, RAG, Python',
  '●   Built a tool-calling agent that answers natural-language questions over live pipeline logs and metrics, then names the probable root cause in seconds.',
  '●   Generated ranked reports with root cause, recommended fix, and execution priority, cutting incident resolution time by 45 minutes to 2 hours per case.',
  'Ferryman   —   Multi-Region Inventory Consistency | Aurora DSQL, PostgreSQL, TypeScript, IAM',
  '●   Built a dual-region write path with per-region connection pools, cross-region routing, and short-lived IAM tokens instead of static credentials.',
].join('  ');

const RESUME = `ALEX MORGAN  Data Engineer | Cloud Data Platform  alex@example.com |   5550001111 | Richardson, Texas   |   GitHub   |   LinkedIn  `
  + `PROFESSIONAL SUMMARY  Data engineer with 4+ years owning production pipelines end to end — ingestion, transformation, lakehouse modeling, and the serving layer.  `
  + `TECHNICAL SKILLS  ${SKILLS}  `
  + `PROFESSIONAL EXPERIENCE  ${EXPERIENCE}  `
  + `EDUCATION  Master of Science in Health Informatics | Lakeside University, Indianapolis, IN, USA | 2025  `
  + `PROJECTS  ${PROJECTS}`;

const EMPLOYERS = ['Northwind Systems', 'Lakeside University', 'Corvid Hospitals', 'Harbourline Health'];

describe('distillForCover — smaller, and provably not lossy', () => {
  const out = distillForCover(RESUME);

  it('actually shrinks a real resume', () => {
    expect(out.length).toBeLessThan(RESUME.length);
    // The skills wall and the achievement bullets are the two blocks a
    // twenty-word spoken opener cannot use.
    expect(1 - out.length / RESUME.length).toBeGreaterThan(0.12);
  });

  it('keeps EVERY employer — this is the whole correctness condition', () => {
    for (const e of EMPLOYERS) {
      expect(out, `${e} was dropped from the spoken opener's context`).toContain(e);
    }
  });

  it('keeps the dates, so "current employer" is still answerable', () => {
    expect(out).toContain('April 2026');
    expect(out).toContain('Present');
  });

  it('keeps the skills LABELS, which is what a platform question needs', () => {
    // "on what platforms did you work?" is answered from these labels,
    // not from the fortieth tool in the list.
    expect(out).toContain('Cloud Data Platform');
    expect(out).toContain('Streaming & Event Processing');
    expect(out).toContain('Data Factory');
  });

  it('drops the tail of the tool lists', () => {
    expect(RESUME).toContain('consumer-lag tuning');
    expect(out).not.toContain('consumer-lag tuning');
  });

  it('keeps project TITLES but not their achievement bullets', () => {
    expect(out).toContain('Sentinel');
    expect(out).toContain('Ferryman');
    expect(out).not.toContain('45 minutes to 2 hours per case');
  });

  it('leaves the summary and the header alone', () => {
    expect(out).toContain('ALEX MORGAN');
    expect(out).toContain('owning production pipelines end to end');
  });

  it('does nothing to a document with no skills or projects section', () => {
    const notes = 'Some interview notes about Kafka consumer groups and rebalancing. '.repeat(40);
    expect(distillForCover(notes)).toBe(notes);
  });

  it('does nothing to empty or junk input', () => {
    expect(distillForCover('')).toBe('');
    expect(distillForCover(null)).toBe('');
    expect(distillForCover('TECHNICAL SKILLS')).toBe('TECHNICAL SKILLS');
  });

  it('is idempotent — running it twice changes nothing further', () => {
    expect(distillForCover(out)).toBe(out);
  });

  it('declines rather than guesses: output is never LONGER than input', () => {
    expect(out.length).toBeLessThanOrEqual(RESUME.length);
  });
});

describe('the distillation reaches the cover context the routes send', () => {
  it('buildCoverContext returns the distilled resume, not the raw one', () => {
    const ctx = buildCoverContext([
      { id: '1', name: 'alex_resume.pdf', type: 'resume', content: RESUME },
    ]);
    expect(ctx).toBeTruthy();
    for (const e of EMPLOYERS) expect(ctx).toContain(e);
    expect(ctx).not.toContain('consumer-lag tuning');
    expect(ctx.length).toBeLessThan(RESUME.length);
  });
});

// Opportunistic: if the developer has exported real session files, run
// the same guarantees against them. Never committed — these are real
// people's resumes.
const FIXTURE = path.join(os.tmpdir(), 'real-session-files.json');
const real = fs.existsSync(FIXTURE) ? JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) : null;
describe.skipIf(!real)('against real uploaded documents', () => {
  it('never loses an employer on any of them', () => {
    const EMP = /[A-Za-z][^|\n●•]{2,60}\|[^|\n●•]{2,80}\|[^|\n●•]{0,40}(?:(?:19|20)\d{2}|Present|Current)/g;
    for (const f of real) {
      const src = f.content || '';
      if (src.length < 500) continue;
      const got = distillForCover(src);
      const companies = [...new Set((src.match(EMP) || []).map(x => x.split('|').slice(-2)[0].replace(/\s+/g, ' ').trim()))];
      for (const c of companies) {
        expect(got, `${c} vanished from ${f.name}`).toContain(c);
      }
    }
  });
});
