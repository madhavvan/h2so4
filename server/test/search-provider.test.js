// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  searchProvider — unit tests
//
//  Uses better-sqlite3 in-memory DB + an injected fetcher (_searchFn)
//  to exercise the cache logic without hitting Brave or disk. The
//  initSchema helper sets up the same tables as production so tests
//  exercise real SQL paths, not a mock.
//
//  Covered:
//    1. fingerprint normalizes case and whitespace, stable across calls
//    2. Cache miss → fetcher called, results persisted, returned
//    3. Cache hit → fetcher NOT called, results returned with cached=true
//    4. Stale cache (TTL expired) → fetcher called again
//    5. Fetcher failure with stale cache → stale served, marked stale=true
//    6. Fetcher failure without cache → empty + skipped reason
//    7. No API key + no cache → empty + skipped='no_api_key'
//    8. No API key + existing cache → cache served (stale)
//    9. Maintenance: clearCache / pruneStale / cacheStats
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const {
  searchWithCache,
  fetchPageContent,
  fetchPageContentWithCache,
  clearCache, pruneStale, cacheStats,
  _test,
} = require('../src/services/searchProvider.js');
const { fingerprint, initSchema, extractMainText, DEFAULT_TTL_SEC, DEFAULT_PAGE_TTL_SEC } = _test;

function makeDb() {
  const db = new Database(':memory:');
  initSchema(db);
  return db;
}

describe('fingerprint', () => {
  it('returns stable hex string', () => {
    const fp = fingerprint('AWS Glue dashboard tabs');
    expect(typeof fp).toBe('string');
    expect(fp.length).toBe(16);
    expect(/^[0-9a-f]+$/.test(fp)).toBe(true);
  });

  it('normalizes case', () => {
    expect(fingerprint('AWS Glue')).toBe(fingerprint('aws glue'));
  });

  it('normalizes leading/trailing whitespace', () => {
    expect(fingerprint('  hello  ')).toBe(fingerprint('hello'));
  });

  it('different queries produce different fingerprints', () => {
    expect(fingerprint('foo')).not.toBe(fingerprint('bar'));
  });
});

describe('searchWithCache — cache miss', () => {
  it('calls the fetcher, persists, returns results with cached=false', async () => {
    const db = makeDb();
    const fetcher = vi.fn().mockResolvedValue([
      { title: 'AWS Glue Console', description: 'Tables, Crawlers, Jobs', url: 'https://docs.aws.amazon.com/glue' },
    ]);

    const r = await searchWithCache('aws glue tabs', { _db: db, _searchFn: fetcher, apiKey: 'k' });

    expect(r.cached).toBe(false);
    expect(r.results).toHaveLength(1);
    expect(r.results[0].title).toBe('AWS Glue Console');
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Persisted row should be there
    const row = db.prepare('SELECT * FROM search_cache WHERE fingerprint = ?').get(fingerprint('aws glue tabs'));
    expect(row).toBeTruthy();
    expect(row.provider).toBe('brave');
  });
});

describe('searchWithCache — cache hit', () => {
  it('serves cached results without calling fetcher', async () => {
    const db = makeDb();
    const fetcher = vi.fn().mockResolvedValue([{ title: 'X', description: 'Y', url: 'Z' }]);

    // First call: miss
    await searchWithCache('q1', { _db: db, _searchFn: fetcher, apiKey: 'k' });
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Second call: hit
    const r = await searchWithCache('q1', { _db: db, _searchFn: fetcher, apiKey: 'k' });
    expect(r.cached).toBe(true);
    expect(r.results).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(1);  // still only one call
  });

  it('cache key is normalized — different case hits same row', async () => {
    const db = makeDb();
    const fetcher = vi.fn().mockResolvedValue([{ title: 'X', description: 'Y', url: 'Z' }]);
    await searchWithCache('AWS GLUE', { _db: db, _searchFn: fetcher, apiKey: 'k' });
    const r = await searchWithCache('aws glue', { _db: db, _searchFn: fetcher, apiKey: 'k' });
    expect(r.cached).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('searchWithCache — TTL expiration', () => {
  it('refetches when cached_at is older than ttlSec', async () => {
    const db = makeDb();
    const fetcher = vi.fn()
      .mockResolvedValueOnce([{ title: 'OLD', description: 'old data', url: '' }])
      .mockResolvedValueOnce([{ title: 'NEW', description: 'fresh data', url: '' }]);

    // Insert a stale row directly (simulate cached_at = 2 days ago)
    const fp = fingerprint('expiring');
    const oldTs = Math.floor(Date.now() / 1000) - 2 * 24 * 3600;
    db.prepare(`INSERT INTO search_cache VALUES (?, ?, ?, ?, ?)`)
      .run(fp, 'expiring', 'brave', JSON.stringify([{ title: 'OLD', description: 'old', url: '' }]), oldTs);

    // ttlSec = 24h → 2-day-old row is stale → fetcher should be called
    const r = await searchWithCache('expiring', { _db: db, _searchFn: fetcher, apiKey: 'k', ttlSec: 24 * 3600 });
    expect(r.cached).toBe(false);
    expect(r.results[0].title).toBe('OLD');  // first call returns first mock value
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('searchWithCache — fail-open paths', () => {
  it('returns empty + skipped="no_api_key" when no key and no cache', async () => {
    const db = makeDb();
    const r = await searchWithCache('nokey', { _db: db, apiKey: '' });
    expect(r.results).toEqual([]);
    expect(r.cached).toBe(false);
    expect(r.skipped).toBe('no_api_key');
  });

  it('serves stale cache when no API key but row exists', async () => {
    const db = makeDb();
    const oldTs = Math.floor(Date.now() / 1000) - 100 * 24 * 3600;  // 100 days ago
    db.prepare(`INSERT INTO search_cache VALUES (?, ?, ?, ?, ?)`)
      .run(fingerprint('q'), 'q', 'brave', JSON.stringify([{ title: 'cached', description: '', url: '' }]), oldTs);
    const r = await searchWithCache('q', { _db: db, apiKey: '' });
    expect(r.results).toHaveLength(1);
    expect(r.results[0].title).toBe('cached');
    expect(r.stale).toBe(true);
    expect(r.skipped).toBe('no_api_key');
  });

  it('serves stale cache when fetcher throws', async () => {
    const db = makeDb();
    // Seed a stale row
    const oldTs = Math.floor(Date.now() / 1000) - 100 * 24 * 3600;
    db.prepare(`INSERT INTO search_cache VALUES (?, ?, ?, ?, ?)`)
      .run(fingerprint('flaky'), 'flaky', 'brave', JSON.stringify([{ title: 'stale-result', description: '', url: '' }]), oldTs);

    const fetcher = vi.fn().mockRejectedValue(Object.assign(new Error('rate limited'), { code: 'BRAVE_RATE_LIMITED' }));
    const r = await searchWithCache('flaky', { _db: db, _searchFn: fetcher, apiKey: 'k' });

    expect(r.results).toHaveLength(1);
    expect(r.results[0].title).toBe('stale-result');
    expect(r.stale).toBe(true);
    expect(r.skipped).toBe('BRAVE_RATE_LIMITED');
  });

  it('returns empty when fetcher throws and there is no cache to fall back to', async () => {
    const db = makeDb();
    const fetcher = vi.fn().mockRejectedValue(Object.assign(new Error('down'), { code: 'BRAVE_HTTP_ERROR' }));
    const r = await searchWithCache('cold-miss', { _db: db, _searchFn: fetcher, apiKey: 'k' });
    expect(r.results).toEqual([]);
    expect(r.cached).toBe(false);
    expect(r.skipped).toBe('BRAVE_HTTP_ERROR');
  });
});

describe('Maintenance helpers', () => {
  it('clearCache wipes all rows from BOTH tables', async () => {
    const db = makeDb();
    const fetcher = vi.fn().mockResolvedValue([{ title: 'a', description: '', url: '' }]);
    await searchWithCache('x1', { _db: db, _searchFn: fetcher, apiKey: 'k' });
    await searchWithCache('x2', { _db: db, _searchFn: fetcher, apiKey: 'k' });
    db.prepare(`INSERT INTO page_cache VALUES (?, ?, ?, ?)`).run('p1', 'https://x', 'content', Math.floor(Date.now() / 1000));
    expect(db.prepare('SELECT COUNT(*) AS n FROM search_cache').get().n).toBe(2);
    expect(db.prepare('SELECT COUNT(*) AS n FROM page_cache').get().n).toBe(1);

    const r = clearCache(db);
    expect(r.searchRows).toBe(2);
    expect(r.pageRows).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM search_cache').get().n).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM page_cache').get().n).toBe(0);
  });

  it('pruneStale removes rows older than maxAgeSec from BOTH tables', async () => {
    const db = makeDb();
    const now = Math.floor(Date.now() / 1000);
    // search_cache: one fresh, one ancient
    db.prepare(`INSERT INTO search_cache VALUES (?, ?, ?, ?, ?)`).run('fp_fresh', 'fresh', 'brave', '[]', now);
    db.prepare(`INSERT INTO search_cache VALUES (?, ?, ?, ?, ?)`).run('fp_old', 'old', 'brave', '[]', now - 30 * 24 * 3600);
    // page_cache: one fresh, one ancient
    db.prepare(`INSERT INTO page_cache VALUES (?, ?, ?, ?)`).run('p_fresh', 'https://fresh', 'fresh content', now);
    db.prepare(`INSERT INTO page_cache VALUES (?, ?, ?, ?)`).run('p_old', 'https://old', 'old content', now - 30 * 24 * 3600);

    const removed = pruneStale(7 * 24 * 3600, db);
    expect(removed.searchRows).toBe(1);
    expect(removed.pageRows).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM search_cache').get().n).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM page_cache').get().n).toBe(1);
    expect(db.prepare('SELECT query FROM search_cache').get().query).toBe('fresh');
  });

  it('cacheStats reports searchTotal / pageTotal / oldest / newest', async () => {
    const db = makeDb();
    const now = Math.floor(Date.now() / 1000);
    db.prepare(`INSERT INTO search_cache VALUES (?, ?, ?, ?, ?)`).run('a', 'a', 'brave', '[]', now - 100);
    db.prepare(`INSERT INTO search_cache VALUES (?, ?, ?, ?, ?)`).run('b', 'b', 'brave', '[]', now);
    db.prepare(`INSERT INTO page_cache VALUES (?, ?, ?, ?)`).run('p1', 'https://a', 'x', now - 50);
    const stats = cacheStats(db);
    expect(stats.searchTotal).toBe(2);
    expect(stats.pageTotal).toBe(1);
    expect(stats.oldest).toBe(now - 100);
    expect(stats.newest).toBe(now);
  });
});

describe('Defaults', () => {
  it('DEFAULT_TTL_SEC is 24 hours', () => {
    expect(DEFAULT_TTL_SEC).toBe(24 * 3600);
  });
  it('DEFAULT_PAGE_TTL_SEC is 7 days', () => {
    expect(DEFAULT_PAGE_TTL_SEC).toBe(7 * 24 * 3600);
  });
});

describe('searchWithCache — cacheOnly mode (chat-time)', () => {
  it('cache hit + fresh → returns cached, never calls fetcher', async () => {
    const db = makeDb();
    const fetcher = vi.fn();
    db.prepare(`INSERT INTO search_cache VALUES (?, ?, ?, ?, ?)`)
      .run(fingerprint('warm'), 'warm', 'brave',
        JSON.stringify([{ title: 'cached', description: '', url: '' }]),
        Math.floor(Date.now() / 1000));

    const r = await searchWithCache('warm', { _db: db, _searchFn: fetcher, apiKey: 'k', cacheOnly: true });
    expect(r.cached).toBe(true);
    expect(r.results[0].title).toBe('cached');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('cache miss → returns empty + skipped="cache_only_miss", never calls fetcher', async () => {
    const db = makeDb();
    const fetcher = vi.fn().mockResolvedValue([{ title: 'should-not-be-called', description: '', url: '' }]);
    const r = await searchWithCache('cold', { _db: db, _searchFn: fetcher, apiKey: 'k', cacheOnly: true });
    expect(r.results).toEqual([]);
    expect(r.cached).toBe(false);
    expect(r.skipped).toBe('cache_only_miss');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('stale cache → serves stale + skipped="cache_only_stale", never calls fetcher', async () => {
    const db = makeDb();
    const fetcher = vi.fn();
    const ancientTs = Math.floor(Date.now() / 1000) - 100 * 24 * 3600;
    db.prepare(`INSERT INTO search_cache VALUES (?, ?, ?, ?, ?)`)
      .run(fingerprint('stale'), 'stale', 'brave',
        JSON.stringify([{ title: 'stale-result', description: '', url: '' }]), ancientTs);

    const r = await searchWithCache('stale', {
      _db: db, _searchFn: fetcher, apiKey: 'k',
      ttlSec: 24 * 3600, cacheOnly: true,
    });
    expect(r.results[0].title).toBe('stale-result');
    expect(r.stale).toBe(true);
    expect(r.skipped).toBe('cache_only_stale');
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('fetchPageContentWithCache — cacheOnly mode', () => {
  it('cache hit → returns cached, never calls fetcher', async () => {
    const db = makeDb();
    const fetcher = vi.fn();
    db.prepare(`INSERT INTO page_cache VALUES (?, ?, ?, ?)`)
      .run(fingerprint('https://docs.example.com'), 'https://docs.example.com', 'cached page', Math.floor(Date.now() / 1000));

    const r = await fetchPageContentWithCache('https://docs.example.com', {
      _db: db, _fetchFn: fetcher, cacheOnly: true,
    });
    expect(r.ok).toBe(true);
    expect(r.text).toBe('cached page');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('cache miss → returns ok:false, never calls fetcher', async () => {
    const db = makeDb();
    const fetcher = vi.fn().mockResolvedValue({ ok: true, text: 'should-not-be-called' });
    const r = await fetchPageContentWithCache('https://cold.example.com', {
      _db: db, _fetchFn: fetcher, cacheOnly: true,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('cache_only_miss');
    expect(r.skipped).toBe('cache_only_miss');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('stale cache → serves stale, never calls fetcher', async () => {
    const db = makeDb();
    const fetcher = vi.fn();
    const ancientTs = Math.floor(Date.now() / 1000) - 100 * 24 * 3600;
    db.prepare(`INSERT INTO page_cache VALUES (?, ?, ?, ?)`)
      .run(fingerprint('https://stale.example.com'), 'https://stale.example.com', 'old content', ancientTs);

    const r = await fetchPageContentWithCache('https://stale.example.com', {
      _db: db, _fetchFn: fetcher,
      ttlSec: 7 * 24 * 3600, cacheOnly: true,
    });
    expect(r.ok).toBe(true);
    expect(r.text).toBe('old content');
    expect(r.stale).toBe(true);
    expect(r.skipped).toBe('cache_only_stale');
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('extractMainText', () => {
  it('returns empty for null/undefined/non-string', () => {
    expect(extractMainText(null)).toBe('');
    expect(extractMainText(undefined)).toBe('');
    expect(extractMainText(42)).toBe('');
  });

  it('extracts text from <main>', () => {
    const html = `
      <html><body>
        <header>Header text — should be stripped</header>
        <nav>Nav text — should be stripped</nav>
        <main><h1>Main Title</h1><p>The actual content lives here.</p></main>
        <footer>Footer text — should be stripped</footer>
      </body></html>`;
    const text = extractMainText(html);
    expect(text).toContain('Main Title');
    expect(text).toContain('The actual content lives here.');
    expect(text).not.toContain('Header text');
    expect(text).not.toContain('Nav text');
    expect(text).not.toContain('Footer text');
  });

  it('falls back to <article> when no <main>', () => {
    const html = `<body><article>Article body content here.</article></body>`;
    const text = extractMainText(html);
    expect(text).toContain('Article body content here.');
  });

  it('falls back to [role="main"]', () => {
    const html = `<body><div role="main">Role main content</div></body>`;
    const text = extractMainText(html);
    expect(text).toContain('Role main content');
  });

  it('falls back to body when nothing else matches', () => {
    const html = `<body>Loose body text without semantic tags.</body>`;
    const text = extractMainText(html);
    expect(text).toContain('Loose body text without semantic tags.');
  });

  it('strips <script> tags', () => {
    const html = `<body><main>Content<script>var evil = 1;</script>more content</main></body>`;
    const text = extractMainText(html);
    expect(text).not.toContain('var evil');
    expect(text).toContain('Content');
    expect(text).toContain('more content');
  });

  it('strips <style> tags', () => {
    const html = `<body><main>Content<style>.foo{color:red}</style></main></body>`;
    const text = extractMainText(html);
    expect(text).not.toContain('.foo');
    expect(text).not.toContain('color');
  });

  it('strips common UI noise classes', () => {
    const html = `
      <body><main>
        <div class="advertisement">Buy this thing</div>
        <p>Real content paragraph.</p>
        <div class="sidebar">Sidebar links</div>
      </main></body>`;
    const text = extractMainText(html);
    expect(text).toContain('Real content paragraph.');
    expect(text).not.toContain('Buy this thing');
    expect(text).not.toContain('Sidebar links');
  });

  it('caps output at maxChars', () => {
    const long = 'a'.repeat(10000);
    const html = `<body><main>${long}</main></body>`;
    const text = extractMainText(html, 1000);
    expect(text.length).toBeLessThanOrEqual(1000);
  });

  it('normalizes whitespace', () => {
    const html = `<body><main>line one\n\n\nline two   \t  word</main></body>`;
    const text = extractMainText(html);
    expect(text).not.toMatch(/\n/);
    expect(text).not.toMatch(/  /);  // no double spaces
    expect(text).toContain('line one line two word');
  });
});

describe('fetchPageContent', () => {
  function makeFetch(response) {
    return vi.fn().mockResolvedValue(response);
  }

  it('returns ok:true with extracted text on 200 success', async () => {
    const fakeFetch = makeFetch({
      ok: true,
      status: 200,
      headers: { get: () => 'text/html; charset=utf-8' },
      text: async () => '<body><main>Main content from the page.</main></body>',
    });
    const result = await fetchPageContent('https://example.com/page', { _fetch: fakeFetch });
    expect(result.ok).toBe(true);
    expect(result.text).toContain('Main content from the page.');
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });

  it('returns ok:false on 404', async () => {
    const fakeFetch = makeFetch({
      ok: false,
      status: 404,
      headers: { get: () => 'text/html' },
    });
    const result = await fetchPageContent('https://example.com/missing', { _fetch: fakeFetch });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('http_404');
    expect(result.status).toBe(404);
  });

  it('returns ok:false on 5xx', async () => {
    const fakeFetch = makeFetch({
      ok: false,
      status: 503,
      headers: { get: () => 'text/html' },
    });
    const result = await fetchPageContent('https://example.com/broken', { _fetch: fakeFetch });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('http_503');
  });

  it('returns ok:false for non-HTML content-type', async () => {
    const fakeFetch = makeFetch({
      ok: true,
      status: 200,
      headers: { get: () => 'application/pdf' },
      text: async () => '%PDF-1.4...',
    });
    const result = await fetchPageContent('https://example.com/doc.pdf', { _fetch: fakeFetch });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('non_html');
    expect(result.contentType).toBe('application/pdf');
  });

  it('returns ok:false for invalid URL', async () => {
    const result = await fetchPageContent('not a url');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('invalid_url');
  });

  it('returns ok:false for null URL', async () => {
    const result = await fetchPageContent(null);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('invalid_url');
  });

  it('returns ok:false on fetch throw', async () => {
    const fakeFetch = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    const result = await fetchPageContent('https://example.com', { _fetch: fakeFetch });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/ECONNRESET/);
  });

  it('caps HTML size before parsing', async () => {
    const huge = '<body><main>' + 'A'.repeat(2_000_000) + '</main></body>';
    const fakeFetch = makeFetch({
      ok: true,
      status: 200,
      headers: { get: () => 'text/html' },
      text: async () => huge,
    });
    const result = await fetchPageContent('https://example.com', { _fetch: fakeFetch, maxChars: 1000 });
    expect(result.ok).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(1000);
  });
});

describe('fetchPageContentWithCache', () => {
  function makeFakeFetcher(toReturn) {
    return vi.fn().mockImplementation(async () => toReturn);
  }

  it('cache miss → fetches, stores, returns ok:true', async () => {
    const db = makeDb();
    const fetcher = makeFakeFetcher({ ok: true, text: 'cached page content' });
    const r = await fetchPageContentWithCache('https://example.com/p1', {
      _db: db, _fetchFn: fetcher,
    });
    expect(r.ok).toBe(true);
    expect(r.text).toBe('cached page content');
    expect(r.cached).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Verify it was persisted
    const row = db.prepare('SELECT * FROM page_cache WHERE url_hash = ?').get(fingerprint('https://example.com/p1'));
    expect(row).toBeTruthy();
    expect(row.content).toBe('cached page content');
  });

  it('cache hit → serves cached, does NOT call fetcher', async () => {
    const db = makeDb();
    const fetcher = makeFakeFetcher({ ok: true, text: 'should not be called' });
    // Seed cache
    db.prepare(`INSERT INTO page_cache VALUES (?, ?, ?, ?)`)
      .run(fingerprint('https://example.com/p2'), 'https://example.com/p2', 'cached value', Math.floor(Date.now() / 1000));

    const r = await fetchPageContentWithCache('https://example.com/p2', {
      _db: db, _fetchFn: fetcher,
    });
    expect(r.ok).toBe(true);
    expect(r.text).toBe('cached value');
    expect(r.cached).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('cache miss + fetcher error + no cache → returns ok:false', async () => {
    const db = makeDb();
    const fetcher = makeFakeFetcher({ ok: false, error: 'timeout', text: '' });
    const r = await fetchPageContentWithCache('https://example.com/p3', {
      _db: db, _fetchFn: fetcher,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('timeout');
    expect(r.cached).toBe(false);
  });

  it('cache miss + fetcher error + STALE cache → serves stale', async () => {
    const db = makeDb();
    const ancientTs = Math.floor(Date.now() / 1000) - 100 * 24 * 3600;  // 100 days
    db.prepare(`INSERT INTO page_cache VALUES (?, ?, ?, ?)`)
      .run(fingerprint('https://example.com/p4'), 'https://example.com/p4', 'old content', ancientTs);

    const fetcher = makeFakeFetcher({ ok: false, error: 'http_503', text: '' });
    const r = await fetchPageContentWithCache('https://example.com/p4', {
      _db: db, _fetchFn: fetcher,
      ttlSec: 24 * 3600,  // 1 day TTL — 100 days ago is stale
    });
    expect(r.ok).toBe(true);
    expect(r.text).toBe('old content');
    expect(r.cached).toBe(true);
    expect(r.stale).toBe(true);
    expect(r.fetchError).toBe('http_503');
  });

  it('TTL expiration triggers refetch', async () => {
    const db = makeDb();
    const ancientTs = Math.floor(Date.now() / 1000) - 30 * 24 * 3600;
    db.prepare(`INSERT INTO page_cache VALUES (?, ?, ?, ?)`)
      .run(fingerprint('https://example.com/p5'), 'https://example.com/p5', 'old', ancientTs);

    const fetcher = makeFakeFetcher({ ok: true, text: 'new content' });
    const r = await fetchPageContentWithCache('https://example.com/p5', {
      _db: db, _fetchFn: fetcher,
      ttlSec: 7 * 24 * 3600,
    });
    expect(r.text).toBe('new content');
    expect(r.cached).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('returns ok:false for invalid URL', async () => {
    const db = makeDb();
    const r = await fetchPageContentWithCache(null, { _db: db });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('invalid_url');
  });
});
