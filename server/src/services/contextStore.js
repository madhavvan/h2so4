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

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  THE ENTRY CAP WAS GLOBAL, AND THAT DOES NOT SURVIVE GROWTH
//
//  `MAX_ENTRIES = 96` counted entries across ALL users. Measured, with the
//  real resume as the payload:
//
//    300 users each uploading once -> 96 resolvable, 204 evicted
//    => 68% of users get a 409 context_missing on their next question
//    96 entries held 933KB of a 96MB budget = 0.95% used
//    => the entry cap bound ~10,000x sooner than the byte cap
//
//  And a 409 is not free: the client re-uploads and retries after a 1s
//  backoff, so at any real concurrency the store spends its capacity
//  thrashing — every eviction manufacturing the upload that causes the
//  next one. The byte budget it was supposed to be protecting sat
//  essentially untouched.
//
//  So the entry cap is now PER USER, where it actually means something (a
//  person has a resume, maybe a JD, maybe a couple of variants), and the
//  global limit is the one that reflects the real resource: bytes. A user
//  can no longer be evicted by strangers, only by their own newer uploads.
const MAX_ENTRIES_PER_USER = 6;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024; // 512 MB across all users
const TTL_MS = 3 * 60 * 60 * 1000;         // 3h — longer than any interview
// A backstop against unbounded key growth, sized so it can never be the
// binding constraint at a plausible concurrency: 100K live sessions × 6.
const MAX_ENTRIES_TOTAL = 600_000;
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// key = `${userId}:${hash}` → { text, bytes, lastUsed, userId }
const store = new Map();
// userId → number of live entries, so the per-user cap costs no scan.
const perUser = new Map();
let totalBytes = 0;

function bumpUser(userId, delta) {
  const n = (perUser.get(userId) || 0) + delta;
  if (n <= 0) perUser.delete(userId);
  else perUser.set(userId, n);
}

// Evict this user's least-recently-used entries until they are within the
// per-user cap. Map iteration is insertion order and every read re-inserts,
// so the first matching key is the oldest.
function evictForUser(userId) {
  while ((perUser.get(userId) || 0) > MAX_ENTRIES_PER_USER) {
    let victim = null;
    for (const [k, v] of store) {
      if (v.userId === userId) { victim = k; break; }
    }
    if (victim === null) break;
    const v = store.get(victim);
    store.delete(victim);
    if (v) { totalBytes -= v.bytes; bumpUser(userId, -1); }
  }
}

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
      bumpUser(v.userId, -1);
    }
  }
  // Global pressure only — bytes, or the absolute key backstop. A user is
  // never evicted here because another user was busy; their own per-user
  // cap (evictForUser) is what bounds them.
  while ((totalBytes > MAX_TOTAL_BYTES || store.size > MAX_ENTRIES_TOTAL) && store.size > 0) {
    const oldestKey = store.keys().next().value;
    const v = store.get(oldestKey);
    store.delete(oldestKey);
    if (v) { totalBytes -= v.bytes; bumpUser(v.userId, -1); }
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

  store.set(k, { text, bytes, lastUsed: Date.now(), userId });
  totalBytes += bytes;
  bumpUser(userId, 1);
  evictForUser(userId);
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
    bumpUser(v.userId, -1);
    return null;
  }
  // Re-insert to mark most-recently-used (Map keeps insertion order).
  store.delete(k);
  v.lastUsed = Date.now();
  store.set(k, v);
  return v.text;
}

function stats() {
  return {
    entries: store.size,
    users: perUser.size,
    totalBytes,
    maxEntriesPerUser: MAX_ENTRIES_PER_USER,
    maxEntriesTotal: MAX_ENTRIES_TOTAL,
    maxTotalBytes: MAX_TOTAL_BYTES,
  };
}

// Test-only: wipe everything.
function _reset() {
  store.clear();
  perUser.clear();
  totalBytes = 0;
}

// Forget everything this user has uploaded. Called when the client says the
// knowledge base is gone (new conversation, every file deleted, sign-out) so
// a document's bytes do not sit on the server for the full three-hour TTL
// after the person who uploaded it has moved on.
function forgetUser(userId) {
  if (!userId) return 0;
  let dropped = 0;
  for (const [k, v] of Array.from(store)) {
    if (v.userId !== userId) continue;
    store.delete(k);
    totalBytes -= v.bytes;
    dropped++;
  }
  perUser.delete(userId);
  return dropped;
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

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  SUBSTITUTION IS AN AMPLIFIER, AND IT RUNS BEFORE EVERY GATE
//
//  This is the one place in the app where a small request body legally
//  turns into a large one. A placeholder is 74 bytes; the blob it stands
//  for can be MAX_TEXT_BYTES (2 MB). That ratio is ~29,000x, and until
//  now nothing counted the matches — a single global .replace() expanded
//  however many the caller sent, into ONE string, in one allocation.
//
//  Measured on this exact code before the cap: a 200 KB blob gave 2,926x
//  per placeholder, and 200 placeholders in a 14.8 KB body produced a
//  41 MB string in 24 ms. Scale that to a 2 MB blob and ~250 repeats and
//  the resolver reaches ~500 MB of live string — an OOM kill of the whole
//  process, which is every concurrent live interview on that instance,
//  not just the abuser's.
//
//  What makes it reachable is WHERE it sits: routes/ai.js mounts this as
//  router-level middleware registered ahead of requireTier /
//  requireTimeRemaining / requireActiveSession, because the downstream
//  handlers must see the fully assembled prompt. So a free, trial-
//  exhausted account gets here — the tier gates never run.
//
//  Hence: price the expansion BEFORE performing it. Count the matches with
//  an exec loop and add up the bytes they would pull in; refuse past
//  either bound instead of allocating. The bounds are deliberately far
//  above real traffic — the renderer only offloads a KB under
//  RETRIEVAL_MIN_CHARS (20K chars, so tens of KB on the wire) and emits
//  exactly ONE placeholder, in the system message. 16 placeholders is
//  ~16x the observed shape; 4 MB is ~60-200x a realistic blob and still
//  admits two entries at the absolute 2 MB per-entry maximum.
const MAX_PLACEHOLDERS = 16;
const MAX_RESOLVED_BYTES = 4 * 1024 * 1024;

// The budget is an object, not a per-string counter, because a per-string
// cap is trivially defeated: 250 messages carrying one placeholder each
// costs the same memory as one message carrying 250. Callers that resolve
// several strings for the SAME request should thread one of these through
// so the ceiling applies to the request as a whole.
function newResolveBudget() {
  return { count: 0, bytes: 0 };
}

// How big would this hash expand to — without disturbing anything. get()
// re-inserts to mark recency and deletes on TTL; the pricing pass must do
// neither, or merely quoting a request would reorder the LRU.
function peekBytes(userId, hash) {
  const v = store.get(keyFor(userId, hash));
  if (!v) return 0;                                  // a miss costs nothing; the resolve pass raises CONTEXT_MISSING
  if (Date.now() - v.lastUsed > TTL_MS) return 0;
  return v.bytes;
}

// Distinguishable from CONTEXT_MISSING on purpose: a miss is retryable and
// the client answers it by re-sending the text inline, which is the LAST
// thing we want here — this request is refused because it was too big, and
// telling the client to resend it bigger would be worse than the attack.
// `status`/`statusCode` are set so an error handler that honors them (the
// Express default does) answers 413 rather than 500.
function tooLarge(detail) {
  const err = new Error(`context_too_large:${detail}`);
  err.code = 'CONTEXT_TOO_LARGE';
  err.status = 413;
  err.statusCode = 413;
  err.expose = true;
  return err;
}

// Substitute every placeholder in `str`. Throws CONTEXT_MISSING when a
// referenced hash isn't in this user's store, so the route can answer
// with a retryable error instead of sending the model a literal ⟪CTX:…⟫.
// Throws CONTEXT_TOO_LARGE (413) when the expansion would exceed `budget`
// — pass a shared budget from newResolveBudget() to bound a whole request.
function resolveText(userId, str, budget) {
  if (typeof str !== 'string' || str.indexOf('⟪CTX:') === -1) return str;
  const b = budget || newResolveBudget();
  // Price first, allocate second. This loop is a linear scan with a fixed
  // 64-hex-char pattern (no backtracking to exploit) and it bails on the
  // first offending match, so refusal stays cheap no matter how many
  // placeholders were sent — that is the point of doing it before
  // .replace() rather than measuring the result.
  PLACEHOLDER_RE.lastIndex = 0;
  let m;
  while ((m = PLACEHOLDER_RE.exec(str)) !== null) {
    b.count += 1;
    if (b.count > MAX_PLACEHOLDERS) {
      PLACEHOLDER_RE.lastIndex = 0;   // shared /g regex — leave no lastIndex behind when we throw
      throw tooLarge(`placeholders:${b.count}>${MAX_PLACEHOLDERS}`);
    }
    b.bytes += peekBytes(userId, m[1]);
    if (b.bytes > MAX_RESOLVED_BYTES) {
      PLACEHOLDER_RE.lastIndex = 0;
      throw tooLarge(`bytes:${b.bytes}>${MAX_RESOLVED_BYTES}`);
    }
  }
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
//
// ONE budget covers the whole array — every message and every text part
// inside it. Anything less and the cap is decorative: an attacker just
// spreads the same total expansion over more messages.
function resolveMessages(userId, messages, budget) {
  if (!Array.isArray(messages)) return messages;
  const b = budget || newResolveBudget();
  let changed = false;
  const out = messages.map(m => {
    if (!m) return m;
    if (typeof m.content === 'string') {
      const r = resolveText(userId, m.content, b);
      if (r !== m.content) { changed = true; return { ...m, content: r }; }
      return m;
    }
    if (Array.isArray(m.content)) {
      let partChanged = false;
      const parts = m.content.map(p => {
        if (p && p.type === 'text' && typeof p.text === 'string') {
          const r = resolveText(userId, p.text, b);
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

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  A MISSING BLOB MUST NOT 409 A FIELD NOBODY IS WAITING ON.
//
//  resolveText throws CONTEXT_MISSING so the route can answer 409 and the
//  client can re-upload and retry — correct for systemInstruction/prompt/
//  messages, where the model cannot answer without them.
//
//  It is the wrong answer for the COVER fields. Those are speculative: the
//  cover is a sentence spoken in front of an answer that is already on its
//  way, and /cover/prewarm runs during a silence timer for a question that
//  has not been asked yet. Refusing the whole request because a spoken
//  opener lost its grounding would turn a degraded cover into a failed
//  ANSWER — the exact inversion this feature exists to avoid.
//
//  So a miss here degrades to '': the cover falls back to whatever the
//  no-knowledge-base path already does (which the grounding guard treats
//  as its STRICTEST mode, not its loosest), and the answer is untouched.
//
//  CONTEXT_TOO_LARGE still throws. That one is not a cache miss, it is a
//  request asking the server to allocate more than it has agreed to, and
//  swallowing it would remove the only backstop against the amplification
//  attack the pricing pass above exists to stop.
function resolveTextLenient(userId, str, budget) {
  try {
    return resolveText(userId, str, budget);
  } catch (err) {
    if (err && err.code === 'CONTEXT_MISSING') return '';
    throw err;
  }
}

module.exports = {
  put, get, stats, resolveText, resolveTextLenient, resolveMessages, hasPlaceholder, sha256, forgetUser,
  // Exported so a route resolving several fields of ONE body (systemInstruction,
  // prompt, messages) can hold them to a single shared ceiling instead of one
  // ceiling each. Omitting it is safe — every entry point makes its own.
  newResolveBudget,
  _test: {
    _reset, MAX_ENTRIES_PER_USER, MAX_ENTRIES_TOTAL, MAX_TOTAL_BYTES,
    MAX_TEXT_BYTES, TTL_MS, MAX_PLACEHOLDERS, MAX_RESOLVED_BYTES,
  },
};
