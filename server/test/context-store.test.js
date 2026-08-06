// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  contextStore — pin the upload-once knowledge-base contract
//
//  This store is what keeps request bodies ~4KB instead of ~400KB when a
//  user attaches 100 files. The properties that MUST hold:
//    1. round-trip: put → get returns the exact text
//    2. per-user isolation — a hash from user A must never read back
//       under user B (it holds their resume)
//    3. integrity — a claimed hash that doesn't match the bytes is
//       rejected, so a bad client can't poison an entry
//    4. substitution rebuilds the prompt byte-identically (this is what
//       preserves provider prompt-cache hits)
//    5. a miss raises CONTEXT_MISSING so the route can 409 and the client
//       can re-upload + retry, instead of shipping a literal ⟪CTX:…⟫
//       to the model
//    6. bounded — eviction keeps the entry count under the cap
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const store = require('../src/services/contextStore.js');

const BIG = 'resume line about kafka and spark. '.repeat(500);

beforeEach(() => store._test._reset());

describe('put / get round-trip', () => {
  it('stores and returns the exact text', () => {
    const r = store.put('u1', BIG);
    expect(r.ok).toBe(true);
    expect(r.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(store.get('u1', r.hash)).toBe(BIG);
  });

  it('same bytes dedupe to the same hash', () => {
    const a = store.put('u1', BIG);
    const b = store.put('u1', BIG);
    expect(b.hash).toBe(a.hash);
    expect(b.deduped).toBe(true);
    expect(store.stats().entries).toBe(1);
  });

  it('rejects empty text and missing user', () => {
    expect(store.put('u1', '').ok).toBe(false);
    expect(store.put(null, BIG).ok).toBe(false);
  });
});

describe('security', () => {
  it('another user cannot read the blob by hash', () => {
    const { hash } = store.put('u1', BIG);
    expect(store.get('u2', hash)).toBeNull();
    expect(store.get('u1', hash)).toBe(BIG);
  });

  it('rejects a claimed hash that does not match the bytes', () => {
    const r = store.put('u1', BIG, 'f'.repeat(64));
    expect(r.ok).toBe(false);
    expect(r.error).toBe('hash_mismatch');
  });

  it('accepts a correct claimed hash', () => {
    const real = store.sha256(BIG);
    expect(store.put('u1', BIG, real).ok).toBe(true);
  });
});

describe('placeholder substitution', () => {
  it('rebuilds the prompt byte-identically (prompt-cache safety)', () => {
    const { hash } = store.put('u1', BIG);
    const inlined = `SYSTEM PROMPT\n\nKNOWLEDGE BASE:\n${BIG}\n\nRULES`;
    const withPlaceholder = `SYSTEM PROMPT\n\nKNOWLEDGE BASE:\n⟪CTX:${hash}⟫\n\nRULES`;
    expect(store.resolveText('u1', withPlaceholder)).toBe(inlined);
  });

  it('leaves text without a placeholder untouched (same reference)', () => {
    const plain = 'no placeholder here';
    expect(store.resolveText('u1', plain)).toBe(plain);
  });

  it('resolves inside a messages array — string and multimodal parts', () => {
    const { hash } = store.put('u1', BIG);
    const msgs = [
      { role: 'system', content: `KB: ⟪CTX:${hash}⟫` },
      { role: 'user', content: [{ type: 'text', text: `also ⟪CTX:${hash}⟫` }, { type: 'image_url', image_url: { url: 'x' } }] },
    ];
    const out = store.resolveMessages('u1', msgs);
    expect(out[0].content).toBe(`KB: ${BIG}`);
    expect(out[1].content[0].text).toBe(`also ${BIG}`);
    expect(out[1].content[1]).toEqual({ type: 'image_url', image_url: { url: 'x' } });
    // original untouched
    expect(msgs[0].content).toContain('⟪CTX:');
  });

  it('a miss raises CONTEXT_MISSING (never leaks the raw placeholder)', () => {
    const bogus = 'a'.repeat(64);
    expect(() => store.resolveText('u1', `KB: ⟪CTX:${bogus}⟫`)).toThrowError(/context_missing/);
    try { store.resolveText('u1', `KB: ⟪CTX:${bogus}⟫`); }
    catch (e) { expect(e.code).toBe('CONTEXT_MISSING'); }
  });

  it('an evicted-for-another-user hash also raises rather than resolving', () => {
    const { hash } = store.put('u1', BIG);
    expect(() => store.resolveText('u2', `⟪CTX:${hash}⟫`)).toThrowError(/context_missing/);
  });
});

describe('bounds', () => {
  it('a single user is capped at their own entry budget', () => {
    store._test._reset();
    const cap = store._test.MAX_ENTRIES_PER_USER;
    for (let i = 0; i < cap + 20; i++) store.put('u1', `blob-${i}-` + 'x'.repeat(100));
    expect(store.stats().entries).toBeLessThanOrEqual(cap);
  });

  it('refuses an absurdly large blob', () => {
    const huge = 'x'.repeat(store._test.MAX_TEXT_BYTES + 10);
    expect(store.put('u1', huge)).toEqual({ ok: false, error: 'text_too_large' });
  });

  // ── THE REGRESSION THAT WOULD HAVE BITTEN AT SCALE ──
  // The entry cap used to be GLOBAL: 96 entries across every user. With 300
  // users uploading once each, 204 were evicted and 68% of them got a 409
  // on their next question — while the 96MB byte budget sat 0.95% used. A
  // user must only ever be evicted by their own newer uploads.
  it('one user is NEVER evicted because other users are busy', () => {
    store._test._reset();
    const N = 500;
    const hashes = [];
    for (let u = 0; u < N; u++) {
      const r = store.put(`user${u}`, `resume of user ${u} ` + 'x'.repeat(3000));
      hashes.push(r.hash);
    }
    let resolvable = 0;
    for (let u = 0; u < N; u++) if (store.get(`user${u}`, hashes[u]) !== null) resolvable++;
    expect(resolvable, `${N - resolvable} of ${N} users would 409`).toBe(N);
    expect(store.stats().users).toBe(N);
  });

  it('a user evicts only their OWN oldest entry once past the per-user cap', () => {
    store._test._reset();
    const cap = store._test.MAX_ENTRIES_PER_USER;
    const mine = [];
    for (let i = 0; i <= cap; i++) mine.push(store.put('mine', `doc ${i} ` + 'y'.repeat(200)).hash);
    const other = store.put('other', 'someone else entirely').hash;
    // My oldest is gone, my newest survives, and the stranger is untouched.
    expect(store.get('mine', mine[0])).toBeNull();
    expect(store.get('mine', mine[cap])).not.toBeNull();
    expect(store.get('other', other)).not.toBeNull();
  });

  it('forgetUser drops exactly that user and nothing else', () => {
    store._test._reset();
    const a = store.put('a', 'alpha document').hash;
    const b = store.put('b', 'beta document').hash;
    expect(store.forgetUser('a')).toBe(1);
    expect(store.get('a', a)).toBeNull();
    expect(store.get('b', b)).toBe('beta document');
    expect(store.forgetUser('nobody')).toBe(0);
    expect(store.forgetUser(null)).toBe(0);
  });

  it('per-user accounting does not drift', () => {
    store._test._reset();
    for (let i = 0; i < 3; i++) store.put('u', `d${i}`);
    expect(store.stats().users).toBe(1);
    store.forgetUser('u');
    expect(store.stats().users).toBe(0);
    expect(store.stats().entries).toBe(0);
    expect(store.stats().totalBytes).toBe(0);
  });
});
