// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  kbRetrieval — pin the cost-saving retrieval contract
//
//  This engine is what stops a 100-file session from shipping ~100K
//  tokens per question: instead of dumping the whole KB, it returns only
//  the BM25-relevant passages for the current question. The properties
//  that MUST hold:
//    1. a question about topic X retrieves the passage containing X (not
//       some unrelated file) — grounding is preserved
//    2. the evidence stays within the char budget no matter how big the
//       KB is (this is the cost guarantee)
//    3. empty/whitespace KB → '' (no crash, nothing to send)
//    4. kbTextLength counts only text (not base64) — drives the adaptive
//       full-vs-retrieve threshold
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { describe, it, expect } from 'vitest';
import { retrieveEvidence, kbTextLength, RETRIEVAL_CHAR_BUDGET, _retrievalStats } from '../../services/kbRetrieval.ts';

// A realistic large KB: a resume with a UNIQUE planted fact, plus many
// filler note files (the 100-file stress case in miniature).
function bigKb() {
  const files = [
    { id: 'resume', name: 'resume.md', type: 'resume', content:
      'Senior Data Engineer.\n\nAt Meridian Health I migrated a 41-billion-row PostgreSQL fleet onto Aurora, cutting p99 from 820ms to 90ms.\n\n' +
      'Built a Kafka to Iceberg CDC pipeline processing 3.2 million events per minute with exactly-once semantics.\n\n' +
      'Earlier at Northwind Labs I owned Airflow orchestration and cut nightly batch cost 38 percent using spot instances.' },
    { id: 'jd', name: 'jd.md', type: 'jd', content:
      'Payments platform role. Wants streaming, exactly-once, CDC, lakehouse, Kubernetes, cost optimization.' },
  ];
  for (let i = 1; i <= 60; i++) {
    files.push({ id: 'f' + i, name: 'note_' + i + '.md', type: 'custom', content:
      `Design note ${i}. Generic content about partitioning, retries, dedupe keys, backfill strategy, and SLO budgets for service ${i}. `.repeat(30) });
  }
  return files;
}

describe('kbTextLength', () => {
  it('counts text content only, skips base64', () => {
    const files = [
      { id: 'a', name: 'a.md', type: 'custom', content: 'x'.repeat(100) },
      { id: 'b', name: 'b.png', type: 'custom', content: '[Binary File]', base64: 'AAAA' },
    ];
    expect(kbTextLength(files)).toBe(100);
  });
});

describe('retrieveEvidence — grounding', () => {
  const kb = bigKb();

  it('a question about the migration retrieves the exact planted fact', () => {
    const ev = retrieveEvidence('Tell me about your biggest database migration', kb);
    expect(ev).toMatch(/41-billion-row|Aurora|Meridian|820ms/);
  });

  it('a Kafka/streaming question retrieves the CDC pipeline passage', () => {
    const ev = retrieveEvidence('How did you build your streaming pipeline with Kafka?', kb);
    expect(ev).toMatch(/Kafka|Iceberg|CDC|exactly-once|3\.2 million/);
  });

  it('a cost question retrieves the Northwind cost passage', () => {
    const ev = retrieveEvidence('Tell me about a time you reduced cost', kb);
    expect(ev).toMatch(/Northwind|38 percent|batch cost|spot/);
  });

  it('tags each passage with its source file', () => {
    const ev = retrieveEvidence('Aurora migration', kb);
    expect(ev).toMatch(/\[from resume\.md\]/);
  });
});

describe('retrieveEvidence — cost guarantee', () => {
  it('never exceeds the char budget no matter how big the KB is', () => {
    const kb = bigKb(); // ~110K+ chars across 62 files
    expect(kbTextLength(kb)).toBeGreaterThan(100_000);
    const ev = retrieveEvidence('exactly-once streaming pipeline design', kb);
    // Evidence is a tiny fraction of the KB — the whole point.
    expect(ev.length).toBeLessThanOrEqual(RETRIEVAL_CHAR_BUDGET + 800); // + source tags
    expect(ev.length).toBeLessThan(kbTextLength(kb) / 8);
  });

  it('a 200-file KB retrieves the same tiny evidence size as a small one', () => {
    const files = [];
    for (let i = 1; i <= 200; i++) {
      files.push({ id: 'f' + i, name: 'n' + i + '.md', type: 'custom',
        content: `Notes on service ${i} covering ingestion and retries. `.repeat(40) });
    }
    files.push({ id: 'r', name: 'resume.md', type: 'resume',
      content: 'I specialize in Snowflake warehouse cost tuning and clustering keys.' });
    const ev = retrieveEvidence('snowflake cost tuning', files);
    expect(ev).toMatch(/Snowflake/);
    expect(ev.length).toBeLessThanOrEqual(RETRIEVAL_CHAR_BUDGET + 800);
  });
});

describe('retrieveEvidence — edge cases', () => {
  it('empty KB → empty string', () => {
    expect(retrieveEvidence('anything', [])).toBe('');
    expect(retrieveEvidence('anything', [{ id: 'x', name: 'x', type: 'custom', content: '   ' }])).toBe('');
  });

  it('a query with only stopwords still returns something (fallback)', () => {
    const kb = [{ id: 'r', name: 'r.md', type: 'resume', content: 'Kafka and Spark experience at scale. '.repeat(50) }];
    const ev = retrieveEvidence('and the of to', kb);
    expect(ev.length).toBeGreaterThan(0);
  });

  it('chunking produces multiple passages for a large file', () => {
    const kb = [{ id: 'r', name: 'r.md', type: 'resume', content: 'sentence about data engineering. '.repeat(200) }];
    const stats = _retrievalStats(kb);
    expect(stats.chunks).toBeGreaterThan(5);
  });
});
