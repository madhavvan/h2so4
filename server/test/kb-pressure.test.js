// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  WHAT A BIG KNOWLEDGE BASE COSTS PER QUESTION
//
//  kbRetrieval.ts claims "a 200-file KB costs the same per question as a
//  1-file KB". That is the whole defence against a large upload turning
//  every answer into a 100K-token bill, so it is measured here rather
//  than trusted — using the REAL retrieval the app runs, over a KB shaped
//  like a real one (a resume, a JD, and a pile of notes).
//
//  Pure and offline: no API calls, no cost to run.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { describe, it, expect } from 'vitest';
import { retrieveEvidence, kbTextLength, RETRIEVAL_MIN_CHARS, RETRIEVAL_CHAR_BUDGET }
  from '../../services/kbRetrieval.ts';

const RESUME = `ALEX MORGAN — Senior Data Engineer
Fidelity Investments (2023-2026) — built a Kafka to Snowflake pipeline moving 40M events/day.
Optum (2021-2023) — Airflow DAGs, dbt models, HIPAA-scoped PHI handling.
Skills: Python, Spark, Snowflake, Kafka, Airflow, dbt, AWS, Terraform.`;
const JD = `Staff Data Engineer, streaming platform. Kafka, Flink, exactly-once, schema registry, backfills.`;
const TOPICS = ['kafka', 'spark', 'airflow', 'snowflake', 'dbt', 'terraform', 'flink', 'kubernetes', 'postgres', 'redis'];
const QUESTION = 'How would you design an exactly-once Kafka to Snowflake pipeline with backfills?';

const note = (i) => ({
  id: `n${i}`, name: `notes-${TOPICS[i % TOPICS.length]}-${i}.md`, type: 'custom',
  content: [`# ${TOPICS[i % TOPICS.length]} notes ${i}`,
    ...Array.from({ length: 40 }, (_, k) =>
      `Line ${k}: ${TOPICS[i % TOPICS.length]} detail on partitions, consumers, retries, throughput ${i * 40 + k}.`)].join('\n'),
});
const base = [
  { id: 'r', name: 'VMADp_Resume.pdf', type: 'resume', content: RESUME },
  { id: 'j', name: 'job-description.txt', type: 'jd', content: JD },
];
const kbOf = (n) => [...base, ...Array.from({ length: n }, (_, i) => note(i))];

// Mirrors assembleEvidence's large-KB branch: identity always, bulk by
// retrieval. (assembleEvidence itself pulls in Electron-only deps.)
function sentToModel(files) {
  const total = kbTextLength(files);
  if (total < RETRIEVAL_MIN_CHARS) return total;
  const identity = files.filter(f => /resume|cv|job|jd/i.test(f.name));
  const bulk = files.filter(f => !identity.includes(f));
  return identity.map(f => f.content).join('\n\n').length
    + (bulk.length ? retrieveEvidence(QUESTION, bulk).length : 0);
}

describe('a big knowledge base does not mean a big bill', () => {
  it('sends a small KB whole — retrieval would only make it worse', () => {
    const files = kbOf(1);
    expect(kbTextLength(files)).toBeLessThan(RETRIEVAL_MIN_CHARS);
    expect(sentToModel(files)).toBe(kbTextLength(files));
  });

  it('stops growing once the KB is large', () => {
    const at200 = sentToModel(kbOf(200));
    const at400 = sentToModel(kbOf(400));
    // Doubling the upload must not meaningfully move the per-question
    // payload. This is the property that keeps the bill flat.
    expect(at400).toBeLessThan(at200 * 1.15);
  });

  it('keeps 200 files inside the evidence budget', () => {
    const files = kbOf(200);
    const kb = kbTextLength(files);
    const sent = sentToModel(files);
    expect(kb).toBeGreaterThan(500_000);          // genuinely large
    // Identity block + retrieved passages, nothing else.
    expect(sent).toBeLessThan(RETRIEVAL_CHAR_BUDGET + 4_000);
    // And that is a rounding error against the raw KB.
    expect(sent / kb).toBeLessThan(0.03);
  });

  it('still finds the passages the question is about', () => {
    // Cheap is worthless if it drops the relevant material. The question
    // is about Kafka and Snowflake; the evidence must contain both.
    const bulk = kbOf(200).filter(f => !/resume|job/i.test(f.name));
    const ev = retrieveEvidence(QUESTION, bulk).toLowerCase();
    expect(ev).toContain('kafka');
    expect(ev).toContain('snowflake');
  });

  it('retrieves fast enough to sit on the answer path', () => {
    const bulk = kbOf(200).filter(f => !/resume|job/i.test(f.name));
    const t0 = Date.now();
    retrieveEvidence(QUESTION, bulk);
    // Runs before every question; tens of ms is fine, seconds is not.
    expect(Date.now() - t0).toBeLessThan(400);
  });
});
