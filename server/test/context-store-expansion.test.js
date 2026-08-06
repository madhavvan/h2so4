// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  contextStore — the expansion cap (crown-jewels H3)
//
//  Placeholder substitution is the one place a small request body legally
//  becomes a large one, and it runs as router-level middleware in
//  routes/ai.js registered AHEAD of requireTier / requireTimeRemaining /
//  requireActiveSession — so a free, trial-exhausted account reaches it.
//  Measured against the uncapped code: a 74-byte token pointing at a 2 MB
//  entry is 28,340x, and 250 of them in an 18.1 KB body allocated a 500 MB
//  string in 334 ms. That is an OOM kill of the process, which drops every
//  concurrent live interview on the instance, not just the abuser's.
//
//  What must hold:
//    1. the expansion is PRICED before it is performed — refusal must not
//       allocate the string it is refusing
//    2. the budget is shared across a messages array, or 250 messages of
//       one placeholder each walks straight past a per-string cap
//    3. the refusal is distinguishable from CONTEXT_MISSING — a miss tells
//       the client to resend the text INLINE, which is the last thing this
//       request should be told to do
//    4. real traffic (one placeholder, a sub-20K-char KB) is untouched,
//       byte-for-byte, because that identity is what keeps provider
//       prompt caches hitting
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const store = require('../src/services/contextStore.js');

// A realistic offloaded blob: the renderer only offloads below
// RETRIEVAL_MIN_CHARS (20K chars), so this is the shape of real traffic.
const KB = 'resume line about kafka and spark. '.repeat(500);
const tok = h => `⟪CTX:${h}⟫`;

beforeEach(() => store._test._reset());

describe('expansion cap', () => {
  it('refuses a body that would expand past the byte budget — without building it', () => {
    // 512 KB entry × 9 references = 4.5 MB > the 4 MB ceiling.
    const blob = 'x'.repeat(512 * 1024);
    const { hash } = store.put('u1', blob);
    const body = `answer this: ${tok(hash).repeat(9)}`;
    // The refusal is cheap because it happens before .replace(): the input
    // is ~700 bytes and no 4.5 MB string is ever materialised.
    expect(body.length).toBeLessThan(1000);
    expect(() => store.resolveText('u1', body)).toThrowError(/context_too_large/);
  });

  it('refuses on match count alone, even when every hash is bogus', () => {
    // Unresolvable hashes cost 0 bytes, so only the count cap stands
    // between us and an unbounded callback loop.
    const body = Array.from({ length: 40 }, (_, i) =>
      tok(String(i).padStart(64, 'a'))).join(' ');
    expect(() => store.resolveText('u1', body)).toThrowError(/placeholders:/);
  });

  it('the budget spans the whole messages array, not each string', () => {
    // THE REGRESSION THIS EXISTS FOR: a per-string cap is defeated by
    // spreading the same total expansion over more messages.
    const blob = 'x'.repeat(512 * 1024);
    const { hash } = store.put('u1', blob);
    const msgs = Array.from({ length: 30 }, (_, i) => ({ role: 'user', content: `q${i} ${tok(hash)}` }));
    expect(() => store.resolveMessages('u1', msgs)).toThrowError(/context_too_large/);
  });

  it('counts text parts inside one multimodal message too', () => {
    const blob = 'x'.repeat(512 * 1024);
    const { hash } = store.put('u1', blob);
    const parts = Array.from({ length: 30 }, () => ({ type: 'text', text: tok(hash) }));
    expect(() => store.resolveMessages('u1', [{ role: 'user', content: parts }]))
      .toThrowError(/context_too_large/);
  });

  it('carries a 413-shaped, non-retryable code — NOT context_missing', () => {
    const body = Array.from({ length: 40 }, () => tok('a'.repeat(64))).join(' ');
    try {
      store.resolveText('u1', body);
      throw new Error('should have refused');
    } catch (e) {
      // A CONTEXT_MISSING here would make the client re-send the payload
      // inline — bigger — which is worse than the request we just refused.
      expect(e.code).toBe('CONTEXT_TOO_LARGE');
      expect(e.status).toBe(413);
      expect(e.statusCode).toBe(413);
    }
  });

  it('a throw leaves the shared /g regex with a clean lastIndex', () => {
    // PLACEHOLDER_RE is module-level and global-flagged; escaping mid-scan
    // with a stale lastIndex would silently corrupt the NEXT request.
    const { hash } = store.put('u1', KB);
    const many = Array.from({ length: 40 }, () => tok(hash)).join(' ');
    expect(() => store.resolveText('u1', many)).toThrow();
    expect(store.hasPlaceholder(`x ${tok(hash)}`)).toBe(true);
    expect(store.resolveText('u1', tok(hash))).toBe(KB);
  });
});

describe('real traffic is untouched', () => {
  it('the one-placeholder shape the renderer actually sends still rebuilds byte-identically', () => {
    const { hash } = store.put('u1', KB);
    const inlined = `SYSTEM PROMPT\n\nKNOWLEDGE BASE:\n${KB}\n\nRULES`;
    expect(store.resolveText('u1', `SYSTEM PROMPT\n\nKNOWLEDGE BASE:\n${tok(hash)}\n\nRULES`)).toBe(inlined);
  });

  it('16x the observed shape still passes, with byte headroom to spare', () => {
    const { hash } = store.put('u1', KB);
    const cap = store._test.MAX_PLACEHOLDERS;
    const body = Array.from({ length: cap }, (_, i) => `part ${i} ${tok(hash)}`).join('\n');
    const out = store.resolveText('u1', body);
    // 16 × ~17 KB ≈ 0.27 MB — about 15x under the byte ceiling, so real
    // usage is never near either bound.
    expect(out).not.toContain('⟪CTX:');
    expect(Buffer.byteLength(out)).toBeLessThan(store._test.MAX_RESOLVED_BYTES);
  });

  it('a peek for pricing does not disturb LRU recency or expire an entry', () => {
    // The pricing pass must not use get(): get() re-inserts and TTL-evicts,
    // so merely quoting a request would reorder the store.
    const { hash } = store.put('u1', KB);
    const before = store.stats().entries;
    expect(() => store.resolveText('u1', tok(hash).repeat(40))).toThrow();
    expect(store.stats().entries).toBe(before);
    expect(store.get('u1', hash)).toBe(KB);
  });

  it('a miss still raises CONTEXT_MISSING so the 409 retry path survives', () => {
    const bogus = 'b'.repeat(64);
    try {
      store.resolveText('u1', `KB: ${tok(bogus)}`);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e.code).toBe('CONTEXT_MISSING');
    }
  });
});
