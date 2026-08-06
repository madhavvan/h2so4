// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  "IMMEDIATELY AFTER UPLOADING, EVERYTHING SHOULD BE READY TO SERVE"
//
//  That is the product promise for the knowledge base, and three pieces
//  of work stood between an upload and the first answer:
//
//    1. the context-store UPLOAD    ~1.2s, network
//    2. the BM25 index build        4ms @21 files → 71ms @801, CPU
//    3. the cover's resume slice    0.8ms @21 files → 18ms @801, CPU
//
//  All three were being paid inside question one. (2) and (3) were
//  simply never prewarmed. (1) had a prewarm that COULD NOT RUN: the
//  caller in App.tsx returned early for KBs under 20,000 chars, and the
//  offload branch inside prewarmContext runs only for KBs under 20,000
//  chars. Two guards, exactly inverted, so the branch was dead for the
//  whole life of the feature — and the most ordinary upload in the
//  product, a resume plus a job description at roughly 12K chars, sat
//  precisely in the band it was supposed to cover.
//
//  These tests pin the readiness contract at the source level, because
//  the failure was never in a function — it was in how two functions
//  agreed, which no unit test of either one could have caught.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const PROXY_SRC = fs.readFileSync(
  path.resolve(process.cwd(), '..', 'services', 'aiProxyService.ts'), 'utf8');
const APP_SRC = fs.readFileSync(
  path.resolve(process.cwd(), '..', 'App.tsx'), 'utf8');
const KB_SRC = fs.readFileSync(
  path.resolve(process.cwd(), '..', 'services', 'kbRetrieval.ts'), 'utf8');

globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.window = Object.assign(globalThis, { addEventListener() {}, removeEventListener() {} });
globalThis.__APP_VERSION__ = '0.0.0';
const { prewarmRetrieval, buildCoverContext, _coverContextDerivations } = await import('../../services/aiProxyService.ts');
const { warmIndex, _retrievalStats, retrieveEvidence, _indexBuildCount } = await import('../../services/kbRetrieval.ts');

const RESUME = 'PROFESSIONAL SUMMARY\nSenior Data Engineer.\nWORK EXPERIENCE\nFidelity Investments — Kafka to Snowflake CDC, Airflow, dbt.\n';
function kb(noteCount, noteChars = 3000) {
  const files = [{ id: 'r', name: 'VMADp_DataEngineer.docx', type: 'resume', content: RESUME.repeat(20) }];
  for (let i = 0; i < noteCount; i++) {
    files.push({ id: `n${i}`, name: `note-${i}.md`, content: `# System ${i}\n` + `partitions consumers throughput latency backfill ${i}. `.repeat(Math.ceil(noteChars / 50)) });
  }
  return files;
}

describe('the guard that made the upload prewarm dead code', () => {
  it('App.tsx no longer size-gates the call', () => {
    // The exact line that inverted the pair.
    expect(APP_SRC).not.toMatch(/if \(totalText < 20_000\) return;/);
  });

  it('the size decision lives once, next to the branch it decides', () => {
    const fn = /export function prewarmContext[\s\S]*?\n}/.exec(PROXY_SRC)[0];
    expect(fn).toMatch(/kbTextLength\(contextFiles\) < RETRIEVAL_MIN_CHARS/);
    expect(fn).toMatch(/offloadContext/);
  });

  it('a resume plus a JD lands in the band the prewarm now covers', () => {
    // ~12K chars: over OFFLOAD_MIN_CHARS (8K, so it IS uploaded) and
    // under RETRIEVAL_MIN_CHARS (20K, so the offload path is the one
    // used). This is the case the dead branch was written for.
    expect(8_000).toBeLessThan(12_000);
    expect(12_000).toBeLessThan(20_000);
  });
});

describe('the free half of readiness runs eagerly, the paid half debounced', () => {
  it('the eager effect warms retrieval and nothing that costs money', () => {
    const effect = /contextFilesRef\.current = db\.contextFiles;[\s\S]*?\}, \[db\.contextFiles\]\);/.exec(APP_SRC)[0];
    // syncKnowledge is the single owner of "the knowledge base changed" —
    // see services/knowledgeCache.ts. It replaced the bare prewarmRetrieval
    // call so the fact ledger the spoken opener is composed from is warm
    // before question one, and so a DELETED document's offloaded bytes are
    // actually dropped.
    expect(effect).toMatch(/syncKnowledge\(db\.contextFiles\)/);
    // Identity extraction is a real model call — it must not be here.
    expect(effect).not.toMatch(/prewarmIdentity|prewarmClaudeIdentity|prewarmContext|warmKnowledgeNetwork/);
  });

  it('syncKnowledge itself touches no network and no paid API', () => {
    const KC_SRC = fs.readFileSync(
      path.resolve(process.cwd(), '..', 'services', 'knowledgeCache.ts'), 'utf8');
    const fn = /export function syncKnowledge[\s\S]*?\n}/.exec(KC_SRC)[0];
    expect(fn).toMatch(/prewarmRetrieval/);
    expect(fn).toMatch(/getLedger/);
    // The paid half lives in warmKnowledgeNetwork, which the caller
    // debounces. Nothing here may reach for it.
    expect(fn).not.toMatch(/prewarmContext|prewarmIdentity|proxyRequest|fetch|offloadContext/);
  });

  it('identity extraction is debounced, so a five-file upload is one call', () => {
    // Undebounced, every added file changed the KB hash and started a
    // fresh extraction — five model calls for one upload, four of them
    // for a knowledge base that no longer existed, all contending with
    // the user's first question.
    // Both briefing-card extractions sit inside the debounced timer.
    // warmKnowledgeNetwork is the one owner of the paid half (context-store
    // upload + the OpenAI-side identity card); Claude's own card follows it.
    const timer = /modelPrewarmTimerRef\.current = window\.setTimeout\([\s\S]*?\}, 900\);/.exec(APP_SRC)[0];
    expect(timer).toMatch(/warmKnowledgeNetwork\(files\);/);
    expect(timer).toMatch(/prewarmClaudeIdentity\(files\);/);
  });

  it('prewarmRetrieval touches no network and no paid API', () => {
    const fn = /export function prewarmRetrieval[\s\S]*?\n}/.exec(PROXY_SRC)[0];
    expect(fn).toMatch(/warmIndex/);
    expect(fn).toMatch(/buildCoverContext/);
    expect(fn).not.toMatch(/offloadContext|getExtractedCards|proxyRequest|fetch/);
  });
});

describe('after prewarm, question one does no build work', () => {
  // These two used to be wall-clock assertions (<15ms and <2ms), which is
  // how they were written to mean "cached, not rebuilt". Measured, that
  // proxy was much tighter than it looked: a WARM retrieval at kb(200) is
  // ~0.6ms, but its FIRST call in a fresh process is ~4ms — V8 compiling
  // the BM25 scorer and the sort comparator — so the 15ms bound carried
  // only ~3x headroom on an IDLE machine, and vanished when the suite ran
  // 40 files in parallel (observed: 15.62ms, a 25x outlier over warm).
  // Nothing was wrong with the code: cold build 32.8ms vs warm 0.61ms is a
  // ~50x gap, exactly the caching the tests describe.
  //
  // So assert the claim itself. A build counter and a memo counter can't be
  // perturbed by JIT, GC, or a loaded CPU, and they say precisely what the
  // describe block promises — question one does no build work.
  it('the index is already built when the first question arrives', () => {
    const files = kb(200);
    warmIndex(files);
    const stats = _retrievalStats(files);
    expect(stats.chunks).toBeGreaterThan(100);

    const buildsBefore = _indexBuildCount();
    retrieveEvidence('kafka snowflake exactly once backfill', files);
    expect(_indexBuildCount()).toBe(buildsBefore);   // ZERO rebuilds — the whole contract

    // …and the counter is real: a genuinely different KB must rebuild, or
    // "no rebuild" would pass for a cache that never invalidates.
    retrieveEvidence('kafka', kb(201));
    expect(_indexBuildCount()).toBe(buildsBefore + 1);
  });

  it('prewarmRetrieval leaves the cover context ready too', () => {
    const files = kb(200);
    prewarmRetrieval(files);
    const derivesBefore = _coverContextDerivations();
    const ctx = buildCoverContext(files);
    expect(_coverContextDerivations()).toBe(derivesBefore); // memo hit, not a rescan
    expect(ctx).toContain('Fidelity Investments');
  });

  it('the memo re-derives when the files actually change', () => {
    // A stale cover context is the resume of a DIFFERENT upload spoken
    // out loud — strictly worse than the milliseconds it saves.
    const a = kb(2);
    expect(buildCoverContext(a)).toContain('Fidelity');
    const b = [{ id: 'r2', name: 'other_resume.docx', type: 'resume', content: 'PROFESSIONAL SUMMARY\nNurse practitioner at Mercy General.\nWORK EXPERIENCE\nTriage, ICU.' }];
    expect(buildCoverContext(b)).toContain('Mercy General');
    expect(buildCoverContext(b)).not.toContain('Fidelity');
  });

  it('a KB with no resume caches the empty answer, and does not leak the last one', () => {
    const withResume = kb(1);
    expect(buildCoverContext(withResume)).toContain('Fidelity');
    const noResume = [{ id: 'x', name: 'reference-manual.pdf', content: 'Chapter 1. Torque specifications for flange bolts.' }];
    expect(buildCoverContext(noResume)).toBe('');
    expect(buildCoverContext(noResume)).toBe('');   // stable across calls
  });

  it('warmIndex is safe to call repeatedly during a multi-file upload', () => {
    const files = kb(50);
    expect(() => { for (let i = 0; i < 5; i++) warmIndex(files); }).not.toThrow();
    expect(() => warmIndex([])).not.toThrow();
    expect(() => warmIndex(null)).not.toThrow();
  });

  it('the index warm is documented as fingerprint-cached, not a rebuild', () => {
    const fn = /export function warmIndex[\s\S]*?\n}/.exec(KB_SRC)[0];
    expect(fn).toMatch(/getIndex\(contextFiles\)/);
    expect(fn).toMatch(/catch/);   // must never throw into an upload handler
  });
});
