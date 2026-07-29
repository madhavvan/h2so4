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
  it('evicts so the entry count never exceeds the cap', () => {
    const cap = store._test.MAX_ENTRIES;
    for (let i = 0; i < cap + 20; i++) store.put('u1', `blob-${i}-` + 'x'.repeat(100));
    expect(store.stats().entries).toBeLessThanOrEqual(cap);
  });

  it('refuses an absurdly large blob', () => {
    const huge = 'x'.repeat(store._test.MAX_TEXT_BYTES + 10);
    expect(store.put('u1', huge)).toEqual({ ok: false, error: 'text_too_large' });
  });
});
