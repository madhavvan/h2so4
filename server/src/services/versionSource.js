// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  WHAT IS THE LATEST APP VERSION? — exactly one answer.
//
//  There were two, and they disagreed. `/api/v1/app-version` read this
//  live GitHub-backed cache and answered 4.0.17. `/api/v1/license/version`
//  read a hand-maintained `latest_app_version` row in the database and
//  answered **4.0.8** — a value nobody had touched in months, on a public
//  endpoint, while 4.0.17 was shipping.
//
//  That is not a cosmetic drift. The whole reason this cache exists is so
//  that cutting a release propagates without a server deploy; a second
//  endpoint that requires someone to remember to update a database row
//  defeats it, and the way it fails is silent — a stale row looks exactly
//  like a fresh one.
//
//  So the cache moved here, out of index.js, where every route can reach
//  it without an import cycle. The database value survives only as an
//  explicit OVERRIDE for the rare case where an operator must pin an
//  answer; unset (the normal state) means "use the live source".
//
//  Source of truth is the GitHub Releases API, cached in memory for
//  VERSION_CACHE_TTL_MS. FALLBACK_VERSION covers a cold start where
//  GitHub is unreachable, so clients get a sane answer rather than a 500.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// Must name the SAME repo as REPO in routes/downloads.js. It pointed at
// `interviewcopilot-releases` from 2026-07-18 to 2026-08-06 — a repo that
// was never created — so this fetch 404'd on every refresh and the
// endpoint silently served FALLBACK_VERSION to every client for three
// weeks. server/test/release-feed-config.test.js pins the three copies of
// "which repo" together so they cannot drift apart again.
const GITHUB_RELEASES_URL = 'https://api.github.com/repos/madhavvan/h2so4/releases/latest';
const VERSION_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

// Offline fallback ONLY — the GitHub Releases fetch above is the live
// source of truth. Used when GitHub is unreachable AND the in-memory cache
// is cold (server just restarted). Override at deploy with
// LATEST_APP_VERSION so it can't silently drift behind the shipped
// release: a hardcoded 3.4.9 once sat four releases behind shipped 4.0.8,
// which on a cold start told every client "latest is 3.4.9" and showed a
// misleading downgrade prompt. Whatever value is used MUST point at a
// version that actually has a GitHub release.
const FALLBACK_VERSION = {
  // Bumped 4.0.8 → 4.0.16 on 2026-08-06, → 4.0.17 on 2026-08-07. While
  // GITHUB_RELEASES_URL pointed at a repo that did not exist, the fetch
  // failed on every refresh and this fallback WAS the live answer — so
  // production told every client the latest version was 4.0.8 while
  // 4.0.16 was the shipped build.
  version: process.env.LATEST_APP_VERSION || '4.0.18',
  minVersion: '2.0.0',
  releaseDate: '2026-08-07',
  releaseNotes: 'Latest stable release.',
  downloadUrl: {
    // Routed through get.minicaai.com → 302 → the release CDN. Keeps the
    // codename out of any URL the client receives and surfaces in browser
    // address bars / notifications. routes/downloads.js owns the actual
    // GitHub release URL and never lets the browser see it.
    windows: 'https://get.minicaai.com/windows',
    mac: 'https://get.minicaai.com/mac',
    linux: 'https://get.minicaai.com/linux',
  },
};

const versionCache = {
  value: FALLBACK_VERSION,
  fetchedAt: 0,
  refreshing: false,
};

async function refreshVersionCache() {
  if (versionCache.refreshing) return;
  versionCache.refreshing = true;
  try {
    const res = await fetch(GITHUB_RELEASES_URL, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'minicaai-server',
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    const data = await res.json();
    const tag = (data.tag_name || '').replace(/^v/, '');
    if (!/^\d+\.\d+\.\d+$/.test(tag)) throw new Error(`Bad tag: ${data.tag_name}`);
    versionCache.value = {
      version: tag,
      minVersion: FALLBACK_VERSION.minVersion,
      releaseDate: data.published_at || FALLBACK_VERSION.releaseDate,
      releaseNotes: data.body || FALLBACK_VERSION.releaseNotes,
      // "/releases/latest/download/<asset>" always resolves to current
      // latest, so the same URLs work after every release.
      downloadUrl: FALLBACK_VERSION.downloadUrl,
    };
    versionCache.fetchedAt = Date.now();
  } catch (err) {
    // Keep the last good cached value. On a cold start where GitHub was
    // never reachable, this stays at FALLBACK_VERSION — clients still get
    // a sane (if slightly stale) answer rather than a 500.
    console.warn('[version-check] GitHub fetch failed:', err.message);
  } finally {
    versionCache.refreshing = false;
  }
}

function getLatestVersion() {
  // Sync getter. If the cache is stale, kick off a background refresh for
  // the next caller — never blocks this request.
  if (Date.now() - versionCache.fetchedAt > VERSION_CACHE_TTL_MS) {
    refreshVersionCache();
  }
  return versionCache.value;
}

// Test seam — lets a suite assert the cold-start shape without network.
function _resetForTest() {
  versionCache.value = FALLBACK_VERSION;
  versionCache.fetchedAt = 0;
  versionCache.refreshing = false;
}

module.exports = {
  getLatestVersion,
  refreshVersionCache,
  FALLBACK_VERSION,
  GITHUB_RELEASES_URL,
  VERSION_CACHE_TTL_MS,
  _test: { _resetForTest, versionCache },
};
