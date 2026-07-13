// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Search Provider — Brave Search API + SQLite cache
//
//  This is the retrieval backbone for the FRESH_CONTEXT system. When
//  an interview question lands and the classifier decides it's a
//  tool/UI/version-specific question, we hit this module to fetch
//  authoritative snippets that ground the model's answer.
//
//  Why a dedicated service:
//    • The cache (24h TTL, sha256 query fingerprint) is the secret to
//      "same speed" — most repeat questions hit cache @ ~5ms instead
//      of paying ~500ms for a Brave round-trip.
//    • Pluggable provider: default is Brave (raw snippets, $3/1k after
//      2k free/month, fastest), but the interface allows swapping to
//      Tavily, Bing, or DuckDuckGo without touching callers.
//    • Fail-open semantics: if BRAVE_API_KEY is missing OR Brave is
//      down, we return either stale cache (if we have it) or an empty
//      results array — never throw to the caller. The chat path keeps
//      working without retrieval.
//
//  The cache lives in its own SQLite file (search-cache.sqlite next
//  to the main minicaai.db) for two reasons:
//    1. Cache is throwaway — no point bloating the daily VACUUM INTO
//       backup of the auth/payments DB with retrieval snippets.
//    2. Cache wipe should be independent of auth state — `clearCache()`
//       in this module never touches anything else.
//
//  Cost model:
//    • Brave free tier: 2,000 queries/month
//    • At ~70% cache hit rate, expect ~9 fresh queries per 30-question
//      interview → 270 queries / 30 interviews = within free tier
//    • Pre-warm of top 100 tools is a one-time ~100 queries
//    • Even at scale ($3/1k beyond free), per-interview cost ≈ $0.03
//
//  Verified API specs as of May 2026 — see api.search.brave.com docs.
//  Re-verify endpoint + auth header before any upgrade.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const cheerio = require('cheerio');

let cacheDb = null;

// Cache lives in a sibling file to the main DB. Resolves the same way
// database.js does so DATABASE_PATH is honored in production deployments
// (Railway volume) and the dev default in development.
function resolveCachePath() {
  const mainDbPath = process.env.DATABASE_PATH || path.join(__dirname, '..', '..', 'data', 'minicaai.db');
  return path.join(path.dirname(mainDbPath), 'search-cache.sqlite');
}

// Initialize the cache schema on the given DB. Exposed so tests can
// create an in-memory DB and reuse the same schema setup as production.
// On :memory: databases the WAL pragma is a no-op (better-sqlite3 keeps
// memory mode regardless), so we don't need a wal-disable flag.
//
// Two tables live here:
//   1. search_cache — Brave search results keyed by query fingerprint
//   2. page_cache   — extracted page content keyed by URL fingerprint
//
// They share a DB file because they're conceptually one cache layer for
// retrieval, and storing them together simplifies maintenance (clear,
// prune, stats all touch one connection).
function initSchema(db) {
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS search_cache (
      fingerprint TEXT PRIMARY KEY,
      query TEXT NOT NULL,
      provider TEXT NOT NULL,
      results_json TEXT NOT NULL,
      cached_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_search_cache_cached_at ON search_cache(cached_at);

    CREATE TABLE IF NOT EXISTS page_cache (
      url_hash TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      content TEXT NOT NULL,
      fetched_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_page_cache_fetched_at ON page_cache(fetched_at);
  `);
  return db;
}

function getCacheDB() {
  if (cacheDb) return cacheDb;
  const cachePath = resolveCachePath();
  // better-sqlite3 refuses to open a DB in a directory that doesn't exist,
  // which crashes on a clean CI runner or a fresh Railway container where the
  // data dir hasn't been created yet. Create it first — this is the retrieval
  // path and must never throw into a live interview (fail-open contract above).
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  cacheDb = new Database(cachePath);
  initSchema(cacheDb);
  return cacheDb;
}

// 16-char hex prefix is more than enough — collision probability for
// even 1M entries is < 1 in 10^14. Trimmed to keep PK indexes small.
function fingerprint(query) {
  return crypto.createHash('sha256')
    .update(String(query || '').trim().toLowerCase())
    .digest('hex')
    .slice(0, 16);
}

const DEFAULT_TTL_SEC = 24 * 3600;        // 24h: tool docs change but slowly
// Top-N hits requested from Brave. Bumped from 5 → 8 when authority
// re-ranking landed in freshContext.js: the re-ranker partitions
// results into "authoritative docs" vs "the rest" and we keep the top
// 3 after re-ranking. Starting from 8 means the re-ranker has enough
// material to find the canonical docs even when SEO blogs crowd the
// initial Brave ordering. Old cache rows (5 results) still work —
// the re-ranker just has fewer candidates for those queries until they
// expire and refresh.
const DEFAULT_RESULT_COUNT = 8;

// ── Brave Search API ──
// Request shape from api.search.brave.com docs (verified May 2026).
// X-Subscription-Token is the auth header; Brave does NOT use Bearer.
//
// 5s timeout via AbortController — without this a slow Brave response
// could pin a server worker indefinitely. Even though the prefetch
// endpoint runs this in the background (202'd), an indefinite hang
// would leak handles. 5s matches fetchPageContent for symmetry.
const DEFAULT_BRAVE_TIMEOUT_MS = 5000;

async function braveSearch(query, apiKey, count = DEFAULT_RESULT_COUNT, options = {}) {
  const timeoutMs = options.timeoutMs || DEFAULT_BRAVE_TIMEOUT_MS;
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'X-Subscription-Token': apiKey,
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`Brave Search HTTP ${res.status}: ${text.slice(0, 200)}`);
      err.code = res.status === 429 ? 'BRAVE_RATE_LIMITED'
               : res.status === 401 ? 'BRAVE_UNAUTHORIZED'
               : 'BRAVE_HTTP_ERROR';
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    // Trim each result to bounded sizes — protects the prompt budget
    // from a runaway snippet (Brave usually keeps these reasonable but
    // we don't want one rogue result to bloat every chat call).
    return (data.web?.results || []).slice(0, count).map(r => ({
      title: String(r.title || '').slice(0, 200),
      description: String(r.description || '').slice(0, 500),
      url: String(r.url || ''),
    }));
  } catch (err) {
    if (err?.name === 'AbortError') {
      const timeoutErr = new Error(`Brave Search timeout after ${timeoutMs}ms`);
      timeoutErr.code = 'BRAVE_TIMEOUT';
      throw timeoutErr;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ── Public API ──
// Fail-open contract: this function NEVER throws. Callers that need
// the result shape can rely on { results, cached, skipped?, stale? }
// being well-formed even when retrieval fails entirely.
//
// Two modes:
//   1. DEFAULT (cacheOnly:false) — cache hit returns fresh; cache miss
//      triggers a live Brave call; on Brave failure, serves stale cache
//      if any. Used by /prefetch-context (background, async).
//   2. CACHE-ONLY (cacheOnly:true) — never triggers a live Brave call.
//      Cache hit returns fresh; stale cache also served (better than
//      nothing); cache miss returns empty immediately. Used by chat
//      routes so chat TTFB never depends on Brave's response time.
//
// The cacheOnly mode is the load-bearing piece for "user feels same
// speed as before web search was added". Chat path: always ~5ms.
async function searchWithCache(query, options = {}) {
  const ttlSec = options.ttlSec || DEFAULT_TTL_SEC;
  const apiKey = options.apiKey !== undefined ? options.apiKey : process.env.BRAVE_API_KEY;
  const db = options._db || getCacheDB();
  const fetcher = options._searchFn || braveSearch;
  const cacheOnly = options.cacheOnly === true;

  const fp = fingerprint(query);
  const row = db.prepare('SELECT results_json, cached_at FROM search_cache WHERE fingerprint = ?').get(fp);
  const now = Math.floor(Date.now() / 1000);

  // Cache hit AND fresh — fastest path, ~5ms. Same behavior in both modes.
  if (row && now - row.cached_at < ttlSec) {
    return { results: JSON.parse(row.results_json), cached: true };
  }

  // CACHE-ONLY mode: never call Brave. Serve stale if we have it
  // (better than empty for the model), otherwise return empty so the
  // chat path proceeds without retrieval enrichment.
  if (cacheOnly) {
    if (row) {
      return { results: JSON.parse(row.results_json), cached: true, stale: true, skipped: 'cache_only_stale' };
    }
    return { results: [], cached: false, skipped: 'cache_only_miss' };
  }

  // No API key configured. If we have stale cache, serve it (better
  // than nothing); otherwise return empty so the caller can decide
  // whether to still try the model without enrichment.
  if (!apiKey) {
    if (row) {
      return { results: JSON.parse(row.results_json), cached: true, stale: true, skipped: 'no_api_key' };
    }
    return { results: [], cached: false, skipped: 'no_api_key' };
  }

  // Cache miss or expired — fetch fresh (live mode only).
  let results;
  try {
    results = await fetcher(query, apiKey);
  } catch (err) {
    // Provider failure (network, 5xx, rate limit, timeout). If we have
    // a stale cache row, serve it — graceful degradation. Otherwise
    // return empty and let the chat path proceed without retrieval.
    if (row) {
      console.warn(`[search] ${err.code || 'error'} — serving stale cache for "${String(query).slice(0, 60)}"`);
      return { results: JSON.parse(row.results_json), cached: true, stale: true, skipped: err.code || 'fetch_failed' };
    }
    console.warn(`[search] ${err.code || 'error'} for "${String(query).slice(0, 60)}" — no cache fallback`);
    return { results: [], cached: false, skipped: err.code || 'fetch_failed' };
  }

  // Persist. ON CONFLICT updates timestamp + payload — keeps the row
  // fresh after each refresh instead of leaving stale duplicates.
  db.prepare(`
    INSERT INTO search_cache (fingerprint, query, provider, results_json, cached_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(fingerprint) DO UPDATE SET
      results_json = excluded.results_json,
      cached_at = excluded.cached_at,
      query = excluded.query
  `).run(fp, String(query).slice(0, 500), 'brave', JSON.stringify(results), now);

  return { results, cached: false };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Deep-fetch layer — fetch + extract main content from a URL
//
//  Brave's snippets (200-300 chars per result) are great for breadth
//  but sometimes thin on specifics. For the TOP authoritative result,
//  we fetch the actual HTML and extract ~3000 chars of clean main
//  content. The model gets richer raw material to ground its answer.
//
//  Why cheerio for extraction:
//    - DOM-aware (handles nested tags correctly, unlike regex strip)
//    - jQuery-like API, very easy to read
//    - Handles real-world malformed HTML (common in docs sites)
//    - Battle-tested, used by 2M+ projects
//
//  Extraction strategy:
//    1. Strip non-content elements (scripts, styles, nav, header,
//       footer, aside, noscript, iframe, forms, ads/sidebar classes)
//    2. Find the main content area in priority order:
//       <main>, <article>, [role="main"], #content, .content, .documentation
//    3. Fall back to <body> if no main area found
//    4. Extract .text() — cheerio normalizes whitespace
//    5. Cap at 3000 chars (keeps prompt token count predictable)
//
//  Failure modes (all fail-soft, never throw to caller):
//    - Invalid URL → returns ok:false with error tag
//    - HTTP 4xx/5xx → returns ok:false (caller can fall back to snippets)
//    - Non-HTML response (PDF, JSON, etc.) → ok:false
//    - Timeout after 5s → ok:false
//    - Network error → ok:false
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const DEFAULT_PAGE_TTL_SEC = 7 * 24 * 3600;     // 7 days — docs change slowly
const DEFAULT_PAGE_MAX_CHARS = 3000;
const DEFAULT_PAGE_TIMEOUT_MS = 5000;

function extractMainText(html, maxChars = DEFAULT_PAGE_MAX_CHARS) {
  if (!html || typeof html !== 'string') return '';

  let $;
  try {
    $ = cheerio.load(html);
  } catch {
    return '';  // Malformed HTML beyond cheerio's tolerance
  }

  // Strip non-content elements aggressively. These selectors cover the
  // chrome (header/footer/nav), interactive widgets (forms/buttons),
  // and accessibility-hidden content (aria-hidden, role=navigation).
  $([
    'script', 'style', 'nav', 'header', 'footer', 'aside',
    'noscript', 'iframe', 'form', 'button',
    '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]',
    '[aria-hidden="true"]',
  ].join(', ')).remove();

  // Strip common SEO/UI noise by class/id patterns. Docs sites usually
  // have these and they pollute the text dump.
  $([
    '.advertisement', '.ads', '.ad', '.sidebar', '.side-bar',
    '.menu', '.navigation', '.breadcrumb', '.breadcrumbs',
    '.pagination', '.cookie-banner', '.cookie-notice',
    '.newsletter', '.subscribe', '.social-share', '.share-buttons',
    '#sidebar', '#nav', '#navigation', '#footer', '#header',
  ].join(', ')).remove();

  // Find main content in priority order. <main> is the spec-recommended
  // landmark; <article> is common for blog posts; role="main" is the
  // ARIA fallback; common id/class patterns cover the rest.
  let main = $('main').first();
  if (!main.length) main = $('article').first();
  if (!main.length) main = $('[role="main"]').first();
  if (!main.length) main = $('#main, #content, #main-content, .main-content, .documentation, .docs-content, .doc-content').first();
  if (!main.length) main = $('body');

  // Extract text. cheerio's .text() concatenates text nodes;
  // we normalize whitespace to a single space and trim.
  const text = main.text()
    .replace(/\s+/g, ' ')
    .trim();

  return text.slice(0, maxChars);
}

async function fetchPageContent(url, options = {}) {
  const timeoutMs = options.timeoutMs || DEFAULT_PAGE_TIMEOUT_MS;
  const maxChars = options.maxChars || DEFAULT_PAGE_MAX_CHARS;
  const _fetch = options._fetch || fetch;
  const _extract = options._extract || extractMainText;

  if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    return { ok: false, error: 'invalid_url', text: '' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await _fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        // Real-looking User-Agent. Some sites block obvious bot UAs.
        // We identify as ourselves but use a browser-shaped string.
        'User-Agent': 'Mozilla/5.0 (compatible; minicaai-bot/1.0; +https://minicaai.com/bot)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    clearTimeout(timer);

    if (!res.ok) {
      return { ok: false, error: `http_${res.status}`, status: res.status, text: '' };
    }

    const contentType = String(res.headers.get('content-type') || '');
    if (!contentType.includes('html')) {
      return { ok: false, error: 'non_html', contentType, text: '' };
    }

    const html = await res.text();
    // Cap raw HTML size before parsing — some pages are 5MB+ which
    // bloats memory and parsing time. 500KB is plenty for any docs page.
    const htmlCapped = html.length > 500_000 ? html.slice(0, 500_000) : html;
    const text = _extract(htmlCapped, maxChars);
    return { ok: true, text, contentLength: text.length };
  } catch (err) {
    clearTimeout(timer);
    if (err?.name === 'AbortError') {
      return { ok: false, error: 'timeout', text: '' };
    }
    return { ok: false, error: err.message || 'fetch_failed', text: '' };
  }
}

// ── fetchPageContentWithCache ──
// Same fail-open contract as searchWithCache: NEVER throws. Returns
// { ok, text, cached, stale?, error? } in all cases.
//
// Two modes (mirroring searchWithCache):
//   1. DEFAULT — cache hit returns fresh; miss triggers live HTTP fetch
//      with 5s timeout; failure serves stale cache if any.
//   2. CACHE-ONLY (cacheOnly:true) — never triggers HTTP fetch. Cache
//      hit returns fresh; stale cache served; miss returns ok:false
//      with skipped='cache_only_miss'.
//
// Cache strategy:
//   - URL hash as primary key (16-char sha256 prefix)
//   - 7-day TTL — docs sites change slowly enough that stale-by-a-week
//     is fine for ~all practical purposes
//   - On fetch failure with cached row → serve stale (graceful degradation)
//   - On fetch failure without cache → return ok:false, caller falls
//     back to snippets-only FRESH_CONTEXT (which is itself fine)
async function fetchPageContentWithCache(url, options = {}) {
  const ttlSec = options.ttlSec || DEFAULT_PAGE_TTL_SEC;
  const db = options._db || getCacheDB();
  const fetcher = options._fetchFn || fetchPageContent;
  const cacheOnly = options.cacheOnly === true;

  if (!url || typeof url !== 'string') {
    return { ok: false, error: 'invalid_url', text: '', cached: false };
  }

  const urlHash = fingerprint(url);
  const row = db.prepare('SELECT content, fetched_at FROM page_cache WHERE url_hash = ?').get(urlHash);
  const now = Math.floor(Date.now() / 1000);

  // Cache hit + fresh — fastest path, ~5ms.
  if (row && now - row.fetched_at < ttlSec) {
    return { ok: true, text: row.content, cached: true };
  }

  // CACHE-ONLY mode: never trigger a live HTTP fetch. This is what
  // chat routes use so the chat call's TTFB never depends on a slow
  // page-content fetch (which can be 1-5s on cold paths).
  if (cacheOnly) {
    if (row) {
      return { ok: true, text: row.content, cached: true, stale: true, skipped: 'cache_only_stale' };
    }
    return { ok: false, error: 'cache_only_miss', text: '', cached: false, skipped: 'cache_only_miss' };
  }

  // Fetch fresh (live mode only).
  const result = await fetcher(url, options);

  if (!result.ok) {
    // Stale cache fallback — better than nothing.
    if (row) {
      return { ok: true, text: row.content, cached: true, stale: true, fetchError: result.error };
    }
    return { ok: false, error: result.error, text: '', cached: false };
  }

  // Persist. Trim url to keep storage bounded — some URLs are
  // pathologically long with tracking params.
  db.prepare(`
    INSERT INTO page_cache (url_hash, url, content, fetched_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(url_hash) DO UPDATE SET
      content = excluded.content,
      fetched_at = excluded.fetched_at,
      url = excluded.url
  `).run(urlHash, String(url).slice(0, 1000), result.text, now);

  return { ok: true, text: result.text, cached: false };
}

// ── Maintenance helpers ──
// Used by the prewarm script and any future "wipe stale entries" cron.
function clearCache(db) {
  const target = db || getCacheDB();
  const r1 = target.prepare('DELETE FROM search_cache').run();
  const r2 = target.prepare('DELETE FROM page_cache').run();
  return { searchRows: r1.changes, pageRows: r2.changes };
}

function pruneStale(maxAgeSec = 7 * 24 * 3600, db) {
  const cutoff = Math.floor(Date.now() / 1000) - maxAgeSec;
  const target = db || getCacheDB();
  const r1 = target.prepare('DELETE FROM search_cache WHERE cached_at < ?').run(cutoff);
  const r2 = target.prepare('DELETE FROM page_cache WHERE fetched_at < ?').run(cutoff);
  return { searchRows: r1.changes, pageRows: r2.changes };
}

function cacheStats(db) {
  const target = db || getCacheDB();
  const searchTotal = target.prepare('SELECT COUNT(*) AS n FROM search_cache').get().n;
  const pageTotal = target.prepare('SELECT COUNT(*) AS n FROM page_cache').get().n;
  const oldest = target.prepare('SELECT MIN(cached_at) AS t FROM search_cache').get().t;
  const newest = target.prepare('SELECT MAX(cached_at) AS t FROM search_cache').get().t;
  return { searchTotal, pageTotal, oldest, newest };
}

module.exports = {
  searchWithCache,
  fetchPageContent,
  fetchPageContentWithCache,
  clearCache,
  pruneStale,
  cacheStats,
  // Internals exposed for testing
  _test: {
    fingerprint, braveSearch, getCacheDB, resolveCachePath, initSchema,
    extractMainText,
    DEFAULT_TTL_SEC, DEFAULT_PAGE_TTL_SEC, DEFAULT_PAGE_MAX_CHARS,
  },
};
