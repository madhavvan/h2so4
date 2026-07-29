// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  CONTEXT STORE — content-addressed knowledge-base cache
//
//  Why this exists: the renderer used to embed the ENTIRE uploaded
//  knowledge base (up to 400K chars — resumes, JDs, 100 notes files)
//  into the system prompt of EVERY chat request. Measured cost with
//  100 files: ~2.4-3.2s to first paint vs ~350-700ms with no files.
//  Provider prompt-caching fixed the re-PREFILL cost, but the bytes
//  still had to be serialized, shipped, and parsed on every single
//  question — and that happens BEFORE the route can stream the instant
//  cover, so the user feels it.
//
//  Fix: upload the KB once, then send a tiny placeholder + hash per
//  request. The server substitutes the stored text back in right
//  before the model call. Request bodies drop from ~400KB to ~4KB, so
//  parsing is instant and the cover streams immediately — while the
//  ASSEMBLED prompt stays byte-identical, so provider prompt caches
//  keep hitting exactly as before.
//
//  Safety properties:
//   • Per-user scoped. Entries are keyed by userId + content hash, so a
//     hash guessed (or reused) by another account can never read back
//     someone else's resume.
//   • Integrity-checked. The client sends the hash it computed; we
//     recompute sha256 server-side and reject a mismatch, so a bad
//     client can't poison an entry another request would read.
//   • Bounded. LRU by last-use with entry-count AND total-byte caps,
//     plus a TTL, so a long-running server can't grow without limit.
//   • Fail-open at the edges. A miss (evicted / server restarted /
//     different instance behind a load balancer) is reported to the
//     client as `context_missing`, and the client simply retries once
//     with the full inline text — the pre-existing behavior. Nothing
//     breaks mid-interview.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const crypto = require('crypto');

// A single KB is capped client-side at 400K chars; allow headroom but
// refuse anything absurd so one request can't balloon the heap.
const MAX_TEXT_BYTES = 2 * 1024 * 1024;   // 2 MB per entry
const MAX_ENTRIES = 96;                    // plenty for concurrent sessions
const MAX_TOTAL_BYTES = 96 * 1024 * 1024;  // 96 MB ceiling across all entries
const TTL_MS = 3 * 60 * 60 * 1000;         // 3h — longer than any interview

// key = `${userId}:${hash}` → { text, bytes, lastUsed }
const store = new Map();
let totalBytes = 0;

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function keyFor(userId, hash) {
  return `${userId}:${hash}`;
}

// Drop expired entries, then evict least-recently-used until both the
// entry-count and total-byte budgets are satisfied. Map preserves
// insertion order; we re-insert on read so iteration order == LRU order.
function evict() {
  const now = Date.now();
  for (const [k, v] of store) {
    if (now - v.lastUsed > TTL_MS) {
      store.delete(k);
      totalBytes -= v.bytes;
    }
  }
  while ((store.size > MAX_ENTRIES || totalBytes > MAX_TOTAL_BYTES) && store.size > 0) {
    const oldestKey = store.keys().next().value;
    const v = store.get(oldestKey);
    store.delete(oldestKey);
    if (v) totalBytes -= v.bytes;
  }
}

// Store `text` for this user. `claimedHash` (optional) is verified
// against the real sha256 — a mismatch is rejected rather than silently
// stored under the wrong key. Returns { ok, hash } or { ok:false, error }.
function put(userId, text, claimedHash) {
  if (!userId) return { ok: false, error: 'user_required' };
  if (typeof text !== 'string' || text.length === 0) return { ok: false, error: 'text_required' };
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > MAX_TEXT_BYTES) return { ok: false, error: 'text_too_large' };

  const hash = sha256(text);
  if (claimedHash && claimedHash !== hash) return { ok: false, error: 'hash_mismatch' };

  const k = keyFor(userId, hash);
  const existing = store.get(k);
  if (existing) {
    // Refresh recency without double-counting bytes.
    store.delete(k);
    existing.lastUsed = Date.now();
    store.set(k, existing);
    return { ok: true, hash, deduped: true };
  }

  store.set(k, { text, bytes, lastUsed: Date.now() });
  totalBytes += bytes;
  evict();
  return { ok: true, hash, deduped: false };
}

// Read back a user's stored text. Returns null on miss (evicted, wrong
// user, unknown hash) — callers treat null as `context_missing`.
function get(userId, hash) {
  if (!userId || !hash) return null;
  const k = keyFor(userId, hash);
  const v = store.get(k);
  if (!v) return null;
  if (Date.now() - v.lastUsed > TTL_MS) {
    store.delete(k);
    totalBytes -= v.bytes;
    return null;
  }
  // Re-insert to mark most-recently-used (Map keeps insertion order).
  store.delete(k);
  v.lastUsed = Date.now();
  store.set(k, v);
  return v.text;
}

function stats() {
  return { entries: store.size, totalBytes, maxEntries: MAX_ENTRIES, maxTotalBytes: MAX_TOTAL_BYTES };
}

// Test-only: wipe everything.
function _reset() {
  store.clear();
  totalBytes = 0;
}

// ── Placeholder substitution ──
// The renderer replaces a big KB blob with ⟪CTX:<hash>⟫. We swap it back
// for the stored text immediately before the model call. The token is
// deliberately exotic (guillemets) so it cannot collide with resume/JD
// prose or the [[SOURCE: …]] markers the KB builder already emits.
const PLACEHOLDER_RE = /⟪CTX:([a-f0-9]{64})⟫/g;

function hasPlaceholder(str) {
  if (typeof str !== 'string') return false;
  PLACEHOLDER_RE.lastIndex = 0;
  return PLACEHOLDER_RE.test(str);
}

// Substitute every placeholder in `str`. Throws CONTEXT_MISSING when a
// referenced hash isn't in this user's store, so the route can answer
// with a retryable error instead of sending the model a literal ⟪CTX:…⟫.
function resolveText(userId, str) {
  if (typeof str !== 'string' || str.indexOf('⟪CTX:') === -1) return str;
  let missing = null;
  const out = str.replace(PLACEHOLDER_RE, (whole, hash) => {
    const text = get(userId, hash);
    if (text === null) { missing = hash; return whole; }
    return text;
  });
  if (missing) {
    const err = new Error(`context_missing:${missing}`);
    err.code = 'CONTEXT_MISSING';
    throw err;
  }
  return out;
}

// Resolve placeholders inside a messages array (system message and any
// user-message text parts). Returns a NEW array only when something
// changed; otherwise the original reference passes through.
function resolveMessages(userId, messages) {
  if (!Array.isArray(messages)) return messages;
  let changed = false;
  const out = messages.map(m => {
    if (!m) return m;
    if (typeof m.content === 'string') {
      const r = resolveText(userId, m.content);
      if (r !== m.content) { changed = true; return { ...m, content: r }; }
      return m;
    }
    if (Array.isArray(m.content)) {
      let partChanged = false;
      const parts = m.content.map(p => {
        if (p && p.type === 'text' && typeof p.text === 'string') {
          const r = resolveText(userId, p.text);
          if (r !== p.text) { partChanged = true; return { ...p, text: r }; }
        }
        return p;
      });
      if (partChanged) { changed = true; return { ...m, content: parts }; }
      return m;
    }
    return m;
  });
  return changed ? out : messages;
}

module.exports = {
  put, get, stats, resolveText, resolveMessages, hasPlaceholder, sha256,
  _test: { _reset, MAX_ENTRIES, MAX_TOTAL_BYTES, MAX_TEXT_BYTES, TTL_MS },
};
