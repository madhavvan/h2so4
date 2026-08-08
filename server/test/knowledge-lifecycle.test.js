// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  THE CACHE IS ONLY AS GOOD AS ITS ERASURE
//
//  Six separate caches hold the text of the uploaded knowledge base — the
//  fact ledger, the BM25 index, the cover slice, two briefing cards and the
//  offloaded blobs. All six are keyed by a fingerprint of the files, so all
//  six are CORRECT when the files CHANGE. None of them had any way to be
//  EMPTIED, which is a different requirement and the one that matters for a
//  product where the documents are somebody's employment history:
//
//    · delete a file and its text stayed resident, and a single server-side
//      eviction re-uploaded the deleted document
//    · start a new conversation and the previous one's resume was still
//      the knowledge base in memory
//    · sign out and it was still there for the next account on the machine
//
//  services/knowledgeCache.ts is the one owner of both events. These tests
//  pin the wiring at every point the lifecycle is actually triggered from,
//  because the failure mode here is silent by construction: a stale cache
//  answers questions perfectly well, just about the wrong person.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const read = (...p) => fs.readFileSync(path.resolve(process.cwd(), '..', ...p), 'utf8');
const KC_SRC = read('services', 'knowledgeCache.ts');
const APP_SRC = read('App.tsx');
const DB_SRC = read('hooks', 'useDatabase.ts');
const CTX_SRC = read('services', 'contextStore.ts');

globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.window = Object.assign(globalThis, { addEventListener() {}, removeEventListener() {} });
globalThis.__APP_VERSION__ = '0.0.0';

const { buildLedger, getLedgerFor, resetLedger, _ledgerBuilds } =
  await import('../../services/factLedger.ts');

const fileOf = (id, content) => ({ id, name: `${id}.docx`, type: 'custom', content });
const RESUME_A = 'EXPERIENCE\n\nKestrelby Pharma, PA\t\t\tApr 2023 - Present Data Engineer\n\nOwned Kafka pipelines.';
const RESUME_B = 'EXPERIENCE\n\nNorthgate Labs, IN\t\t\tMay 2018 – Apr 2020 Quality Engineer\n\nRan investigations.';

describe('the ledger is rebuilt exactly when the files change, and not otherwise', () => {
  it('a repeated question is a memo hit — answer-time is free', () => {
    resetLedger();
    const files = [fileOf('a', RESUME_A)];
    const before = _ledgerBuilds();
    for (let i = 0; i < 50; i++) getLedgerFor(files);
    expect(_ledgerBuilds() - before, 'one build for fifty questions').toBe(1);
  });

  it('adding a file rebuilds it, and the new employer is immediately present', () => {
    resetLedger();
    const first = getLedgerFor([fileOf('a', RESUME_A)]);
    expect(first.employers.map((e) => e.subject)).toEqual(['Kestrelby Pharma']);
    const second = getLedgerFor([fileOf('a', RESUME_A), fileOf('b', RESUME_B)]);
    expect(second.employers.map((e) => e.subject).sort())
      .toEqual(['Kestrelby Pharma', 'Northgate Labs']);
  });

  it('REMOVING a file removes its facts — the deleted résumé stops answering', () => {
    resetLedger();
    getLedgerFor([fileOf('a', RESUME_A), fileOf('b', RESUME_B)]);
    const after = getLedgerFor([fileOf('a', RESUME_A)]);
    expect(after.employers.map((e) => e.subject)).toEqual(['Kestrelby Pharma']);
    expect(after.vocabulary.has('northgate')).toBe(false);
    expect(after.haystack).not.toMatch(/northgate/i);
  });

  it('resetLedger empties it — a new conversation starts with no knowledge base', () => {
    resetLedger();
    getLedgerFor([fileOf('a', RESUME_A)]);
    resetLedger();
    const builds = _ledgerBuilds();
    const again = getLedgerFor([fileOf('a', RESUME_A)]);
    expect(_ledgerBuilds(), 'must rebuild, not serve the emptied memo').toBe(builds + 1);
    expect(again.employers.length).toBe(1);
    // …and an empty file list is the empty ledger, never the last one.
    expect(getLedgerFor([]).charCount).toBe(0);
    expect(buildLedger([]).employers).toEqual([]);
  });
});

describe('forgetKnowledge reaches every cache that holds a document', () => {
  const fn = /export function forgetKnowledge[\s\S]*?\n}/.exec(KC_SRC)[0];

  it('empties all six, and nothing may throw on the way', () => {
    for (const owner of ['resetLedger', 'resetIndex', 'resetCoverContext', 'resetIdentityCache', 'forgetAll']) {
      expect(fn, `forgetKnowledge does not clear ${owner}`).toMatch(new RegExp(`${owner}\\(\\)`));
    }
    // The sixth lives in claudeService, which cannot be imported here
    // without closing a cycle, so it registers itself instead.
    expect(fn).toMatch(/for \(const hook of hooks\)/);
    expect(read('services', 'claudeService.ts')).toMatch(/registerForgetHook/);
    // Every call is individually guarded: a cache that refuses to clear must
    // not stop the other five from clearing.
    expect((fn.match(/catch \{/g) || []).length).toBeGreaterThanOrEqual(5);
  });

  it('is reached by an emptied file list — new chat and last-file-deleted', () => {
    // useDatabase.newSession and clearSession both set contextFiles to [],
    // which drives the syncKnowledge effect, which forgets.
    expect(DB_SRC).toMatch(/const newSession = useCallback[\s\S]*?setContextFiles\(\[\]\);/);
    expect(DB_SRC).toMatch(/const clearSession = useCallback[\s\S]*?setContextFiles\(\[\]\);/);
    const sync = /export function syncKnowledge[\s\S]*?\n}/.exec(KC_SRC)[0];
    expect(sync).toMatch(/if \(list\.length === 0\) \{\s*\n\s*forgetKnowledge\(\);/);
  });

  it('is reached by SIGN-OUT, which does not change the file list at all', () => {
    // The caches are module-level singletons and outlive the component, so
    // signing out has to say so itself. Otherwise the next account on this
    // machine starts with the previous one's resume still resident.
    const logout = /const handleLogout = \(\) => \{[\s\S]*?\n  \};/.exec(APP_SRC)[0];
    expect(logout).toMatch(/forgetKnowledge\(\);/);
    expect(logout.indexOf('forgetKnowledge'), 'forget before the session is torn down')
      .toBeLessThan(logout.indexOf('licenseService.logout'));
  });

  it('tells the SERVER to drop the blobs too, not just this renderer', () => {
    const forgetAll = /export function forgetAll[\s\S]*?\n}/.exec(CTX_SRC)[0];
    expect(forgetAll).toMatch(/uploaded\.clear\(\)/);
    expect(forgetAll).toMatch(/hashToText\.clear\(\)/);
    expect(forgetAll).toMatch(/tellServerToForget\(\)/);
    // keepalive, because sign-out navigates the renderer away mid-request.
    expect(CTX_SRC).toMatch(/keepalive: true/);
    expect(read('server', 'src', 'routes', 'ai.js')).toMatch(/router\.post\('\/context\/forget'/);
  });

  it('a still-attached document survives — forgetting is not indiscriminate', () => {
    const sync = /export function syncKnowledge[\s\S]*?\n}/.exec(KC_SRC)[0];
    // forgetExcept keeps the blobs for the files that are STILL attached and
    // drops every other document's bytes. Passing nothing here would re-upload
    // deleted documents on the next server eviction.
    expect(sync).toMatch(/forgetExcept\(/);
    const forgetExcept = /export function forgetExcept[\s\S]*?\n}/.exec(CTX_SRC)[0];
    expect(forgetExcept).toMatch(/keepKeys/);
    expect(forgetExcept).toMatch(/hashToText\.delete/);
  });
});

describe('what upload actually costs, since it runs on the UI thread', () => {
  it('a four-file knowledge base is ready in a time the upload absorbs', () => {
    const files = Array.from({ length: 4 }, (_, i) => fileOf(`f${i}`, `${RESUME_A}\n${RESUME_B}`));
    const t0 = process.hrtime.bigint();
    const l = buildLedger(files);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    console.log(`   4 files -> ${l.facts.length} facts in ${ms.toFixed(1)}ms`);
    expect(ms).toBeLessThan(250);
  });

  it('and every question after it is a memo hit, not a rebuild', () => {
    resetLedger();
    const files = [fileOf('a', RESUME_A)];
    getLedgerFor(files);
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 1000; i++) getLedgerFor(files);
    const us = Number(process.hrtime.bigint() - t0) / 1000 / 1000;
    console.log(`   ${us.toFixed(2)}us per answer-time lookup`);
    expect(us).toBeLessThan(50);
  });
});
